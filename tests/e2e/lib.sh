#!/usr/bin/env bash
# entangle E2E — shared configuration and helpers.
#
# Sourced by run.sh, security.sh and lifecycle.sh. Every value is overridable
# from the environment so the suite can be re-pointed without editing scripts.

E2E_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export E2E_REPO="${E2E_REPO:-$(cd "$E2E_LIB_DIR/../.." && pwd)}"

# --- scratch project -------------------------------------------------------
export E2E_DIR="${E2E_DIR:-/tmp/entangle-e2e}"
export E2E_STATE="${E2E_STATE:-$E2E_DIR/state}"
export E2E_CONFIG_HOME="${E2E_CONFIG_HOME:-$E2E_DIR/config}"
export E2E_LOG="${E2E_LOG:-$E2E_DIR/opencode.log}"
export E2E_PIDFILE="${E2E_PIDFILE:-$E2E_DIR/opencode.pid}"

# --- ports -----------------------------------------------------------------
# Both are pinned so lsof assertions and the post-restart re-pair are
# deterministic. The mobile port is pinned through the plugin options.
export E2E_OC_PORT="${E2E_OC_PORT:-41777}"
export E2E_MOBILE_PORT="${E2E_MOBILE_PORT:-41778}"
export E2E_OC_URL="http://127.0.0.1:$E2E_OC_PORT"
export E2E_MOBILE_LOCAL="http://127.0.0.1:$E2E_MOBILE_PORT"

# --- models (cheapest configured provider on this machine) -----------------
export E2E_MODEL="${E2E_MODEL:-deepseek/deepseek-v4-flash}"
export E2E_MODEL_ALT="${E2E_MODEL_ALT:-deepseek/deepseek-chat}"

# --- outputs ---------------------------------------------------------------
export E2E_EVIDENCE="${E2E_EVIDENCE:-/tmp/entangle-e2e-evidence}"
export E2E_REPORT="${E2E_REPORT:-$E2E_EVIDENCE/entangle-e2e.txt}"
export E2E_SECURITY_REPORT="${E2E_SECURITY_REPORT:-$E2E_EVIDENCE/entangle-security.txt}"
export E2E_TOOLS="${E2E_TOOLS:-/tmp/entangle-e2e-tools}"
export E2E_PLAYWRIGHT_VERSION="${E2E_PLAYWRIGHT_VERSION:-1.59.1}"

# URL-encoded scratch directory, as opencode's per-instance routing expects.
e2e_dir_enc() { printf %s "$E2E_DIR" | jq -sRr @uri; }

# --- logging ---------------------------------------------------------------
E2E_FAILURES=0

e2e_say() { printf '%s\n' "$*" | tee -a "$E2E_REPORT"; }
e2e_step() { printf '\n=== %s ===\n' "$*" | tee -a "$E2E_REPORT"; }
e2e_pass() { printf 'PASS  %s\n' "$*" | tee -a "$E2E_REPORT"; }
e2e_note() { printf 'NOTE  %s\n' "$*" | tee -a "$E2E_REPORT"; }
e2e_fail() {
  E2E_FAILURES=$((E2E_FAILURES + 1))
  printf 'FAIL  %s\n' "$*" | tee -a "$E2E_REPORT"
}

# e2e_expect <label> <expected> <actual>
e2e_expect() {
  if [ "$2" = "$3" ]; then
    e2e_pass "$1 — got $3"
  else
    e2e_fail "$1 — expected $2, got $3"
  fi
}

# --- scratch project -------------------------------------------------------
e2e_write_config() {
  # $1 (optional): extra top-level JSON members, already comma-terminated.
  cat > "$E2E_DIR/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "model": "$E2E_MODEL",
  "small_model": "$E2E_MODEL",
  "permission": { "bash": "ask" },
  "plugin": [["$E2E_REPO", { "host": "0.0.0.0", "port": $E2E_MOBILE_PORT, "pairingTtlMs": 300000 }]],
  "agent": {
    "plan": {
      "mode": "primary",
      "model": "$E2E_MODEL",
      "prompt": "You are the plan agent driven by an automated end-to-end test. Answer in as few words as possible and never call a tool unless the prompt explicitly demands it."
    }
  }
}
EOF
}

e2e_scratch_reset() {
  e2e_stop_opencode
  rm -rf "$E2E_DIR"
  mkdir -p "$E2E_DIR" "$E2E_STATE" "$E2E_CONFIG_HOME/opencode"
  # Neutral XDG config home so a developer's global opencode.jsonc (and its
  # plugins) cannot change what this suite measures.
  printf '{}\n' > "$E2E_CONFIG_HOME/opencode/opencode.json"
  printf 'entangle end-to-end scratch project\n' > "$E2E_DIR/README.md"
  e2e_write_config
}

# --- opencode lifecycle ----------------------------------------------------
# Writes the pid to $E2E_PIDFILE and returns 0 once the server answers. It
# deliberately prints NOTHING: wrapping this in $(...) makes the caller wait on
# a pipe that the detached server keeps open, which hangs the whole suite.
e2e_start_opencode() {
  # Two load-bearing details, both found by the SIGINT step failing silently:
  #   `set -m` — a non-interactive bash sets SIGINT/SIGQUIT to SIG_IGN on every
  #     async child, and `exec` preserves that disposition, so opencode would
  #     ignore the lifecycle SIGINT entirely. Job control gives the child its
  #     own process group with default dispositions.
  #   `exec`  — makes $! the opencode pid rather than a wrapper subshell's, so
  #     the signal reaches the process that actually owns the two ports.
  set -m
  (
    cd "$E2E_DIR" || exit 1
    # Running this suite from inside an opencode session leaks
    # OPENCODE_CONFIG_CONTENT into the child, which injects that session's
    # plugins and can even demote built-in agents (`plan` -> subagent). Scrub
    # every inherited OPENCODE_* knob so the scratch config is authoritative.
    unset OPENCODE OPENCODE_PID OPENCODE_CLIENT OPENCODE_CONFIG \
          OPENCODE_CONFIG_CONTENT OPENCODE_CONFIG_DIR
    export XDG_STATE_HOME="$E2E_STATE" XDG_CONFIG_HOME="$E2E_CONFIG_HOME"
    exec opencode serve --port "$E2E_OC_PORT" --hostname 127.0.0.1 --print-logs \
      >> "$E2E_LOG" 2>&1 < /dev/null
  ) &
  echo $! > "$E2E_PIDFILE"
  local pid deadline
  pid="$(cat "$E2E_PIDFILE")"
  deadline=$((SECONDS + 40))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -sS --max-time 3 "$E2E_OC_URL/config" >/dev/null 2>&1; then
      e2e_port_pids "$E2E_OC_PORT" | grep -qx "$pid" && return 0
      return 1
    fi
    sleep 0.25
  done
  return 1
}

# Also sweeps whatever is bound to $E2E_OC_PORT. A leftover server from an
# aborted run answers the readiness probe, so the next run silently talks to a
# stale process whose plugin state no longer exists.
e2e_stop_opencode() {
  local pid deadline
  pid="$(cat "$E2E_PIDFILE" 2>/dev/null || true)"
  for victim in $pid $(e2e_port_pids "$E2E_OC_PORT"); do
    kill -INT "$victim" 2>/dev/null || true
  done
  deadline=$((SECONDS + 10))
  while [ "$SECONDS" -lt "$deadline" ] && [ -n "$(e2e_port_pids "$E2E_OC_PORT")" ]; do sleep 0.2; done
  for victim in $pid $(e2e_port_pids "$E2E_OC_PORT"); do
    kill -KILL "$victim" 2>/dev/null || true
  done
  rm -f "$E2E_PIDFILE"
}

# opencode creates a per-directory instance (and therefore loads plugins) lazily
# on the first request that carries a directory. Without this the descriptor is
# never written, no matter how long the server has been up.
e2e_boot_instance() {
  curl -sS --max-time 60 \
    -H "x-opencode-directory: $(e2e_dir_enc)" \
    "$E2E_OC_URL/session?directory=$(e2e_dir_enc)"
}

# Prints a fresh session id. Pairing pins the most recently updated root session,
# so one must exist before generating the QR; a new one also keeps "last user
# message" assertions unambiguous.
e2e_ensure_session() {
  e2e_boot_instance > /dev/null
  curl -sS --max-time 60 -X POST \
    -H "content-type: application/json" \
    -H "x-opencode-directory: $(e2e_dir_enc)" \
    "$E2E_OC_URL/session?directory=$(e2e_dir_enc)" \
    -d '{"title":"entangle e2e"}' | jq -r .id
}

# --- entangle CLI ----------------------------------------------------------
# Always the BUILT artifact — opencode loads dist/plugin.js, so the CLI under
# test must be dist/cli.js too.
e2e_cli() {
  ( cd "$E2E_DIR" && XDG_STATE_HOME="$E2E_STATE" bun "$E2E_REPO/dist/cli.js" "$@" )
}

e2e_descriptor_files() {
  find "$E2E_STATE/entangle/instances" -name '*.json' -type f 2>/dev/null || true
}

e2e_port_pids() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true; }

e2e_control_port() {
  e2e_descriptor_files | head -1 | xargs -I{} jq -r '.controlUrl | split(":") | last' {} 2>/dev/null || true
}
