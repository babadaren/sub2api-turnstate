import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { recordsPage } from '../lib/records-page.mjs';
import { makeConfig } from '../lib/config.mjs';
import { createExtension } from '../lib/server.mjs';

const sample = (count=105) => Array.from({length:count},(_,i)=>({id:`record-${i+1}`,time:'2026-09-19T00:00:00Z',kind:i%2?'state':'request',status:i%3?200:500}));
const params = value => new URLSearchParams(value);
const ids = rows => rows.map(r=>r.id);
const createPager = vm.runInNewContext(fs.readFileSync(new URL('../public/records.js',import.meta.url),'utf8')+'\ncreateRecordsPager;', { URLSearchParams });

test('default page has only the latest 20 records; all retained records are accessible beyond the old 100 cutoff',()=>{
  const rows=sample(), first=recordsPage(rows);
  assert.equal(first.records.length,20);assert.equal(first.pageSize,20);assert.equal(first.total,105);assert.equal(first.totalPages,6);
  assert.deepEqual(ids(first.records),ids(rows.slice(-20).reverse()));assert.equal(first.hasPrevious,false);assert.equal(first.hasNext,true);
  const all=[];
  for(let page=1;page<=6;page++)all.push(...recordsPage(rows,params({page:String(page),anchor:first.anchor})).records);
  assert.deepEqual(ids(all),ids([...rows].reverse()));assert.equal(new Set(ids(all)).size,105);
  const last=recordsPage(rows,params({page:'6'}));assert.equal(last.records.length,5);assert.equal(last.hasNext,false);assert.equal(last.rangeStart,101);assert.equal(last.rangeEnd,105);
});

test('empty, exact-page boundary and out-of-range page have correct totals and disabled controls',()=>{
  const empty=recordsPage([]);assert.equal(empty.page,1);assert.equal(empty.totalPages,1);assert.equal(empty.total,0);assert.equal(empty.rangeStart,0);assert.equal(empty.hasNext,false);
  assert.equal(recordsPage(sample(20)).hasNext,false);
  const out=recordsPage(sample(21),params({page:'9007199254740991'}));assert.equal(out.page,2);assert.equal(out.records.length,1);assert.equal(out.hasNext,false);
});

test('historical anchor prevents new arrivals shifting pages; ring eviction is explicit',()=>{
  const rows=sample(60), first=recordsPage(rows), query=params({page:'2',anchor:first.anchor});
  const expected=ids(recordsPage(rows,query).records);
  rows.push({id:'new-61',kind:'request',status:200},{id:'new-62',kind:'request',status:200});
  assert.deepEqual(ids(recordsPage(rows,query).records),expected);assert.equal(recordsPage(rows,query).total,60);
  assert.equal(recordsPage(rows).total,62);
  assert.throws(()=>recordsPage([{id:'new-63'}],query),error=>error.code==='records_snapshot_expired');
});

test('kind/status filtering and explicit legacy limits are preserved without mutating the journal',()=>{
  const rows=sample(), before=JSON.stringify(rows);
  const data=recordsPage(rows,params({kind:'request',status:'500',limit:'5',page:'2'}));
  const expected=rows.filter(r=>r.kind==='request'&&r.status===500).reverse();
  assert.equal(data.total,expected.length);assert.deepEqual(ids(data.records),ids(expected.slice(5,10)));
  assert.equal(recordsPage(sample(300),params({limit:'1000'})).pageSize,200);
  assert.equal(JSON.stringify(rows),before);
});

test('malformed page, limit and anchor are rejected safely',()=>{
  for(const key of ['page','limit'])for(const bad of ['0','-1','1.5','NaN','Infinity','1e3','9007199254740992',''])
    assert.throws(()=>recordsPage(sample(1),params({[key]:bad})),e=>e.code==='invalid_pagination');
  assert.throws(()=>recordsPage(sample(1),params({anchor:'../../secret'})),e=>e.code==='invalid_pagination');
});

function uiFixture(){
  let rows=sample();const calls=[],rendered=[],errors=[];
  const pager=createPager({fetchPage:async route=>{calls.push(route);return recordsPage(rows,new URL(route,'http://test').searchParams);},
    render:(records,state)=>{if(records!==null)rendered.push({records,state});},onError:e=>errors.push(e.message)});
  return {pager,calls,rendered,errors,setRows:value=>{rows=value;},get rows(){return rows;}};
}

test('UI defaults to 20, pages and jumps correctly, and historical polling does not fetch or jump',async()=>{
  const f=uiFixture();await f.pager.refresh();assert.equal(f.rendered.at(-1).records.length,20);assert.equal(f.pager.snapshot().live,true);
  await f.pager.next();assert.equal(f.pager.snapshot().page,2);assert.equal(f.pager.snapshot().live,false);
  const count=f.calls.length, expected=ids(f.rendered.at(-1).records);f.rows.push({id:'new-request'});
  await f.pager.refresh();assert.equal(f.calls.length,count);assert.deepEqual(ids(f.rendered.at(-1).records),expected);
  await f.pager.go(6);assert.equal(f.rendered.at(-1).records.length,5);await f.pager.next();assert.equal(f.pager.snapshot().page,6);
  await f.pager.previous();assert.equal(f.pager.snapshot().page,5);
  await f.pager.latest();assert.equal(f.pager.snapshot().page,1);assert.equal(f.pager.snapshot().live,true);assert.equal(f.rendered.at(-1).records[0].id,'new-request');
  for(const route of f.calls)assert.equal(new URL(route,'http://test').searchParams.get('limit'),'20');
});

test('expired page snapshots recover to latest with a visible message',async()=>{
  const f=uiFixture();await f.pager.refresh();f.setRows([{id:'replacement-record'}]);
  await f.pager.next();assert.equal(f.pager.snapshot().page,1);assert.equal(f.pager.snapshot().live,true);
  assert.equal(f.rendered.at(-1).records[0].id,'replacement-record');assert.equal(f.errors.length,1);
});

test('logout reset rejects a late page response, and overlapping clicks are not dispatched twice',async()=>{
  let resolve;const pending=new Promise(r=>resolve=r);const rendered=[],calls=[];
  const pager=createPager({fetchPage:route=>{calls.push(route);return pending;},render:(records,state)=>rendered.push({records,state}),onError:()=>{}});
  const a=pager.refresh(),b=pager.latest();assert.equal(calls.length,1);pager.reset();resolve(recordsPage(sample()));await Promise.all([a,b]);
  assert.equal(pager.snapshot().hasData,false);assert.equal(pager.snapshot().loading,false);assert.equal(pager.snapshot().page,1);
  assert.equal(rendered.filter(r=>r.records?.length).length,0);
});

test('a failed page load preserves the last successful page and restores controls',async()=>{
  let failed=false;const errors=[];
  const pager=createPager({fetchPage:async route=>{if(failed)throw new Error('network unavailable');return recordsPage(sample(),new URL(route,'http://test').searchParams);},render:()=>{},onError:e=>errors.push(e.message)});
  await pager.refresh();failed=true;await pager.next();assert.equal(pager.snapshot().page,1);assert.equal(pager.snapshot().loading,false);assert.equal(pager.snapshot().hasNext,true);assert.equal(errors[0],'network unavailable');
});

test('real admin API requires authentication and returns disjoint 20-entry pages while exposing pagination assets',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'records-pages-'));
  const {config}=makeConfig({password:'pagination-test-password!',mode:'off'});
  const app=await createExtension(config,home,{proxyPort:0,adminPort:0});
  config.adminPort=app.admin.address().port;config.adminOrigin=`http://127.0.0.1:${config.adminPort}`;
  t.after(async()=>{await app.close(100);fs.rmSync(home,{recursive:true,force:true});});
  app.journal.recent=sample(105);
  const base=config.adminOrigin;
  assert.equal((await fetch(base+'/api/records?page=2')).status,401);
  const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'pagination-test-password!'})});
  const cookie=login.headers.get('set-cookie').split(';')[0];await login.json();
  const get=route=>fetch(base+route,{headers:{cookie}});
  const first=await (await get('/api/records')).json();assert.equal(first.records.length,20);
  const second=await (await get('/api/records?page=2&anchor='+first.anchor)).json();assert.equal(second.records.length,20);assert.equal(second.page,2);
  assert.equal(ids(second.records).some(id=>ids(first.records).includes(id)),false);
  const last=await (await get('/api/records?page=6&anchor='+first.anchor)).json();assert.equal(last.hasNext,false);assert.equal(last.rangeEnd,106);
  assert.equal((await get('/api/records?page=0')).status,400);assert.equal((await get('/api/records?anchor=expired-anchor')).status,409);
  const html=await (await fetch(base)).text();for(const id of ['records-prev','records-next','records-latest','records-page','records-go'])assert.ok(html.includes(`id="${id}"`));
  assert.ok(html.indexOf('src="/records.js"')<html.indexOf('src="/app.js"'));
  const script=await fetch(base+'/records.js');assert.equal(script.status,200);assert.match(script.headers.get('content-type'),/javascript/);
  assert.match(await script.text(),/createRecordsPager/);assert.equal(app.automatic.totals.attempts,0);
});
