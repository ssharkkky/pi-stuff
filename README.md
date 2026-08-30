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

After updating, rerun the patch script (see below), then `/reload` in pi.

## Fresh machine setup

1. Install pi, then `pi install git:github.com/ssharkkky/pi-stuff`
   (this also pulls the other packages listed in settings, or install them:
   `npm:better-claude-code-ui`, `npm:better-custom-provider`,
   `npm:@monotykamary/pi-tps`, `npm:@narumitw/pi-goal`).
2. Copy `config/settings.example.json` over `~/.pi/agent/settings.json`
   (merge if you already have one), and `config/pi-goal.example.json` over
   `~/.pi/agent/pi-goal.json` (enables pi-goal's managed-run RPC, which the
   `goal-autostart` extension needs).
3. Run `scripts/reapply-package-patches.sh`, then `/reload` in pi.

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
- `prompts/` — prompt templates (`/name` commands)
- `themes/` — theme JSON files
- `scripts/` — maintenance scripts (package patch replay)
- `config/` — settings templates (`settings.example.json` for fresh machines)

## Package patches

`scripts/reapply-package-patches.sh` re-applies local patches to installed npm
packages (idempotent). Run it after `pi update --extensions`, then `/reload`:

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

## claude / claude-light themes

Claude Code-inspired warm monochrome palettes (terracotta orange `#D97757`
accents). Set `"theme": "claude-light/claude"` in settings.json to follow
terminal appearance, or pin one with `"claude"` / `"claude-light"`.
