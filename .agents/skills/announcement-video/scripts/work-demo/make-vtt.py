"""Captions track from edit.json: one cue per segment caption, output time."""
import json
from pathlib import Path
P = Path(__file__).parent
seg = json.loads((P / 'edit.json').read_text())['segments']
def stamp(t):
    h = int(t // 3600); m = int(t % 3600 // 60); s = t % 60
    return f'{h:02}:{m:02}:{s:06.3f}'
cues = []; t = 0.0
for s in seg:
    length = (s['out'] - s['in']) / s.get('speed', 1)
    if s.get('caption'):
        if cues and cues[-1][2] == s['caption']:
            cues[-1][1] = t + length
        else:
            cues.append([t, t + length, s['caption']])
    t += length
out = ['WEBVTT', '']
for a, b, text in cues:
    out += [f'{stamp(a)} --> {stamp(b)}', text, '']
(P / 'work-desktop-film.vtt').write_text('\n'.join(out))
print(f'{len(cues)} cues, {t:.1f}s')
