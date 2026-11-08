import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSnapshot, decide, revalidate } from './coordinator.mjs';
const s = n => n.toString(16).padStart(40, '0');
const cfg = { buildLimit: 3, mergeLimit: 3, debounceMs: 10, deadlineMs: 100 };
const entries = n => Array.from({length:n}, (_, i) => ({ position:i+1, pr:i+1, head:s(i+1), base:s(i), solo:false, state:'AWAITING_CHECKS' }));
const snap = nodes => ({ nodes, hasNextPage:false });
const call = (nodes, pr, overrides = {}) => decide({ snapshot:snap(nodes), eventSha:s(pr), nowMs:0, startedAtMs:0, config:cfg, ...overrides });
const stabilize = (nodes, pr, overrides={}) => {
  const a = call(nodes, pr, overrides);
  return call(nodes, pr, {...overrides, nowMs:10, priorSignature:a.signature, stableSinceMs:a.stableSinceMs});
};
test('singleton elects itself only after debounce', () => { assert.equal(call(entries(1),1).action,'wait'); assert.equal(stabilize(entries(1),1).action,'run'); });
test('one of three heads runs, others remain pending', () => { for (let n=1;n<=2;n++) assert.equal(stabilize(entries(3),n).action,'defer'); assert.equal(stabilize(entries(3),3).action,'run'); });
test('unbuilt suffix beyond build limit is not elected', () => { const q=entries(3).concat([4,5].map(n => ({position:n,pr:n,head:null,base:null,solo:false,state:'QUEUED'}))); assert.equal(stabilize(q,3).action,'run'); assert.equal(inspectSnapshot(snap(q),cfg).head,s(3)); });
test('max merge count bounds election even when more heads built', () => { const config={...cfg,buildLimit:5}; const q=entries(5); assert.equal(stabilize(q,3,{config}).action,'run'); assert.equal(stabilize(q,5,{config}).reason,'event_outside_first_group'); });
test('solo starts a separate group and never pulls in prior entries', () => { const q=entries(3); q[1].solo=true; assert.equal(stabilize(q,1).action,'run'); assert.equal(stabilize(q,2).reason,'event_outside_first_group'); });
test('queue additions reset debounce and re-election', () => { const old=call(entries(2),2); const next=call(entries(3),2,{nowMs:10,priorSignature:old.signature,stableSinceMs:old.stableSinceMs}); assert.equal(next.action,'wait'); assert.equal(next.stableSinceMs,10); assert.equal(call(entries(3),2,{nowMs:20,priorSignature:next.signature,stableSinceMs:10}).action,'defer'); });
test('removed or replaced candidate never gets a successful result', () => { assert.equal(call(entries(2),3).action,'wait'); assert.equal(call(entries(2),3,{nowMs:100}).action,'stale'); const q=entries(3); const elected=stabilize(q,3); q.pop(); assert.equal(revalidate({snapshot:snap(q),eventSha:s(3),electedSignature:elected.signature,config:cfg}),false); });
test('unchanged membership permits revalidation; changed prefix does not', () => { const q=entries(3), elected=stabilize(q,3); assert.ok(revalidate({snapshot:snap(q),eventSha:s(3),electedSignature:elected.signature,config:cfg})); q[0].pr=9; assert.equal(revalidate({snapshot:snap(q),eventSha:s(3),electedSignature:elected.signature,config:cfg}),false); });
test('API error cannot be successful; deadline requires actual fresh suite', () => { assert.equal(call(null,1,{snapshot:null}).action,'wait'); assert.equal(call(null,1,{snapshot:null,nowMs:100}).action,'fallback'); });
test('deadline for deferred prefix requires actual fresh suite', () => { const q=entries(3); assert.equal(call(q,1,{nowMs:100}).action,'fallback'); });
test('empty queue can be transient; marks stale only at deadline', () => { assert.equal(call([],1).action,'wait'); assert.equal(call([],1,{nowMs:100}).action,'stale'); });
test('incomplete page, invalid positions, duplicate PRs and malformed SHA fail closed', () => { const a=entries(2); a[1].position=3; assert.equal(inspectSnapshot(snap(a),cfg).reason,'invalid_entry'); const b=entries(2); b[1].pr=1; assert.equal(inspectSnapshot(snap(b),cfg).reason,'duplicate_pr'); const c=entries(2); c[1].head='oops'; assert.equal(inspectSnapshot(snap(c),cfg).reason,'invalid_candidate_sha'); assert.equal(inspectSnapshot({nodes:entries(1),hasNextPage:true},cfg).reason,'incomplete_snapshot'); });
test('inconsistent parent chain and unbuilt hole are rejected', () => { const a=entries(2); a[1].base=s(20); assert.equal(inspectSnapshot(snap(a),cfg).reason,'inconsistent_chain'); const b=entries(3); b[1]={...b[1],head:null,base:null,state:'QUEUED'}; assert.equal(inspectSnapshot(snap(b),cfg).reason,'buildable_candidate_not_ready'); });
test('unknown or invalid configuration is an error and never a pass', () => { assert.equal(call(entries(1),1,{config:{...cfg,buildLimit:null}}).action,'error'); assert.equal(call(entries(1),1,{eventSha:'bad'}).action,'error'); });
test('locked state remains unstable; failed prefixes do not prevent head election', () => { const q=entries(2); q[0].state='UNMERGEABLE'; assert.equal(stabilize(q,2).action,'run'); q[0].state='LOCKED'; assert.equal(inspectSnapshot(snap(q),cfg).reason,'unstable_state'); });
test('unbuilt candidate within window waits rather than electing prefix', () => { const q=entries(2); q[1]={...q[1],head:null,base:null,state:'QUEUED'}; assert.equal(inspectSnapshot(snap(q),cfg).reason,'buildable_candidate_not_ready'); assert.equal(stabilize(q,1).action,'wait'); });
test('changed snapshot at deadline falls back instead of electing without debounce', () => { assert.equal(call(entries(1),1,{nowMs:100,priorSignature:'other',stableSinceMs:0}).reason,'debounce_deadline'); });


test('tested head remains valid when later candidate is appended', () => {
  const before=entries(2); const result=stabilize(before,2); const after=entries(3);
  assert.equal(revalidate({snapshot:snap(after),eventSha:s(2),electedSignature:result.signature,config:cfg}),true);
});
test('later head may be elected despite earlier failed prefix under HEADGREEN', () => {
  const q=entries(3); q[1].state='UNMERGEABLE'; const result=stabilize(q,3);
  assert.equal(result.action,'run');
  assert.equal(revalidate({snapshot:snap(q),eventSha:s(3),electedSignature:result.signature,config:cfg}),true);
});
test('revalidate rejects removal and rebasing, even if a later PR is present', () => {
  const q=entries(2); const result=stabilize(q,2);
  const rebased=entries(3); rebased[0].pr=55;
  assert.equal(revalidate({snapshot:snap(rebased),eventSha:s(2),electedSignature:result.signature,config:cfg}),false);
  const removed=[{...entries(3)[1],position:1,base:s(0)}, {...entries(3)[2],position:2}];
  assert.equal(revalidate({snapshot:snap(removed),eventSha:s(2),electedSignature:result.signature,config:cfg}),false);
});
test('revalidate never transfers success to appended or different SHA', () => {
  const result=stabilize(entries(2),2); const q=entries(3);
  assert.equal(revalidate({snapshot:snap(q),eventSha:s(3),electedSignature:result.signature,config:cfg}),false);
  assert.equal(revalidate({snapshot:snap(q),eventSha:s(2),electedSignature:'invalid',config:cfg}),false);
  assert.equal(revalidate({snapshot:snap(q),eventSha:s(2),electedSignature:'[]',config:cfg}),false);
});
test('a later candidate losing its check does not invalidate tested prefix', () => {
  const result=stabilize(entries(2),2); const q=entries(3); q[2].state='UNMERGEABLE';
  assert.equal(revalidate({snapshot:snap(q),eventSha:s(2),electedSignature:result.signature,config:cfg}),true);
});

test('same tested head survives earlier PRs merging and shifting position', () => {
  const original=entries(3), result=stabilize(original,3);
  const shifted={...original[2],position:1};
  assert.equal(revalidate({snapshot:snap([shifted]),eventSha:s(3),electedSignature:result.signature,config:cfg,verifiedMerged:new Set([1,2])}),true);
  assert.equal(revalidate({snapshot:snap([shifted]),eventSha:s(3),electedSignature:result.signature,config:cfg,verifiedMerged:new Set([1])}),false);
  assert.equal(revalidate({snapshot:snap([shifted]),eventSha:s(3),electedSignature:result.signature,config:cfg}),false);
});
test('a single merged predecessor may disappear and new PRs may append', () => {
  const original=entries(3), result=stabilize(original.slice(0,2),2);
  const shifted={...original[1],position:1};
  const appended={...original[2],position:2};
  assert.equal(revalidate({snapshot:snap([shifted,appended]),eventSha:s(2),electedSignature:result.signature,config:cfg,verifiedMerged:new Set([1])}),true);
});
test('missing middle PR or reordered membership is never treated as merged prefix', () => {
  const q=entries(3), result=stabilize(q,3);
  const missingMiddle=[q[0],{...q[2],position:2,base:q[0].head}];
  assert.equal(revalidate({snapshot:snap(missingMiddle),eventSha:s(3),electedSignature:result.signature,config:cfg,verifiedMerged:new Set([2])}),false);
  const changedPr=[{...q[2],position:1,pr:99}];
  assert.equal(revalidate({snapshot:snap(changedPr),eventSha:s(3),electedSignature:result.signature,config:cfg,verifiedMerged:new Set([1,2])}),false);
});
test('same PR with changed head, base or solo is not a tested candidate', () => {
  const q=entries(3), result=stabilize(q,3);
  for (const changed of [{head:s(99)},{base:s(99)},{solo:true}]) {
    assert.equal(revalidate({snapshot:snap([{...q[2],position:1,...changed}]),eventSha:s(3),electedSignature:result.signature,config:cfg,verifiedMerged:new Set([1,2])}),false);
  }
});
