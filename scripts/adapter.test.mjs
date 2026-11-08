import test from 'node:test';
import assert from 'node:assert/strict';
import { context, parseResponse, fetchQueue, runCoordinator } from './adapter.mjs';
const s = n => n.toString(16).padStart(40,'0');
const env = {GITHUB_REPOSITORY:'owner/repo',GITHUB_EVENT_NAME:'merge_group',GITHUB_SHA:s(2),GH_TOKEN:'redacted',GITHUB_OUTPUT:'/tmp/out',BUILD_LIMIT:'3',MERGE_LIMIT:'3',DEBOUNCE_MS:'10',DEADLINE_MS:'100',POLL_MS:'5'};
const event = {merge_group:{base_ref:'refs/heads/main',head_sha:s(2)}};
const mk = n => ({hasNextPage:false,nodes:Array.from({length:n},(_,i)=>({position:i+1,pr:i+1,head:s(i+1),base:s(i),solo:false,state:'AWAITING_CHECKS'}))});
const simulate = (ctx, fn) => { let now=0, calls=0; return runCoordinator(ctx,{fetch:() => fn(++calls,now),clock:()=>now,sleep:async ms=>{now+=ms}}); };
test('binds exact event SHA and explicit configuration', () => { assert.equal(context(env,event).branch,'main'); assert.throws(()=>context({...env,GITHUB_SHA:s(3)},event)); assert.throws(()=>context({...env,BUILD_LIMIT:''},event)); assert.throws(()=>context({...env,GH_TOKEN:''},event)); });
test('rejects API errors and malformed response rather than treating them as empty queue', () => { assert.equal(parseResponse({errors:[{message:'denied'}]}),null); assert.equal(parseResponse({data:{repository:{mergeQueue:null}}}),null); assert.equal(fetchQueue(context(env,event),()=>{throw Error('denied')}),null); });
test('normalizes queue nodes and pagination', () => { assert.deepEqual(parseResponse({data:{repository:{mergeQueue:{entries:{pageInfo:{hasNextPage:false},nodes:[{position:1,state:'QUEUED',solo:false,pullRequest:{number:9},baseCommit:null,headCommit:null}]}}}}}),{hasNextPage:false,nodes:[{position:1,pr:9,head:null,base:null,state:'QUEUED',solo:false}]}); });
test('polls until stable before electing head', async () => { const result=await simulate(context(env,event),()=>mk(2)); assert.equal(result.action,'run'); assert.equal(result.head,s(2)); });
test('prefix keeps polling until promotion after removal', async () => { const ctx=context({...env,GITHUB_SHA:s(1)},{merge_group:{...event.merge_group,head_sha:s(1)}}); const result=await simulate(ctx,(_,now)=>mk(now < 30 ? 2 : 1)); assert.equal(result.action,'run'); assert.equal(result.head,s(1)); });
test('prefix timeout falls back to fresh test, never false success', async () => { const ctx=context({...env,GITHUB_SHA:s(1)},{merge_group:{...event.merge_group,head_sha:s(1)}}); const result=await simulate(ctx,()=>mk(2)); assert.equal(result.action,'fallback'); assert.equal(result.reason,'prefix_deadline'); });
test('API outage falls back to fresh test at deadline', async () => { const result=await simulate(context(env,event),()=>null); assert.equal(result.action,'fallback'); });
test('removed event remains stale after deadline and exits with error', async () => { await assert.rejects(simulate(context(env,event),()=>mk(1)),/stale/); });

test('CLI executes through a symlinked script path and writes election outputs', async () => {
  const {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {execFileSync} = await import('node:child_process');
  const d=mkdtempSync(join(tmpdir(),'headgreen-cli-'));
  try {
    mkdirSync(join(d,'bin'));
    const result={data:{repository:{mergeQueue:{entries:{pageInfo:{hasNextPage:false},nodes:[1,2].map(i=>({position:i,state:'AWAITING_CHECKS',solo:false,headCommit:{oid:s(i)},baseCommit:{oid:s(i-1)},pullRequest:{number:i}}))}}}}};
    writeFileSync(join(d,'api.json'),JSON.stringify(result));
    writeFileSync(join(d,'bin','gh'),`#!/bin/sh\ncat '${join(d,'api.json')}'\n`,{mode:0o755});
    writeFileSync(join(d,'event.json'),JSON.stringify(event));
    // A symlink reproduces macOS /tmp versus /private/tmp script path resolution.
    symlinkSync(new URL('./adapter.mjs',import.meta.url).pathname,join(d,'linked-adapter.mjs'));
    const output=join(d,'out');
    execFileSync(process.execPath,[join(d,'linked-adapter.mjs')],{env:{...process.env,...env,GITHUB_EVENT_PATH:join(d,'event.json'),GITHUB_OUTPUT:output,DEADLINE_MS:'5000',DEBOUNCE_MS:'5',POLL_MS:'5',PATH:`${join(d,'bin')}:${process.env.PATH}`},timeout:10000});
    assert.match(readFileSync(output,'utf8'),/run_test=true\nelection=run\n/);
  } finally { rmSync(d,{recursive:true,force:true}); }
});
