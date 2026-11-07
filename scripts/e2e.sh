#!/usr/bin/env bash
set -euo pipefail
if [[ "$EVENT" == pull_request ]]; then
  echo 'PR E2E placeholder passed; actual experiment runs only for merge_group.'
  exit 0
fi
current=$(echo "$REF" | sed -nE 's#.*\/pr-([0-9]+)-.*#\1#p')
[[ -n "$current" ]] || { echo "Cannot identify queue revision: $REF"; exit 1; }
owner=${REPO%/*}
repo=${REPO#*/}
query='query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){mergeQueue(branch:"main"){entries(first:20){nodes{position pullRequest{number}}}}}}'
for i in $(seq 1 60); do
  data=$(gh api graphql -f query="$query" -F owner="$owner" -F repo="$repo")
  count=$(jq '.data.repository.mergeQueue.entries.nodes | length' <<< "$data")
  tail=$(jq -r '.data.repository.mergeQueue.entries.nodes | last | .pullRequest.number // empty' <<< "$data")
  if [[ "$count" -ge 3 ]]; then break; fi
  sleep 5
done
[[ "$count" -ge 3 ]] || { echo "Never observed a batch of three"; exit 1; }
if [[ "$current" != "$tail" ]]; then
  echo "PREFIX_PENDING PR=$current current_tail=$tail; no synthetic E2E result will be reported."
  sleep 300
  echo 'Prefix timed out; fail closed.'
  exit 1
fi
sleep 15
data=$(gh api graphql -f query="$query" -F owner="$owner" -F repo="$repo")
last=$(jq -r '.data.repository.mergeQueue.entries.nodes | last | .pullRequest.number // empty' <<< "$data")
[[ "$current" == "$last" ]] || { echo 'Batch tail changed before validation; fail closed.'; exit 1; }
echo "BATCH_E2E_EXECUTED PR=$current TESTED_SHA=$(git rev-parse HEAD)"
echo 'TEST_HOLD_FOR_PREFIX_CANCELLATION'; sleep 90
node scripts/e2e.mjs
