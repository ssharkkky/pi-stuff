# pi-stuff

My [pi](https://pi.dev) extensions, skills, prompt templates, and themes.

## Install

```bash
pi install git:github.com/ssharkkky/pi-stuff
```

## Update

```bash
pi update --extensions
```

After updating, rerun the patch script (see below), then restart pi fully
(quit + relaunch) — `/reload` picks up the extension patches, but the
pi-coding-agent core-bundle patch only loads at process start.

## Fresh machine setup

- pi needs **Node >= 22.19** (`fs.globSync`). On a machine where an older
  node is on PATH (e.g. pcubuntu's `/opt/node20`), install Node 22 (e.g.
  official tarball into `/opt/node22`) and put its `bin` FIRST in PATH —
  both `npm` and `pi` shebangs use `env node`, so whatever node wins the
  PATH is what pi runs on.
- `scripts/reapply-package-patches.sh` locates the pi core bundle chunk via
  `command -v pi`; run it with pi's bin dir on PATH or the core
  click-to-expand patch is silently skipped.
1. Install pi, then `pi install git:github.com/ssharkkky/pi-stuff`
   (this also pulls the other packages listed in settings, or install them:
   `npm:better-claude-code-ui`, `npm:better-custom-provider`,
   `npm:@monotykamary/pi-tps`, `npm:@narumitw/pi-goal`, `npm:pi-mcp-adapter`).
2. Copy `config/settings.example.json` over `~/.pi/agent/settings.json`
   (merge if you already have one), `config/pi-goal.example.json` over
   `~/.pi/agent/pi-goal.json` (enables pi-goal's managed-run RPC, which the
   `goal-autostart` extension needs), `config/mcp.example.json` over
   `~/.config/mcp/mcp.json` (user-global MCP server list for pi-mcp-adapter),
   and `config/models.example.json` over `~/.pi/agent/models.json`
   (custom providers/model list: local llama.cpp server, tokensupply
   antigravity/openai, opencode-zen free models). Keep it in sync across
   machines when the model list changes.
3. Run `scripts/reapply-package-patches.sh`, then restart pi fully (quit +
   relaunch) if a pi process is running.

## Layout

- `extensions/` — TypeScript extensions (custom tools, commands, UI)
- `skills/` — skill packages (each subdir contains a `SKILL.md`)

### Extensions

- **context** — `/context` command: Claude Code-style context usage report
  (block-grid usage bar, per-category breakdown: system prompt / system
  tools / skills / messages / free space). `/context all` expands
  per-tool and per-role token counts. Rendered as a TUI-only transcript
  entry; never sent to the LLM.
- **claude-cc** — drive persistent, non-interactive Claude Code sessions from pi.
- **goal-autostart** — `goal_start` model tool on top of `@narumitw/pi-goal`:
  lets the MODEL start a goal run itself (user entry stays `/goal`). Goes
  through pi-goal's official managed-run RPC (`pi-goal:start` /
  `pi-goal:event:<runId>`), so pi-goal's own safety limits, stale-goal guards
  and `goal_complete`/`goal_blocked`/`goal_wait` termination tools apply
  unchanged. Needs `rpc.enabled: true` in `~/.pi/agent/pi-goal.json`
  (`config/pi-goal.example.json`).
  Tools: `cc_spawn` (start session + first turn), `cc_send` (follow up, blocks
  until the turn finishes), `cc_list`, `cc_attach` (re-attach by raw session uuid,
  e.g. after a pi restart), `cc_close`. Each turn runs `claude -p --resume <id>`
  in the session's original cwd; sessions persist in Claude Code's on-disk store
  and survive pi restarts. Defaults to `--permission-mode acceptEdits`
  (override per call, incl. `bypassPermissions`); 30-min per-turn timeout by
  default. Full per-turn output is saved under `$TMPDIR/pi-cc-sessions/<alias>/`.
- **MCP** — via the `npm:pi-mcp-adapter` package (installed through settings
  `packages`, not a local extension). Registers one `mcp` proxy tool
  (~200 tokens instead of one tool definition per MCP tool): the model runs
  `mcp({ search: ... })` / `mcp({ tool: ..., args: ... })` to discover and
  call server tools on demand; servers are lazy by default (connect on first
  use, idle-timeout disconnect). Manage servers with the `/mcp` panel and
  `/mcp setup` wizard. Server config files (highest precedence first):
  `~/.config/mcp/mcp.json` (user-global, shared across hosts — template:
  `config/mcp.example.json`), `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json`,
  `~/.pi/agent/mcp.json` (pi global override), project `.mcp.json`,
  project `.pi/mcp.json`. JSONC (comments) is supported.
- `prompts/` — prompt templates (`/name` commands)
- `themes/` — theme JSON files
- `scripts/` — maintenance scripts (package patch replay)
- `config/` — templates for fresh machines (`settings.example.json`,
  `pi-goal.example.json`, `mcp.example.json`, `models.example.json`)

## Package patches

`scripts/reapply-package-patches.sh` re-applies local patches to installed npm
packages (idempotent). Run it after `pi update --extensions`; extension-level
patches then apply on `/reload`, the core-bundle patch needs a full pi restart
(quit + relaunch):

- **better-claude-code-ui** — thinking blocks **expanded by default**
  (`extension/thinking.ts`: `thinkingExpanded = false` → `true`); `alt+t`
  still toggles per session.
- **better-claude-code-ui** — **full welcome banner always shown**
  (`extension/banner.ts`: per-project "seen once" gating → `full = true`),
  so every startup in every directory shows the two-column welcome box.
  (To restore the default seen-once behavior, drop that section from the
  script and rerun it after reinstalling the package.)
- **@monotykamary/pi-tps** — **one TPS banner per agent run, not per LLM
  turn** (`extensions/pi-tps/index.ts`). Upstream notifies on every
  `turn_end`, i.e. after each tool-call round, which is noisy. The patch
  keeps the per-turn JSONL persistence (so `/tps-export` and `/tree`
  rehydration are unchanged) but accumulates each turn's telemetry and
  emits a single aggregated banner on `agent_settled` (summed tokens, first
  TTFT, TPS over the summed streaming window, tool execution excluded).
- **@earendil-works/pi-coding-agent** — **per-block click-to-expand**
  (fullscreen TUI; `dist/bundle/chunks/chunk-*.js`, applied via
  `scripts/patches/pi-click-expand.js`, per-replacement idempotent so rounds
  layer cleanly and re-runs are no-ops):
    - *Round 1*: the `[compaction]`, `[branch]` and `[skill]` message blocks
      get a click handler — left-click the block to expand it, click again
      to collapse it (the whole block is the hit area, including its label
      line). Collapsed hints read "(click to expand)"; expanded blocks get a
      dim trailing "(click to collapse)" line.
    - *Round 2*: every **tool block** (`ToolExecutionComponent` — bash/read/
      grep/…, rendered either by pi core or the better-claude-code-ui
      extension) and `/bash:` user commands (`BashExecutionComponent`) are
      click-toggleable the same way; the **startup header** and each
      **loaded-resource section** (`ExpandableText`) are clickable via a
      generic layout-tree path. The **global ctrl+o toggle is removed**
      (`defaultKeys: []`, `onAction` deleted, all core hints rewritten):
      expanding is strictly per-block, with no shared state. The transcript
      hit test maps the pointer to a content row of the scroll view and
      walks the component tree with rendered heights (the layout box tree
      does not mirror plain containers); outside the scroll view the deepest
      layout box whose component carries the `clickToggleExpandable` marker
      is toggled, so unmarked components (editor, status line, …) keep
      normal click/selection behavior. Fullscreen mode only (regular mode
      has no mouse protocol). Verified end-to-end in a PTY:
      `tests/click-expand-e2e.py` (14 checks — expand/collapse for all block
      types, per-block independence, ctrl+o no-op, no-op clicks).
- **better-claude-code-ui** — **CC-style tool rendering cooperates with the
  per-block click** (`extension/tools/{builtins,diff,grouping}.ts`, applied
  via `scripts/patches/bcc-tool-click.js`):
    - bash **collapsed** shows **no output at all** — just the (truncated)
      command header plus one dim placeholder line `⎿ (N lines, click to
      expand)` (failed commands keep their `Exit N` status on that line).
      Independent of the `ccToolsExtraDetail` setting (`alt+o`).
    - bash **expanded** shows the full command and full output with a
      trailing "(click to collapse)"; a truncated collapsed command header
      gets an italic "(+N lines, click to expand)" hint.
    - all remaining "(ctrl+o to expand)" / "ctrl+o to toggle" hints become
      "(click to expand)" / "(click to toggle)"; the shared read/grep/find/
      ls expanded body gets the same trailing "(click to collapse)".

## claude / claude-light themes

Claude Code-inspired warm monochrome palettes (terracotta orange `#D97757`
accents). Set `"theme": "claude-light/claude"` in settings.json to follow
terminal appearance, or pin one with `"claude"` / `"claude-light"`.
