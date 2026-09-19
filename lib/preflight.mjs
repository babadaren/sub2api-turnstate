import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJSON } from './config.mjs';
import { validModel } from './states.mjs';
import { identity, probeOnce } from './probes.mjs';

export const defaultPreflight = () => ({ enabled: false, maxAttempts: 3, maxWaitSeconds: 45, intervalSeconds: 2, failurePolicy: 'reject', cooldownSeconds: 60 });
export function validatePreflight(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 128) throw new Error('Expected an object keyed by model (max 128).');
  const out = Object.create(null);
  for (const [model, raw] of Object.entries(value)) {
    if (!validModel(model) || !raw || typeof raw !== 'object') throw new Error('Invalid preflight model.');
    const r = { ...defaultPreflight(), ...raw };
    if (typeof r.enabled !== 'boolean' || !['reject','passthrough'].includes(r.failurePolicy)) throw new Error('Invalid preflight switch/failure policy.');
    for (const [key, min, max] of [['maxAttempts',1,10],['maxWaitSeconds',5,60],['intervalSeconds',2,10],['cooldownSeconds',10,600]]) {
      if (!Number.isInteger(r[key]) || r[key] < min || r[key] > max) throw new Error(`${key} must be ${min}..${max}.`);
    }
    out[model] = Object.fromEntries(Object.keys(defaultPreflight()).map(k => [k,r[k]]));
  }
  return out;
}

// Optional synchronous ingress gate. Original payloads NEVER enter the probe.
// A length is a compatibility criterion, not proof of authenticity/model execution.
export class PreflightGate {
  constructor(config, home, states, journal, probes, getMode) {
    Object.assign(this, { config, home, states, journal, probes, getMode });
    this.file = path.join(home,'preflight.json');
    this.rules = { 'gpt-6-astra': defaultPreflight() };
    try { this.rules = validatePreflight(JSON.parse(fs.readFileSync(this.file,'utf8'))); }
    catch(e) { if (e.code !== 'ENOENT') throw new Error('Invalid preflight.json: '+e.message); }
    this.jobs = new Map(); this.cooldowns = new Map(); this.recent = [];
    this.waiters = 0; this.heldBytes = 0; this.revision = 0; this.closed = false;
    this.totals = { cacheHits: 0, starts: 0, attempts: 0, found: 0, blocked: 0, passthrough: 0, joined: 0 };
  }
  enabled(model) { return !this.closed && this.getMode() === 'pin' && !!this.rules[model]?.enabled; }
  snapshot() {
    return { rules: this.rules, activeJobs: [...this.jobs.values()].map(j=>({...j.public,waiters:j.waiters})),
      recent: this.recent, waitingRequests: this.waiters, heldRequestBytes: this.heldBytes, totals: this.totals,
      limits: { maxJobs:2, maxWaitingRequests:8, maxHeldRequestBytes:67108864, maxAttemptsPerHour:30 },
      notice:'Off by default. Blocking HTTP preflight, not background refresh. Local TTL + exact response model + configured length are necessary, not proof of upstream identity. Original payload is never retried.' };
  }
  configure(value, acknowledged = false) {
    const clean = validatePreflight(value);
    for (const [m,r] of Object.entries(clean)) if (r.enabled) {
      if (!acknowledged) throw new Error('Explicit billable and experimental acknowledgement required.');
      const rule = this.states.rules[m];
      if (!rule?.enabled || !rule.pinLengths.length) throw new Error('Enable explicit model pin lengths before preflight.');
    }
    atomicJSON(this.file,clean); this.rules = clean; this.revision++;
    this.cancel('configuration_changed'); this.cooldowns.clear();
    this.journal.add({kind:'preflight',action:'configured',enabledModels:Object.keys(clean).filter(m=>clean[m].enabled)});
  }
  cancel(reason = 'stopped') {
    for (const job of this.jobs.values()) { job.reason = reason; job.controller.abort(); }
  }
  fail(rule, reason, extra = {}) {
    const allow = rule.failurePolicy === 'passthrough';
    this.totals[allow?'passthrough':'blocked']++;
    return { allow, handled:true, action:allow?'failure_passthrough':'blocked',reason, ...extra };
  }
  async ensure(ctx, headers, payload, requestPath, bytes, signal) {
    if (!this.enabled(ctx.model)) return {allow:true,handled:false,action:'disabled'};
    const rule = structuredClone(this.rules[ctx.model]), started = Date.now();
    if (signal?.aborted) return {allow:false,handled:true,action:'cancelled',reason:'client_disconnected'};
    if (!ctx.id || !ctx.rule?.enabled || !ctx.rule.pinLengths.length) return this.fail(rule,'missing_binding_or_model_rule');
    const cache = this.states.liveForPreflight(ctx);
    if (cache) { this.totals.cacheHits++; return {allow:true,handled:true,action:'cache_hit',attempts:0,waitMs:0}; }
    const key = `${ctx.id}:${ctx.epoch}:${ctx.ruleSignature}:${this.revision}`;
    const prior = this.cooldowns.get(key);
    if (prior?.until > started) return this.fail(rule,prior.reason,{cooldown:true,retryAfter:Math.ceil((prior.until-started)/1000)});
    if (this.waiters >= 8 || this.heldBytes + bytes > 67108864) return this.fail(rule,'waiting_capacity');
    let job = this.jobs.get(key);
    if (!job) {
      if (this.jobs.size >= 2 || ['running','waiting_request'].includes(this.probes.job?.public.status)) return this.fail(rule,'probe_busy');
      const routing = identity(headers,payload);
      if (this.states.context(ctx.model,routing.headers,routing.payload).id !== ctx.id) return this.fail(rule,'routing_identity_unavailable');
      const p = {id:randomUUID(),model:ctx.model,bindingId:ctx.id,status:'running',createdAt:started,
        deadline:started+rule.maxWaitSeconds*1000,attempts:0,maxAttempts:rule.maxAttempts,lastResult:null};
      job = {public:p,rule,ctx,key,revision:this.revision,controller:new AbortController(),waiters:0,reason:null};
      this.jobs.set(key,job); this.probes.automaticActive++; this.totals.starts++;
      this.journal.add({kind:'preflight',action:'started',model:ctx.model,jobId:p.id,bindingId:ctx.id,maxAttempts:rule.maxAttempts});
      job.timer = setTimeout(()=>{job.reason='deadline';job.controller.abort();},rule.maxWaitSeconds*1000);
      job.promise = this.run(job,routing,requestPath).catch(()=>({ok:false,reason:'internal_error'})).then(result=>{
        p.status=result.ok?'found':result.reason; p.finishedAt=Date.now();
        if (!result.ok && !['all_clients_disconnected','processing_disabled','configuration_changed','service_stopped'].includes(result.reason)) {
          this.cooldowns.set(key,{reason:result.reason,until:Date.now()+rule.cooldownSeconds*1000});
          while(this.cooldowns.size>512)this.cooldowns.delete(this.cooldowns.keys().next().value);
        }
        this.recent.unshift({...p}); this.recent=this.recent.slice(0,30);
        this.journal.add({kind:'preflight',action:p.status,model:ctx.model,jobId:p.id,attempts:p.attempts});
        return result;
      }).finally(()=>{
        clearTimeout(job.timer); this.jobs.delete(key); this.probes.automaticActive--;
        for(const k of Object.keys(routing.headers)) delete routing.headers[k]; routing.payload=null;
      });
    } else this.totals.joined++;
    this.waiters++; this.heldBytes+=bytes; job.waiters++;
    let onAbort;
    try {
      const cancelled = new Promise(resolve=>{
        onAbort=()=>resolve({ok:false,reason:'client_disconnected'});
        signal?.addEventListener('abort',onAbort,{once:true});
        if(signal?.aborted)onAbort();
      });
      const result = await Promise.race([job.promise,cancelled]);
      const extra={jobId:job.public.id,attempts:job.public.attempts,waitMs:Date.now()-started};
      if (signal?.aborted) return {allow:false,handled:true,action:'cancelled',reason:'client_disconnected',...extra};
      if (this.getMode() !== 'pin') return {allow:true,handled:false,action:'processing_disabled',...extra};
      if (!this.closed && !this.rules[ctx.model]?.enabled) return {allow:true,handled:false,action:'preflight_disabled',...extra};
      if (result.ok && this.enabled(ctx.model) && this.states.liveForPreflight(ctx)) return {allow:true,handled:true,action:'found',...extra};
      return this.fail(rule,result.ok?'binding_changed':result.reason,extra);
    } finally {
      signal?.removeEventListener('abort',onAbort);
      job.waiters--; this.waiters--; this.heldBytes-=bytes;
      if(job.waiters===0 && this.jobs.has(key)) {job.reason='all_clients_disconnected';job.controller.abort();}
    }
  }
  async run(job,routing,requestPath) {
    const {ctx,rule,controller,public:p}=job,signal=controller.signal;
    for(let i=0;i<rule.maxAttempts;i++) {
      if(i>0) {try{await delay(rule.intervalSeconds*1000,null,{signal});}catch{}}
      if(signal.aborted)return {ok:false,reason:job.reason||'cancelled'};
      if(!this.enabled(ctx.model))return {ok:false,reason:'processing_disabled'};
      if(job.revision!==this.revision || ctx.epoch!==(this.states.epochs.get(ctx.model)||0) || ctx.ruleSignature!==this.states.signature(ctx.model))return {ok:false,reason:'configuration_changed'};
      if(Date.now()>=p.deadline)return {ok:false,reason:'deadline'};
      if(!this.probes.consumeAttempt())return {ok:false,reason:'hourly_budget'};
      p.attempts++; this.totals.attempts++;
      const endpoint=requestPath.startsWith('/v1/')?'/v1/responses':'/responses';
      const out=await probeOnce(this.config.target,ctx.model,routing,endpoint,ctx.rule.pinLengths,signal,Math.min(15,(p.deadline-Date.now())/1000));
      if(signal.aborted)return {ok:false,reason:job.reason||'cancelled'};
      if(job.revision!==this.revision || !this.enabled(ctx.model))return {ok:false,reason:'configuration_changed'};
      p.lastResult={status:out.status,length:out.length,responseModel:out.responseModel,outcome:out.error||'candidate'};
      this.journal.add({kind:'preflight',action:'attempt',jobId:p.id,model:ctx.model,attempt:p.attempts,...p.lastResult});
      if(!out.error && out.accepted && out.responseModel===ctx.model && out.state && ctx.rule.pinLengths.includes(out.length)) {
        if(!this.states.adoptProbe(ctx,out.state,out.responseModel))return {ok:false,reason:'binding_changed'};
        this.totals.found++;return {ok:true};
      }
      // Only a successful, same-model length miss is retryable. No auth/quota/model bypass.
      if(out.error!=='length_miss')return {ok:false,reason:out.error||'not_accepted'};
    }
    return {ok:false,reason:'attempts_exhausted'};
  }
  async close() {this.closed=true;this.cancel('service_stopped');await Promise.allSettled([...this.jobs.values()].map(j=>j.promise));}
}
