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

## Layout

- `extensions/` — TypeScript extensions (custom tools, commands, UI)
- `skills/` — skill packages (each subdir contains a `SKILL.md`)

### Extensions

- **claude-cc** — drive persistent, non-interactive Claude Code sessions from pi.
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

## Package patches

`scripts/reapply-package-patches.sh` re-applies local patches to installed npm
packages (idempotent). Run it after `pi update --extensions`, then `/reload`:

- **better-claude-code-ui** — thinking blocks **expanded by default**
  (`extension/thinking.ts`: `thinkingExpanded = false` → `true`); `alt+t`
  still toggles per session.

## claude / claude-light themes

Claude Code-inspired warm monochrome palettes (terracotta orange `#D97757`
accents). Set `"theme": "claude-light/claude"` in settings.json to follow
terminal appearance, or pin one with `"claude"` / `"claude-light"`.
