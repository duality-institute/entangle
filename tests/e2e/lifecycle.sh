#!/usr/bin/env bash
# entangle E2E — shutdown/restart lifecycle, driven from browser.ts so the phone
# stays open across the whole sequence.
#
#   SIGINT opencode  -> both entangle ports must be closed within 2s
#                    -> descriptor handling is measured, not assumed
#   entangle         -> must report "no instance" (exit 1)
#   restart + pair   -> the phone's stale cookie must be rejected (401)
#
# Writes tests/e2e state to $E2E_DIR/lifecycle.json for browser.ts to read.
set -uo pipefail
# shellcheck source=./lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

PID="$(cat "$E2E_PIDFILE")"
CONTROL_PORT="$(e2e_control_port)"
DESCRIPTOR="$(e2e_descriptor_files | head -1)"

# An independent, curl-held session cookie minted from the SAME in-memory auth
# the phone is using. After the restart it must be rejected, which is exactly
# why the phone lands on the unpaired screen.
STALE_JAR="$E2E_DIR/phone-jar.txt"
rm -f "$STALE_JAR"
STALE_PAIR_URL="$(e2e_cli --json 2>/dev/null | jq -r .pairingUrl)"
MOBILE_LAN="${STALE_PAIR_URL%%/pair*}"
curl -sS -o /dev/null --max-time 20 -c "$STALE_JAR" "$STALE_PAIR_URL"

e2e_step "6. lifecycle — SIGINT"
e2e_say "opencode pid       : $PID"
e2e_say "control port       : $CONTROL_PORT (loopback only)"
e2e_say "mobile port        : $E2E_MOBILE_PORT (LAN)"
e2e_say "descriptor         : $DESCRIPTOR"

[ -n "$(e2e_port_pids "$CONTROL_PORT")" ] && e2e_pass "control port is listening before SIGINT" \
  || e2e_fail "control port was not listening before SIGINT"
[ -n "$(e2e_port_pids "$E2E_MOBILE_PORT")" ] && e2e_pass "mobile port is listening before SIGINT" \
  || e2e_fail "mobile port was not listening before SIGINT"

START_NS="$(date +%s%N)"
kill -INT "$PID"

CLOSED_NS=""
while :; do
  if [ -z "$(e2e_port_pids "$CONTROL_PORT")" ] && [ -z "$(e2e_port_pids "$E2E_MOBILE_PORT")" ]; then
    CLOSED_NS="$(date +%s%N)"
    break
  fi
  NOW_NS="$(date +%s%N)"
  if [ $(( (NOW_NS - START_NS) / 1000000 )) -gt 5000 ]; then break; fi
  sleep 0.05
done

if [ -n "$CLOSED_NS" ]; then
  ELAPSED_MS=$(( (CLOSED_NS - START_NS) / 1000000 ))
  e2e_say "both ports closed after ${ELAPSED_MS}ms"
  if [ "$ELAPSED_MS" -le 2000 ]; then
    e2e_pass "both entangle ports closed within 2s of SIGINT (${ELAPSED_MS}ms)"
  else
    e2e_fail "ports took ${ELAPSED_MS}ms to close, budget is 2000ms"
  fi
else
  ELAPSED_MS=-1
  e2e_fail "entangle ports were still listening 5s after SIGINT"
fi

# --- descriptor ------------------------------------------------------------
# Measured, then explained. Do not "fix" this by weakening the assertion: the
# finding itself is the deliverable.
sleep 0.5
DESC_AFTER_SIGINT="$(e2e_descriptor_files | wc -l | tr -d ' ')"
e2e_say "descriptor files 2s after SIGINT: $DESC_AFTER_SIGINT"
if [ "$DESC_AFTER_SIGINT" = "0" ]; then
  e2e_pass "descriptor removed by the plugin's dispose hook on SIGINT"
  DESC_MODE="dispose"
else
  DESC_MODE="self-heal"
  e2e_note "descriptor SURVIVES SIGINT. opencode 1.18.18 registers zero"
  e2e_note "SIGINT/SIGTERM/exit/beforeExit listeners and does not invoke plugin"
  e2e_note "dispose() on signal death, so no in-process cleanup can run. The"
  e2e_note "descriptor is instead reclaimed by listDescriptors()'s dead-pid"
  e2e_note "sweep, asserted immediately below."
fi

kill -0 "$PID" 2>/dev/null && e2e_fail "opencode is still alive after SIGINT" \
  || e2e_pass "opencode process exited on SIGINT"
rm -f "$E2E_PIDFILE"

e2e_step "6b. lifecycle — entangle after shutdown"
CLI_OUT="$(e2e_cli --json 2>&1)"; CLI_CODE=$?
e2e_expect "entangle --json exit code with no live instance" "1" "$CLI_CODE"
e2e_expect "entangle --json prints nothing on stdout" "" "$(e2e_cli --json 2>/dev/null)"
e2e_say "stderr: $CLI_OUT"
DESC_AFTER_SWEEP="$(e2e_descriptor_files | wc -l | tr -d ' ')"
e2e_expect "descriptor files after the CLI's dead-pid sweep" "0" "$DESC_AFTER_SWEEP"
[ -z "$(e2e_port_pids "$E2E_MOBILE_PORT")" ] && e2e_pass "mobile port still closed" \
  || e2e_fail "something is listening on the mobile port after shutdown"

e2e_step "6c. lifecycle — restart, re-pair, stale cookie must be rejected"
e2e_start_opencode || e2e_fail "opencode did not come back up"
e2e_ensure_session > /dev/null
NEW_URL="$(e2e_cli --json 2>/dev/null | jq -r .pairingUrl)"
e2e_say "new pairing url    : $NEW_URL"
NEW_PORT="$(printf '%s' "$NEW_URL" | sed -E 's#.*:([0-9]+)/pair.*#\1#')"
e2e_expect "the restarted instance re-binds the pinned mobile port" "$E2E_MOBILE_PORT" "$NEW_PORT"
STALE_CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
  -b "$STALE_JAR" "$MOBILE_LAN/api/state" 2>/dev/null || echo 000)"
e2e_expect "a cookie from the previous process is rejected after restart" "401" "$STALE_CODE"
e2e_note "sessions live in memory only, so a restart invalidates every phone."

jq -n --arg mode "$DESC_MODE" --argjson elapsed "$ELAPSED_MS" \
      --argjson descAfterSigint "$DESC_AFTER_SIGINT" --arg url "$NEW_URL" \
      --argjson failures "$E2E_FAILURES" \
  '{portsClosedMs:$elapsed, descriptorMode:$mode, descriptorsAfterSigint:$descAfterSigint, newPairingUrl:$url, failures:$failures}' \
  > "$E2E_DIR/lifecycle.json"

exit "$([ "$E2E_FAILURES" -eq 0 ] && echo 0 || echo 1)"
