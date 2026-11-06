"""Native key presses on a dedicated GitHub macOS desktop; no extra packages.

Usage: native-keys-macos.py KEYCODE [command] [shift] [option] [control]

A press posted where the hardware's arrive, so it reaches the app the way a
keyboard's does: through AppKit, its menus and the system's own shortcuts
(Cmd+` moving between an app's windows), before any web page sees it.
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
    sys.exit("Native key input requires a dedicated GitHub macOS runner")

cg = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
cg.CGEventCreateKeyboardEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint16, ctypes.c_bool]
cg.CGEventCreateKeyboardEvent.restype = ctypes.c_void_p
cg.CGEventSetFlags.argtypes = [ctypes.c_void_p, ctypes.c_uint64]
cg.CGEventSetFlags.restype = None
cg.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
cg.CGEventPost.restype = None
cf.CFRelease.argtypes = [ctypes.c_void_p]
cf.CFRelease.restype = None

MODIFIERS = {
    "command": (55, 0x100000),
    "shift": (56, 0x20000),
    "option": (58, 0x80000),
    "control": (59, 0x40000),
}

args = sys.argv[1:]
if not args or not args[0].isdigit() or any(arg not in MODIFIERS for arg in args[1:]):
    sys.exit("Usage: native-keys-macos.py KEYCODE [command] [shift] [option] [control]")
key = int(args[0])
modifiers = [MODIFIERS[name] for name in args[1:]]


def post(key, down, flags):
    event = cg.CGEventCreateKeyboardEvent(None, key, down)
    if not event:
        sys.exit("Failed to create native key event")
    try:
        cg.CGEventSetFlags(event, flags)
        # kCGHIDEventTap = 0.
        cg.CGEventPost(0, event)
    finally:
        cf.CFRelease(event)


flags = 0
held = []
try:
    for modifier_key, flag in modifiers:
        flags |= flag
        post(modifier_key, True, flags)
        held.append((modifier_key, flag))
    post(key, True, flags)
    time.sleep(0.05)
    post(key, False, flags)
finally:
    # Release the physical modifiers too. Leaving Command on the key-up
    # alone strands it in the event source used by subsequent pointer input.
    for modifier_key, flag in reversed(held):
        flags &= ~flag
        post(modifier_key, False, flags)
