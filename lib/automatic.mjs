import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { identity, probeOnce } from './probe-transport.mjs';

// Resource protections are not attempt quotas. Renewal never changes an old
// pin's expiry merely because a timer fired or the same state was returned.
export const automaticBackoff = misses => Math.min(30000, 2000 * 2 ** Math.min(4, Math.floor(Math.max(0, misses - 1) / 5)));
export const renewalLeadMs = pin => Math.min(600000, Math.max(0, Math.floor((pin.expiresAt - pin.capturedAt) / 3)));
export const renewalAt = pin => pin.expiresAt - renewalLeadMs(pin);
const wipe = routing => { if (!routing) return; for (const key of Object.keys(routing.headers)) delete routing.headers[key]; routing.payload = null; };
const cancelledReasons = new Set(['disabled','client_disconnected','configuration_changed','service_stopped','binding_changed']);

export class AutomaticGate {
  constructor(config, states, journal, isEnabled, options = {}) {
    Object.assign(this, { config, states, journal, isEnabled });
    this.probe = options.probe || probeOnce;
    this.sleep = options.sleep || delay;
    this.now = options.now || (() => states.now());
    this.jobs = new Map(); this.cooldowns = new Map(); this.recent = [];
    // This private map is NEVER serialized: only allowlisted routing identity,
    // no original request body, Cookie, prompt or API key on disk/in snapshots.
    this.renewals = new Map();
    this.waiters = 0; this.heldBytes = 0; this.generation = 0; this.closed = false;
    this.totals = { cacheHits:0, starts:0, attempts:0, found:0, joined:0, blocked:0, renewalStarts:0, renewed:0 };
    this.timer = options.scheduler === false ? null : setInterval(() => {
      try { this.tick(); } catch { journal.add({kind:'automatic',action:'renewal_scheduler_error'}); }
    }, 1000);
    this.timer?.unref();
  }
  enabled(model) {
    const rule = this.states.rules[model];
    return !this.closed && this.isEnabled() && !!rule?.enabled && !!rule.pinLengths.length;
  }
  current(ctx) {
    return this.enabled(ctx.model) && ctx.epoch === (this.states.epochs.get(ctx.model) || 0) && ctx.ruleSignature === this.states.signature(ctx.model);
  }
  key(ctx) { return `${ctx.id}:${ctx.epoch}:${ctx.ruleSignature}:${this.generation}`; }
  forget(id) { const slot = this.renewals.get(id); if (slot) { wipe(slot.routing); this.renewals.delete(id); } }
  remember(ctx, headers, payload, requestPath) {
    if (!this.current(ctx) || !this.states.liveForPreflight(ctx)) return false;
    const routing = identity(headers, payload);
    if (this.states.context(ctx.model, routing.headers, routing.payload).id !== ctx.id) { wipe(routing); return false; }
    const old = this.renewals.get(ctx.id);
    const slot = { ctx:structuredClone(ctx), routing, requestPath:requestPath.startsWith('/v1/')?'/v1/responses':'/responses',
      lastSeen:this.now(), retryAt:old?.retryAt || 0, lastError:old?.lastError || null };
    if (old) wipe(old.routing);
    this.renewals.delete(ctx.id); this.renewals.set(ctx.id, slot);
    while (this.renewals.size > 128) this.forget(this.renewals.keys().next().value);
    return true;
  }
  renewalSnapshot() {
    const now = this.now();
    return [...this.states.pins.values()].map(pin => {
      const slot = this.renewals.get(pin.id), job = slot && this.jobs.get(this.key(slot.ctx));
      const usable = !pin.pending && pin.verifiedModel === pin.model;
      let status = !this.enabled(pin.model) ? 'disabled' : !usable ? 'waiting_request' : !slot ? 'waiting_credentials' :
        job ? 'renewing' : slot.retryAt > now ? 'error_backoff' : 'scheduled';
      return { bindingId:pin.id, model:pin.model, status, refreshAt:usable ? renewalAt(pin) : null,
        expiresAt:pin.expiresAt, credentialsReady:!!slot, nextRetryAt:slot?.retryAt || null,
        lastError:slot?.lastError || null, oldValueExpired:pin.pending || pin.expiresAt <= now };
    });
  }
  snapshot() {
    return { enabled:this.isEnabled(), activeJobs:[...this.jobs.values()].map(j => ({...j.public,waiters:j.waiters})),
      recent:this.recent.map(j => ({...j})), waitingRequests:this.waiters, totals:{...this.totals},
      renewals:this.renewalSnapshot(), serverTime:this.now(), renewalLeadSeconds:600,
      eligibleModels:Object.entries(this.states.rules).filter(([,r]) => r.enabled && r.pinLengths.length).map(([model,r]) => ({model,lengths:r.pinLengths})),
      notice:'One switch. Renew 10 minutes before a one-hour local expiry; old valid state remains usable until replacement or expiry. Routing credentials are memory-only and cleared on stop/restart; first matching traffic re-arms renewal. Length/model checks are not proof of upstream validity.' };
  }
  cancel(reason = 'disabled') {
    this.generation++;
    for (const job of this.jobs.values()) if (!job.controller.signal.aborted) { job.reason=reason; job.controller.abort(); }
    for (const id of [...this.renewals.keys()]) this.forget(id);
    if (reason === 'disabled' || reason === 'configuration_changed') this.cooldowns.clear();
  }
  block(reason, extra = {}) { this.totals.blocked++; return {allow:false,handled:true,action:'blocked',reason,...extra}; }
  tick() {
    if (this.closed || !this.isEnabled()) return;
    for (const [id,slot] of this.renewals) {
      if (!this.current(slot.ctx)) { this.forget(id); continue; }
      const pin = this.states.pins.get(id);
      if (!pin || pin.pending || pin.verifiedModel !== slot.ctx.model) { this.forget(id); continue; }
      if (this.jobs.has(this.key(slot.ctx)) || this.now() < renewalAt(pin) || this.now() < slot.retryAt) continue;
      if (this.jobs.size >= 2) continue; // rescan next tick, without a duplicate job
      const routing = identity(slot.routing.headers, slot.routing.payload);
      this.launch(slot.ctx, routing, slot.requestPath, 'renewal');
    }
  }
  launch(ctx, routing, requestPath, purpose) {
    const key=this.key(ctx), started=this.now();
    const pub={id:randomUUID(),model:ctx.model,bindingId:ctx.id,purpose,status:'probing',startedAt:started,
      attempts:0,mismatchCount:0,lengthMissCount:0,unchangedCount:0,nextAttemptAt:null,lastResult:null};
    const basePin=this.states.pins.get(ctx.id);
    const job={public:pub,ctx,key,generation:this.generation,waiters:0,controller:new AbortController(),reason:null,
      background:purpose==='renewal',basePin,baseExpiresAt:basePin?.expiresAt,basePending:basePin?.pending};
    this.jobs.set(key,job);this.totals.starts++;if(job.background)this.totals.renewalStarts++;
    this.journal.add({kind:'automatic',action:job.background?'renewal_started':'started',purpose,model:ctx.model,jobId:pub.id,bindingId:ctx.id});
    job.promise=this.run(job,routing,requestPath).catch(()=>({ok:false,reason:'internal_error'})).then(result=>{
      pub.status=result.ok?(result.reused?'superseded':job.background?'renewed':'found'):result.reason;
      pub.finishedAt=this.now();pub.nextAttemptAt=null;
      if(result.ok && job.generation===this.generation && this.current(ctx)) {
        if(!this.renewals.has(ctx.id))this.remember(ctx,routing.headers,routing.payload,requestPath);
        const slot=this.renewals.get(ctx.id);if(slot){slot.retryAt=0;slot.lastError=null;}
        this.cooldowns.delete(key);
      } else if(!result.ok && !cancelledReasons.has(result.reason) && job.generation===this.generation) {
        const until=this.now()+Math.max(60000,result.retryAfterMs||0);
        this.cooldowns.set(key,{reason:result.reason,until});
        while(this.cooldowns.size>512)this.cooldowns.delete(this.cooldowns.keys().next().value);
        const slot=this.renewals.get(ctx.id);
        if(slot){slot.retryAt=until;slot.lastError=result.reason;}
        // Do not repeatedly reuse credentials rejected by upstream. Existing pin
        // is untouched; a subsequent real request is needed to re-arm this slot.
        if(['http_401','http_403'].includes(result.reason))this.forget(ctx.id);
      }
      this.recent.unshift({...pub});this.recent=this.recent.slice(0,30);
      this.journal.add({kind:'automatic',action:pub.status,purpose,model:ctx.model,jobId:pub.id,attempts:pub.attempts});
      return result;
    }).finally(()=>{this.jobs.delete(key);wipe(routing);});
    return job;
  }
  async ensure(ctx, headers, payload, requestPath, bytes, signal) {
    if(!this.enabled(ctx.model))return {allow:true,handled:false,action:'disabled'};
    if(signal?.aborted)return {allow:false,handled:true,action:'cancelled',reason:'client_disconnected'};
    if(!ctx.id)return this.block('missing_binding');
    if(this.states.liveForPreflight(ctx)) {
      this.remember(ctx,headers,payload,requestPath);this.totals.cacheHits++;
      return {allow:true,handled:true,action:'cache_hit',attempts:0,waitMs:0};
    }
    const started=this.now(),generation=this.generation,key=this.key(ctx),cool=this.cooldowns.get(key);
    if(cool?.until>started)return this.block(cool.reason,{retryAfter:Math.ceil((cool.until-started)/1000)});
    if(this.waiters>=8 || this.heldBytes+bytes>64*1024*1024)return this.block('waiting_capacity');
    let job=this.jobs.get(key);
    if(!job) {
      if(this.jobs.size>=2)return this.block('probe_capacity');
      const routing=identity(headers,payload);
      if(this.states.context(ctx.model,routing.headers,routing.payload).id!==ctx.id){wipe(routing);return this.block('routing_identity_unavailable');}
      job=this.launch(ctx,routing,requestPath,'discovery');
    } else this.totals.joined++;
    this.waiters++;this.heldBytes+=bytes;job.waiters++;
    let abort;
    try {
      const cancelled=new Promise(resolve=>{abort=()=>resolve({ok:false,reason:'client_disconnected'});signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});
      const result=await Promise.race([job.promise,cancelled]);
      const detail={jobId:job.public.id,attempts:job.public.attempts,waitMs:this.now()-started};
      if(signal?.aborted)return {allow:false,handled:true,action:'cancelled',reason:'client_disconnected',...detail};
      if(job.reason==='disabled'||!this.isEnabled())return {allow:true,handled:false,action:'disabled',...detail};
      if(result.ok && generation===this.generation && this.enabled(ctx.model) && this.states.liveForPreflight(ctx))return {allow:true,handled:true,action:'found',...detail};
      return this.block(result.ok?'binding_changed':result.reason,detail);
    } finally {
      signal?.removeEventListener('abort',abort);this.waiters--;this.heldBytes-=bytes;job.waiters--;
      if(!job.waiters && !job.background && this.jobs.has(key)){job.reason='client_disconnected';job.controller.abort();}
    }
  }
  replacementStatus(job) {
    const current=this.states.pins.get(job.ctx.id);
    if(current!==job.basePin)return this.states.liveForPreflight(job.ctx)?{ok:true,reused:true}:{ok:false,reason:'binding_changed'};
    if(current && (current.expiresAt!==job.baseExpiresAt || current.pending!==job.basePending))return {ok:false,reason:'binding_changed'};
    return null;
  }
  async run(job,routing,requestPath) {
    const {ctx,public:p,controller}=job,signal=controller.signal;
    const endpoint=requestPath.startsWith('/v1/')?'/v1/responses':'/responses';
    while(!signal.aborted) {
      if(!this.current(ctx)||job.generation!==this.generation)return {ok:false,reason:job.reason||'configuration_changed'};
      let replacement=this.replacementStatus(job);if(replacement)return replacement;
      p.status='probing';p.nextAttemptAt=null;p.attempts++;this.totals.attempts++;
      const out=await this.probe(this.config.target,ctx.model,routing,endpoint,ctx.rule.pinLengths,signal,15);
      if(signal.aborted)return {ok:false,reason:job.reason||'cancelled'};
      if(!this.current(ctx)||job.generation!==this.generation)return {ok:false,reason:job.reason||'configuration_changed'};
      replacement=this.replacementStatus(job);if(replacement)return replacement;
      const qualified=!out.error&&out.accepted&&out.responseModel===ctx.model&&out.state&&ctx.rule.pinLengths.includes(out.length);
      // Re-issuing the same opaque value does not prove renewed upstream expiry.
      const unchanged=qualified&&job.basePin?.state===out.state;
      const outcome=unchanged?'unchanged_state':out.error||'candidate';
      p.lastResult={status:out.status,length:out.length,responseModel:out.responseModel,outcome};
      if(outcome==='model_mismatch')p.mismatchCount++;
      if(outcome==='length_miss')p.lengthMissCount++;
      if(unchanged)p.unchangedCount++;
      this.journal.add({kind:'automatic',action:job.background?'renewal_attempt':'attempt',purpose:p.purpose,jobId:p.id,model:ctx.model,attempt:p.attempts,...p.lastResult});
      if(qualified&&!unchanged) {
        // No await between compare and replace: a late probe cannot overwrite a
        // newer pin, and a concurrent old request cannot roll this pin back.
        if(!this.states.adoptProbe(ctx,out.state,out.responseModel))return {ok:false,reason:'binding_changed'};
        if(job.background)this.states.pins.get(ctx.id).source='renewal';
        this.states.flush();this.totals.found++;if(job.background)this.totals.renewed++;
        return {ok:true};
      }
      if(!(out.status>=200&&out.status<300&&['model_mismatch','length_miss','unchanged_state'].includes(outcome)))return {ok:false,reason:out.error||'not_accepted',retryAfterMs:out.retryAfterMs};
      const ms=automaticBackoff(p.attempts);p.status='retrying';p.nextAttemptAt=this.now()+ms;
      try{await this.sleep(ms,null,{signal});}catch{if(!signal.aborted)throw new Error('Retry wait failed');}
    }
    return {ok:false,reason:job.reason||'cancelled'};
  }
  async close() {
    this.closed=true;clearInterval(this.timer);this.timer=null;this.cancel('service_stopped');
    await Promise.allSettled([...this.jobs.values()].map(j=>j.promise));
  }
}
