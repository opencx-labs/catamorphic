"""Build edit.json from markers.jsonl: UI at 1x, agent waits accelerated."""
import json, sys
from pathlib import Path
P = Path(__file__).parent
def load(name):
    marks = {}
    for line in (P / f'markers-{name}.jsonl').read_text().splitlines():
        if line.strip():
            m = json.loads(line); marks.setdefault(m['event'], m['t'])
    dur = json.loads((P / f'raw-{name}/manifest.json').read_text())['duration']
    return marks, dur
main, dur = load('main'); pick, pdur = load('pickup')
def t(name, default=None):
    return main.get(name, default)
seg = []
def add(i, o, caption='', speed=1, source='main', **extra):
    if o - i <= 0: return
    seg.append({'in': round(i, 3), 'out': round(o, 3), 'caption': caption, 'speed': speed, 'source': source, **extra})
def working(i, o, caption='', head=2.6, tail=0.8):
    """An agent wait: the send settles at 1x, then a cut to the agent already
    working, held until it lands. Nothing is fast-forwarded; the window simply
    shows Working for a while."""
    if o - i <= head + tail:
        add(i, o, caption); return
    if head > 0: add(i, i + head, caption)
    add(o - tail, o, caption)
# 1. Reading a page (1x)
add(max(0, t('bookmark clicked') - 2.0), t('sidebar collapsed', t('page loaded')) + 0.4, 'Reading a page in Work.')
add(t('sidebar collapsed', t('page loaded')) + 0.4, t('scrolled') + 1.2, 'Put the sidebar away to read.')
# 2. Open the chat and type the first ask (1x)
add(t('scrolled') + 1.2, t('prompt 1 sent') + 1.0, 'Ask for a Launch section with the four docs.')
# 3. Agent works (sped up), then the change lands (1x)
land = t('sidebar section added')
working(t('prompt 1 sent') + 1.0, land - 0.8, 'The assistant edits the workspace files.', head=1.2, tail=4.0)
add(land - 0.8, land + 3.5, 'The sidebar changes in place; the page stays.')
# 4. Reply finishes (sped up), then the second ask is typed (1x)
working(land + 3.5, t('prompt 1 done') + 0.8, 'The assistant explains what it changed.', head=2.0, tail=1.2)
# 4b. The look: ask, put the chat away, collapse the dock, watch it land (1x),
#     then the finished signal, the dock back, and the chat to the side (1x).
add(t('prompt 1 done') + 0.8, t('prompt 2 sent') + 1.0, 'Ask for light mode, a calmer accent, a softer font.')
add(t('prompt 2 sent') + 1.0, t('dock collapsed') + 1.2, 'Put the chat away while it works.')
switched = t('theme switched')
if switched > t('dock collapsed') + 1.2:
    working(t('dock collapsed') + 1.2, switched - 0.6, 'The assistant edits the theme file.', head=1.2, tail=4.0)
add(max(t('dock collapsed') + 1.2, switched - 0.6), switched + 3.2, 'Light mode, a new accent and font, in place.')
working(switched + 3.2, t('prompt 2 done') + 1.6, 'The bubble signals when it is done.', head=2.0, tail=2.5)
add(t('prompt 2 done') + 1.6, t('chat opened to the side') + 2.0, 'Open the chat beside the page.')
add(t('chat opened to the side') + 2.0, t('build requested') + 1.0, 'Ask for a tool that reads your own chats.')
# 5. Build (sped up): the main take ends while the assistant is still
#    building; the pickup starts from the state it left (app tab open).
working(t('build requested') + 1.0, dur - 0.2, 'It writes a workflow and an app, then builds them.', head=1.2, tail=4.0)
# 6. Pickup: put the chat away, allow once, the app, then the chat beside it.
add(pick['pickup start'] + 0.3, pick['consent shown'] + 0.2, 'Put the chat away.', source='pickup')
add(pick['consent shown'] + 0.2, pick['allowed'] + 3.2, 'Work asks once before the app reads your chats.', source='pickup')
add(pick['allowed'] + 3.2, min(pdur, pick['pickup end']), 'The chat, back beside the app.', source='pickup')
json.dump({'segments': seg}, open(P / 'edit.json', 'w'), indent=1)
total = sum((s['out'] - s['in']) / s['speed'] for s in seg)
print(f'{len(seg)} segments, {total:.1f}s')
for s in seg: print(f"  {s['in']:7.1f}-{s['out']:7.1f} x{s['speed']:.1f} {s['caption']}")
