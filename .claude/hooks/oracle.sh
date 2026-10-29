#!/usr/bin/env bash
# api-oracle hook shim for Claude Code cloud sessions. Copy to
# .claude/hooks/oracle.sh in a product repo and wire it from
# .claude/settings.json (see templates/cloud-settings.json).
#
# Local sessions are left alone: on a developer machine the user-level hooks
# installed by `oracle setup` already cover this repo. In a cloud sandbox
# (CLAUDE_CODE_REMOTE=true) this shim installs the one reviewed api-oracle
# revision named below, verifies it, bootstraps the drainer once per session,
# and forwards hook events. Every failure is soft: the session always starts,
# the hook never blocks, and nothing executes unless the checkout matches the
# pinned revision exactly.
#
# Bumping ORACLE_REV is a reviewed change to this repository, on purpose.
set -uo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

ORACLE_REV="edd8ad955f77117ca0dbaf874bf24d4b3f536b59"   # full commit SHA of saari-co/api-oracle, set when this file is copied
ORACLE_REPO_URL="${ORACLE_REPO_URL:-https://github.com/saari-co/api-oracle.git}"

event="${1:-}"
oracle_dir="${ORACLE_DIR:-$HOME/.api-oracle/$ORACLE_REV}"   # revision-specific install
oracle="$oracle_dir/bin/oracle"

note() {
  # Soft failure: say why in SessionStart context, never fail the session.
  if [ "$event" = "session-start" ]; then
    printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"api-oracle cloud: %s Delegated audits are unavailable in this session."}}' "$1"
  fi
  exit 0
}

case "$ORACLE_REV" in
  *[!0-9a-f]*|"") note "ORACLE_REV in .claude/hooks/oracle.sh is not a full commit SHA." ;;
esac
[ "${#ORACLE_REV}" -eq 40 ] || note "ORACLE_REV in .claude/hooks/oracle.sh is not a full commit SHA."

# True only when the checkout is exactly the pinned revision with a clean tree.
verified() {
  [ -x "$oracle" ] || return 1
  [ "$(git -C "$oracle_dir" rev-parse --verify HEAD 2>/dev/null)" = "$ORACLE_REV" ] || return 1
  [ -z "$(git -C "$oracle_dir" status --porcelain 2>/dev/null)" ] || return 1
  return 0
}

# Clone from the configured URL only, then check out the pinned commit.
install_pinned() {
  rm -rf "$oracle_dir"
  mkdir -p "$(dirname "$oracle_dir")" || return 1
  git clone --quiet --no-checkout "$ORACLE_REPO_URL" "$oracle_dir" >/dev/null 2>&1 || return 1
  git -C "$oracle_dir" fetch --quiet --depth 1 origin "$ORACLE_REV" >/dev/null 2>&1 || true
  git -C "$oracle_dir" checkout --quiet --detach "$ORACLE_REV" >/dev/null 2>&1 || return 1
  verified
}

case "$event" in
  session-start)
    if ! verified && ! install_pinned; then
      note "could not install saari-co/api-oracle at the pinned revision $ORACLE_REV from $ORACLE_REPO_URL; the cloud environment needs read access to that private repository (attach it to the session)."
    fi
    [ -n "${CLAUDE_ENV_FILE:-}" ] && printf 'export ORACLE_DIR=%q\nexport PATH=%q:$PATH\n' "$oracle_dir" "$oracle_dir/bin" >> "$CLAUDE_ENV_FILE"
    exec "$oracle" cloud-bootstrap
    ;;
  stop|prompt)
    verified || exit 0
    exec "$oracle" hook "$event"
    ;;
  *)
    exit 0
    ;;
esac
