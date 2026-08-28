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
