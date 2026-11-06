"""edit.json and the WebVTT track for the Lisbon film from a take's markers.
Everything plays at 1x; only the agent's work (and an app's first load) is
cut, each time with a short dissolve. Usage: make-edit.py <take>"""
import json
import sys
from pathlib import Path

P = Path(__file__).parent
take = sys.argv[1] if len(sys.argv) > 1 else "main"
marks = {}
for line in (P / f"markers-{take}.jsonl").read_text().splitlines():
    if line.strip():
        m = json.loads(line)
        marks.setdefault(m["event"], []).append(m["t"])
duration = json.loads((P / f"raw-{take}/manifest.json").read_text())["duration"]


def t(name, n=0):
    if name not in marks or len(marks[name]) <= n:
        raise SystemExit(f"missing marker: {name} #{n}")
    return marks[name][n]


def has(name, n=0):
    return name in marks and len(marks[name]) > n


seg = []


def add(i, o, caption, xfade=0.0):
    if o - i > 0.05:
        seg.append({"source": take, "in": round(i, 3), "out": round(o, 3), "caption": caption, **({"xfade": xfade} if xfade else {})})


def asked(name, caption, reply_hold=None):
    """Open the chat, (read the last answer), type, send, put it away."""
    start = t(f"{name} chat open") - 0.4
    add(start, t(f"{name} sent") + 0.8, caption)
    add(t(f"{name} sent") + 0.8, t(f"{name} minimized") + 0.6, caption)


# 1. The plan; the palette opens the guide beside it; a look at the guide.
opening = "Sam is planning a team offsite in Lisbon. From the palette, Sam opens a travel guide beside the plan."
# The guide's page load is cut: from just after it opens to just before it shows.
add(max(0.2, t("open hold end") - 3.0), t("palette beside") + 1.2, opening)
add(t("guide shown") - 2.4, t("belem chat open") - 0.4, opening, xfade=0.3)
# 2. Ask for Friday afternoon.
asked("belem", "Sam asks the agent to open Belém in the guide and fill Friday afternoon.")
nav = t("belem: guide on Belém") if has("belem: guide on Belém") else None
filled = t("belem: plan filled") if has("belem: plan filled") else t("belem idle")
landing = "The agent opens the Belém page in the guide and writes three stops into the plan."
if nav is not None and filled - nav > 7.0:
    add(nav - 0.8, nav + 2.6, landing, xfade=0.4)
    add(filled - 1.0, t("belem landed"), landing, xfade=0.4)
else:
    add((nav if nav is not None else filled) - 0.8, t("belem landed"), landing, xfade=0.4)
# 3. Light mode, by asking.
asked("light", "Sam asks for light mode.")
add(t("light: theme light") - 1.0, t("light landed"), "Work turns light, everywhere at once.", xfade=0.4)
# 4. A workflow, and its graph.
asked("workflow", "Sam asks for a workflow that checks Friday's forecast every morning.")
add(t("workflow settled") - 1.2, t("graph held"),
    "The workflow is saved to the project. Sam opens it: a schedule, the forecast check, a message to the chat.",
    xfade=0.4)
# 5. An app; the palette opens it beside the workflow; Sam uses it.
asked("app", "Sam asks for an app for the team with the plan, the forecast and who's joining what.")
use_caption = "In the app, Sam picks a name, sees Friday's live forecast, and joins a stop on the Belém walk."
beside = t("app beside")
end = min(t("end") - 2.2, duration - 0.1) if has("end") else duration - 0.1
if t("app ready") - beside > 3.0:
    add(t("app settled") - 1.0, beside + 1.0,
        "The app is ready. From the palette, Sam opens it beside the workflow.", xfade=0.4)
    add(t("app ready") - 0.4, end, use_caption, xfade=0.45)
else:
    add(t("app settled") - 1.0, end, use_caption, xfade=0.4)
last = seg[-1]
seg.append({"source": take, "in": last["out"], "out": last["out"], "hold": 1.4, "caption": last["caption"]})

starts, start = [], 0.0
for n, s in enumerate(seg):
    if n and s.get("xfade"):
        start -= s["xfade"]
    starts.append(start)
    start += s.get("hold", s["out"] - s["in"])
total = start
from PIL import Image  # noqa: E402
src_frames = json.loads((P / f"raw-{take}/manifest.json").read_text())["frames"]
src_size = Image.open(P / f"raw-{take}" / src_frames[0]["file"]).size
json.dump({"output": "work-desktop-film", "crf": 17, "size": list(src_size), "poster": round(total - 0.5, 2), "segments": seg},
          open(P / "edit.json", "w"), indent=1)


def stamp(x):
    return f"{int(x // 3600):02}:{int(x % 3600 // 60):02}:{x % 60:06.3f}"


cues = []
for n, s in enumerate(seg):
    a = starts[n]
    b = starts[n + 1] if n + 1 < len(seg) else total
    if cues and cues[-1][2] == s["caption"]:
        cues[-1][1] = b
    else:
        cues.append([a, b, s["caption"]])
vtt = ["WEBVTT", ""]
for a, b, text in cues:
    vtt += [f"{stamp(a)} --> {stamp(b)}", text, ""]
(P / "work-desktop-film.vtt").write_text("\n".join(vtt))
print(f"{len(seg)} segments, {total:.1f}s")
for n, s in enumerate(seg):
    print(f"  {starts[n]:6.2f}  src {s['in']:7.2f}-{s['out']:7.2f} ({s.get('hold', s['out'] - s['in']):5.2f}s) xfade={s.get('xfade', 0)}  {s['caption'][:46]}")
