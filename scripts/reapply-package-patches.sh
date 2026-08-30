#!/bin/sh
# Reapply local patches to installed pi packages after `pi update --extensions`.
#
# Currently applies:
#   better-claude-code-ui: thinking blocks expanded by default
#   (extension/thinking.ts: `let thinkingExpanded = false;` -> `true;`)
#   better-claude-code-ui: always show the full welcome banner
#   (extension/banner.ts: per-project "seen" gating -> `full = true`)
#   @monotykamary/pi-tps: one TPS banner per agent run instead of per LLM turn
#   (extensions/pi-tps/index.ts: turn_end notify -> accumulate; new agent_settled
#    handler shows the aggregated run banner; per-turn JSONL persistence kept)
#   @earendil-works/pi-coding-agent: per-block click-to-expand in the TUI
#   (fullscreen mode; dist/bundle/chunks/chunk-*.js; see
#    scripts/patches/pi-click-expand.js):
#     round 1: [compaction]/[branch]/[skill] message blocks
#     round 2: every tool block (ToolExecutionComponent) + /bash: user
#              commands (BashExecutionComponent) + startup header / loaded
#              resource sections; the GLOBAL ctrl+o toggle is removed
#              (per-block click only)
#   better-claude-code-ui: CC-style tool rendering cooperates with the core
#   patch (scripts/patches/bcc-tool-click.js): bash collapsed shows NO
#   output (command header + one "(N lines, click to expand)" placeholder
#   line, independent of ccToolsExtraDetail); expanded shows the full
#   command/output with a "(click to collapse)" footer; all remaining hints
#   use click wording
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
    # portable in-place replace (macOS + GNU sed); `.*` swallows the rest
    # of the original expression
    if sed --version >/dev/null 2>&1; then
      sed -i "s|const full = state.version.*|const full = true; // patched: always show full welcome banner (pi-stuff)|" "$BANNER_TS"
    else
      sed -i "" "s|const full = state.version.*|const full = true; // patched: always show full welcome banner (pi-stuff)|" "$BANNER_TS"
    fi
    echo "patched: better-claude-code-ui always show full welcome banner"
    PATCHED=1
  else
    echo "ok:      better-claude-code-ui banner already patched"
  fi
else
  echo "skip:      better-claude-code-ui not installed"
fi

# --- @monotykamary/pi-tps: one TPS banner per agent run -------------------
TPS_TS="$AGENTS_DIR/npm/node_modules/@monotykamary/pi-tps/extensions/pi-tps/index.ts"
if [ -f "$TPS_TS" ]; then
  if grep -q "runTelemetry.push(telemetry)" "$TPS_TS"; then
    echo "ok:      @monotykamary/pi-tps already patched (run-level TPS banner)"
  else
    TPS_TMP="$(mktemp -d)"
    # state: run-level accumulator (inserted after `let currentTiming`)
    cat > "$TPS_TMP/state.inc" <<'TPS_STATE_EOF'

  // (pi-stuff patch) Run-level accumulator: aggregate per-turn telemetry and
  // show one TPS banner per agent run on agent_settled (was: per LLM turn).
  let runTelemetry: TurnTelemetry[] = [];
TPS_STATE_EOF
    # top-level: AgentSettledEvent iface + run aggregator (before buildTelemetry)
    cat > "$TPS_TMP/func.inc" <<'TPS_FUNC_EOF'
// (pi-stuff patch) Local mirror of pi's AgentSettledEvent (see public API).
interface AgentSettledEvent {
  type: 'agent_settled';
}

/**
 * (pi-stuff patch) Aggregate per-turn telemetry of one agent run into a
 * single run-level telemetry: summed tokens/timing, first TTFT, TPS
 * recomputed over the summed streaming window (tool execution excluded).
 */
function aggregateRunTelemetry(turns: TurnTelemetry[]): TurnTelemetry {
  const first = turns[0];
  const tokens = turns.reduce(
    (a, t) => ({
      input: a.input + t.tokens.input,
      output: a.output + t.tokens.output,
      cacheRead: a.cacheRead + t.tokens.cacheRead,
      cacheWrite: a.cacheWrite + t.tokens.cacheWrite,
      total: a.total + t.tokens.total
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  );
  const timing = turns.reduce(
    (a, t) => ({
      ttftMs: a.ttftMs !== null ? a.ttftMs : t.timing.ttftMs, // first token of the run
      totalMs: a.totalMs + t.timing.totalMs,
      generationMs: a.generationMs + t.timing.generationMs,
      streamMs: (a.streamMs ?? 0) + (t.timing.streamMs ?? 0),
      stallMs: a.stallMs + t.timing.stallMs,
      stallCount: a.stallCount + t.timing.stallCount,
      messageCount: a.messageCount + t.timing.messageCount
    }),
    { ttftMs: null as number | null, totalMs: 0, generationMs: 0, streamMs: 0, stallMs: 0, stallCount: 0, messageCount: 0 }
  );
  const allCosted = turns.every((t) => t.cost !== null);
  const cost = allCosted
    ? turns.reduce(
        (a, t) => ({
          input: a.input + t.cost!.input,
          output: a.output + t.cost!.output,
          cacheRead: a.cacheRead + t.cost!.cacheRead,
          cacheWrite: a.cacheWrite + t.cost!.cacheWrite,
          total: a.total + t.cost!.total
        }),
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      )
    : null;
  // Same measurement guards as the per-turn calculation, applied to the
  // summed streaming window (pure generation time).
  let tps: number | null = null;
  let isPrimaryBranch = false;
  if (
    timing.streamMs >= 50 &&
    timing.stallMs < timing.streamMs &&
    timing.streamMs - timing.stallMs >= 50
  ) {
    const effectiveStreamMs = timing.streamMs - timing.stallMs;
    tps = Math.round((tokens.output / (effectiveStreamMs / 1000)) * 10) / 10;
    isPrimaryBranch = true;
  } else if (timing.generationMs >= 200) {
    tps = Math.round((tokens.output / (timing.generationMs / 1000)) * 10) / 10;
  }
  const rateUsdPerMTokens =
    cost !== null && cost.total > 0 && tokens.total > 0
      ? Math.round((cost.total / (tokens.total / 1_000_000)) * 100) / 100
      : null;
  return {
    model: first.model,
    tokens,
    timing: {
      ttftMs: timing.ttftMs,
      totalMs: timing.totalMs,
      generationMs: timing.generationMs,
      streamMs: timing.streamMs > 0 ? timing.streamMs : null,
      stallMs: timing.stallMs,
      stallCount: timing.stallCount,
      messageCount: timing.messageCount
    },
    tps,
    isPrimaryBranch,
    cost,
    rateUsdPerMTokens,
    timestamp: first.timestamp
  };
}

TPS_FUNC_EOF
    # handler: aggregate + notify once per agent run (before Export commands)
    cat > "$TPS_TMP/handler.inc" <<'TPS_HAND_EOF'
  // (pi-stuff patch) One TPS banner per agent run: on agent_settled, show
  // the aggregated telemetry of all LLM turns of the conversation (was:
  // a banner on every turn_end, i.e. after each tool-call round).
  pi.on('agent_settled', (_event: AgentSettledEvent, ctx: ExtensionContext) => {
    const turns = runTelemetry;
    runTelemetry = [];
    if (turns.length === 0 || !ctx.hasUI) return;
    const run = turns.length === 1 ? turns[0] : aggregateRunTelemetry(turns);
    ctx.ui.notify(composeDisplayString(run), 'info');
  });

TPS_HAND_EOF
    # Single awk pass: 3 insertions + notify-block replacement. POSIX awk
    # (works on macOS BSD awk and GNU gawk/mawk); anchors are exact lines.
    awk -v statef="$TPS_TMP/state.inc" -v funcf="$TPS_TMP/func.inc" -v handf="$TPS_TMP/handler.inc" '
      !ins_state && /^  let currentTiming: TurnTiming \| null = null;$/ {
        print
        while ((getline l < statef) > 0) print l
        ins_state = 1
        next
      }
      !ins_func && /^function buildTelemetry\($/ {
        while ((getline l < funcf) > 0) print l
        print
        ins_func = 1
        next
      }
      !ins_hand && index($0, "// ── Export commands") == 3 {
        while ((getline l < handf) > 0) print l
        print
        ins_hand = 1
        next
      }
      /^    \/\/ Show notification only when UI is available$/ {
        print "    // (pi-stuff patch) Accumulate per-turn telemetry; the banner"
        print "    // is shown once per agent run on agent_settled (was: notify on every turn_end)."
        print "    runTelemetry.push(telemetry);"
        skip = 4
        next
      }
      skip > 0 { skip--; next }
      { print }
    ' "$TPS_TS" > "$TPS_TMP/index.patched"
    # Verify all 4 patch markers landed and the old notify block is gone.
    if grep -q "runTelemetry.push(telemetry)" "$TPS_TMP/index.patched" \
      && grep -q "let runTelemetry" "$TPS_TMP/index.patched" \
      && grep -q "function aggregateRunTelemetry" "$TPS_TMP/index.patched" \
      && grep -q "pi.on('agent_settled'" "$TPS_TMP/index.patched" \
      && ! grep -q "Show notification only when UI is available" "$TPS_TMP/index.patched"; then
      mv "$TPS_TMP/index.patched" "$TPS_TS"
      echo "patched: @monotykamary/pi-tps run-level TPS banner (one per agent run)"
      PATCHED=1
    else
      echo "warn:    @monotykamary/pi-tps patch anchors changed upstream; manual review needed"
    fi
    rm -rf "$TPS_TMP"
  fi
else
  echo "skip:      @monotykamary/pi-tps not installed"
fi

# --- @earendil-works/pi-coding-agent: click-to-expand messages -------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PI_PATCHER="$SCRIPT_DIR/patches/pi-click-expand.js"
PI_BIN="$(command -v pi || true)"
PI_PKG_ROOT=""
if [ -n "$PI_BIN" ] && command -v node >/dev/null 2>&1; then
  # pi is a symlink to <pkg>/dist/bundle/cli.js -> 3 dirnames up = package root
  PI_PKG_ROOT="$(node -e '
    const fs=require("node:fs"),p=require("node:path");
    try{const r=fs.realpathSync(process.argv[1]);console.log(p.dirname(p.dirname(p.dirname(r))))}catch{}
  ' "$PI_BIN" 2>/dev/null || true)"
fi
PI_CHUNK=""
if [ -n "$PI_PKG_ROOT" ] && [ -d "$PI_PKG_ROOT/dist/bundle/chunks" ]; then
  for f in "$PI_PKG_ROOT/dist/bundle/chunks"/chunk-*.js; do
    if [ -f "$f" ] && grep -q "CompactionSummaryMessageComponent" "$f"; then
      PI_CHUNK="$f"; break
    fi
  done
fi
if [ -n "$PI_CHUNK" ] && [ -f "$PI_PATCHER" ] && command -v node >/dev/null 2>&1; then
  if node "$PI_PATCHER" "$PI_CHUNK"; then
    echo "ok:      pi-coding-agent click-to-expand applied (or already applied)"
    PATCHED=1
  else
    echo "warn:    pi-coding-agent click-to-expand patch failed; manual review needed"
  fi
else
  echo "skip:      pi-coding-agent bundle chunk not found (or node missing)"
fi

# --- better-claude-code-ui: per-block click-to-expand for tool blocks ------
BCC_PKG="$AGENTS_DIR/npm/node_modules/better-claude-code-ui"
BCC_PATCHER="$SCRIPT_DIR/patches/bcc-tool-click.js"
if [ -d "$BCC_PKG" ] && [ -f "$BCC_PATCHER" ] && command -v node >/dev/null 2>&1; then
  if node "$BCC_PATCHER" "$BCC_PKG"; then
    echo "ok:      better-claude-code-ui tool click-to-expand applied (or already applied)"
    PATCHED=1
  else
    echo "warn:    better-claude-code-ui tool click-to-expand failed; manual review needed"
  fi
else
  echo "skip:      better-claude-code-ui tool click-to-expand not applicable"
fi

if [ "$PATCHED" -eq 1 ]; then
  echo "done. Extension-level patches (pi-tps, better-claude-code-ui) apply on"
  echo "/reload; the pi-coding-agent core-chunk patch needs a FULL pi restart"
  echo "(quit + relaunch), not just /reload."
fi || true
