#!/usr/bin/env python3
"""E2E regression test: click-to-expand transcript blocks (pi-stuff patches).

Requires: fullscreen tuiMode, the pi-click-expand.js + bcc-tool-click.js
patches applied, and the pi binary on PATH. Drives a real `pi --session <id>`
in a PTY with a fabricated session (compaction + branch summary + skill
message + a long bash call/result), sends SGR (1006) mouse clicks, and
verifies per-block independent expand/collapse with NO global state:

   1  collapsed hints say "(click to expand)", no "(ctrl+o ...)" left
  2-3  click [compaction] expands, second click collapses
  4-5  click [branch] expands, second click collapses
  6-7  click [skill] expands, second click collapses
   8  bash block collapsed: truncated command + preview head + click hints
   9  click bash block -> full command + full output + "(click to collapse)"
  10  click bash block again -> collapsed
  11  skill + bash expanded simultaneously (per-block independence)
  12  ctrl+o is a no-op (global toggle removed)
  13  ctrl+o again: still a no-op
  14  clicks on non-block lines are no-ops

Usage: python3 click-expand-e2e.py
"""
import os, pty, select, time, sys, struct, signal, termios, fcntl, ctypes

ROWS, COLS = 64, 120
CWD = '/Users/stoneshi/pi/pi-dev'
SESSION_ID = None  # fabricated below (main)

BASH_COMMAND = """set -e
# click-e2e: long multi-line command probe
for i in 1 2 3 4 5; do
  echo "loop iteration $i"
done
grep -n "click" /dev/null || true
find /tmp -maxdepth 0 -type d
echo "mid marker"
date -u
echo "CLICKE2E-CMD-LAST-LINE"""

BASH_OUTPUT = "\n".join(
    [f"output-line-{i:02d}" for i in range(1, 12)] + ["CLICKE2E-OUT-LAST-LINE"]
)

class Grid:
    def __init__(self):
        self.rows = ROWS
        self.cols = COLS
        self.r, self.c = 0, 0
        self.clear()
    def clear(self):
        self.buf = [[' '] * self.cols for _ in range(self.rows)]
    def text(self):
        return '\n'.join(''.join(row).rstrip() for row in self.buf)
    def find(self, s):
        for r in range(self.rows):
            line = ''.join(self.buf[r])
            idx = line.find(s)
            if idx >= 0:
                return r, idx
        return None

def parse(stream, grid):
    """Feed an ANSI byte stream into the grid (subset sufficient for pi TUI)."""
    i, n = 0, len(stream)
    while i < n:
        b = stream[i]
        if b == 0x1b:
            if i + 1 < n and stream[i+1:i+2] == b'[':
                # CSI
                j = i + 2
                private = b''
                if j < n and stream[j:j+1] in (b'?', b'>', b'=', b'<'):
                    private = stream[j:j+1]; j += 1
                params = b''
                while j < n and not (0x40 <= stream[j] <= 0x7e):
                    params += stream[j:j+1]; j += 1
                if j < n:
                    final = stream[j:j+1]
                    p = [x for x in params.split(b';') if x]
                    if final == b'H' or final == b'f':
                        r = int(p[0]) if p and p[0] else 1
                        c = int(p[1]) if len(p) > 1 and p[1] else 1
                        grid.r, grid.c = max(0, r - 1), max(0, c - 1)
                    elif final == b'A':
                        grid.r = max(0, grid.r - (int(p[0]) if p and p[0] else 1))
                    elif final == b'B':
                        grid.r = min(grid.rows - 1, grid.r + (int(p[0]) if p and p[0] else 1))
                    elif final == b'C':
                        grid.c = min(grid.cols - 1, grid.c + (int(p[0]) if p and p[0] else 1))
                    elif final == b'D':
                        grid.c = max(0, grid.c - (int(p[0]) if p and p[0] else 1))
                    elif final == b'J':
                        if private == b'' and (not p or p[0] in (b'0', b'2', b'3')):
                            grid.clear()
                    elif final == b'K':
                        if private == b'':
                            for c in range(grid.c, grid.cols):
                                grid.buf[grid.r][c] = ' '
                    # else: SGR/private/etc — ignore
                    i = j + 1
                    continue
            elif i + 1 < n and stream[i+1:i+2] == b']':
                # OSC: skip to BEL or ST
                j = i + 2
                while j < n and stream[j] not in (0x07,) and not (stream[j] == 0x1b and j + 1 < n and stream[j+1:j+2] == b'\\'):
                    j += 1
                i = j + 2 if (j < n and stream[j] == 0x1b) else j + 1
                continue
            elif i + 1 < n and stream[i+1:i+2] == b'P':
                # DCS: skip to BEL or ST
                j = i + 2
                while j < n and stream[j] not in (0x07,) and not (stream[j] == 0x1b and j + 1 < n and stream[j+1:j+2] == b'\\'):
                    j += 1
                i = j + 2 if (j < n and stream[j] == 0x1b) else j + 1
                continue
            i += 2
            continue
        if 0x20 <= b < 0x7f:
            if grid.r < grid.rows and grid.c < grid.cols:
                grid.buf[grid.r][grid.c] = chr(b)
            grid.c = min(grid.cols - 1, grid.c + 1)
        i += 1

def read_quiescent(fd, stream, quiet=0.8, max_wait=15):
    t0 = time.time()
    while time.time() - t0 < max_wait:
        r, _, _ = select.select([fd], [], [], 0.5)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            stream += data
        else:
            if len(stream) > 0 and time.time() - t0 > 3:
                # re-arm after one quiet window with content
                r2, _, _ = select.select([fd], [], [], quiet)
                if not r2:
                    break
                try:
                    data = os.read(fd, 65536)
                    if data:
                        stream += data
                except OSError:
                    break
    return stream

def mouse_click(fd, col, row):
    # SGR 1006: press then release, 1-based coords
    os.write(fd, b'\x1b[<0;%d;%dM' % (col + 1, row + 1))
    time.sleep(0.12)
    os.write(fd, b'\x1b[<0;%d;%dm' % (col + 1, row + 1))

def fabricate_session():
    """Throwaway session: compaction + branch summary + skill message +
    a long bash toolCall/toolResult, in the session dir of CWD."""
    import json, uuid
    sid = str(uuid.uuid4())
    now = __import__('datetime').datetime.utcnow().isoformat()
    usage = {"input": 120, "output": 60, "cacheRead": 0, "cacheWrite": 0,
             "reasoning": 0, "totalTokens": 180,
             "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}
    def e(o): return json.dumps(o)
    lines = [
        e({'type': 'session', 'version': 3, 'id': sid, 'timestamp': now, 'cwd': CWD}),
        e({'type': 'compaction', 'id': 'aa11bb22', 'parentId': None, 'timestamp': now,
           'summary': '## Test summary\nThis is a fabricated compaction summary used to test click-to-expand.',
           'tokensBefore': 136202}),
        e({'type': 'branch_summary', 'id': 'bb22cc33', 'parentId': 'aa11bb22', 'timestamp': now,
           'summary': 'BRANCH SUMMARY TEST TEXT', 'fromId': 'aa11bb22'}),
        e({'type': 'message', 'id': 'cc33dd44', 'parentId': 'bb22cc33', 'timestamp': now,
           'message': {'role': 'user', 'content': [{'type': 'text',
           'text': '<skill name="test-skill" location="/tmp/x/SKILL.md">\nTest skill content line one.\n</skill>'}]}}),
        e({'type': 'message', 'id': 'dd44ee55', 'parentId': 'cc33dd44', 'timestamp': now,
           'message': {'role': 'assistant', 'api': 'openai-completions',
                       'provider': 'llama-local',
                       'model': 'Qwen3.8-27B-Heretic-Uncensored',
                       'stopReason': 'toolUse', 'timestamp': now, 'usage': usage,
                       'content': [{'type': 'toolCall', 'id': 'call_e2e_bash',
                                    'name': 'bash',
                                    'arguments': {'command': BASH_COMMAND}}]}}),
        e({'type': 'message', 'id': 'ee55ff66', 'parentId': 'dd44ee55', 'timestamp': now,
           'message': {'role': 'toolResult', 'toolCallId': 'call_e2e_bash',
                       'toolName': 'bash', 'timestamp': now, 'isError': False,
                       'content': [{'type': 'text', 'text': BASH_OUTPUT}]}}),
    ]
    sdir = os.path.expanduser('~/.pi/agent/sessions/--' + CWD.lstrip('/').replace('/', '-') + '--')
    os.makedirs(sdir, exist_ok=True)
    path = os.path.join(sdir, 'click-expand-e2e_' + sid + '.jsonl')
    with open(path, 'w') as fh:
        fh.write('\n'.join(lines) + '\n')
    return sid, path


def main():
    global SESSION_ID
    env = {k: v for k, v in os.environ.items()}
    env['TERM'] = 'xterm-256color'
    grid = Grid()
    stream = b''
    SESSION_ID, session_path = fabricate_session()
    print(f'test session: {SESSION_ID[:8]}')

    pid, fd = pty.fork()
    if pid == 0:
        _err = open('/tmp/pi-click-e2e-stderr.log', 'w')
        os.dup2(_err.fileno(), 2)
        os.chdir(CWD)
        os.execvpe('pi', ['pi', '--session', SESSION_ID], env)

    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))
    except Exception:
        pass

    stream = read_quiescent(fd, stream, max_wait=25)
    try:
        os.kill(pid, 0); alive = True
    except ProcessLookupError:
        alive = False
    print(f'debug: stream={len(stream)}B child_alive={alive}')
    if len(stream) == 0:
        print('FAIL: no output from pi')
        return 1
    parse(stream, grid)
    screen = grid.text()
    print(f'debug: grid non-empty lines={sum(1 for l in screen.split(chr(10)) if l.strip())}')
    print('--- startup screen (excerpt) ---')
    for ln in screen.split('\n'):
        if any(k in ln for k in ('Compacted', 'click', 'Bash', 'trust', 'Trust')):
            print(repr(ln))
    print('-----------------------------')

    if 'trust' in screen.lower() and 'do you trust' in screen.lower():
        os.write(fd, b'y\r')
        stream = read_quiescent(fd, stream)
        parse(stream, grid)
        screen = grid.text()

    if 'click to expand' not in screen:
        print('FAIL: collapsed "(click to expand)" hint not found on screen')
        print(screen)
        return 1
    if 'ctrl+o to expand' in screen or 'ctrl+o to collapse' in screen:
        print('FAIL: old "(ctrl+o ...)" hint still present')
        print(screen)
        return 1
    print('PASS 1: collapsed hints say "(click to expand)", no ctrl+o hints')

    # T2: compaction click toggle
    pos = grid.find('Compacted from')
    if pos is None:
        print('FAIL: compaction block not found'); print(screen); return 1
    print(f'clicking compaction block at row={pos[0]} col={pos[1]}')
    mouse_click(fd, pos[1] + 5, pos[0])
    stream = read_quiescent(fd, stream)
    parse(stream, grid)
    screen = grid.text()
    if 'Test summary' not in screen or '(click to collapse)' not in screen:
        print('FAIL: click did not expand the compaction block'); print(screen); return 1
    print('PASS 2: click expanded the compaction block')
    pos2 = grid.find('Test summary')
    mouse_click(fd, pos2[1] + 2, pos2[0])
    stream = read_quiescent(fd, stream)
    parse(stream, grid)
    screen = grid.text()
    if 'Test summary' in screen:
        print('FAIL: second click did not collapse the compaction block'); print(screen); return 1
    print('PASS 3: second click collapsed the compaction block')

    # T3: branch summary click toggle
    bpos = grid.find('Branch summary')
    if bpos is None:
        print('FAIL: branch summary block not found'); print(screen); return 1
    print(f'clicking branch block at row={bpos[0]} col={bpos[1]}')
    mouse_click(fd, bpos[1] + 5, bpos[0])
    stream = read_quiescent(fd, stream)
    parse(stream, grid)
    screen = grid.text()
    if 'BRANCH SUMMARY TEST TEXT' not in screen:
        print('FAIL: click did not expand the branch summary block'); print(screen); return 1
    print('PASS 4: click expanded the branch summary block')
    bpos2 = grid.find('BRANCH SUMMARY TEST TEXT')
    mouse_click(fd, bpos2[1] + 2, bpos2[0])
    stream = read_quiescent(fd, stream)
    parse(stream, grid)
    screen = grid.text()
    if 'BRANCH SUMMARY TEST TEXT' in screen:
        print('FAIL: second click did not collapse the branch summary block'); print(screen); return 1
    print('PASS 5: second click collapsed the branch summary block')

    # T4: skill invocation click toggle
    spos = grid.find('test-skill')
    if spos is None:
        print('FAIL: skill block not found'); print(screen); return 1
    print(f'clicking skill block at row={spos[0]} col={spos[1]}')
    mouse_click(fd, spos[1] + 5, spos[0])
    stream = read_quiescent(fd, stream)
    parse(stream, grid)
    screen = grid.text()
    if 'Test skill content line one.' not in screen:
        print('FAIL: click did not expand the skill block'); print(screen); return 1
    print('PASS 6: click expanded the skill block')
    spos2 = grid.find('Test skill content line one.')
    mouse_click(fd, spos2[1] + 2, spos2[0])
    stream = read_quiescent(fd, stream)
    parse(stream, grid)
    screen = grid.text()
    if 'Test skill content line one.' in screen:
        print('FAIL: second click did not collapse the skill block'); print(screen); return 1
    print('PASS 7: second click collapsed the skill block')

    # T5: bash block collapsed state (CC-style rendering).
    # NOTE: the user's ccToolsExtraDetail=true makes the collapsed preview
    # show the full output, so the collapsed/expanded discriminators are the
    # command truncation (CLICKE2E-CMD-LAST-LINE) and the collapse footer —
    # both independent of the extraDetail setting.
    hpos = grid.find('long multi-line command probe')
    if hpos is None:
        print('FAIL: bash block header not found'); print(screen); return 1
    screen = grid.text()
    if 'CLICKE2E-CMD-LAST-LINE' in screen:
        print('FAIL: full command visible in collapsed bash block'); print(screen); return 1
    if '(click to collapse)' in screen:
        print('FAIL: collapsed bash block already shows "(click to collapse)"'); print(screen); return 1
    if 'output-line-01' not in screen:
        print('FAIL: preview (output-line-01) missing from collapsed bash result'); print(screen); return 1
    print('PASS 8: bash collapsed: truncated command, no collapse footer')

    # T6: click the bash block -> full command + collapse footer
    print(f'clicking bash block at row={hpos[0]} col={hpos[1]}')
    mouse_click(fd, hpos[1] + 5, hpos[0])
    stream = read_quiescent(fd, stream)
    parse(stream, grid)
    screen = grid.text()
    if 'CLICKE2E-CMD-LAST-LINE' not in screen:
        print('FAIL: click did not expand the bash command'); print(screen); return 1
    if 'output-line-11' not in screen:
        print('FAIL: bash output (output-line-11) not visible'); print(screen); return 1
    if '(click to collapse)' not in screen:
        print('FAIL: expanded bash block missing "(click to collapse)"'); print(screen); return 1
    print('PASS 9: click expanded the bash block (full command + collapse footer)')

    # T7: click the bash block again -> collapsed
    hpos2 = grid.find('long multi-line command probe')
    if hpos2 is None:
        print('FAIL: bash block scrolled away after expand'); print(screen); return 1
    mouse_click(fd, hpos2[1] + 5, hpos2[0])
    stream = read_quiescent(fd, stream)
    parse(stream, grid)
    screen = grid.text()
    if 'CLICKE2E-CMD-LAST-LINE' in screen:
        print('FAIL: second click did not collapse the bash block (command)'); print(screen); return 1
    if '(click to collapse)' in screen:
        print('FAIL: second click did not collapse the bash block (footer)'); print(screen); return 1
    print('PASS 10: second click collapsed the bash block')

    # T8: per-block independence: skill + bash expanded at the same time
    spos3 = grid.find('test-skill')
    if spos3 is None:
        print('FAIL: skill block not found for independence check'); print(screen); return 1
    mouse_click(fd, spos3[1] + 5, spos3[0])
    stream = read_quiescent(fd, stream)
    parse(stream, grid)
    screen = grid.text()
    if 'Test skill content line one.' not in screen:
        print('FAIL: skill did not expand in independence check'); print(screen); return 1
    hpos3 = grid.find('long multi-line command probe')
    if hpos3 is None:
        print('FAIL: bash block not found for independence check'); print(screen); return 1
    mouse_click(fd, hpos3[1] + 5, hpos3[0])
    stream = read_quiescent(fd, stream)
    parse(stream, grid)
    screen = grid.text()
    if not ('Test skill content line one.' in screen
            and 'CLICKE2E-CMD-LAST-LINE' in screen
            and 'output-line-11' in screen):
        print('FAIL: skill and bash are not both expanded at the same time'); print(screen); return 1
    print('PASS 11: skill + bash independently expanded simultaneously')

    # T9: ctrl+o is a no-op (global toggle removed)
    os.write(fd, b'\x0f')
    stream = read_quiescent(fd, stream)
    parse(stream, grid)
    screen = grid.text()
    if not ('CLICKE2E-CMD-LAST-LINE' in screen and 'Test skill content line one.' in screen):
        print('FAIL: ctrl+o changed block states (global toggle still active?)'); print(screen); return 1
    if 'Test summary' in screen:
        print('FAIL: ctrl+o globally expanded the compaction block'); print(screen); return 1
    print('PASS 12: ctrl+o is a no-op')
    os.write(fd, b'\x0f')
    stream = read_quiescent(fd, stream)
    parse(stream, grid)
    screen = grid.text()
    if not ('CLICKE2E-CMD-LAST-LINE' in screen and 'Test skill content line one.' in screen):
        print('FAIL: second ctrl+o changed block states'); print(screen); return 1
    print('PASS 13: second ctrl+o still a no-op')

    # T10: clicking non-block lines must not toggle anything
    os.write(fd, b'\x1b[<0;5;1M\x1b[<0;5;1m')
    stream = read_quiescent(fd, stream)
    parse(stream, grid)
    screen = grid.text()
    os.write(fd, b'\x1b[<0;10;11M\x1b[<0;10;11m')
    stream = read_quiescent(fd, stream)
    parse(stream, grid)
    screen = grid.text()
    if 'Test summary' in screen:
        print('FAIL: click on non-block line toggled the compaction block'); print(screen); return 1
    if not ('CLICKE2E-CMD-LAST-LINE' in screen and 'Test skill content line one.' in screen):
        print('FAIL: click on non-block line changed expanded blocks'); print(screen); return 1
    print('PASS 14: clicks on non-block lines are no-ops')

    # cleanup: kill pi + remove the throwaway session
    try:
        os.write(fd, b'\x1b')
        time.sleep(0.3)
        os.write(fd, b'q')
    except OSError:
        pass
    time.sleep(0.5)
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        os.remove(session_path)
    except OSError:
        pass
    print('ALL PASS (14 checks)')
    return 0

if __name__ == '__main__':
    sys.exit(main())
