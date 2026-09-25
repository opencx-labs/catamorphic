"""Reproducible edit of genuine desktop captures; UI stays at 1x.
Only segments explicitly marked speed>1 accelerate the agent build wait.
"""
from pathlib import Path
from PIL import Image
import json,bisect,subprocess,sys
P=Path(__file__).parent
edit=json.loads((P/'edit.json').read_text())
# Sources: each take's frames live in their own folder; a segment names one.
sources={}
def source(name):
 if name not in sources:
  m=json.loads((P/f'raw-{name}/manifest.json').read_text())['frames']
  sources[name]=(m,[f['t'] for f in m])
 return sources[name]
segments=edit['segments']; duration=sum((s['out']-s['in'])/s.get('speed',1) for s in segments)
cache={}
def frame(t):
 for s in segments:
  length=(s['out']-s['in'])/s.get('speed',1)
  if t<length:break
  t-=length
 st=min(s['out'],s['in']+t*s.get('speed',1))
 frames,times=source(s.get('source','main'))
 idx=max(0,bisect.bisect_right(times,st)-1)
 key=(s.get('source','main'),idx)
 if key not in cache:
  cache.clear();cache[key]=Image.open(P/f"raw-{s.get('source','main')}"/frames[idx]['file']).convert('RGB')
 source_im=cache[key]
 if 'crop' in s:
  box=s['crop']
  if s.get('zoomIn'):
   q=min(1,t/1.0);q=q*q*(3-2*q);base=[0,0,1280,800];box=[a+(b-a)*q for a,b in zip(base,box)]
  source_im=source_im.crop(tuple(box))
 # The window fills the frame: 1280x800 at 1.5x, no bands and no captions.
 return source_im.resize((1920,1200),Image.Resampling.LANCZOS)
if '--stills' in sys.argv:
 for i in range(0,round(duration),5):frame(i).save(P/f'review-{i:03}.jpg',quality=94)
else:
 proc=subprocess.Popen(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s','1920x1200','-r','60','-i','-','-an','-c:v','libx264','-preset','medium','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',str(P/'work-desktop-film.mp4')],stdin=subprocess.PIPE)
 for n in range(round(duration*60)):proc.stdin.write(frame(n/60).tobytes())
 proc.stdin.close()
 if proc.wait():raise RuntimeError('Encode failed')
 frame(duration-2).save(P/'work-desktop-poster.jpg',quality=94,optimize=True)
 print(f'Rendered {duration:.2f}s')
