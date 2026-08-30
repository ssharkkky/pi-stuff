#!/bin/sh
# Reapply local patches to installed pi packages after `pi update --extensions`.
#
# Currently applies:
#   better-claude-code-ui: thinking blocks expanded by default
#   (extension/thinking.ts: `let thinkingExpanded = false;` -> `true;`)
#   better-claude-code-ui: always show the full welcome banner
#   (extension/banner.ts: per-project "seen" gating -> `full = true`)
#
# Usage: ./scripts/reapply-package-patches.sh   (idempotent, safe to rerun)

set -e

AGENTS_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
PATCHED=0

# --- better-claude-code-ui: thinking expanded by default -----------------
THINKING_TS="$AGENTS_DIR/npm/node_modules/better-claude-code-ui/extension/thinking.ts"
if [ -f "$THINKING_TS" ]; then
  if grep -q "thinkingExpanded = false" "$THINKING_TS"; then
    # portable in-place replace (macOS + GNU sed)
    if sed --version >/dev/null 2>&1; then
      sed -i "s/let thinkingExpanded = false;/let thinkingExpanded = true; \/\/ patched: expanded by default (pi-stuff)/" "$THINKING_TS"
    else
      sed -i "" "s/let thinkingExpanded = false;/let thinkingExpanded = true; \/\/ patched: expanded by default (pi-stuff)/" "$THINKING_TS"
    fi
    echo "patched: better-claude-code-ui thinking expanded by default"
    PATCHED=1
  else
    echo "ok:      better-claude-code-ui already patched (or updated)"
  fi
else
  echo "skip:      better-claude-code-ui not installed"
fi

# --- better-claude-code-ui: always show full welcome banner -----------
BANNER_TS="$AGENTS_DIR/npm/node_modules/better-claude-code-ui/extension/banner.ts"
if [ -f "$BANNER_TS" ]; then
  if grep -q "const full = state.version" "$BANNER_TS"; then
    if sed --version >/dev/null 2>&1; then
      sed -i 's|const full = state.version.*|const full = true; // patched: always full welcome banner (pi-stuff)|' "$BANNER_TS"
    else
      sed -i '' 's|const full = state.version.*|const full = true; // patched: always full welcome banner (pi-stuff)|' "$BANNER_TS"
    fi
    echo "patched: better-claude-code-ui always full welcome banner"
    PATCHED=1
  else
    echo "ok:      better-claude-code-ui banner already patched (or updated)"
  fi
else
  echo "skip:      better-claude-code-ui not installed"
fi

[ "$PATCHED" -eq 1 ] && echo "done. /reload pi to apply." || true
