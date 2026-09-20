#!/usr/bin/env node
// Explicit offline migration for an operator requesting model-wide sharing.
// Run only after stopping the service; never print credentials or raw states.
import path from 'node:path';
import fs from 'node:fs';
import {parseArgs} from 'node:util';
import {loadConfig} from '../lib/config.mjs';
import {StateStore} from '../lib/states.mjs';
const {values}=parseArgs({options:{home:{type:'string',default:'/var/lib/sub2api-turnstate'},apply:{type:'boolean',default:false}},strict:true});
const home=path.resolve(values.home);
if(!fs.existsSync(path.join(home,'config.json')))throw new Error('Expected an existing service configuration');
const config=loadConfig(home),store=new StateStore(home,config.logSalt),rules=structuredClone(store.rules);
for(const rule of Object.values(rules)){
  rule.scope='model';
  if(rule.ttlSeconds===300)rule.ttlSeconds=3600;
}
const preview={apply:values.apply,notice:'Model-wide sharing spans client keys. Keep this disabled on incompatible upstream account pools.',
  rules:Object.fromEntries(Object.entries(rules).map(([m,r])=>[m,{enabled:r.enabled,scope:r.scope,ttlSeconds:r.ttlSeconds}]))};
if(values.apply){
  const before=store.pins.size;preview.changed=store.configure(rules);store.flush();
  if(store.persistError)throw new Error('Migrated states were not persisted; restore the backup before starting');
  preview.pinsBefore=before;preview.pinsAfter=store.pins.size;
  preview.pins=[...store.pins.values()].map(p=>({model:p.model,scope:p.scope,length:p.length,fingerprint:p.fingerprint,capturedAt:p.capturedAt,expiresAt:p.expiresAt}));
}
console.log(JSON.stringify(preview));
