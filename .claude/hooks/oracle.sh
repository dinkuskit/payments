#!/usr/bin/env bash
# api-oracle hook shim for Claude Code cloud sessions. Copy to
# .claude/hooks/oracle.sh in a product repo and wire it from
# .claude/settings.json (see templates/cloud-settings.json).
#
# Local sessions are left alone: on a developer machine the user-level hooks
# installed by `oracle setup` already cover this repo. In a cloud sandbox
# (CLAUDE_CODE_REMOTE=true) this shim makes sure the oracle checkout exists,
# bootstraps the drainer once per session, and forwards hook events. Every
# failure is soft: the session always starts, and the hook never blocks.
set -uo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

event="${1:-}"
oracle_dir="${ORACLE_DIR:-$HOME/.api-oracle}"
oracle="$oracle_dir/bin/oracle"
repo_url="${ORACLE_REPO_URL:-https://github.com/saari-co/api-oracle.git}"

ensure_checkout() {
  [ -x "$oracle" ] && return 0
  if command -v gh >/dev/null 2>&1 && gh repo clone saari-co/api-oracle "$oracle_dir" -- --quiet --depth 1 >/dev/null 2>&1; then return 0; fi
  git clone --quiet --depth 1 "$repo_url" "$oracle_dir" >/dev/null 2>&1 && return 0
  return 1
}

case "$event" in
  session-start)
    if ! ensure_checkout; then
      printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"api-oracle cloud: could not clone saari-co/api-oracle into %s; the cloud environment needs read access to that private repo (attach it to the session). Delegated audits are unavailable here."}}' "$oracle_dir"
      exit 0
    fi
    [ -n "${CLAUDE_ENV_FILE:-}" ] && printf 'export ORACLE_DIR=%q\nexport PATH=%q:$PATH\n' "$oracle_dir" "$oracle_dir/bin" >> "$CLAUDE_ENV_FILE"
    exec "$oracle" cloud-bootstrap
    ;;
  stop|prompt)
    [ -x "$oracle" ] || exit 0
    exec "$oracle" hook "$event"
    ;;
  *)
    exit 0
    ;;
esac
