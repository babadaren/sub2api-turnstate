import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { atomicJSON } from './config.mjs';

const MODEL = /^[\w./:@-]{1,100}$/;
const MAX_PINS = 512, MAX_MODELS = 128;
export const defaultRules = () => ({
  'gpt-6-astra': { enabled: true, pinLengths: [292], discardLengths: [312], ttlSeconds: 300, scope: 'session', unknownPolicy: 'pass', autoLearn: false },
  'gpt-5.6-sol': { enabled: false, pinLengths: [], discardLengths: [], ttlSeconds: 300, scope: 'session', unknownPolicy: 'pass', autoLearn: false }
});
export function validModel(v) { return typeof v === 'string' && MODEL.test(v) && !['__proto__','constructor','prototype'].includes(v); }
export function validateRules(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > MAX_MODELS) throw new Error('Rules must be an object of at most 128 model names.');
  const result = Object.create(null);
  for (const [model, r] of Object.entries(value)) {
    if (!validModel(model) || !r || typeof r !== 'object') throw new Error('Invalid model rule.');
    for (const field of ['pinLengths','discardLengths']) {
      if (!Array.isArray(r[field]) || r[field].length > 16 || r[field].some(n => !Number.isInteger(n) || n < 1 || n > 8192)) throw new Error('Lengths must be integer arrays in 1..8192.');
    }
    if (r.pinLengths.some(n => r.discardLengths.includes(n))) throw new Error('Pin and discard lengths must not overlap.');
    if (!Number.isInteger(r.ttlSeconds) || r.ttlSeconds < 30 || r.ttlSeconds > 86400) throw new Error('Refresh interval must be 30..86400 seconds.');
    if (!['turn','session','credential'].includes(r.scope) || !['pass','drop'].includes(r.unknownPolicy)) throw new Error('Invalid scope or unknown-length policy.');
    if (typeof r.enabled !== 'boolean' || typeof r.autoLearn !== 'boolean') throw new Error('enabled and autoLearn must be boolean.');
    result[model] = { enabled: r.enabled, pinLengths: [...new Set(r.pinLengths)], discardLengths: [...new Set(r.discardLengths)], ttlSeconds: r.ttlSeconds, scope: r.scope, unknownPolicy: r.unknownPolicy, autoLearn: r.autoLearn };
  }
  return result;
}
function stateText(value) {
  // Duplicated, non-ASCII, or oversized values are not candidates for replay.
  return typeof value === 'string' && value.length <= 8192 && /^[\x21-\x7e]+$/.test(value) ? value : '';
}
export class StateStore {
  constructor(home, salt, audit = () => {}, now = () => Date.now()) {
    this.home = home; this.salt = salt; this.audit = audit; this.now = now;
    this.pins = new Map(); this.observed = new Map(); this.epochs = new Map(); this.timer = null; this.persistError = false;
    this.rules = defaultRules();
    try { this.rules = validateRules(JSON.parse(fs.readFileSync(path.join(home, 'rules.json'), 'utf8'))); } catch (e) { if (e.code !== 'ENOENT') throw new Error('Invalid rules.json: ' + e.message); }
    // Read candidates, never credentials. Invalid/expired records cannot be replayed.
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(home, 'states.json'), 'utf8'));
      for (const p of (saved.pins || []).slice(-MAX_PINS)) {
        if (/^[a-f0-9]{32}$/.test(p.id) && validModel(p.model) && stateText(p.state) && Number.isFinite(p.expiresAt) && p.expiresAt <= now() + 86400_000 && p.ruleSignature === this.signature(p.model)) this.pins.set(p.id, p);
      }
    } catch {}
  }
  hash(s) { return createHmac('sha256', this.salt).update(s).digest('hex'); }
  signature(model) { return JSON.stringify(this.rules[model] || null); }
  context(model, headers, payload = null) {
    model = validModel(model) ? model : null;
    const credential = String(headers.authorization || headers['x-api-key'] || '');
    const session = String(headers.session_id || headers['session-id'] || headers['x-session-id'] || headers.conversation_id || payload?.prompt_cache_key || '').slice(0, 512);
    const turn = String(headers['x-codex-turn-id'] || payload?.metadata?.turn_id || '').slice(0, 512);
    const rule = this.rules[model], scope = rule?.scope || 'session';
    let id = null;
    if (model && credential && (scope === 'credential' || session) && (scope !== 'turn' || turn)) {
      id = this.hash(JSON.stringify([credential, model, scope, scope === 'credential' ? '' : session, scope === 'turn' ? turn : ''])).slice(0,32);
    }
    return { id, model, client: this.hash(credential || 'anonymous').slice(0,12), session: session ? this.hash(session).slice(0,12) : null, scope,
      epoch: this.epochs.get(model) || 0, ruleSignature: this.signature(model), rule: rule ? structuredClone(rule) : null };
  }
  observe(ctx, incoming, side) {
    if (!ctx.model) return;
    const n = typeof incoming === 'string' ? Buffer.byteLength(incoming) : 0;
    if (n > 8192) return;
    if (!this.observed.has(ctx.model)) {
      if (this.observed.size >= MAX_MODELS) this.observed.delete(this.observed.keys().next().value);
      this.observed.set(ctx.model, { model: ctx.model, requests: 0, responses: 0, requestLengths: {}, responseLengths: {}, lastSeen: 0 });
    }
    const o = this.observed.get(ctx.model); o[side === 'request' ? 'requests' : 'responses']++;
    const histogram = o[side === 'request' ? 'requestLengths' : 'responseLengths'];
    if (Object.keys(histogram).length < 32 || Object.hasOwn(histogram, n)) histogram[n] = (histogram[n] || 0) + 1;
    o.lastSeen = this.now();
  }
  decide(ctx, incoming, side, mode, status = 200) {
    const length = typeof incoming === 'string' ? Buffer.byteLength(incoming) : 0;
    const d = { incomingLength: length, outgoingLength: length, action: 'bypass', remove: false };
    if (mode === 'off') return d;
    this.observe(ctx, incoming, side);
    const rule = ctx.rule;
    if (!ctx.id || !rule?.enabled || ctx.epoch !== (this.epochs.get(ctx.model) || 0) || ctx.ruleSignature !== this.signature(ctx.model)) {
      d.action = mode === 'observe' ? 'observe' : 'unconfigured_or_unscoped'; return d;
    }
    let pin = this.pins.get(ctx.id);
    const text = stateText(incoming);
    const usable = text && !rule.discardLengths.includes(length) && (rule.pinLengths.includes(length) || (rule.autoLearn && rule.pinLengths.length === 0));
    const success = side === 'response' && status >= 200 && status < 300;
    if (success && usable) {
      const refresh = !pin || pin.pending || pin.expiresAt <= this.now() || pin.state !== text;
      if (refresh) {
        const now = this.now();
        pin = { id: ctx.id, model: ctx.model, client: ctx.client, session: ctx.session, scope: ctx.scope, state: text,
          length, fingerprint: this.hash(text).slice(0,16), capturedAt: now, expiresAt: now + rule.ttlSeconds * 1000,
          pending: false, source: 'response', ruleSignature: ctx.ruleSignature };
        if (this.pins.size >= MAX_PINS && !this.pins.has(ctx.id)) this.pins.delete(this.pins.keys().next().value);
        this.pins.set(ctx.id, pin); this.schedule();
        this.audit({ kind: 'state', action: 'captured', model: ctx.model, pinId: pin.id, length, fingerprint: pin.fingerprint });
      }
      d.action = mode === 'observe' ? 'observe_candidate' : 'captured_or_kept';
      return d;
    }
    if (mode !== 'pin') { d.action = 'observe'; return d; }
    // Error responses are never pinned or rewritten; errors invalidate only the matching binding.
    if (side === 'response' && (status < 200 || status >= 300)) {
      if (pin && [401,403,409].includes(status)) { pin.pending = true; pin.expiresAt = 0; this.schedule(); }
      d.action = 'error_passthrough'; return d;
    }
    const live = pin && !pin.pending && pin.expiresAt > this.now();
    if (side === 'request' && pin && !live) {
      // Expired/manual-refresh bindings wait for a new response. Never seed from a stale request.
      if (length) { d.remove = true; d.outgoingLength = 0; }
      d.action = 'refresh_wait_response'; return d;
    }
    const unknownDrop = length > 0 && !usable && rule.unknownPolicy === 'drop';
    const discard = rule.discardLengths.includes(length) || unknownDrop;
    if (live && (length === 0 || discard || (side === 'request' && usable))) {
      d.value = pin.state; d.remove = true; d.outgoingLength = pin.length;
      d.action = length === 0 ? 'inject' : 'reuse'; return d;
    }
    if (discard) { d.remove = true; d.outgoingLength = 0; d.action = 'discard'; }
    else d.action = 'keep';
    return d;
  }
  adoptProbe(ctx, state, responseModel) {
    const rule = this.rules[ctx.model], text = stateText(state);
    if (!ctx.id || responseModel !== ctx.model || !rule?.enabled || !text || !rule.pinLengths.includes(text.length) || rule.discardLengths.includes(text.length) || ctx.epoch !== (this.epochs.get(ctx.model) || 0) || ctx.ruleSignature !== this.signature(ctx.model)) return false;
    const now = this.now();
    const pin = { id: ctx.id, model: ctx.model, client: ctx.client, session: ctx.session, scope: ctx.scope,
      state: text, length: text.length, fingerprint: this.hash(text).slice(0,16), capturedAt: now,
      expiresAt: now + rule.ttlSeconds * 1000, pending: false, source: 'probe', verifiedModel: responseModel, ruleSignature: ctx.ruleSignature };
    if (this.pins.size >= MAX_PINS && !this.pins.has(ctx.id)) this.pins.delete(this.pins.keys().next().value);
    this.pins.set(ctx.id, pin); this.schedule();
    this.audit({ kind: 'state', action: 'probe_captured', model: ctx.model, pinId: pin.id, length: pin.length, fingerprint: pin.fingerprint });
    return true;
  }
  liveForPreflight(ctx) {
    const p=this.pins.get(ctx.id),r=this.rules[ctx.model];
    if(!p || !r?.enabled || p.pending || p.expiresAt<=this.now()+250 || p.ruleSignature!==ctx.ruleSignature || ctx.ruleSignature!==this.signature(ctx.model) || ctx.epoch!==(this.epochs.get(ctx.model)||0))return null;
    if(p.verifiedModel!==ctx.model || !stateText(p.state) || p.length!==p.state.length || !r.pinLengths.includes(p.length) || r.discardLengths.includes(p.length))return null;
    return p;
  }
  verifyResponsePin(ctx, raw, responseModel, accepted) {
    const p=this.pins.get(ctx.id);
    if(!p || p.state!==raw || ctx.epoch!==(this.epochs.get(ctx.model)||0) || ctx.ruleSignature!==this.signature(ctx.model))return;
    if(accepted && responseModel===ctx.model) p.verifiedModel=responseModel;
    else {delete p.verifiedModel;if(responseModel && responseModel!==ctx.model){p.pending=true;p.expiresAt=0;}}
    this.schedule();
  }
  invalidateUsedPin(ctx, fingerprint) {
    const p=this.pins.get(ctx.id);
    if(!fingerprint || !p || p.fingerprint!==fingerprint || ctx.epoch!==(this.epochs.get(ctx.model)||0) || ctx.ruleSignature!==this.signature(ctx.model))return;
    p.pending=true;p.expiresAt=0;delete p.verifiedModel;this.schedule();
    this.audit({kind:'state',action:'invalidated_response',model:ctx.model,pinId:ctx.id});
  }
  captureAutomatic(ctx,raw,responseModel) {
    const rule=this.rules[ctx.model],state=stateText(raw);
    if(!ctx.id || !rule?.enabled || !state || responseModel!==ctx.model || !rule.pinLengths.includes(state.length) || rule.discardLengths.includes(state.length) || ctx.epoch!==(this.epochs.get(ctx.model)||0) || ctx.ruleSignature!==this.signature(ctx.model))return;
    const p=this.pins.get(ctx.id);
    // An identical state never resets or extends its configured local expiry.
    if(p && p.state===state && !p.pending && p.expiresAt>this.now()) {p.verifiedModel=responseModel;this.schedule();return;}
    this.adoptProbe(ctx,state,responseModel);this.pins.get(ctx.id).source='response';
  }
  configure(rules) {
    const clean = validateRules(rules);
    atomicJSON(path.join(this.home, 'rules.json'), clean);
    // Rule edits invalidate old and in-flight bindings. Never silently change the replay scope.
    for (const model of new Set([...Object.keys(this.rules), ...Object.keys(clean)])) {
      if (JSON.stringify(this.rules[model]) !== JSON.stringify(clean[model])) {
        this.epochs.set(model, (this.epochs.get(model) || 0) + 1);
        for (const [id,p] of this.pins) if (p.model === model) this.pins.delete(id);
      }
    }
    this.rules = clean; this.schedule();
  }
  refresh({ model, id } = {}) {
    if (id) { const p = this.pins.get(id); if (!p) throw new Error('Binding not found'); model = p.model; }
    if (!validModel(model)) throw new Error('A model or binding id is required');
    this.epochs.set(model, (this.epochs.get(model) || 0) + 1);
    let count = 0;
    for (const p of this.pins.values()) if (p.model === model && (!id || p.id === id)) { p.pending = true; p.expiresAt = 0; count++; }
    this.schedule(); this.audit({ kind: 'state', action: 'refresh_requested', model, count });
    return { refreshed: false, pending: true, count, message: 'Old binding invalidated. Waiting for the next matching successful upstream response; no billable probe was sent.' };
  }
  manual(id, value) {
    const p = this.pins.get(id), state = stateText(value);
    const rule = p && this.rules[p.model];
    if (!p || !state || !rule?.pinLengths.includes(state.length)) throw new Error('Choose an existing binding and a state matching its configured pin length.');
    this.epochs.set(p.model, (this.epochs.get(p.model) || 0) + 1);
    delete p.verifiedModel;
    Object.assign(p, { state, length: state.length, fingerprint: this.hash(state).slice(0,16), capturedAt: this.now(), expiresAt: this.now() + rule.ttlSeconds * 1000, pending: false, source: 'manual' });
    this.schedule(); this.audit({ kind: 'state', action: 'manual_pin', model: p.model, pinId: p.id, length: p.length });
  }
  reveal(id) {
    const p = this.pins.get(id); if (!p) throw new Error('Binding not found');
    this.audit({ kind: 'admin', action: 'state_revealed', pinId: id, model: p.model });
    return { state: p.state, length: p.length, expired: p.pending || p.expiresAt <= this.now() };
  }
  snapshot() {
    const now = this.now();
    return { rules: this.rules, observed: [...this.observed.values()], serverTime: now, persistError: this.persistError,
      pins: [...this.pins.values()].map(({ state, ruleSignature, ...p }) => ({ ...p, preview: state.length > 24 ? state.slice(0,12) + '…' + state.slice(-8) : '••••',
        remainingSeconds: Math.max(0, Math.ceil((p.expiresAt - now) / 1000)), status: p.pending || p.expiresAt <= now ? 'waiting_response' : 'candidate' })) };
  }
  schedule() { if (!this.timer) { this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 500); this.timer.unref(); } }
  flush() {
    clearTimeout(this.timer); this.timer = null;
    try { atomicJSON(path.join(this.home, 'states.json'), { version: 1, pins: [...this.pins.values()] }); this.persistError = false; }
    catch { this.persistError = true; /* In-memory operation continues; console reports persistence failure. */ }
  }
}
