"""Native pointer input on a dedicated GitHub macOS desktop; no extra packages.

Usage: native-pointer-macos.py X Y [X Y ...] [click]

The pointer moves the way a hand moves it: mouse-moved events posted where
the hardware's arrive, each point reached from a pixel beside it, so the app
sees real movement into whatever is there. It never warps the cursor:
CGWarpMouseCursorPosition moves it without an event, and a move posted at
the warped position right after it is sometimes never delivered, which left
an app hovering what the pointer had already left.
"""

import ctypes
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


cg = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
cg.CGEventCreate.argtypes = [ctypes.c_void_p]
cg.CGEventCreate.restype = ctypes.c_void_p
cg.CGEventGetLocation.argtypes = [ctypes.c_void_p]
cg.CGEventGetLocation.restype = Point
cg.CGEventCreateMouseEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32, Point, ctypes.c_uint32]
cg.CGEventCreateMouseEvent.restype = ctypes.c_void_p
cg.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
cg.CGEventPost.restype = None
cf.CFRelease.argtypes = [ctypes.c_void_p]
cf.CFRelease.restype = None

# kCGEventLeftMouseDown = 1, kCGEventLeftMouseUp = 2, kCGEventMouseMoved = 5.
DOWN, UP, MOVED = 1, 2, 5

args = sys.argv[1:]
click = args[-1:] == ["click"]
if click:
    args = args[:-1]
if not args or len(args) % 2:
    sys.exit("Usage: native-pointer-macos.py X Y [X Y ...] [click]")
points = [Point(float(args[i]), float(args[i + 1])) for i in range(0, len(args), 2)]


def post(kind, point):
    # kCGMouseButtonLeft = 0, kCGHIDEventTap = 0.
    event = cg.CGEventCreateMouseEvent(None, kind, point, 0)
    if not event:
        sys.exit("Failed to create native mouse event")
    try:
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
