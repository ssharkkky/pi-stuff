#!/usr/bin/env node
/**
 * (pi-stuff patch) @earendil-works/pi-coding-agent: click-to-expand in the
 * TUI (fullscreen mode). Per-block expand/collapse on mouse click, no global
 * toggle.
 *
 * All changes are in dist/bundle/chunks/chunk-*.js, the runtime bundle.
 *
 * Round 1 (message-level blocks):
 *   1. CompactionSummaryMessageComponent / BranchSummaryMessageComponent /
 *      SkillInvocationMessageComponent get a `clickToggleExpandable` marker.
 *   2. TuiAltScreen gets `handleClickExpandable(event)`, wired into the mouse
 *      chain (after scrollbar handling, before text selection): a left press
 *      inside the transcript scroll view is hit-tested against the component
 *      tree (rendered heights) and the marked block under the pointer is
 *      toggled with `setExpanded(!expanded)`. Non-matching clicks fall
 *      through to normal text selection.
 *   3. Hints: "(ctrl+o to expand)" -> "(click to expand)"; expanded state
 *      gains a dim trailing "(click to collapse)" line.
 *
 * Round 2 (per-block only, global toggle removed):
 *   4. ToolExecutionComponent (every tool call/result block, including the
 *      CC-style bash rendering from better-claude-code-ui) and
 *      BashExecutionComponent (`/bash:` user commands) get the marker, so
 *      each tool block is independently click-toggleable.
 *   5. The global `ctrl+o` (app.tools.expand) binding is removed:
 *      defaultKeys -> [], the onAction handler is deleted, and all core
 *      hint texts that referenced it now say "click to expand" /
 *      "click to collapse".
 *   6. ExpandableText (startup header, loaded-resource sections) tracks its
 *      expansion state and gets the marker; handleClickExpandable gains a
 *      generic layout-tree path: outside the transcript scroll view, the
 *      deepest layout box at the pointer whose component carries the marker
 *      is toggled (startup header + each loaded-resource section).
 *
 * Idempotency is PER REPLACEMENT. Each spec is [old, new, mode?, marker?]:
 *   - marker: explicit "already applied" detector (default: for insertions
 *     where old is a substring of new, the new text itself). Checked FIRST:
 *     if the marker is present, the replacement is skipped. This is what
 *     keeps R1-5 (handler insertion) from re-firing after R2-5 replaces the
 *     R1 handler body (which destroys the R1-5 "new" string).
 *   - then the anchor `old` is looked up: present (exactly once, or >=1 for
 *     mode 'all') => applied; absent => skipped if `new` (or, for pure
 *     deletions, the absence itself) proves the result exists, otherwise an
 *     error (pi version changed; review needed).
 * This makes the patcher safe to re-run and lets later rounds layer on top
 * of an already-patched install.
 *
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

const BT = '`'; // backtick
const NL = '\n';
const EXPANDED_HINT =
  ',this.addChild(new Text(theme.fg("dim","(click to collapse)"),0,0))';
const MARKDOWN_SUMMARY =
  'this.addChild(new Markdown(header+this.message.summary,0,0,this.markdownTheme,{color:text=>theme.fg("customMessageText",text)}))';

// The round-1 handler (inserted by R1-5); round 2 replaces it wholesale.
const R1_HANDLER =
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
  'comp.setExpanded(!comp.expanded);this.requestRender();return!0}';

// The round-2 handler: the round-1 scroll-view/component-tree path PLUS a
// generic layout-tree path for expandable components outside the transcript
// (startup header, loaded-resource sections). Marker-gated so that only
// known click-toggleable components react (the editor, status line, etc.
// keep their normal click behavior).
const R2_HANDLER =
  'handleClickExpandable(event){' +
  'if((event.button&3)!==0||event.release||(event.button&32)!==0||this.hasOverlay())return!1;' +
  'if(!this.currentLayout)return!1;' +
  'let scrollView=getScrollViewsAt(this.currentLayout,event.x,event.y)[0];' +
  'if(scrollView){' +
  'let box=getScrollViewBox(this.currentLayout,scrollView);' +
  'if(box&&box.rect.height>0){' +
  'let contentRow=scrollView.scrollTop+event.y-box.rect.y,contentCol=event.x-box.rect.x;' +
  'let lines=box.scrollContentLines;' +
  'if(lines&&contentRow>=0&&contentRow<lines.length&&contentCol>=0&&contentCol<=visibleWidth(lines[contentRow]??"")){' +
  'let root=box.children[0]?.component;' +
  'if(root&&root.children){' +
  'let width=box.rect.width;' +
  'const walk=(cont,row)=>{let offset=0;for(let child of cont.children){let h;try{h=child.render(width).length}catch(e){h=1}' +
  'if(row>=offset&&row<offset+h){if(child.clickToggleExpandable)return child;if(child.children)return walk(child,row-offset);return child}' +
  'offset+=h}return undefined};' +
  'let comp=walk(root,contentRow);' +
  'if(comp&&typeof comp.setExpanded=="function"){comp.setExpanded(!comp.expanded);this.requestRender();return!0}' +
  '}}}}' +
  'let deepest=void 0;' +
  'const visitBox=(bx)=>{' +
  'if(!bx||typeof bx!=="object"||!bx.rect)return;' +
  'let r=bx.rect;' +
  'if(event.x<r.x||event.x>=r.x+r.width||event.y<r.y||event.y>=r.y+r.height)return;' +
  'deepest=bx;' +
  'let kids=bx.children;' +
  'if(Array.isArray(kids))for(let child of kids)visitBox(child);' +
  '};' +
  'if(this.currentLayout.root)visitBox(this.currentLayout.root);' +
  'if(deepest&&deepest.component&&deepest.component.clickToggleExpandable&&typeof deepest.component.setExpanded=="function"){' +
  'deepest.component.setExpanded(!deepest.component.expanded);' +
  'this.requestRender();' +
  'return!0;' +
  '}' +
  'return!1}';

// [old, new, mode?]  mode: 'one' (default, exactly one occurrence) | 'all'
// Every `old` anchor must come from a pi release whose structure we know;
// if an anchor is missing on a fresh (unpatched) bundle, the patcher errors
// out instead of silently skipping.
const replacements = [
  // ── round 1.1: mark the three message components as click-toggleable ──
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
  // ── round 1.2: collapsed-state hints "(ctrl+o ...)" -> "(click ...)" ───
  [
    'Compacted from ${tokenStr} tokens (' + BT + ')+theme.fg("dim",keyText("app.tools.expand"))',
    'Compacted from ${tokenStr} tokens (' + BT + ')+theme.fg("dim","click")',
  ],
  [
    '"Branch summary (")+theme.fg("dim",keyText("app.tools.expand"))',
    '"Branch summary (")+theme.fg("dim","click")',
  ],
  [
    'this.skillBlock.name)+theme.fg("dim",' + BT + ' (${keyText("app.tools.expand")} to expand)' + BT + ')',
    'this.skillBlock.name)+theme.fg("dim"," (click to expand)")',
  ],
  // ── round 1.3: expanded-state hint: trailing dim "(click to collapse)" ─
  [
    'let header=' + BT + '**Compacted from ${tokenStr} tokens**' + NL + NL + BT + ';' + MARKDOWN_SUMMARY + '}else',
    'let header=' + BT + '**Compacted from ${tokenStr} tokens**' + NL + NL + BT + ';' + MARKDOWN_SUMMARY + EXPANDED_HINT + '}else',
  ],
  [
    'let header=' + BT + '**Branch Summary**' + NL + NL + BT + ';' + MARKDOWN_SUMMARY + '}else',
    'let header=' + BT + '**Branch Summary**' + NL + NL + BT + ';' + MARKDOWN_SUMMARY + EXPANDED_HINT + '}else',
  ],
  [
    'this.addChild(new Markdown(header+this.skillBlock.content,0,0,this.markdownTheme,{color:text=>theme.fg("customMessageText",text)}))}',
    'this.addChild(new Markdown(header+this.skillBlock.content,0,0,this.markdownTheme,{color:text=>theme.fg("customMessageText",text)}))' +
      EXPANDED_HINT +
      '}',
  ],
  // ── round 1.4: mouse chain: route left presses through handleClickExpandable
  [
    'if(mouseEvent){if(this.handleRightClickPaste(mouseEvent))return{consume:!0};let handled=this.handleScrollbarMouseEvent(mouseEvent);return this.scrollbarDrag||this.updateScrollbarHover(mouseEvent.x,mouseEvent.y),handled||this.handleSelectionMouseEvent(mouseEvent),{consume:!0}}',
    'if(mouseEvent){if(this.handleRightClickPaste(mouseEvent))return{consume:!0};let handled=this.handleScrollbarMouseEvent(mouseEvent);return this.scrollbarDrag||this.updateScrollbarHover(mouseEvent.x,mouseEvent.y),handled||this.handleClickExpandable(mouseEvent)||this.handleSelectionMouseEvent(mouseEvent),{consume:!0}}',
  ],
  // ── round 1.5: the handler itself (before handleSelectionMouseEvent) ───
  // marker: the method name — survives R2-5, which replaces the R1 handler
  // body with the R2 body (the "new" text of this replacement would then be
  // gone and the insertion would fire again, creating a duplicate method).
  [
    'handleSelectionMouseEvent(event){',
    R1_HANDLER + 'handleSelectionMouseEvent(event){',
    'one',
    'handleClickExpandable(event){',
  ],
  // ── round 2.1: mark tool blocks as click-toggleable ────────────────────
  [
    'toolName;toolCallId;args;expanded=!1;showImages;',
    'toolName;toolCallId;args;expanded=!1;clickToggleExpandable=!0;showImages;',
  ],
  [
    'truncationResult;fullOutputPath;expanded=!1;contentContainer;',
    'truncationResult;fullOutputPath;expanded=!1;clickToggleExpandable=!0;contentContainer;',
  ],
  // ── round 2.2: remove the global ctrl+o toggle ─────────────────────────
  [
    '"app.tools.expand":{defaultKeys:"ctrl+o",description:"Toggle tool output"}',
    '"app.tools.expand":{defaultKeys:[],description:"Toggle tool output (per-block click; global binding removed)"}',
  ],
  [
    'this.defaultEditor.onAction("app.tools.expand",()=>this.toggleToolOutputExpansion()),',
    '',
  ],
  // ── round 2.3: core hint texts that referenced the global key ──────────
  [
    'keyHint("app.tools.expand","to expand")',
    'theme.fg("muted","click to expand")',
    'all',
  ],
  [
    'keyHint("app.tools.expand","to collapse")',
    'theme.fg("muted","click to collapse")',
  ],
  [
    'theme2.fg("dim",' + BT + ' (${keyText("app.tools.expand")} to expand)' + BT + ')',
    'theme2.fg("dim"," (click to expand)")',
  ],
  [
    'compactOnboarding=theme.fg("dim",' + BT + 'Press ${keyText("app.tools.expand")} to show full startup help and loaded resources.' + BT + ')',
    'compactOnboarding=theme.fg("dim","(click the header to expand full startup help and loaded resources)")',
  ],
  [
    'hint("app.tools.expand","to expand tools"),hint("app.thinking.toggle","to expand thinking")',
    'hint("app.thinking.toggle","to expand thinking")',
  ],
  [
    'rawKeyHint("!","bash"),hint("app.tools.expand","more")].join(',
    'rawKeyHint("!","bash")].join(',
  ],
  // NOTE: inside the chunk this line lives in a template literal, so the
  // backticks are escaped (backslash + backtick).
  [
    '| \\`' + '${expandTools}\\`' + ' | Toggle tool output expansion |' + NL,
    '',
  ],
  // ── round 2.4: ExpandableText: track state + click marker ──────────────
  [
    'var ExpandableText=class extends Text{getCollapsedText;getExpandedText;constructor(getCollapsedText,getExpandedText,expanded=!1,paddingX=0,paddingY=0){super(expanded?getExpandedText():getCollapsedText(),paddingX,paddingY),this.getCollapsedText=getCollapsedText,this.getExpandedText=getExpandedText}setExpanded(expanded){this.setText(expanded?this.getExpandedText():this.getCollapsedText())}',
    'var ExpandableText=class extends Text{getCollapsedText;getExpandedText;expanded=!1;clickToggleExpandable=!0;constructor(getCollapsedText,getExpandedText,expanded=!1,paddingX=0,paddingY=0){super(expanded?getExpandedText():getCollapsedText(),paddingX,paddingY),this.getCollapsedText=getCollapsedText,this.getExpandedText=getExpandedText,this.expanded=!!expanded}setExpanded(expanded){this.expanded=!!expanded,this.setText(expanded?this.getExpandedText():this.getCollapsedText())}',
  ],
  // ── round 2.5: upgrade the handler with the generic layout-tree path ───
  // marker: visitBox exists only in the R2 handler body.
  [R1_HANDLER, R2_HANDLER, 'one', 'visitBox'],
];

let applied = 0;
let skipped = 0;
for (const entry of replacements) {
  const oldStr = entry[0];
  const newStr = entry[1];
  const mode = entry[2] || 'one';
  // Explicit "already applied" detector; defaults to the new text for
  // insertions (where old stays a substring of new). Checked first.
  const doneMarker = entry[3] || (newStr !== '' && newStr.includes(oldStr) ? newStr : null);
  if (doneMarker && src.includes(doneMarker)) {
    skipped++;
    continue;
  }
  const count = src.split(oldStr).length - 1;
  if (count === 0) {
    // Anchor gone: either already applied (result present / pure deletion)
    // or the pi version changed (error).
    if (newStr === '' || src.includes(newStr)) {
      skipped++;
      continue;
    }
    console.error(
      'error: anchor not found (pi version change? review needed): ' +
        JSON.stringify(oldStr.slice(0, 80))
    );
    process.exit(1);
  }
  if (mode === 'all') {
    src = src.split(oldStr).join(newStr);
  } else {
    if (count !== 1) {
      console.error(
        'error: anchor found ' +
          count +
          ' times (expected 1): ' +
          JSON.stringify(oldStr.slice(0, 80))
      );
      process.exit(1);
    }
    src = src.replace(oldStr, newStr);
  }
  applied++;
}

// Syntax-check the patched bundle (ESM) before touching the real file.
const tmp = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'pi-click-expand-')),
  'chunk-check.mjs'
);
fs.writeFileSync(tmp, src);
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
} catch (e) {
  console.error('error: patched bundle failed syntax check: ' + e.message);
  process.exit(1);
}
fs.writeFileSync(target, src);
console.log(
  'patched: click-to-expand (per-block; global ctrl+o removed) — applied ' +
    applied + ', already-applied ' + skipped
);
