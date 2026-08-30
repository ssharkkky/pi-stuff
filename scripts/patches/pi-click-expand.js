#!/usr/bin/env node
/**
 * (pi-stuff patch) @earendil-works/pi-coding-agent: click-to-expand for the
 * message-level expandable blocks in the TUI transcript (fullscreen mode).
 *
 * What it changes (all in dist/bundle/chunks/chunk-*.js, the runtime bundle):
 *   1. CompactionSummaryMessageComponent / BranchSummaryMessageComponent /
 *      SkillInvocationMessageComponent get a `clickToggleExpandable` marker.
 *   2. TuiAltScreen gets `handleClickExpandable(event)`: a left mouse press
 *      (no drag, no release, no overlay open) inside the transcript scroll
 *      view is hit-tested against the layout tree (content coordinates via
 *      the scroll view box + scrollTop); the deepest ancestor box whose
 *      component carries the marker is toggled with `setExpanded(!expanded)`.
 *      The event is consumed (no text selection starts); non-matching clicks
 *      fall through to the normal selection behavior.
 *   3. Hint text: collapsed state "(ctrl+o to expand)" -> "(click to expand)";
 *      expanded state gains a dim trailing "(click to collapse)" line.
 *   4. The global ctrl+o (app.tools.expand) toggle is untouched and keeps
 *      working on all of these components.
 *
 * Idempotent: no-op (exit 0, "already patched") when the marker exists.
 * Usage: node pi-click-expand.js <path-to-chunk-file>
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const target = process.argv[2];
if (!target || !fs.existsSync(target)) {
  console.error('usage: pi-click-expand.js <chunk-file>');
  process.exit(2);
}

let src = fs.readFileSync(target, 'utf8');

if (src.includes('clickToggleExpandable')) {
  console.log('already patched');
  process.exit(0);
}

const NL = '\n';
const EXPANDED_HINT =
  ',this.addChild(new Text(theme.fg("dim","(click to collapse)"),0,0))';
const MARKDOWN_SUMMARY =
  'this.addChild(new Markdown(header+this.message.summary,0,0,this.markdownTheme,{color:text=>theme.fg("customMessageText",text)}))';

// [old, new] pairs; every `old` must occur exactly once.
const replacements = [
  // ── 1. mark the three message components as click-toggleable ─────────
  [
    'var CompactionSummaryMessageComponent=class extends Box{expanded=!1;message;markdownTheme;',
    'var CompactionSummaryMessageComponent=class extends Box{expanded=!1;clickToggleExpandable=!0;message;markdownTheme;',
  ],
  [
    'var BranchSummaryMessageComponent=class extends Box{expanded=!1;message;markdownTheme;',
    'var BranchSummaryMessageComponent=class extends Box{expanded=!1;clickToggleExpandable=!0;message;markdownTheme;',
  ],
  [
    'var SkillInvocationMessageComponent=class extends Box{expanded=!1;skillBlock;markdownTheme;',
    'var SkillInvocationMessageComponent=class extends Box{expanded=!1;clickToggleExpandable=!0;skillBlock;markdownTheme;',
  ],
  // ── 2. collapsed-state hint: "(ctrl+o to expand)" -> "(click to expand)"
  [
    'Compacted from ${tokenStr} tokens (`)+theme.fg("dim",keyText("app.tools.expand"))',
    'Compacted from ${tokenStr} tokens (`)+theme.fg("dim","click")',
  ],
  [
    '"Branch summary (")+theme.fg("dim",keyText("app.tools.expand"))',
    '"Branch summary (click to expand)")'.slice(0, 0) +
      '"Branch summary (")+theme.fg("dim","click")',
  ],
  [
    'this.skillBlock.name)+theme.fg("dim",` (${keyText("app.tools.expand")} to expand)`)',
    'this.skillBlock.name)+theme.fg("dim"," (click to expand)")',
  ],
  // ── 3. expanded-state hint: trailing dim "(click to collapse)" ────────
  [
    'let header=`**Compacted from ${tokenStr} tokens**' + NL + NL + '`;' + MARKDOWN_SUMMARY + '}else',
    'let header=`**Compacted from ${tokenStr} tokens**' + NL + NL + '`;' + MARKDOWN_SUMMARY + EXPANDED_HINT + '}else',
  ],
  [
    'let header=`**Branch Summary**' + NL + NL + '`;' + MARKDOWN_SUMMARY + '}else',
    'let header=`**Branch Summary**' + NL + NL + '`;' + MARKDOWN_SUMMARY + EXPANDED_HINT + '}else',
  ],
  [
    'this.addChild(new Markdown(header+this.skillBlock.content,0,0,this.markdownTheme,{color:text=>theme.fg("customMessageText",text)}))}',
    'this.addChild(new Markdown(header+this.skillBlock.content,0,0,this.markdownTheme,{color:text=>theme.fg("customMessageText",text)}))' +
      EXPANDED_HINT +
      '}',
  ],
  // ── 4. mouse chain: route left presses through handleClickExpandable ──
  [
    'if(mouseEvent){if(this.handleRightClickPaste(mouseEvent))return{consume:!0};let handled=this.handleScrollbarMouseEvent(mouseEvent);return this.scrollbarDrag||this.updateScrollbarHover(mouseEvent.x,mouseEvent.y),handled||this.handleSelectionMouseEvent(mouseEvent),{consume:!0}}',
    'if(mouseEvent){if(this.handleRightClickPaste(mouseEvent))return{consume:!0};let handled=this.handleScrollbarMouseEvent(mouseEvent);return this.scrollbarDrag||this.updateScrollbarHover(mouseEvent.x,mouseEvent.y),handled||this.handleClickExpandable(mouseEvent)||this.handleSelectionMouseEvent(mouseEvent),{consume:!0}}',
  ],
  // ── 5. the handler itself (inserted before handleSelectionMouseEvent) ──
  // The layout box tree does NOT mirror plain Containers (the transcript
  // document is one opaque box), so the hit test walks the real component
  // tree: the scroll box's child component is the document container, and
  // Container.render is the exact concatenation of its children's renders,
  // so cumulative rendered heights map content rows to components.
  [
    'handleSelectionMouseEvent(event){',
    (
      'handleClickExpandable(event){' +
      'if((event.button&3)!==0||event.release||(event.button&32)!==0||this.hasOverlay())return!1;' +
      'if(!this.currentLayout)return!1;' +
      'let scrollView=getScrollViewsAt(this.currentLayout,event.x,event.y)[0];if(!scrollView)return!1;' +
      'let box=getScrollViewBox(this.currentLayout,scrollView);if(!box||box.rect.height<=0)return!1;' +
      'let contentRow=scrollView.scrollTop+event.y-box.rect.y,contentCol=event.x-box.rect.x;' +
      'let lines=box.scrollContentLines;if(!lines||contentRow<0||contentRow>=lines.length)return!1;' +
      'if(contentCol<0||contentCol>visibleWidth(lines[contentRow]??""))return!1;' +
      'let root=box.children[0]?.component;if(!root||!root.children)return!1;' +
      'let width=box.rect.width;' +
      'const walk=(cont,row)=>{let offset=0;for(let child of cont.children){let h;try{h=child.render(width).length}catch(e){h=1}' +
      'if(row>=offset&&row<offset+h){if(child.clickToggleExpandable)return child;if(child.children)return walk(child,row-offset);return child}' +
      'offset+=h}return undefined};' +
      'let comp=walk(root,contentRow);if(!comp||typeof comp.setExpanded!="function")return!1;' +
      'comp.setExpanded(!comp.expanded);this.requestRender();return!0}'
    ) + 'handleSelectionMouseEvent(event){',
  ],
];

let out = src;
for (const [oldStr, newStr] of replacements) {
  const count = out.split(oldStr).length - 1;
  if (count !== 1) {
    console.error(
      'error: anchor found ' +
        count +
        ' times (expected 1): ' +
        JSON.stringify(oldStr.slice(0, 80))
    );
    process.exit(1);
  }
  out = out.replace(oldStr, newStr);
}

// Syntax-check the patched bundle (ESM) before touching the real file.
const tmp = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'pi-click-expand-')),
  'chunk-check.mjs'
);
fs.writeFileSync(tmp, out);
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
} catch (e) {
  console.error('error: patched bundle failed syntax check: ' + e.message);
  process.exit(1);
}
fs.writeFileSync(target, out);
console.log('patched: click-to-expand for [compaction]/[branch]/[skill] messages');
