import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { atomicJSON } from './config.mjs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { validModel } from './states.mjs';
import { ResponseMetadata } from './response-meta.mjs';

const BUSY = new Set(['waiting_request', 'running']);
const HEADER = 'x-codex-turn-state';
const IDENTITY_HEADERS = ['authorization','x-api-key','session_id','session-id','x-session-id','conversation_id','x-codex-turn-id','originator','user-agent'];
export function identity(headers, payload) {
  const safe = {};
  for (const key of IDENTITY_HEADERS) {
    const value = headers[key];
    if (typeof value === 'string' && value.length <= 8192 && !/[\r\n\0]/.test(value)) safe[key] = value;
  }
  return { headers: safe, payload: { prompt_cache_key: payload?.prompt_cache_key || undefined,
    metadata: payload?.metadata?.turn_id ? { turn_id: payload.metadata.turn_id } : undefined } };
}

// Uses only the fixed local Sub2API target. No redirects, proxy environment,
// account selection overrides, TLS interception, original prompts, or state replay.
export function probeOnce(target, model, routing, endpoint, targetLengths, signal, timeoutSeconds = 15) {
  const url = new URL(target);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || !['','/'].includes(url.pathname)) throw new Error('Probe target must be the configured loopback Sub2API origin');
  if (!['/responses','/v1/responses'].includes(endpoint)) throw new Error('Invalid probe endpoint');
  return new Promise(resolve => {
    let request, response, timer, done = false;
    const result = { status: 0, length: 0, responseModel: null, state: '', error: null, completed: false, accepted: false };
    const finish = extra => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      const out = { ...result, ...extra }; response?.destroy(); request?.destroy(); resolve(out);
    };
    const aborted = () => finish({ error: 'cancelled' });
    if (signal?.aborted) { finish({ error: 'cancelled' }); return; }
    signal?.addEventListener('abort', aborted, { once: true });
    const body = Buffer.from(JSON.stringify({ model, stream: true, store: false, instructions: 'Reply only OK.', input: 'ping', max_output_tokens: 16,
      ...routing.payload }));
    const headers = { ...routing.headers, 'content-type': 'application/json', accept: 'text/event-stream', 'content-length': body.length };
    delete headers[HEADER];
    try {
      request = http.request({ hostname: url.hostname, port: url.port || 80, path: endpoint, method: 'POST', headers, agent: false }, res => {
        response = res; result.status = res.statusCode;
        const values = res.headersDistinct?.[HEADER] || [];
        const state = values.length === 1 ? values[0] : '';
        result.length = typeof res.headers[HEADER] === 'string' ? Buffer.byteLength(res.headers[HEADER]) : 0;
        if (res.statusCode < 200 || res.statusCode >= 300) { finish({ error: 'http_' + res.statusCode }); return; }
        const meta = new ResponseMetadata(res.headers);
        if (!meta.enabled) { finish({ error: 'unsupported_response_type' }); return; }
        const wanted = targetLengths.includes(result.length) && state.length === result.length && /^[\x21-\x7e]+$/.test(state);
        res.on('data', chunk => {
          meta.push(chunk); result.responseModel = meta.model;
          if (meta.failed) finish({ error: 'response_failed' });
          else if (meta.modelConflict || (meta.model && meta.model !== model)) finish({ error: 'model_mismatch' });
          else if (meta.truncated) finish({ error: 'response_too_large' });
          // For a non-target length, stop reading as soon as the model is known.
          else if (meta.model && !wanted) finish({ error: 'length_miss' });
          else if (wanted && (meta.completed || meta.outputLimitReached) && meta.model === model) finish({ state, completed: meta.completed, accepted: true });
        });
        res.on('end', () => {
          meta.end(); result.responseModel = meta.model;
          if (meta.failed) finish({ error: 'response_failed' });
          else if (meta.modelConflict || meta.model !== model) finish({ error: meta.model ? 'model_mismatch' : 'response_model_missing' });
          else if (!wanted) finish({ error: 'length_miss' });
          else if (meta.completed || meta.outputLimitReached || (!meta.sse && !meta.truncated)) finish({ state, completed: meta.completed, accepted: true });
          else finish({ error: 'incomplete_response' });
        });
        res.on('aborted', () => finish({ error: 'upstream_aborted' }));
        res.on('error', () => finish({ error: 'upstream_stream_error' }));
      });
      timer = setTimeout(() => finish({ error: 'timeout' }), timeoutSeconds * 1000);
      request.on('error', () => finish({ error: 'connection_error' })); request.end(body);
    } catch { finish({ error: 'invalid_request' }); }
  });
}

export class ProbeManager {
  constructor(config, states, journal, getMode) {
    this.config = config; this.states = states; this.journal = journal; this.getMode = getMode;
    this.job = null; this.recent = new Map(); this.starts = []; this.attempts = []; this.lastStart = 0; this.pending = Promise.resolve();
    this.automaticActive = 0; this.budgetFile = path.join(path.dirname(journal.file),'probe-budget.json');
    this.budgetUnavailable = false;
    try {
      const data=JSON.parse(fs.readFileSync(this.budgetFile,'utf8'));
      if(!Array.isArray(data.attempts)||data.attempts.some(t=>!Number.isFinite(t)))throw new Error('Invalid budget');
      this.attempts=data.attempts.filter(t=>Date.now()-t<3600000);
    } catch(e) { if(e.code!=='ENOENT')this.budgetUnavailable=true; }
  }
  consumeAttempt() {
    this.attempts=this.attempts.filter(t=>Date.now()-t<3600000);
    if(this.budgetUnavailable || this.attempts.length>=30)return false;
    const next=[...this.attempts,Date.now()];
    try{atomicJSON(this.budgetFile,{attempts:next});}catch{return false;}
    this.attempts=next; return true;
  }
  remember(ctx) {
    if (!ctx.id || !ctx.rule?.enabled) return;
    this.recent.set(ctx.id, { id: ctx.id, model: ctx.model, client: ctx.client, session: ctx.session, scope: ctx.scope, lastSeen: Date.now() });
    while (this.recent.size > 128) this.recent.delete(this.recent.keys().next().value);
  }
  snapshot() {
    const now = Date.now();
    return { job: this.job ? structuredClone(this.job.public) : null,
      bindings: [...this.recent.values()].filter(x => now - x.lastSeen < 600_000),
      limits: { maxAttempts: 10, maxRunSeconds: 180, minIntervalSeconds: 2, maxAttemptsPerHour: 30, maxStartsPerTenMinutes: 3 },
      notice: 'Billable opt-in, serial probes only. Keys/routing inputs are memory-only. Hits apply only to the exact binding. No proxy switching, automatic recurring scan or validity guarantee.' };
  }
  start(input) {
    if (!input || input.acknowledgeBillable !== true || input.acknowledgeExperimental !== true) throw new Error('Confirm billable probes and experimental state replay first.');
    if (!['pin','observe'].includes(this.getMode())) throw new Error('Enable observation or pin mode before probing.');
    if (this.job && BUSY.has(this.job.public.status)) throw new Error('A probe is already running or waiting.');
    if (this.automaticActive) throw new Error('An automatic preflight probe is active.');
    const now = Date.now();
    this.starts = this.starts.filter(t => now - t < 600_000); this.attempts = this.attempts.filter(t => now - t < 3600_000);
    if (this.starts.length >= 3 || this.attempts.length >= 30 || now - this.lastStart < 2000) throw new Error('Probe cooldown/budget reached; no requests sent.');
    const model = input.model, rule = this.states.rules[model];
    if (!validModel(model) || !rule?.enabled || !rule.pinLengths.length) throw new Error('Configure and enable explicit pin lengths for the exact model first.');
    const lengths = input.targetLengths ?? rule.pinLengths;
    if (!Array.isArray(lengths) || !lengths.length || lengths.length > 16 || lengths.some(n => !Number.isInteger(n) || !rule.pinLengths.includes(n))) throw new Error('Targets must be a subset of this model\'s configured pin lengths.');
    const count = input.maxAttempts ?? 3, interval = input.intervalSeconds ?? 2;
    if (!Number.isInteger(count) || count < 1 || count > 10 || !Number.isInteger(interval) || interval < 2 || interval > 10) throw new Error('Use 1..10 attempts and a 2..10 second interval.');
    const source = input.source || 'next_request', endpoint = input.endpoint || '/responses';
    if (!['next_request','manual'].includes(source) || !['/responses','/v1/responses'].includes(endpoint)) throw new Error('Invalid probe source/endpoint.');
    let routing = null, ctx = null;
    if (source === 'next_request') {
      const binding = this.recent.get(input.bindingId);
      if (!binding || binding.model !== model || now - binding.lastSeen >= 600_000) throw new Error('Select a recent matching session binding; send a normal request first.');
    } else {
      if (typeof input.apiKey !== 'string' || !input.apiKey || input.apiKey.length > 4096 || /\s/.test(input.apiKey)) throw new Error('Provide a valid Sub2API key; it is not saved.');
      const headers = { authorization: 'Bearer ' + input.apiKey, 'user-agent': 'sub2api-turnstate-probe/0.3.0' };
      if (input.sessionId) headers.session_id = input.sessionId;
      if (input.turnId) headers['x-codex-turn-id'] = input.turnId;
      routing = identity(headers, null); ctx = this.states.context(model, routing.headers, routing.payload);
      if (!ctx.id) throw new Error('This scope requires the same session/turn identifiers as the real client.');
    }
    const pub = { id: randomUUID(), model, source, endpoint, targetLengths: [...new Set(lengths)], maxAttempts: count, intervalSeconds: interval,
      status: source === 'next_request' ? 'waiting_request' : 'running', createdAt: now, startedAt: null, deadline: now + 120_000,
      bindingId: source === 'next_request' ? input.bindingId : ctx.id, tried: 0, hits: 0, lastResult: null, results: [], finishedAt: null };
    const job = { public: pub, controller: new AbortController(), epoch: this.states.epochs.get(model) || 0, signature: this.states.signature(model), timer: null };
    this.job = job; this.starts.push(now); this.lastStart = now;
    job.timer = setTimeout(() => this.stop('waiting_expired'), 120_000);
    this.journal.add({ kind: 'probe', action: 'started', model, jobId: pub.id, source, maxAttempts: count, bindingId: pub.bindingId });
    if (routing) this.launch(job, ctx, routing);
    return this.snapshot();
  }
  // Called only after a successful real HTTP response. Borrow only allowlisted
  // routing headers for this explicitly armed, exact binding; never prompt/body.
  trigger(ctx, headers, payload) {
    const job = this.job;
    if (!job || job.public.status !== 'waiting_request' || ctx.id !== job.public.bindingId || ctx.model !== job.public.model) return;
    if ((this.states.epochs.get(ctx.model) || 0) !== job.epoch || this.states.signature(ctx.model) !== job.signature) { this.stop('configuration_changed'); return; }
    const routing = identity(headers, payload);
    const verified = this.states.context(ctx.model, routing.headers, routing.payload);
    if (verified.id !== ctx.id) { this.stop('routing_identity_unavailable'); return; }
    this.launch(job, verified, routing);
  }
  launch(job, ctx, routing) {
    clearTimeout(job.timer); job.public.status = 'running'; job.public.startedAt = Date.now(); job.public.deadline = Date.now() + 180_000;
    job.timer = setTimeout(() => this.stop('deadline'), 180_000);
    this.pending = this.run(job, ctx, routing).catch(() => { if (BUSY.has(job.public.status)) job.public.status = 'internal_error'; }).finally(() => {
      clearTimeout(job.timer); job.public.finishedAt = Date.now();
      // Drop the only retained credential/routing references at end/cancel/error.
      for (const key of Object.keys(routing.headers)) delete routing.headers[key]; routing.payload = null;
    });
  }
  async run(job, ctx, routing) {
    const p = job.public, signal = job.controller.signal;
    for (let index = 0; index < p.maxAttempts; index++) {
      if (signal.aborted) return;
      if (!['pin','observe'].includes(this.getMode())) { this.stop('processing_disabled'); return; }
      if ((this.states.epochs.get(p.model) || 0) !== job.epoch || this.states.signature(p.model) !== job.signature) { this.stop('configuration_changed'); return; }
      if (Date.now() >= p.deadline || this.attempts.filter(t => Date.now() - t < 3600_000).length >= 30) { this.stop('budget_exhausted'); return; }
      if (index > 0) { try { await delay(p.intervalSeconds * 1000, null, { signal }); } catch { return; } }
      if (signal.aborted) return;
      if(!this.consumeAttempt()){this.stop('budget_exhausted');return;} p.tried++;
      const out = await probeOnce(this.config.target, p.model, routing, p.endpoint, p.targetLengths, signal);
      if (signal.aborted) return;
      const result = { attempt: p.tried, time: Date.now(), status: out.status, length: out.length, responseModel: out.responseModel, outcome: out.error || 'target_candidate' };
      p.lastResult = result; p.results.push(result);
      this.journal.add({ kind: 'probe', action: 'attempt', model: p.model, jobId: p.id, ...result });
      if (!out.error && out.accepted && out.responseModel === p.model && out.state && p.targetLengths.includes(out.length)) {
        if (this.states.adoptProbe(ctx, out.state, out.responseModel)) {
          p.status = 'found'; p.hits = 1; result.outcome = 'pinned_for_binding';
          this.journal.add({ kind: 'probe', action: 'found', model: p.model, jobId: p.id, length: out.length, bindingId: ctx.id });
        } else p.status = 'binding_changed';
        return;
      }
      // Only a confirmed successful response with a different length is retried.
      // Never loop on auth, quota, model mismatch, redirects, timeouts or 5xx.
      if (out.error !== 'length_miss') { p.status = out.error || 'not_accepted'; return; }
    }
    p.status = 'exhausted';
  }
  stop(reason = 'stopped') {
    if (this.job && BUSY.has(this.job.public.status)) {
      this.job.public.status = reason; this.job.public.finishedAt = Date.now(); clearTimeout(this.job.timer); this.job.controller.abort();
      this.journal.add({ kind: 'probe', action: reason, model: this.job.public.model, jobId: this.job.public.id });
    }
    return this.snapshot();
  }
  async close() { this.stop('service_stopped'); await this.pending; }
}
