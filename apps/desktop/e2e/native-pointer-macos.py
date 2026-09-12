"""Native pointer input on a dedicated GitHub macOS desktop; no extra packages."""

import ctypes
import os
import sys

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
cg.CGWarpMouseCursorPosition.argtypes = [Point]
cg.CGWarpMouseCursorPosition.restype = ctypes.c_int32
cg.CGEventCreateMouseEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32, Point, ctypes.c_uint32]
cg.CGEventCreateMouseEvent.restype = ctypes.c_void_p
cg.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
cg.CGEventPost.restype = None
cf.CFRelease.argtypes = [ctypes.c_void_p]
cf.CFRelease.restype = None

point = Point(float(sys.argv[1]), float(sys.argv[2]))
if cg.CGWarpMouseCursorPosition(point) != 0:
    sys.exit("Failed to move the native pointer")
# kCGEventMouseMoved = 5, kCGMouseButtonLeft = 0, kCGHIDEventTap = 0.
event = cg.CGEventCreateMouseEvent(None, 5, point, 0)
if not event:
    sys.exit("Failed to create native mouse event")
try:
    cg.CGEventPost(0, event)
finally:
    cf.CFRelease(event)
