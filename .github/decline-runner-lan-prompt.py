"""Decline only the hosted runner's LAN prompt on a disposable macOS desktop."""
import ctypes
import os
import signal
import subprocess
import sys
import time


def is_runner_lan_prompt(text):
    normalized = text.casefold()
    return 'hosted-compute' in normalized and 'find devices on local networks' in normalized


def is_decline_button(text):
    return text.replace('\u2019', "'").strip() == "Don't Allow"


if '--self-test' in sys.argv:
    assert is_runner_lan_prompt('Allow “hosted-compute” to find devices on local networks?')
    assert not is_runner_lan_prompt('Allow Work to find devices on local networks?')
    assert not is_runner_lan_prompt('hosted-compute quit unexpectedly')
    assert not is_runner_lan_prompt('Allow hosted-compute to record the screen?')
    assert is_decline_button('Don’t Allow')
    assert is_decline_button("Don't Allow")
    assert not is_decline_button('Allow')
    print('Runner prompt policy: 7 checks passed', flush=True)
    sys.exit(0)

if not (sys.platform == 'darwin' and os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'):
    sys.exit('This helper only runs on a dedicated GitHub-hosted macOS test desktop')

ax = ctypes.CDLL('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')
cf = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
ax.AXIsProcessTrusted.restype = ctypes.c_bool
ax.AXUIElementCreateApplication.argtypes = [ctypes.c_int]
ax.AXUIElementCreateApplication.restype = ctypes.c_void_p
ax.AXUIElementCopyAttributeValue.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
ax.AXUIElementCopyAttributeValue.restype = ctypes.c_int
ax.AXUIElementPerformAction.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
ax.AXUIElementPerformAction.restype = ctypes.c_int
cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
cf.CFStringCreateWithCString.restype = ctypes.c_void_p
cf.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_long, ctypes.c_uint32]
cf.CFStringGetCString.restype = ctypes.c_bool
cf.CFGetTypeID.argtypes = [ctypes.c_void_p]
cf.CFGetTypeID.restype = ctypes.c_ulong
cf.CFStringGetTypeID.restype = ctypes.c_ulong
cf.CFArrayGetCount.argtypes = [ctypes.c_void_p]
cf.CFArrayGetCount.restype = ctypes.c_long
cf.CFArrayGetValueAtIndex.argtypes = [ctypes.c_void_p, ctypes.c_long]
cf.CFArrayGetValueAtIndex.restype = ctypes.c_void_p
cf.CFRetain.argtypes = [ctypes.c_void_p]
cf.CFRetain.restype = ctypes.c_void_p
cf.CFRelease.argtypes = [ctypes.c_void_p]
UTF8 = 0x08000100


def string(value):
    return cf.CFStringCreateWithCString(None, value.encode(), UTF8)


def attribute(element, name):
    key = string(name)
    value = ctypes.c_void_p()
    try:
        result = ax.AXUIElementCopyAttributeValue(element, key, ctypes.byref(value))
        return value.value if result == 0 else None
    finally:
        cf.CFRelease(key)


def text_attribute(element, name):
    value = attribute(element, name)
    if not value:
        return ''
    try:
        if cf.CFGetTypeID(value) != cf.CFStringGetTypeID():
            return ''
        buffer = ctypes.create_string_buffer(8192)
        return buffer.value.decode() if cf.CFStringGetCString(value, buffer, len(buffer), UTF8) else ''
    finally:
        cf.CFRelease(value)


def inspect_window(window):
    strings = []
    buttons = []
    visited = 0

    def walk(element, depth=0):
        nonlocal visited
        visited += 1
        if depth > 12 or visited > 200:
            return
        title = text_attribute(element, 'AXTitle')
        strings.extend([title, text_attribute(element, 'AXValue'), text_attribute(element, 'AXDescription')])
        if text_attribute(element, 'AXRole') == 'AXButton' and is_decline_button(title):
            buttons.append(cf.CFRetain(element))
        children = attribute(element, 'AXChildren')
        if children:
            try:
                for i in range(cf.CFArrayGetCount(children)):
                    walk(cf.CFArrayGetValueAtIndex(children, i), depth + 1)
            finally:
                cf.CFRelease(children)

    try:
        walk(window)
        if is_runner_lan_prompt(' '.join(strings)) and len(buttons) == 1:
            action = string('AXPress')
            try:
                result = ax.AXUIElementPerformAction(buttons[0], action)
                if result != 0:
                    raise RuntimeError(f'Cannot decline runner LAN prompt: AX error {result}')
                print('Declined hosted-compute local-network prompt on the isolated test desktop', flush=True)
            finally:
                cf.CFRelease(action)
    finally:
        for button in buttons:
            cf.CFRelease(button)


def check():
    result = subprocess.run(['pgrep', '-x', 'UserNotificationCenter'], capture_output=True, text=True)
    for line in result.stdout.splitlines():
        app = ax.AXUIElementCreateApplication(int(line))
        try:
            windows = attribute(app, 'AXWindows')
            if windows:
                try:
                    for i in range(cf.CFArrayGetCount(windows)):
                        inspect_window(cf.CFArrayGetValueAtIndex(windows, i))
                finally:
                    cf.CFRelease(windows)
        finally:
            cf.CFRelease(app)


if not ax.AXIsProcessTrusted():
    sys.exit('The hosted runner must allow native UI input before running desktop tests')
print('Watching only for the hosted-compute local-network prompt', flush=True)
stopping = False


def stop(*_):
    global stopping
    stopping = True


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
while not stopping:
    check()
    if '--watch' not in sys.argv:
        break
    time.sleep(0.25)
