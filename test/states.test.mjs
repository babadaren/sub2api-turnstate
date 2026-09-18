import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore, validateRules, defaultRules } from '../lib/states.mjs';
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(),'turnstate-model-test-')); let now = 1_800_000_000_000;
  const store = new StateStore(home,'test-salt',()=>{},()=>now);
  t.after(()=>{store.flush();fs.rmSync(home,{recursive:true,force:true});});
  const ctx = (model='gpt-6-astra', h={})=>store.context(model,{authorization:'Bearer private',session_id:'session',...h});
  return {store,home,ctx,tick:ms=>{now+=ms;}};
}
test('local refresh countdown expires; identical responses do not extend the timer forever',t=>{
  const {store,ctx,tick}=fixture(t);store.decide(ctx(),'A'.repeat(292),'response','pin');
  tick(200000);store.decide(ctx(),'A'.repeat(292),'response','pin');assert.equal(store.snapshot().pins[0].remainingSeconds,100);
  tick(101000);const d=store.decide(ctx(),'A'.repeat(292),'request','pin');assert.equal(d.action,'refresh_wait_response');assert.equal(d.outgoingLength,0);
  assert.equal(store.snapshot().pins[0].remainingSeconds,0);
  store.decide(ctx(),'B'.repeat(292),'response','pin');assert.equal(store.snapshot().pins[0].remainingSeconds,300);
});
test('manual refresh invalidates already in-flight responses and never seeds from request headers',t=>{
  const {store,ctx}=fixture(t);const old=ctx();store.decide(old,'A'.repeat(292),'response','pin');
  store.refresh({model:'gpt-6-astra'});store.decide(old,'B'.repeat(292),'response','pin');assert.equal(store.snapshot().pins[0].status,'waiting_response');
  store.decide(ctx(),'C'.repeat(292),'request','pin');assert.equal(store.snapshot().pins[0].status,'waiting_response');
  store.decide(ctx(),'D'.repeat(292),'response','pin');assert.equal(store.reveal(store.snapshot().pins[0].id).state,'D'.repeat(292));
});
test('manual pin validation and scoped values survive process reload; secrets do not enter snapshots',t=>{
  const {store,ctx,home}=fixture(t);store.decide(ctx(),'A'.repeat(292),'response','observe');const id=store.snapshot().pins[0].id;
  assert.throws(()=>store.manual(id,'B'.repeat(280)));store.manual(id,'B'.repeat(292));store.flush();
  const reopened=new StateStore(home,'test-salt',()=>{},()=>1_800_000_000_000);assert.equal(reopened.reveal(id).state,'B'.repeat(292));
  const disk=fs.readFileSync(path.join(home,'states.json'),'utf8');assert.equal(disk.includes('Bearer private'),false);
  assert.equal(JSON.stringify(store.snapshot()).includes('B'.repeat(292)),false);assert.equal(fs.statSync(path.join(home,'states.json')).mode&0o077,0);
});
test('turn scope bypasses missing identities, scopes explicit turns, and invalidates on rule changes',t=>{
  const {store,ctx}=fixture(t);let rules=defaultRules();rules['gpt-6-astra'].scope='turn';store.configure(rules);
  assert.equal(ctx().id,null);assert.notEqual(ctx('gpt-6-astra',{'x-codex-turn-id':'t1'}).id,ctx('gpt-6-astra',{'x-codex-turn-id':'t2'}).id);
  store.decide(ctx('gpt-6-astra',{'x-codex-turn-id':'t1'}),'A'.repeat(292),'response','pin');assert.equal(store.snapshot().pins.length,1);
  rules['gpt-6-astra'].pinLengths=[280];store.configure(rules);assert.equal(store.snapshot().pins.length,0);
});
test('unconfigured models are not assigned the astra length; opt-in autolearn is response-only',t=>{
  const {store,ctx}=fixture(t);let rules=defaultRules();rules['gpt-5.6-sol'].enabled=true;rules['gpt-5.6-sol'].autoLearn=true;store.configure(rules);
  store.decide(ctx('gpt-5.6-sol'),'S'.repeat(280),'request','pin');assert.equal(store.snapshot().pins.length,0);
  store.decide(ctx('gpt-5.6-sol'),'S'.repeat(280),'response','pin');assert.equal(store.snapshot().pins[0].length,280);
  const d=store.decide(ctx('totally-new'),'Q'.repeat(312),'request','pin');assert.equal(d.remove,false);
});
test('invalid rules and poisoned non-ASCII / duplicate states cannot create replay bindings',t=>{
  const {store,ctx}=fixture(t);const rules=defaultRules();rules['gpt-6-astra'].discardLengths=[292];assert.throws(()=>validateRules(rules));
  for(const value of ['\r\n'.repeat(146),['A'.repeat(292)],'中'.repeat(292),'A'.repeat(9000)])store.decide(ctx(),value,'response','pin');
  assert.equal(store.snapshot().pins.length,0);
  assert.throws(()=>validateRules(JSON.parse('{"__proto__":{}}')));
});
