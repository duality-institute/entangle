#!/usr/bin/env bash
# entangle E2E — the whole product against a REAL opencode instance.
#
#   bash tests/e2e/run.sh
#
# Requires: opencode (1.18.18), bun, curl, jq, lsof, and working opencode
# credentials. Everything runs in $E2E_DIR (default /tmp/entangle-e2e), which is
# destroyed and rebuilt on every run — this script is meant to be re-run.
#
# Exit 0 only when every step passed. Evidence is written out of tree, under
# $E2E_EVIDENCE (default /tmp/entangle-e2e-evidence):
#   entangle-e2e.txt
#   entangle-security.txt
#   entangle-{paired,streaming,agent,permission,unpaired}.png
set -uo pipefail
# shellcheck source=./lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

mkdir -p "$E2E_EVIDENCE"
: > "$E2E_REPORT"
# Screenshots are the one artefact that survives a crashed run and can silently
# become stale evidence for the next one.
rm -f "$E2E_EVIDENCE"/entangle-{paired,streaming,agent,permission,unpaired,failure}.png

cleanup() {
  e2e_stop_opencode
  pkill -f "chromium.*entangle-e2e" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

e2e_say "entangle end-to-end suite — REAL opencode, REAL model, no FakeBridge"
e2e_say "generated: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
e2e_say "repo     : $E2E_REPO"
e2e_say "scratch  : $E2E_DIR"

# ---------------------------------------------------------------------------
e2e_step "0. preflight"
for tool in opencode bun curl jq lsof; do
  if command -v "$tool" > /dev/null 2>&1; then
    e2e_pass "$tool present ($(command -v "$tool"))"
  else
    e2e_fail "$tool is missing"
  fi
done
e2e_say "opencode version : $(opencode --version 2>&1)"
e2e_say "bun version      : $(bun --version 2>&1)"
e2e_say "credentials      : $(opencode auth list 2>/dev/null | grep -cE '^●') provider(s) configured"

e2e_say "building dist/ (opencode loads dist/plugin.js, the CLI is dist/cli.js)"
if ( cd "$E2E_REPO" && bun run build > "$E2E_DIR-build.log" 2>&1 ); then
  e2e_pass "bun run build exit 0"
  tail -3 "$E2E_DIR-build.log" | while IFS= read -r line; do e2e_say "  $line"; done
else
  e2e_fail "bun run build failed — see $E2E_DIR-build.log"
  exit 1
fi

if [ ! -d "$E2E_TOOLS/node_modules/playwright" ]; then
  e2e_say "provisioning playwright $E2E_PLAYWRIGHT_VERSION into $E2E_TOOLS (out of tree)"
  mkdir -p "$E2E_TOOLS"
  [ -f "$E2E_TOOLS/package.json" ] || printf '{"name":"entangle-e2e-tools","private":true}\n' > "$E2E_TOOLS/package.json"
  ( cd "$E2E_TOOLS" && bun add "playwright@$E2E_PLAYWRIGHT_VERSION" ) > /dev/null 2>&1
fi
[ -f "$E2E_TOOLS/node_modules/playwright/index.js" ] \
  && e2e_pass "playwright available at $E2E_TOOLS (repo package.json untouched)" \
  || e2e_fail "playwright could not be provisioned"

# ---------------------------------------------------------------------------
e2e_step "1. scratch project + plugin registration"
e2e_scratch_reset
e2e_say "opencode.json:"
sed 's/^/  /' "$E2E_DIR/opencode.json" | tee -a "$E2E_REPORT"
e2e_note "registration form under test: a TUPLE whose first element is an"
e2e_note "absolute filesystem path to this repo. opencode resolves it through"
e2e_note "package.json \"main\" -> dist/plugin.js. The bare-string form"
e2e_note "\"plugin\": [\"<abs path>\"] also works but cannot carry options."

if e2e_start_opencode; then
  e2e_pass "opencode serve is up on $E2E_OC_URL (pid $(cat "$E2E_PIDFILE"))"
else
  e2e_fail "opencode serve did not become reachable"
  tail -20 "$E2E_LOG" | sed 's/^/  /' | tee -a "$E2E_REPORT"
  exit 1
fi

e2e_say "booting the per-directory instance (plugins load lazily, on first"
e2e_say "request carrying a directory — not at serve startup)"
SESSION_ID="$(e2e_ensure_session)"
[ -n "$SESSION_ID" ] && e2e_pass "opencode session $SESSION_ID" || e2e_fail "could not create a session"

DESCRIPTORS="$(e2e_descriptor_files)"
DESC_COUNT="$(printf '%s' "$DESCRIPTORS" | grep -c . || true)"
e2e_expect "descriptor files written by the plugin" "1" "$DESC_COUNT"
if [ "$DESC_COUNT" = "1" ]; then
  e2e_say "descriptor: $DESCRIPTORS"
  e2e_say "$(jq '.controlToken = "<redacted 43-char base64url>"' "$DESCRIPTORS" | sed 's/^/  /')"
  e2e_expect "descriptor mode" "600" "$(stat -f '%Lp' "$DESCRIPTORS")"
  e2e_expect "instances dir mode" "700" "$(stat -f '%Lp' "$(dirname "$DESCRIPTORS")")"
  e2e_expect "descriptor records the CANONICAL directory (/private on macOS)" \
    "$(cd "$E2E_DIR" && pwd -P)" "$(jq -r .directory "$DESCRIPTORS")"
fi

CONTROL_PORT="$(e2e_control_port)"
e2e_say "control port: $CONTROL_PORT"
LOOPBACK_ONLY="$(lsof -nP -iTCP:"$CONTROL_PORT" -sTCP:LISTEN 2>/dev/null | grep -c '127.0.0.1' || true)"
e2e_expect "control server binds loopback only" "1" "$LOOPBACK_ONLY"
UNAUTH="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -X POST "http://127.0.0.1:$CONTROL_PORT/pairing")"
e2e_expect "control server rejects an unauthenticated pairing request" "401" "$UNAUTH"
UNAUTH_SESSIONS="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$CONTROL_PORT/sessions")"
e2e_expect "control server rejects an unauthenticated chat list" "401" "$UNAUTH_SESSIONS"

CONTROL_TOKEN="$(jq -r .controlToken "$DESCRIPTORS")"
SESSIONS_JSON="$(curl -sS --max-time 10 -H "authorization: Bearer $CONTROL_TOKEN" \
  "http://127.0.0.1:$CONTROL_PORT/sessions")"
e2e_expect "chat list is an array" "true" "$(printf '%s' "$SESSIONS_JSON" | jq -r '.sessions | type == "array"')"
e2e_expect "chat list entries carry id, title and updatedAt" "true" \
  "$(printf '%s' "$SESSIONS_JSON" | jq -r '[.sessions[] | has("id") and has("title") and has("updatedAt")] | all')"
e2e_expect "chat list excludes subagent children" "true" \
  "$(printf '%s' "$SESSIONS_JSON" | jq -r '[.sessions[] | has("parentID") | not] | all')"

GHOST_CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -X POST \
  -H "authorization: Bearer $CONTROL_TOKEN" -H 'content-type: application/json' \
  -d '{"sessionID":"ses_definitely_not_in_this_project"}' \
  "http://127.0.0.1:$CONTROL_PORT/pairing")"
e2e_expect "pairing refuses a chat that is not in this project" "400" "$GHOST_CODE"

CHOSEN="$(printf '%s' "$SESSIONS_JSON" | jq -r '.sessions[0].id // empty')"
if [ -n "$CHOSEN" ]; then
  PINNED="$(curl -sS --max-time 10 -X POST \
    -H "authorization: Bearer $CONTROL_TOKEN" -H 'content-type: application/json' \
    -d "{\"sessionID\":\"$CHOSEN\"}" "http://127.0.0.1:$CONTROL_PORT/pairing" | jq -r .session.id)"
  e2e_expect "pairing pins exactly the chat that was chosen" "$CHOSEN" "$PINNED"
fi

# ---------------------------------------------------------------------------
e2e_step "2. entangle CLI + QR decode"
E2E_URL_OUT="$E2E_DIR/pairing-url.txt" bun "$E2E_REPO/tests/e2e/qr-decode.ts" \
  || e2e_fail "qr-decode.ts reported failures"
PAIRING_URL="$(cat "$E2E_DIR/pairing-url.txt" 2>/dev/null || true)"

# ---------------------------------------------------------------------------
e2e_step "3. security negative suite"
bash "$E2E_REPO/tests/e2e/security.sh" > /dev/null 2>&1 \
  && e2e_pass "security suite: 401/403/403/401/429 (see $E2E_SECURITY_REPORT)" \
  || e2e_fail "security suite reported failures (see $E2E_SECURITY_REPORT)"
grep -E '^(PASS|FAIL|NOTE)' "$E2E_SECURITY_REPORT" | sed 's/^/  /' >> "$E2E_REPORT"

# ---------------------------------------------------------------------------
e2e_step "4-7. phone: pair, stream, agent, model, abort, permission, lifecycle"
FRESH_URL="$(e2e_cli --json 2>/dev/null | jq -r .pairingUrl)"
e2e_say "pairing url for the browser: $FRESH_URL"
E2E_PAIRING_URL="$FRESH_URL" E2E_SESSION_ID="$SESSION_ID" \
  bun "$E2E_REPO/tests/e2e/browser.ts" \
  || e2e_fail "browser.ts reported failures"

# ---------------------------------------------------------------------------
e2e_step "8. teardown"
# lifecycle.sh restarted opencode, so the control port is a new one.
CONTROL_PORT="$(e2e_control_port)"
e2e_stop_opencode
sleep 1
for port in "$E2E_MOBILE_PORT" "$E2E_OC_PORT" "$CONTROL_PORT"; do
  [ -z "$(e2e_port_pids "$port")" ] && e2e_pass "port $port is free" || e2e_fail "port $port is still listening"
done
LEFTOVER="$(pgrep -fl 'opencode serve' | grep -c "$E2E_OC_PORT" || true)"
e2e_expect "no orphaned opencode serve on $E2E_OC_PORT" "0" "$LEFTOVER"

e2e_step "result"
# The summary line must not itself begin with FAIL, or it poisons this count.
FAILED="$(grep -c '^FAIL' "$E2E_REPORT" || true)"
e2e_say "failed assertions across every step: $FAILED"
if [ "$FAILED" -eq 0 ]; then
  e2e_say "ALL STEPS PASSED"
  exit 0
fi
e2e_say "SUITE FAILED"
exit 1
