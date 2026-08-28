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

## context-bar extension

Renders context usage as a progress bar inside the powerline footer row, in the
context slot (e.g. `████░░░░░░ 108k/262k (41%)`). It publishes the bar as an
extension status (`ctx-bar`), refreshed on `session_start` and `message_end`;
[pi-powerline-footer](https://www.npmjs.com/package/pi-powerline-footer) renders
it via `customItems` and re-paints on every change.

To use it, install `pi-powerline-footer` and add to `~/.pi/agent/settings.json`
(merge with existing `powerline` config):

```json
{
  "powerline": {
    "customItems": [
      { "id": "ctx_bar", "statusKey": "ctx-bar", "selfColorize": true }
    ],
    "layout": {
      "left": ["model", "thinking", "shell_mode", "path", "git", "queue", "custom:ctx_bar", "cache_read", "cost"]
    }
  }
}
```

(`layout.left` is a full segment list — put `custom:ctx_bar` wherever you want
the bar, and omit `context_pct` if the bar should replace the text segment.)

**Footer colors** live in a separate file — `~/.pi/agent/extensions/powerline-footer/theme.json`
(powerline does *not* read colors from settings.json). Values can be hex or
**pi theme tokens** (`text`, `muted`, `dim`, ...), so the footer follows whatever
pi theme is active (pair with the `claude` / `claude-light` themes in this repo
for a warm monochrome look). Note: `think:high/xhigh/max` use powerline's
built-in rainbow regardless of theme.)

## claude / claude-light themes

Claude Code-inspired warm monochrome palettes (terracotta orange `#D97757`
accents). Set `"theme": "claude-light/claude"` in settings.json to follow
terminal appearance, or pin one with `"claude"` / `"claude-light"`.
