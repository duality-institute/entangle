#!/usr/bin/env bash
# entangle E2E — curl negative suite against the REAL LAN mobile server.
#
# Runs entirely against 127.0.0.1 (an allow-listed Host) so the rate-limit
# bucket it burns belongs to the loopback source IP. The browser pairs over the
# LAN address, which is a different bucket, so the two never interfere.
#
# Expected headline sequence: 401 403 403 401 429
set -uo pipefail
# shellcheck source=./lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

E2E_REPORT="$E2E_SECURITY_REPORT"
: > "$E2E_REPORT"
JAR="$E2E_DIR/security-jar.txt"
BASE="$E2E_MOBILE_LOCAL"

# One request per assertion. Splitting status and body across two curl calls
# silently doubles the failed-pairing count and moves the lockout a step early.
PROBE_CODE=""
PROBE_BODY=""
probe() {
  local raw
  raw="$(curl -sS -w $'\n%{http_code}' --max-time 20 "$@")"
  PROBE_CODE="${raw##*$'\n'}"
  PROBE_BODY="${raw%$'\n'*}"
}

e2e_say "entangle security negative suite — REAL mobile server"
e2e_say "generated: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
e2e_say "target   : $BASE  (host header allow-list entry 127.0.0.1:$E2E_MOBILE_PORT)"

fresh_pairing_url() { e2e_cli --json 2>/dev/null | jq -r .pairingUrl; }
localise() { printf '%s' "$1" | sed -E "s#^http://[^/]+#$BASE#"; }

# --------------------------------------------------------------------------
e2e_step "0. positive control — a correctly formed request must still work"
PAIR_URL="$(localise "$(fresh_pairing_url)")"
rm -f "$JAR"
probe -c "$JAR" "$PAIR_URL"
e2e_expect "GET /pair?token=<fresh> redirects" "303" "$PROBE_CODE"
grep -q entangle_session "$JAR" \
  && e2e_pass "Set-Cookie entangle_session issued (value withheld)" \
  || e2e_fail "no entangle_session cookie in the 303"
probe -b "$JAR" "$BASE/api/state"
CSRF="$(printf '%s' "$PROBE_BODY" | jq -r .csrf)"
SESSION_ID="$(printf '%s' "$PROBE_BODY" | jq -r .session.id)"
{ [ -n "$CSRF" ] && [ "$CSRF" != "null" ]; } \
  && e2e_pass "GET /api/state with cookie returns a csrf token" \
  || e2e_fail "GET /api/state did not return a csrf token"
probe -X POST -b "$JAR" -H "Origin: $BASE" -H "X-Entangle-CSRF: $CSRF" \
  -H "X-Entangle-Session: $SESSION_ID" -H 'content-type: application/json' \
  "$BASE/api/abort" -d '{}'
e2e_expect "POST /api/abort with cookie+Origin+CSRF+session is accepted" "200" "$PROBE_CODE"

probe -X POST -b "$JAR" -H "Origin: $BASE" -H "X-Entangle-CSRF: $CSRF" \
  -H 'content-type: application/json' "$BASE/api/abort" -d '{}'
e2e_expect "POST /api/abort without the pinned session is rejected" "409" "$PROBE_CODE"
e2e_expect "  body" '{"error":"session binding changed; reload before retrying"}' "$PROBE_BODY"

# --------------------------------------------------------------------------
e2e_step "1. 401 — authenticated GET without the session cookie"
probe "$BASE/api/state"
C1="$PROBE_CODE"
e2e_expect "GET /api/state (no cookie)" "401" "$C1"
e2e_expect "  body" '{"error":"pairing required"}' "$PROBE_BODY"

e2e_step "2. 403 — DNS-rebinding defence: Host outside the allow-list"
probe -b "$JAR" -H "Host: evil.example:$E2E_MOBILE_PORT" "$BASE/api/state"
C2="$PROBE_CODE"
e2e_expect "GET /api/state (valid cookie, forged Host)" "403" "$C2"
e2e_expect "  body" '{"error":"forbidden host"}' "$PROBE_BODY"
e2e_note "the cookie is valid here — the host check runs BEFORE authentication,"
e2e_note "so a rebinding attacker never reaches the routing table."

e2e_step "3. 403 — mutation without the X-Entangle-CSRF header"
probe -X POST -b "$JAR" -H "Origin: $BASE" -H 'content-type: application/json' \
  "$BASE/api/prompt" -d '{"text":"csrf probe"}'
C3="$PROBE_CODE"
e2e_expect "POST /api/prompt (cookie + Origin, no CSRF header)" "403" "$C3"
e2e_expect "  body" '{"error":"forbidden"}' "$PROBE_BODY"

e2e_step "4. 401 — replay of an already-consumed pairing token"
probe "$PAIR_URL"
C4="$PROBE_CODE"
e2e_expect "GET /pair?token=<already used>" "401" "$C4"
e2e_expect "  body" '{"error":"bad-token"}' "$PROBE_BODY"
e2e_note "single-use: a screenshot of an old QR is worthless."

e2e_step "5. 429 — five failed pairing attempts lock the source IP"
e2e_note "the replay above is failure 1 of 5 in this 60s window."
SEQ="$C4"
LOCKOUT=""
for i in 2 3 4 5; do
  probe "$BASE/pair?token=brute-force-attempt-$i-$(date +%s%N)"
  SEQ="$SEQ $PROBE_CODE"
  LOCKOUT="$PROBE_CODE"
  e2e_say "  attempt $i -> $PROBE_CODE  $PROBE_BODY"
done
e2e_expect "failure codes 1..5 from one source IP" "401 401 401 401 429" "$SEQ"
probe "$(localise "$(fresh_pairing_url)")"
e2e_expect "even a VALID token is refused while the IP is locked" "429" "$PROBE_CODE"
e2e_expect "  locked-out body" '{"error":"rate-limited"}' "$PROBE_BODY"

# --------------------------------------------------------------------------
e2e_step "headline sequence"
e2e_expect "401 (no cookie) / 403 (bad Host) / 403 (no CSRF) / 401 (replay) / 429 (lockout)" \
  "401 403 403 401 429" "$C1 $C2 $C3 $C4 $LOCKOUT"

e2e_say ""
e2e_say "failures: $E2E_FAILURES"
[ "$E2E_FAILURES" -eq 0 ]
