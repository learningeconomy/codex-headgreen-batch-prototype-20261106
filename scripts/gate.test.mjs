import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const sha = 'a'.repeat(40);
const base = { ...process.env, SELECT_RESULT:'success', BROWSER_RESULT:'success', SERVICE_RESULT:'success', EVENT_SHA:sha, GITHUB_SHA:sha, GITHUB_EVENT_NAME:'merge_group', ELECTION:'fallback' };
const gate = change => spawnSync('bash', ['scripts/gate.sh'], { env:{...base, ...change} }).status;
test('fresh fallback suite can pass for exact SHA', () => assert.equal(gate({}), 0));
for (const key of ['SELECT_RESULT','BROWSER_RESULT','SERVICE_RESULT']) test(`${key} failure blocks the gate`, () => assert.notEqual(gate({[key]:'failure'}), 0));
test('wrong SHA and missing or wrong election block the gate', () => {
  assert.notEqual(gate({EVENT_SHA:'b'.repeat(40)}), 0);
  assert.notEqual(gate({ELECTION:''}), 0);
  assert.notEqual(gate({ELECTION:'pr'}), 0);
});
test('PR election must match PR event', () => assert.equal(gate({GITHUB_EVENT_NAME:'pull_request',ELECTION:'pr'}), 0));
