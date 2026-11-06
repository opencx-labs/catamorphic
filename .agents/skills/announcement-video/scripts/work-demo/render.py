"""Render the v5 film from real captures: an explicit cut list (edit.json),
the window full frame at its captured 1680x1050, a drawn pointer where the
take moved it (CDP input shows none), and dissolves only where time is cut.

  .venv/bin/python render.py            # film, poster
  .venv/bin/python render.py --stills   # a review frame every 2 s
  .venv/bin/python render.py --at 12.5  # one frame
"""
import bisect
import json
import math
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

P = Path(__file__).parent
FPS = 60
edit = json.loads((P / "edit.json").read_text())
segments = edit["segments"]
_first = json.loads((P / f"raw-{segments[0]['source']}/manifest.json").read_text())
# The capture's real size, read from a frame: the manifest only records the
# screencast's ceiling, and a 1x display delivers less.
W, H = Image.open(P / f"raw-{segments[0]['source']}" / _first["frames"][0]["file"]).size
ZOOM = W / 1280  # CSS pixels to frame pixels
OUT = tuple(edit.get("size", (W, H)))  # the film's size

# --------------------------------------------------------------- sources
sources = {}


def source(name):
    if name not in sources:
        frames = json.loads((P / f"raw-{name}/manifest.json").read_text())["frames"]
        pointer = []
        path = P / f"pointer-{name}.jsonl"
        if path.exists():
            pointer = [json.loads(l) for l in path.read_text().splitlines() if l.strip()]
        sources[name] = {
            "frames": frames,
            "times": [f["t"] for f in frames],
            "pointer": pointer,
            "ptimes": [p["t"] for p in pointer],
            "moves": [p for p in pointer if "x" in p],
            "mtimes": [p["t"] for p in pointer if "x" in p],
        }
    return sources[name]


cache = {}


def raw_frame(name, t):
    s = source(name)
    i = max(0, bisect.bisect_right(s["times"], t) - 1)
    key = (name, i)
    if key not in cache:
        if len(cache) > 6:
            cache.clear()
        im = Image.open(P / f"raw-{name}" / s["frames"][i]["file"]).convert("RGB")
        if im.size != (W, H):
            im = im.resize((W, H), Image.Resampling.LANCZOS)
        cache[key] = im
    return cache[key]


# --------------------------------------------------------------- pointer
def arrow(scale):
    """The macOS arrow: black with a white rim and a soft shadow."""
    k = 8  # supersample
    pts = [(0, 0), (0, 16.2), (4.1, 12.4), (6.9, 18.6), (9.6, 17.5), (6.8, 11.4), (12.1, 11.4)]
    size = (int(24 * scale * k), int(28 * scale * k))
    off = 4 * scale * k

    def poly(dx=0, dy=0):
        return [(off + (x * scale * k) + dx, off + (y * scale * k) + dy) for x, y in pts]

    shadow = Image.new("L", size, 0)
    ImageDraw.Draw(shadow).polygon(poly(0, 1.2 * scale * k), fill=110)
    shadow = shadow.filter(ImageFilter.GaussianBlur(1.6 * scale * k))
    shape = Image.new("L", size, 0)
    d = ImageDraw.Draw(shape)
    d.polygon(poly(), fill=255)
    d.line(poly() + [poly()[0]], fill=255, width=int(1.7 * scale * k), joint="curve")
    ink = Image.new("L", size, 0)
    ImageDraw.Draw(ink).polygon(poly(), fill=255)
    ink = ink.filter(ImageFilter.MinFilter(int(1.1 * scale * k) | 1))
    rgba = Image.new("RGBA", size, (0, 0, 0, 0))
    black = Image.new("RGBA", size, (0, 0, 0, 255))
    white = Image.new("RGBA", size, (255, 255, 255, 255))
    sh = Image.new("RGBA", size, (0, 0, 0, 0))
    sh.putalpha(shadow)
    rgba = Image.alpha_composite(rgba, sh)
    w = white.copy()
    w.putalpha(shape)
    rgba = Image.alpha_composite(rgba, w)
    b = black.copy()
    b.putalpha(ink)
    rgba = Image.alpha_composite(rgba, b)
    small = rgba.resize((size[0] // k, size[1] // k), Image.Resampling.LANCZOS)
    return small, off / k


BASE = 1.2 * ZOOM  # a touch larger than life, for a film
SPRITES = {}


def sprite(scale):
    q = round(scale, 2)
    if q not in SPRITES:
        SPRITES[q] = arrow(q)
    return SPRITES[q]


def pointer_at(name, t):
    """(x, y, visible 0..1, press 0..1) in frame pixels at source time t."""
    s = source(name)
    pts, times = s["pointer"], s["ptimes"]
    i = bisect.bisect_right(times, t) - 1
    moves, mtimes = s["moves"], s["mtimes"]
    j = bisect.bisect_right(mtimes, t) - 1
    x, y = 1220.0, 430.0
    if j >= 0:
        x, y = moves[j]["x"], moves[j]["y"]
        # Interpolate within a glide (samples ~16 ms apart).
        if j + 1 < len(moves):
            t0, t1 = moves[j]["t"], moves[j + 1]["t"]
            if 0 < t1 - t0 < 0.08:
                u = (t - t0) / (t1 - t0)
                x += (moves[j + 1]["x"] - x) * u
                y += (moves[j + 1]["y"] - y) * u
    # Hidden from a "hide" (typing) until the next move; fade 0.15 s.
    vis = 1.0
    last_hide = next((p["t"] for p in reversed(pts[: i + 1]) if p["type"] == "hide"), None)
    if last_hide is not None:
        moved_after = next((p["t"] for p in pts[: i + 1] if p["type"] == "mouseMoved" and p["t"] > last_hide), None)
        if moved_after is None:
            vis = max(0.0, 1 - (t - last_hide) / 0.15)
        else:
            vis = min(1.0, (t - moved_after) / 0.15)
    # Press: down quickly, back up after release.
    press = 0.0
    for p in reversed(pts[: i + 1]):
        if p["type"] == "mousePressed":
            press = min(1.0, (t - p["t"]) / 0.06)
            break
        if p["type"] == "mouseReleased":
            press = max(0.0, 1 - (t - p["t"]) / 0.14)
            break
    return x * ZOOM, y * ZOOM, vis, press


def last_click(name, t):
    s = source(name)
    pts = s["pointer"]
    i = bisect.bisect_right(s["ptimes"], t) - 1
    for p in reversed(pts[: i + 1]):
        if p["type"] == "mousePressed":
            return p
    return None


def draw_pointer(im, name, t):
    x, y, vis, press = pointer_at(name, t)
    if vis <= 0.01:
        return im
    im = im.copy()
    click = last_click(name, t)
    if click and 0 <= t - click["t"] < 0.42:
        # A faint ring where the press lands, so a click reads on film.
        u = (t - click["t"]) / 0.42
        r = (10 + 18 * (1 - (1 - u) ** 2)) * ZOOM
        alpha = int(90 * (1 - u) * vis)
        ring = Image.new("RGBA", im.size, (0, 0, 0, 0))
        cx, cy = click["x"] * ZOOM, click["y"] * ZOOM
        ImageDraw.Draw(ring).ellipse([cx - r, cy - r, cx + r, cy + r], outline=(255, 255, 255, alpha), width=max(1, int(2 * ZOOM)))
        im = Image.alpha_composite(im.convert("RGBA"), ring).convert("RGB")
    spr, off = sprite(BASE * (1 - 0.12 * press))
    if vis < 1:
        a = spr.getchannel("A").point(lambda v: int(v * vis))
        spr = spr.copy()
        spr.putalpha(a)
    im.paste(spr, (int(round(x - off)), int(round(y - off))), spr)
    return im


# --------------------------------------------------------------- timeline
def seg_len(s):
    return s.get("hold", s["out"] - s["in"])


starts = []
t = 0.0
for n, s in enumerate(segments):
    if n and s.get("xfade"):
        t -= s["xfade"]
    starts.append(t)
    t += seg_len(s)
duration = t


def seg_frame(s, u):
    st = s["in"] if "hold" in s else min(s["out"], s["in"] + max(0.0, u))
    im = raw_frame(s["source"], st)
    if s.get("pointer", True):
        im = draw_pointer(im, s["source"], st)
    return im


def frame(t):
    im = compose(t)
    return im if im.size == OUT else im.resize(OUT, Image.Resampling.LANCZOS)


def compose(t):
    n = max(0, bisect.bisect_right(starts, t) - 1)
    s = segments[n]
    u = t - starts[n]
    im = seg_frame(s, u)
    x = s.get("xfade", 0)
    if n and x and u < x:
        prev = segments[n - 1]
        a = seg_frame(prev, t - starts[n - 1])
        q = u / x
        q = q * q * (3 - 2 * q)
        im = Image.blend(a, im, q)
    return im


if __name__ == "__main__":
    if "--at" in sys.argv:
        at = float(sys.argv[sys.argv.index("--at") + 1])
        frame(at).save(P / f"at-{at:06.2f}.jpg", quality=94)
        print(f"{duration:.2f}s total")
    elif "--stills" in sys.argv:
        out = P / "stills"
        out.mkdir(exist_ok=True)
        for old in out.glob("*.jpg"):
            old.unlink()
        step = float(sys.argv[sys.argv.index("--stills") + 1]) if len(sys.argv) > sys.argv.index("--stills") + 1 else 2.0
        k = 0.0
        while k < duration:
            frame(k).save(out / f"s-{k:06.2f}.jpg", quality=90)
            k += step
        print(f"{duration:.2f}s, stills in {out}")
    else:
        name = edit.get("output", "work-desktop-film")
        proc = subprocess.Popen(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
             "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{OUT[0]}x{OUT[1]}", "-r", str(FPS), "-i", "-",
             "-an", "-c:v", "libx264", "-preset", "slow", "-crf", str(edit.get("crf", 19)),
             "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(P / f"{name}.mp4")],
            stdin=subprocess.PIPE,
        )
        for k in range(round(duration * FPS)):
            proc.stdin.write(frame(k / FPS).tobytes())
        proc.stdin.close()
        if proc.wait():
            raise RuntimeError("encode failed")
        poster_at = edit.get("poster", duration - 1.0)
        frame(poster_at).save(P / f"{name.replace('film', 'poster')}.jpg", quality=92, optimize=True)
        print(f"Rendered {duration:.2f}s")
