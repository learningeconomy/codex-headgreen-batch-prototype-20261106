# Disposable HEADGREEN experiment

Synthetic public repository for validating GitHub merge-queue required-check behavior. No LearnCard source, data, secrets, or service access.

## Coordinator experiment

This sandbox uses an Actions coordinator, a synthetic browser job, three synthetic service shards, and a required `E2E` aggregator. A prefix stays pending and falls back to a fresh suite after a deadline; skipped checks are never used as passing evidence. Queue policy, timing, failures, and job counts must be tested on real merge groups. This is not LearnCard's E2E suite or production-ready coordination. A live queue snapshot is not a membership lock, overlapping elections can cause extra suites, and Actions waiters consume runners. Coordinator code from a merge-group checkout must not receive write-capable credentials.

Run model tests with `node --test scripts/coordinator.test.mjs scripts/adapter.test.mjs`.
