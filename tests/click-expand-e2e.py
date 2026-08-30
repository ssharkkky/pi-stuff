#!/usr/bin/env python3
"""E2E regression test: click-to-expand transcript messages (pi-stuff patch).

Requires: fullscreen tuiMode, the pi-click-expand.js patch applied, and the
pi binary on PATH. Drives a real `pi --session <id>` in a PTY with a
fabricated session (compaction + branch summary + skill message), sends SGR
(1006) mouse clicks, and verifies:

  1  collapsed hints say "(click to expand)"
  2-3 click [compaction] expands, second click collapses
  4-5 click [branch] expands, second click collapses
  6-7 click [skill] expands, second click collapses
  8-9 ctrl+o still globally expands/collapses all (regression)
  10 clicks on non-message lines are no-ops

Usage: python3 click-expand-e2e.py
"""
import os, pty, select, time, sys, struct, re, signal, termios, fcntl, ctypes

ROWS, COLS = 34, 110
CWD = '/Users/stoneshi/pi/pi-dev'
SESSION_ID = None  # fabricated below (main)

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
    """Create a throwaway session with one compaction, one branch summary
    and one skill-invocation message, in the session dir of CWD."""
    import json, uuid
    sid = str(uuid.uuid4())
    now = __import__('datetime').datetime.utcnow().isoformat()
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
        class _WS(ctypes.Structure):
            _fields_=[('r',ctypes.c_ushort),('c',ctypes.c_ushort),('x',ctypes.c_ushort),('y',ctypes.c_ushort)]
        _ws = _WS(ROWS, COLS, 0, 0)
        _TIO = termios.TIOCSWINSZ - (0x100000000 if termios.TIOCSWINSZ > 0x7FFFFFFF else 0)
        fcntl.ioctl(fd, _TIO, struct.pack('HHHH', ROWS, COLS, 0, 0))
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
        if any(k in ln for k in ('compaction', 'Compacted', 'click to expand', 'ctrl+o', 'trust', 'Trust')):
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
    if 'ctrl+o to expand' in screen:
        print('FAIL: old "(ctrl+o to expand)" hint still present')
        return 1
    print('PASS 1: collapsed hint shows "(click to expand)"')

    # T2: compaction click toggle
    pos = grid.find('click to expand')
    print(f'clicking compaction hint at row={pos[0]} col={pos[1]}')
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
        print('FAIL: branch summary hint not found'); print(screen); return 1
    print(f'clicking branch hint at row={bpos[0]} col={bpos[1]}')
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
        print('FAIL: skill hint not found'); print(screen); return 1
    print(f'clicking skill hint at row={spos[0]} col={spos[1]}')
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

    # T5: ctrl+o global toggle still works (regression)
    os.write(fd, b'\x0f')
    stream = read_quiescent(fd, stream)
    parse(stream, grid)
    screen = grid.text()
    if not ('Test summary' in screen and 'BRANCH SUMMARY TEST TEXT' in screen and 'Test skill content line one.' in screen):
        print('FAIL: ctrl+o did not globally expand the message blocks'); print(screen); return 1
    print('PASS 8: ctrl+o still globally expands all blocks')
    os.write(fd, b'\x0f')
    stream = read_quiescent(fd, stream)
    parse(stream, grid)
    screen = grid.text()
    if 'Test summary' in screen or 'BRANCH SUMMARY TEST TEXT' in screen or 'Test skill content line one.' in screen:
        print('FAIL: ctrl+o did not globally collapse the message blocks'); print(screen); return 1
    print('PASS 9: ctrl+o again globally collapses all blocks')

    # T10: clicking non-message lines must not toggle anything
    os.write(fd, b'\x1b[<0;5;1M\x1b[<0;5;1m')   # click on the logo line
    stream = read_quiescent(fd, stream)
    parse(stream, grid)
    screen = grid.text()
    os.write(fd, b'\x1b[<0;10;11M\x1b[<0;10;11m')  # click on an empty line
    stream = read_quiescent(fd, stream)
    parse(stream, grid)
    screen = grid.text()
    if 'Test summary' in screen or 'BRANCH SUMMARY TEST TEXT' in screen or 'Test skill content line one.' in screen:
        print('FAIL: click on non-message line toggled a block'); print(screen); return 1
    print('PASS 10: clicks on non-message lines are no-ops')

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
    print('ALL PASS (10 checks)')
    return 0

if __name__ == '__main__':
    sys.exit(main())
