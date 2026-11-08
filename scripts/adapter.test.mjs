import test from 'node:test';
import assert from 'node:assert/strict';
import { context, parseResponse, fetchQueue, fetchMerged, runCoordinator } from './adapter.mjs';
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


test('only a matching, positively merged PR is accepted as irreversible evidence', () => {
 const ctx=context(env,event), reply=(n,merged)=>() => JSON.stringify({data:{repository:{pullRequest:{number:n,merged}}}});
 assert.equal(fetchMerged(ctx,2,null,reply(2,true)),true);
 assert.equal(fetchMerged(ctx,2,null,reply(2,false)),false);
 assert.equal(fetchMerged(ctx,2,null,reply(1,true)),false);
 assert.equal(fetchMerged(ctx,2,null,()=>JSON.stringify({errors:[{}],data:{repository:{pullRequest:{number:2,merged:true}}}})),false);
 assert.equal(fetchMerged(ctx,2,null,()=>{throw Error('unavailable')}),false);
});

test('witnessed prefix exits promptly only after its PR is confirmed merged', async () => {
 let now=0, queries=0;
 const ctx=context({...env,GITHUB_SHA:s(1)},{merge_group:{...event.merge_group,head_sha:s(1)}});
 const result=await runCoordinator(ctx,{
   fetch:()=>now<20?mk(2):mk(0),
   merged:(_ctx,pr)=>{ queries++; assert.equal(pr,1); return true; },
   clock:()=>now, sleep:async ms=>{now+=ms},
 });
 assert.deepEqual(result,{action:'obsolete',reason:'witnessed_pr_merged',pr:1});
 assert.equal(queries,1); assert.ok(now<ctx.config.deadlineMs);
});

test('transient missing candidate does not stop an unmerged PR', async () => {
 let now=0, queries=0;
 const ctx=context({...env,GITHUB_SHA:s(1)},{merge_group:{...event.merge_group,head_sha:s(1)}});
 const result=await runCoordinator(ctx,{
   fetch:()=>now<20 ? mk(2) : now<40 ? mk(0) : mk(1),
   merged:()=>{queries++; return false;}, clock:()=>now, sleep:async ms=>{now+=ms},
 });
 assert.equal(result.action,'run'); assert.equal(result.head,s(1)); assert.ok(queries>0);
});

test('no early exit for a PR identity seen only in an invalid snapshot', async () => {
 let now=0, queries=0;
 const ctx=context({...env,GITHUB_SHA:s(1)},{merge_group:{...event.merge_group,head_sha:s(1)}});
 await assert.rejects(runCoordinator(ctx,{
   fetch:()=>now<20?{...mk(2),hasNextPage:true}:mk(0),
   merged:()=>{queries++; return true;}, clock:()=>now, sleep:async ms=>{now+=ms},
 }),/stale/);
 assert.equal(queries,0); assert.equal(now,ctx.config.deadlineMs);
});

test('unavailable merged lookup cannot prove obsolete', async () => {
 let now=0,queries=0;
 const ctx=context({...env,GITHUB_SHA:s(1)},{merge_group:{...event.merge_group,head_sha:s(1)}});
 await assert.rejects(runCoordinator(ctx,{
   fetch:()=>now<20?mk(2):mk(0),
   merged:()=>{queries++; return false;}, clock:()=>now, sleep:async ms=>{now+=ms},
 }),/stale/);
 assert.ok(queries>0); assert.equal(now,ctx.config.deadlineMs);
});

test('same candidate SHA mapped to different PRs fails instead of replacing witness', async () => {
 let now=0;
 const ctx=context({...env,GITHUB_SHA:s(1)},{merge_group:{...event.merge_group,head_sha:s(1)}});
 await assert.rejects(runCoordinator(ctx,{
   fetch:()=>{const v=mk(2); if (now>=10) v.nodes[0].pr=7; return v;},
   merged:()=>true, clock:()=>now, sleep:async ms=>{now+=ms},
 }),/conflicting pull requests/);
});

test('obsolete CLI execution exits without writing a passing selection output', async () => {
  const {mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {spawnSync} = await import('node:child_process');
  const d=mkdtempSync(join(tmpdir(),'headgreen-obsolete-'));
  try {
    mkdirSync(join(d,'bin'));
    const result=nodes=>({data:{repository:{mergeQueue:{entries:{pageInfo:{hasNextPage:false},nodes}}}}});
    const nodes=[1,2].map(i=>({position:i,state:'AWAITING_CHECKS',solo:false,headCommit:{oid:s(i)},baseCommit:{oid:s(i-1)},pullRequest:{number:i}}));
    writeFileSync(join(d,'queue.json'),JSON.stringify(result(nodes)));
    writeFileSync(join(d,'empty.json'),JSON.stringify(result([])));
    writeFileSync(join(d,'merged.json'),JSON.stringify({data:{repository:{pullRequest:{number:1,merged:true}}}}));
    writeFileSync(join(d,'bin','gh'),`#!/bin/sh\ncase "$*" in *CandidatePR*) cat '${join(d,'merged.json')}';; *) if [ -f '${join(d,'called')}' ]; then cat '${join(d,'empty.json')}'; else touch '${join(d,'called')}'; cat '${join(d,'queue.json')}'; fi;; esac\n`,{mode:0o755});
    writeFileSync(join(d,'event.json'),JSON.stringify({merge_group:{...event.merge_group,head_sha:s(1)}}));
    const output=join(d,'out');
    const response=spawnSync(process.execPath,[new URL('./adapter.mjs',import.meta.url).pathname],{env:{...process.env,...env,GITHUB_SHA:s(1),GITHUB_EVENT_PATH:join(d,'event.json'),GITHUB_OUTPUT:output,DEADLINE_MS:'5000',DEBOUNCE_MS:'5',POLL_MS:'5',PATH:`${join(d,'bin')}:${process.env.PATH}`},encoding:'utf8',timeout:10000});
    assert.equal(response.status,1); assert.match(response.stderr,/obsolete/); assert.equal(existsSync(output),false);
  } finally { rmSync(d,{recursive:true,force:true}); }
});

test('revalidate CLI checks merged predecessor evidence after queue positions shift', async () => {
  const {mkdtempSync, mkdirSync, writeFileSync, rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {spawnSync} = await import('node:child_process');
  const {inspectSnapshot} = await import('./coordinator.mjs');
  const d=mkdtempSync(join(tmpdir(),'headgreen-revalidate-'));
  try {
    mkdirSync(join(d,'bin'));
    const original=mk(3); const signature=inspectSnapshot(original,{buildLimit:3,mergeLimit:3}).signature;
    const remaining={position:1,state:'AWAITING_CHECKS',solo:false,headCommit:{oid:s(3)},baseCommit:{oid:s(2)},pullRequest:{number:3}};
    writeFileSync(join(d,'queue.json'),JSON.stringify({data:{repository:{mergeQueue:{entries:{pageInfo:{hasNextPage:false},nodes:[remaining]}}}}}));
    for (const pr of [1,2]) writeFileSync(join(d,`pr${pr}.json`),JSON.stringify({data:{repository:{pullRequest:{number:pr,merged:true,mergeCommit:{oid:s(pr)}}}}}));
    writeFileSync(join(d,'bin','gh'),`#!/bin/sh\ncase "$*" in *CandidatePR*number=1*) cat '${join(d,'pr1.json')}';; *CandidatePR*number=2*) cat '${join(d,'pr2.json')}';; *) cat '${join(d,'queue.json')}';; esac\n`,{mode:0o755});
    writeFileSync(join(d,'event.json'),JSON.stringify({merge_group:{...event.merge_group,head_sha:s(3)}}));
    const run=() => spawnSync(process.execPath,[new URL('./adapter.mjs',import.meta.url).pathname,'--revalidate'],{env:{...process.env,...env,GITHUB_SHA:s(3),GITHUB_EVENT_PATH:join(d,'event.json'),GITHUB_OUTPUT:join(d,'out'),ELECTED_SIGNATURE_BASE64:Buffer.from(signature).toString('base64'),PATH:`${join(d,'bin')}:${process.env.PATH}`},encoding:'utf8',timeout:10000});
    assert.equal(run().status,0);
    writeFileSync(join(d,'pr2.json'),JSON.stringify({data:{repository:{pullRequest:{number:2,merged:false}}}}));
    assert.equal(run().status,1);
  } finally { rmSync(d,{recursive:true,force:true}); }
});

test('shifted candidate requires each merged predecessor commit to equal its tested queue SHA', () => {
 const ctx=context(env,event), reply=(oid)=>() => JSON.stringify({data:{repository:{pullRequest:{number:2,merged:true,mergeCommit:{oid}}}}});
 assert.equal(fetchMerged(ctx,2,s(2),reply(s(2))),true);
 assert.equal(fetchMerged(ctx,2,s(2),reply(s(9))),false);
 assert.equal(fetchMerged(ctx,2,s(2),reply(null)),false);
});
