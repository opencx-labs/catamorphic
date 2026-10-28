"""Native pointer input on a dedicated GitHub macOS desktop; no extra packages.

Usage: native-pointer-macos.py X Y [X Y ...] [click], or --displays

The pointer moves the way a hand moves it: mouse-moved events posted where
the hardware's arrive, each point reached from a pixel beside it, so the app
sees real movement into whatever is there. It never warps the cursor:
CGWarpMouseCursorPosition moves it without an event, and a move posted at
the warped position right after it is sometimes never delivered, which left
an app hovering what the pointer had already left.
"""

import ctypes
import json
import os
import sys
import time

if not (
    sys.platform == "darwin"
    and os.environ.get("GITHUB_ACTIONS") == "true"
    and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
):
    sys.exit("Native pointer input requires a dedicated GitHub macOS runner")


class Point(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]


class Size(ctypes.Structure):
    _fields_ = [("width", ctypes.c_double), ("height", ctypes.c_double)]


class Rect(ctypes.Structure):
    _fields_ = [("origin", Point), ("size", Size)]


cg = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
cg.CGEventCreate.argtypes = [ctypes.c_void_p]
cg.CGEventCreate.restype = ctypes.c_void_p
cg.CGEventGetLocation.argtypes = [ctypes.c_void_p]
cg.CGEventGetLocation.restype = Point
cg.CGEventCreateMouseEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32, Point, ctypes.c_uint32]
cg.CGEventCreateMouseEvent.restype = ctypes.c_void_p
cg.CGEventSetIntegerValueField.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int64]
cg.CGEventSetIntegerValueField.restype = None
cg.CGEventSetFlags.argtypes = [ctypes.c_void_p, ctypes.c_uint64]
cg.CGEventSetFlags.restype = None
cg.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
cg.CGEventPost.restype = None
cf.CFRelease.argtypes = [ctypes.c_void_p]
cf.CFRelease.restype = None
cg.CGGetActiveDisplayList.argtypes = [
    ctypes.c_uint32,
    ctypes.POINTER(ctypes.c_uint32),
    ctypes.POINTER(ctypes.c_uint32),
]
cg.CGGetActiveDisplayList.restype = ctypes.c_int32
cg.CGDisplayBounds.argtypes = [ctypes.c_uint32]
cg.CGDisplayBounds.restype = Rect


def active_displays():
    displays = (ctypes.c_uint32 * 32)()
    count = ctypes.c_uint32()
    error = cg.CGGetActiveDisplayList(32, displays, ctypes.byref(count))
    if error or not count.value:
        sys.exit(f"Could not read active Quartz displays: {error}")
    result = []
    for display in displays[: count.value]:
        rect = cg.CGDisplayBounds(display)
        result.append(
            {
                "x": rect.origin.x,
                "y": rect.origin.y,
                "width": rect.size.width,
                "height": rect.size.height,
            }
        )
    return result

# kCGEventLeftMouseDown = 1, kCGEventLeftMouseUp = 2, kCGEventMouseMoved = 5.
DOWN, UP, MOVED = 1, 2, 5

args = sys.argv[1:]
if args == ["--displays"]:
    print(json.dumps(active_displays()))
    sys.exit(0)
click = args[-1:] == ["click"]
if click:
    args = args[:-1]
if not args or len(args) % 2:
    sys.exit("Usage: native-pointer-macos.py X Y [X Y ...] [click]")
points = [Point(float(args[i]), float(args[i + 1])) for i in range(0, len(args), 2)]
if click:
    end = points[-1]
    displays = active_displays()
    if not any(
        rect["x"] <= end.x < rect["x"] + rect["width"]
        and rect["y"] <= end.y < rect["y"] + rect["height"]
        for rect in displays
    ):
        detail = {"point": {"x": end.x, "y": end.y}, "displays": displays}
        sys.exit(f"Native click is outside active displays: {json.dumps(detail)}")


def post(kind, point):
    # kCGMouseButtonLeft = 0, kCGHIDEventTap = 0.
    event = cg.CGEventCreateMouseEvent(None, kind, point, 0)
    if not event:
        sys.exit("Failed to create native mouse event")
    try:
        # This helper sends plain pointer input, never a modifier gesture.
        # A default source inherits flags left by an earlier native shortcut.
        cg.CGEventSetFlags(event, 0)
        if kind in (DOWN, UP):
            # kCGMouseEventClickState = 1. Core Graphics defaults a release
            # to zero clicks; both halves must describe this single click.
            cg.CGEventSetIntegerValueField(event, 1, 1)
        cg.CGEventPost(0, event)
    finally:
        cf.CFRelease(event)


def location():
    event = cg.CGEventCreate(None)
    if not event:
        sys.exit("Failed to read the native pointer")
    try:
        return cg.CGEventGetLocation(event)
    finally:
        cf.CFRelease(event)


for point in points:
    # From a pixel beside the point onto it: movement the app always sees,
    # with no path across anything else on screen.
    post(MOVED, Point(point.x - 1 if point.x >= 1 else point.x + 1, point.y))
    time.sleep(0.016)
    post(MOVED, point)
    deadline = time.monotonic() + 1
    while True:
        here = location()
        if abs(here.x - point.x) < 0.5 and abs(here.y - point.y) < 0.5:
            break
        if time.monotonic() > deadline:
            sys.exit(
                f"The native pointer stopped at {here.x:.0f},{here.y:.0f}"
                f" short of {point.x:.0f},{point.y:.0f}"
            )
        time.sleep(0.01)
    time.sleep(0.016)

if click:
    end = points[-1]
    post(DOWN, end)
    time.sleep(0.05)
    post(UP, end)
