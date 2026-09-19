import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { identity, probeOnce } from './probe-transport.mjs';

// These are transport/resource protections, NOT attempt quotas or task deadlines.
// A live target request retries model/length misses until it obtains a qualified
// state, is disconnected, or the operator turns the one switch off.
export const automaticBackoff = misses => Math.min(30000, 2000 * 2 ** Math.min(4, Math.floor(Math.max(0, misses - 1) / 5)));
export class AutomaticGate {
  constructor(config, states, journal, isEnabled, options = {}) {
    Object.assign(this, { config, states, journal, isEnabled });
    this.probe = options.probe || probeOnce;
    this.sleep = options.sleep || delay;
    this.jobs = new Map(); this.cooldowns = new Map(); this.recent = [];
    this.waiters = 0; this.heldBytes = 0; this.generation = 0; this.closed = false;
    this.totals = { cacheHits: 0, starts: 0, attempts: 0, found: 0, joined: 0, blocked: 0 };
  }
  enabled(model) {
    const rule = this.states.rules[model];
    return !this.closed && this.isEnabled() && !!rule?.enabled && !!rule.pinLengths.length;
  }
  snapshot() {
    return { enabled: this.isEnabled(), activeJobs: [...this.jobs.values()].map(j => ({ ...j.public, waiters: j.waiters })),
      recent: this.recent.map(j => ({ ...j })), waitingRequests: this.waiters, totals: { ...this.totals },
      eligibleModels: Object.entries(this.states.rules).filter(([,r]) => r.enabled && r.pinLengths.length).map(([model,r]) => ({model, lengths:r.pinLengths})),
      notice: 'One switch; automatic request-time discovery. No hourly quota, maximum attempts or total probe duration. A disconnected client cancels its wait. Keys are not retained between requests. Model and length checks are compatibility checks, not proof of upstream identity.' };
  }
  cancel(reason = 'disabled') {
    this.generation++;
    for (const job of this.jobs.values()) { if (!job.controller.signal.aborted) { job.reason = reason; job.controller.abort(); } }
    if (reason === 'disabled' || reason === 'configuration_changed') this.cooldowns.clear();
  }
  block(reason, extra = {}) { this.totals.blocked++; return { allow:false, handled:true, action:'blocked', reason, ...extra }; }
  async ensure(ctx, headers, payload, requestPath, bytes, signal) {
    if (!this.enabled(ctx.model)) return {allow:true,handled:false,action:'disabled'};
    if (signal?.aborted) return {allow:false,handled:true,action:'cancelled',reason:'client_disconnected'};
    if (!ctx.id) return this.block('missing_binding');
    if (this.states.liveForPreflight(ctx)) { this.totals.cacheHits++; return {allow:true,handled:true,action:'cache_hit',attempts:0,waitMs:0}; }
    const started = Date.now(), generation = this.generation;
    const key = `${ctx.id}:${ctx.epoch}:${ctx.ruleSignature}:${generation}`;
    const cool = this.cooldowns.get(key);
    if (cool?.until > started) return this.block(cool.reason,{retryAfter:Math.ceil((cool.until-started)/1000)});
    if (this.waiters >= 8 || this.heldBytes + bytes > 64*1024*1024) return this.block('waiting_capacity');
    let job = this.jobs.get(key);
    if (!job) {
      if (this.jobs.size >= 2) return this.block('probe_capacity');
      const routing = identity(headers,payload);
      if (this.states.context(ctx.model,routing.headers,routing.payload).id !== ctx.id) return this.block('routing_identity_unavailable');
      const pub = { id:randomUUID(), model:ctx.model, bindingId:ctx.id, status:'probing', startedAt:started,
        attempts:0, mismatchCount:0, lengthMissCount:0, nextAttemptAt:null, lastResult:null };
      job = {public:pub,ctx,key,generation,waiters:0,controller:new AbortController(),reason:null};
      this.jobs.set(key,job); this.totals.starts++;
      this.journal.add({kind:'automatic',action:'started',model:ctx.model,jobId:pub.id,bindingId:ctx.id});
      // No timer and no budget file are consulted by this automatic pipeline.
      job.promise = this.run(job,routing,requestPath).catch(() => ({ok:false,reason:'internal_error'})).then(result => {
        pub.status = result.ok ? 'found' : result.reason; pub.finishedAt = Date.now(); pub.nextAttemptAt = null;
        if (!result.ok && !['disabled','client_disconnected','configuration_changed','service_stopped','binding_changed'].includes(result.reason)) {
          this.cooldowns.set(key,{reason:result.reason,until:Date.now()+60000});
          while(this.cooldowns.size>512)this.cooldowns.delete(this.cooldowns.keys().next().value);
        }
        this.recent.unshift({...pub}); this.recent = this.recent.slice(0,30);
        this.journal.add({kind:'automatic',action:pub.status,model:ctx.model,jobId:pub.id,attempts:pub.attempts});
        return result;
      }).finally(() => {
        this.jobs.delete(key);
        for (const name of Object.keys(routing.headers)) delete routing.headers[name]; routing.payload = null;
      });
    } else this.totals.joined++;
    this.waiters++; this.heldBytes += bytes; job.waiters++;
    let abort;
    try {
      const cancelled = new Promise(resolve => {
        abort = () => resolve({ok:false,reason:'client_disconnected'});
        signal?.addEventListener('abort',abort,{once:true}); if(signal?.aborted)abort();
      });
      const result = await Promise.race([job.promise,cancelled]);
      const detail = {jobId:job.public.id,attempts:job.public.attempts,waitMs:Date.now()-started};
      if (signal?.aborted) return {allow:false,handled:true,action:'cancelled',reason:'client_disconnected',...detail};
      // Turning off explicitly releases originals, even when immediately enabled again.
      if (job.reason === 'disabled' || !this.isEnabled()) return {allow:true,handled:false,action:'disabled',...detail};
      if (result.ok && generation===this.generation && this.enabled(ctx.model) && this.states.liveForPreflight(ctx)) return {allow:true,handled:true,action:'found',...detail};
      return this.block(result.ok?'binding_changed':result.reason,detail);
    } finally {
      signal?.removeEventListener('abort',abort); this.waiters--; this.heldBytes-=bytes; job.waiters--;
      if (!job.waiters && this.jobs.has(key)) {job.reason='client_disconnected';job.controller.abort();}
    }
  }
  async run(job,routing,requestPath) {
    const {ctx,public:p,controller}=job,signal=controller.signal;
    const endpoint=requestPath.startsWith('/v1/')?'/v1/responses':'/responses';
    while (!signal.aborted) {
      if (!this.enabled(ctx.model) || job.generation!==this.generation) return {ok:false,reason:job.reason||'disabled'};
      if (ctx.epoch!==(this.states.epochs.get(ctx.model)||0) || ctx.ruleSignature!==this.states.signature(ctx.model)) return {ok:false,reason:'configuration_changed'};
      p.status='probing';p.nextAttemptAt=null;p.attempts++;this.totals.attempts++;
      const out=await this.probe(this.config.target,ctx.model,routing,endpoint,ctx.rule.pinLengths,signal,15);
      if(signal.aborted)return {ok:false,reason:job.reason||'cancelled'};
      if(job.generation!==this.generation || !this.enabled(ctx.model))return {ok:false,reason:job.reason||'disabled'};
      p.lastResult={status:out.status,length:out.length,responseModel:out.responseModel,outcome:out.error||'candidate'};
      if(out.error==='model_mismatch')p.mismatchCount++;
      if(out.error==='length_miss')p.lengthMissCount++;
      this.journal.add({kind:'automatic',action:'attempt',jobId:p.id,model:ctx.model,attempt:p.attempts,...p.lastResult});
      if(!out.error && out.accepted && out.responseModel===ctx.model && out.state && ctx.rule.pinLengths.includes(out.length)) {
        if(!this.states.adoptProbe(ctx,out.state,out.responseModel))return {ok:false,reason:'binding_changed'};
        this.totals.found++;return {ok:true};
      }
      if(!(out.status>=200 && out.status<300 && ['model_mismatch','length_miss'].includes(out.error)))return {ok:false,reason:out.error||'not_accepted'};
      const ms=automaticBackoff(p.attempts);p.status='retrying';p.nextAttemptAt=Date.now()+ms;
      try {await this.sleep(ms,null,{signal});}catch {if(!signal.aborted)throw new Error('Retry wait failed');}
    }
    return {ok:false,reason:job.reason||'cancelled'};
  }
  async close() {this.closed=true;this.cancel('service_stopped');await Promise.allSettled([...this.jobs.values()].map(j=>j.promise));}
}
