#!/usr/bin/env node
/**
 * (pi-stuff patch) better-claude-code-ui: per-block click-to-expand for tool
 * call/result blocks; drop the global ctrl+o hint.
 *
 * The extension renders pi's ToolExecutionComponent via renderCall/renderResult,
 * which already receive `expanded` in the RenderContext. pi-stuff's core
 * patch (pi-click-expand.js) marks ToolExecutionComponent as click-toggleable,
 * so a click on a tool block toggles exactly that block. This patch makes the
 * CC-style rendering cooperate:
 *
 *   builtins.ts:
 *   - bash renderCall: expanded state shows the FULL command; the collapsed
 *     truncated state gains an italic "(+N lines, click to expand)" hint.
 *   - bash renderResult collapsed: NO output preview — a single dim
 *     "(N lines, click to expand)" placeholder line (failed commands keep
 *     their "Exit N" status on the same line). Full output only when the
 *     block is clicked open; independent of the ccToolsExtraDetail setting.
 *   - renderTruncatedContent footer: "(ctrl+o to expand)" -> "(click to expand)"
 *   - write-tool preview hint: same
 *   - bash expanded body: trailing "(click to collapse)" footer
 *   - expandedStatBody (read/grep/find/ls expanded body): same footer
 *   diff.ts:     toggleHint "ctrl+o to toggle" -> "click to toggle"
 *   grouping.ts: group footer "(ctrl+o to expand)" -> "(click to expand)"
 *
 * Idempotent per replacement (skip when the result is present, error when
 * neither anchor nor result is found => extension version changed).
 *
 * Usage: node bcc-tool-click.js <better-claude-code-ui package root>
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = process.argv[2];
if (!root || !fs.existsSync(root)) {
  console.error('usage: bcc-tool-click.js <package-root>');
  process.exit(2);
}

const T = '\t'; // the extension sources use tabs

const files = {
  'extension/tools/builtins.ts': [
    [
      T + T + T + 'const summary = truncateCommand(String(args?.command ?? ""));\n' +
        T + T + T + 'const header = toolHeader("Bash", summary, theme, statusDot(c, theme));\n' +
        T + T + T + 'return makeText(c.lastComponent, header + liveLineCountTrailing(c, theme));',
      T + T + T + 'const command = String(args?.command ?? "");\n' +
        T + T + T + 'const truncated = truncateCommand(command);\n' +
        T + T + T + 'const summary = c.expanded ? command : truncated;\n' +
        T + T + T + 'let expandHint = "";\n' +
        T + T + T + 'if (!c.expanded && truncated !== command) {\n' +
        T + T + T + T + 'const hiddenLines = Math.max(0, command.split("\\n").length - MAX_COMMAND_DISPLAY_LINES);\n' +
        T + T + T + T + 'expandHint = ` ${italic(`(${hiddenLines > 0 ? `+${hiddenLines} lines, ` : ""}click to expand)`)}`;\n' +
        T + T + T + '}\n' +
        T + T + T + 'const header = toolHeader("Bash", summary, theme, statusDot(c, theme));\n' +
        T + T + T + 'return makeText(c.lastComponent, header + expandHint + liveLineCountTrailing(c, theme));',
    ],
    [
      T + 'const suffix = options.expandHint === false ? "" : ` ${italic("(ctrl+o to expand)")}`;',
      T + 'const suffix = options.expandHint === false ? "" : ` ${italic("(click to expand)")}`;',
    ],
    [
      T + T + T + T + 'body += `\\n${italic(theme.fg("dim", "(ctrl+o to expand)"))}`;',
      T + T + T + T + 'body += `\\n${italic(theme.fg("dim", "(click to expand)"))}`;',
    ],
    [
      'const body = renderTruncatedContent(collected.lines.join("\\n"), contentWidth, MAX_RENDER_LINES, theme, (l) => l, {\n' +
        T + T + T + T + T + T + 'expandHint: false,\n' +
        T + T + T + T + T + '});\n' +
        T + T + T + T + T + 'return status ? `${status}\\n${body}` : body;',
      'const body = renderTruncatedContent(collected.lines.join("\\n"), contentWidth, MAX_RENDER_LINES, theme, (l) => l, {\n' +
        T + T + T + T + T + T + 'expandHint: false,\n' +
        T + T + T + T + T + '});\n' +
        T + T + T + T + T + 'const collapseHint = `\\n${italic(theme.fg("dim", "(click to collapse)"))}`;\n' +
        T + T + T + T + T + 'return status ? `${status}\\n${body}${collapseHint}` : `${body}${collapseHint}`;',
    ],
    [
      T + T + 'const body = renderTruncatedContent(joined, contentWidth, MAX_RENDER_LINES, theme, (l) => theme.fg("dim", l), {\n' +
        T + T + T + 'expandHint: false,\n' +
        T + T + '});\n' +
        T + T + 'return body === "" ? stat : `${stat}\\n${body}`;',
      T + T + 'const body = renderTruncatedContent(joined, contentWidth, MAX_RENDER_LINES, theme, (l) => theme.fg("dim", l), {\n' +
        T + T + T + 'expandHint: false,\n' +
        T + T + '});\n' +
        T + T + 'return body === "" ? stat : `${stat}\\n${body}\\n${italic(theme.fg("dim", "(click to collapse)"))}`;',
    ],
    [
      T + T + T + 'const key = `collapsed\\u0000${failed}\\u0000${exitCode}\\u0000${previewLimit()}\\u0000${output}`;\n' +
        T + T + T + 'return widthBudgetedBody(c.lastComponent, theme, key, (contentWidth) => {\n' +
        T + T + T + T + 'const body = renderTruncatedContent(collected.lines.join("\\n"), contentWidth, previewLimit(), theme, (l) =>\n' +
        T + T + T + T + T + 'theme.fg("dim", l),\n' +
        T + T + T + T + ');\n' +
        T + T + T + T + 'return status ? `${status}\\n${body}` : body;\n' +
        T + T + T + '});',
      T + T + T + '// (pi-stuff patch) Collapsed: no output preview — a single placeholder\n' +
        T + T + T + '// line keeps the block compact (command header + hint); the full output\n' +
        T + T + T + '// appears only when the block is clicked open.\n' +
        T + T + T + 'const collapsedHint = theme.fg("dim", `(${collected.total} line${collected.total === 1 ? "" : "s"}, click to expand)`);\n' +
        T + T + T + 'return cachedText(c.lastComponent, withResultLead(theme, status ? `${status} ${collapsedHint}` : collapsedHint));',
    ],
  ],
  'extension/tools/diff.ts': [
    ['toggleHint = "ctrl+o to toggle"', 'toggleHint = "click to toggle"'],
  ],
  'extension/tools/grouping.ts': [
    [
      'const hint = italic(theme.fg("dim", "(ctrl+o to expand)"));',
      'const hint = italic(theme.fg("dim", "(click to expand)"));',
    ],
  ],
};

let totalApplied = 0;
let totalSkipped = 0;
const patched = {};

for (const [rel, replacements] of Object.entries(files)) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    console.error('error: ' + rel + ' not found under ' + root);
    process.exit(1);
  }
  let src = fs.readFileSync(file, 'utf8');
  let applied = 0;
  let skipped = 0;
  for (const [oldStr, newStr] of replacements) {
    if (src.includes(newStr)) {
      skipped++;
      continue;
    }
    const count = src.split(oldStr).length - 1;
    if (count === 0) {
      console.error(
        'error: anchor not found in ' + rel + ' (extension version change? review needed): ' +
          JSON.stringify(oldStr.slice(0, 80))
      );
      process.exit(1);
    }
    if (count !== 1) {
      console.error(
        'error: anchor found ' + count + ' times (expected 1) in ' + rel + ': ' +
          JSON.stringify(oldStr.slice(0, 80))
      );
      process.exit(1);
    }
    src = src.replace(oldStr, newStr);
    applied++;
  }
  patched[rel] = src;
  totalApplied += applied;
  totalSkipped += skipped;
  console.log(
    rel + ': applied ' + applied + ', already-applied ' + skipped
  );
}

// Syntax-check each patched TS file before writing (esbuild if available).
function esbuildCmd() {
  const candidates = [
    ['npx', '--no-install', 'esbuild'],
    ['npx', '--yes', 'esbuild'],
  ];
  for (const cmd of candidates) {
    try {
      execFileSync(cmd[0], cmd.slice(1).concat(['--version']), { stdio: 'pipe' });
      return cmd;
    } catch {
      // try next
    }
  }
  return null;
}
const eb = esbuildCmd();
if (eb) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcc-tool-click-'));
  for (const [rel, content] of Object.entries(patched)) {
    const tmp = path.join(dir, path.basename(rel));
    fs.writeFileSync(tmp, content);
    try {
      // .ts extension => ts loader is inferred automatically
      execFileSync(eb[0], eb.slice(1).concat([tmp, '--format=esm', '--outfile=' + path.join(dir, 'check-' + path.basename(rel) + '.js')]), { stdio: 'pipe' });
    } catch (e) {
      console.error('error: ' + rel + ' failed syntax check: ' + (e.stderr ? e.stderr.toString() : e.message));
      process.exit(1);
    }
  }
} else {
  console.warn('warn: esbuild not available; skipping TS syntax check');
}

for (const [rel, content] of Object.entries(patched)) {
  fs.writeFileSync(path.join(root, rel), content);
}
console.log(
  'patched: better-claude-code-ui tool click-to-expand — applied ' +
    totalApplied + ', already-applied ' + totalSkipped
);
