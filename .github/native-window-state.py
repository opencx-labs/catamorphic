import ctypes
import json
import plistlib

cg = ctypes.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
cf = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
cg.CGWindowListCopyWindowInfo.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
cg.CGWindowListCopyWindowInfo.restype = ctypes.c_void_p
cf.CFPropertyListCreateData.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_long, ctypes.c_ulong, ctypes.c_void_p]
cf.CFPropertyListCreateData.restype = ctypes.c_void_p
cf.CFDataGetLength.argtypes = [ctypes.c_void_p]
cf.CFDataGetLength.restype = ctypes.c_long
cf.CFDataGetBytePtr.argtypes = [ctypes.c_void_p]
cf.CFDataGetBytePtr.restype = ctypes.c_void_p
cf.CFRelease.argtypes = [ctypes.c_void_p]
info = cg.CGWindowListCopyWindowInfo(17, 0)
data = cf.CFPropertyListCreateData(None, info, 100, 0, None)
try:
    rows = plistlib.loads(ctypes.string_at(cf.CFDataGetBytePtr(data), cf.CFDataGetLength(data)))
    print(json.dumps(rows))
finally:
    cf.CFRelease(data)
    cf.CFRelease(info)
