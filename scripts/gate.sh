#!/usr/bin/env bash
set -euo pipefail
test "$SELECT_RESULT" = success
test "$BROWSER_RESULT" = success
test "$SERVICE_RESULT" = success
test "$EVENT_SHA" = "$GITHUB_SHA"
case "$GITHUB_EVENT_NAME:$ELECTION" in
  pull_request:pr) ;;
  merge_group:run) node scripts/adapter.mjs --revalidate ;;
  merge_group:fallback) ;;
  *) echo 'Invalid coordinator election for event' >&2; exit 1 ;;
esac
echo "E2E gate passed for $GITHUB_SHA ($ELECTION)"
