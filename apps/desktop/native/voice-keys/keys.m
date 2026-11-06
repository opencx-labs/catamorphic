// Work's voice keys (ADR 0236): its voice shortcuts pressed or held in any
// app, and dictation typed into the app in front.
//
//   voice-keys --version   prints the protocol and exits
//   voice-keys             reads commands on stdin, writes events on stdout
//
// Commands, one per line:
//   bind <name> <keycode> <modifiers>   a shortcut: a virtual key code and
//                                       Cmd=1 Ctrl=2 Alt=4 Shift=8; a key
//                                       code of -1 unbinds the name
//   dictate <stretch> <final 0|1> <base64 UTF-8>
//                                       the words of a stretch of speech so
//                                       far, typed where the cursor is: each
//                                       update retypes only what changed
//   send-watch <0|1>                    reports `send` when Return goes down
//                                       alone
//   front                               reports the app in front and its
//                                       window's title
// Events, one per line: ready, down <name>, up <name>, send, untrusted,
// front <base64 JSON {app, window}>.
//
// The held keys are swallowed, so the app in front never acts on them, and
// so is nothing else. The event tap runs on a thread of its own and does
// nothing slow there, so no key anywhere waits on it; asking apps where
// their focus is, and typing, happen on the main thread. The helper needs
// Accessibility, which macOS asks the app for; without it, it says
// `untrusted` and exits 4. It exits when stdin closes, so it never
// outlives Work.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#import <Foundation/Foundation.h>
#import <os/lock.h>
#import <stdatomic.h>

static const int64_t kWorkTyping = 0x576f726b; // "Work": events it types
/** How long an app has to say where its focus is before it is skipped. */
static const float kAskSeconds = 0.25f;

static const CGEventFlags kModifiers = kCGEventFlagMaskCommand |
                                       kCGEventFlagMaskControl |
                                       kCGEventFlagMaskAlternate |
                                       kCGEventFlagMaskShift;

// The tap's thread alone reads and writes these.
static CFMachPortRef tap;
static CFRunLoopRef tapLoop;
#define MAX_BINDINGS 8
static struct {
  char name[32];
  int64_t key;
  CGEventFlags flags;
} bindings[MAX_BINDINGS];
static int bindingCount = 0;
/** The binding held now, or -1. */
static int held = -1;
static bool watchSend = false;

// Between the tap and typing.
/** A stretch of dictation is under way: the person's keys or clicks end it. */
static atomic_bool stretchLive = false;
/**
 * The person took the stretch under way over: they typed, clicked in its
 * field, or focus moved. From then on it is theirs, and nothing more is
 * deleted or typed for it.
 */
static atomic_bool stretchBroken = false;
/**
 * Where the person last clicked during the stretch: in its field, the
 * caret moved; elsewhere (Work's own floating microphone), nothing did.
 */
static os_unfair_lock clickLock = OS_UNFAIR_LOCK_INIT;
static CGPoint click;
/** The window clicked in, by its number; 0 when unknown. */
static int64_t clickWindow = 0;
static atomic_bool clicked = false;
/** A shortcut whose hold ended before its key came up: its key is still ours. */
static int64_t swallowing = -1;

// The main thread alone reads and writes these: the stretch typed so far,
// into which element of which app.
static long liveStretch = -1;
static NSString *liveText = @"";
static CFTypeRef liveElement = NULL;
static pid_t liveApp = 0;

static os_unfair_lock sayLock = OS_UNFAIR_LOCK_INIT;

static void say(const char *event, const char *detail) {
  os_unfair_lock_lock(&sayLock);
  if (detail)
    printf("%s %s\n", event, detail);
  else
    printf("%s\n", event);
  fflush(stdout);
  os_unfair_lock_unlock(&sayLock);
}

static void breakStretch(void) {
  if (atomic_load(&stretchLive)) atomic_store(&stretchBroken, true);
}

static CGEventRef onEvent(CGEventTapProxy proxy, CGEventType type,
                          CGEventRef event, void *info) {
  (void)proxy;
  (void)info;
  if (type == kCGEventTapDisabledByTimeout ||
      type == kCGEventTapDisabledByUserInput) {
    CGEventTapEnable(tap, true);
    // A release missed while the tap was off leaves no key held.
    if (held >= 0) {
      say("up", bindings[held].name);
      held = -1;
    }
    swallowing = -1;
    return event;
  }
  if (CGEventGetIntegerValueField(event, kCGEventSourceUserData) ==
      kWorkTyping)
    return event;
  if (type == kCGEventLeftMouseDown || type == kCGEventRightMouseDown ||
      type == kCGEventOtherMouseDown) {
    // Where it landed says whether the caret moved; typing checks.
    if (atomic_load(&stretchLive)) {
      os_unfair_lock_lock(&clickLock);
      click = CGEventGetLocation(event);
      clickWindow = CGEventGetIntegerValueField(
          event, kCGMouseEventWindowUnderMousePointer);
      os_unfair_lock_unlock(&clickLock);
      atomic_store(&clicked, true);
    }
    return event;
  }
  CGEventFlags flags = CGEventGetFlags(event) & kModifiers;
  if (type == kCGEventFlagsChanged) {
    // A modifier of the keys coming up ends the hold; the key itself stays
    // the hold's until it comes up.
    if (held >= 0 && (flags & bindings[held].flags) != bindings[held].flags) {
      say("up", bindings[held].name);
      swallowing = bindings[held].key;
      held = -1;
    }
    return event;
  }
  int64_t key = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
  if (key == swallowing) {
    if (type == kCGEventKeyUp) swallowing = -1;
    return NULL;
  }
  if (held >= 0) {
    if (key != bindings[held].key) {
      if (type == kCGEventKeyDown) breakStretch();
      return event;
    }
    // Its repeats, and its release, are the hold's.
    if (type == kCGEventKeyUp) {
      say("up", bindings[held].name);
      held = -1;
    }
    return NULL;
  }
  if (type != kCGEventKeyDown) return event;
  bool repeat =
      CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat) != 0;
  for (int index = 0; index < bindingCount; index++)
    if (bindings[index].key == key && bindings[index].flags == flags) {
      // A repeat is a key held since before: never a second press.
      if (repeat) return NULL;
      held = index;
      say("down", bindings[index].name);
      return NULL;
    }
  // The person typing during a stretch of dictation takes it over.
  breakStretch();
  if (watchSend && flags == 0 && (key == 36 || key == 76)) say("send", NULL);
  return event;
}

/** Runs on the tap's thread, which alone touches the bindings. */
static void onTapThread(void (^block)(void)) {
  CFRunLoopPerformBlock(tapLoop, kCFRunLoopCommonModes, block);
  CFRunLoopWakeUp(tapLoop);
}

/** An attribute of an element, or NULL; the caller releases it. */
static CFTypeRef copyAttribute(CFTypeRef element, CFStringRef attribute) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue((AXUIElementRef)element, attribute,
                                    &value) != kAXErrorSuccess)
    return NULL;
  return value;
}

/** The element with keyboard focus, wherever it is; NULL if unknown. */
static CFTypeRef focusedElement(void) {
  AXUIElementRef system = AXUIElementCreateSystemWide();
  CFTypeRef element = copyAttribute(system, kAXFocusedUIElementAttribute);
  CFRelease(system);
  return element;
}

/** A password field, or secure input on anywhere: nothing is typed then. */
static bool secureNow(CFTypeRef element) {
  if (IsSecureEventInputEnabled()) return true;
  if (!element) return false;
  CFTypeRef subrole = copyAttribute(element, kAXSubroleAttribute);
  bool secure = subrole && CFGetTypeID(subrole) == CFStringGetTypeID() &&
                CFEqual(subrole, kAXSecureTextFieldSubrole);
  if (subrole) CFRelease(subrole);
  return secure;
}

static pid_t frontApp(void) {
  return NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
}

/** One of Work's own key events, marked so the tap lets it be. */
static void post(CGEventSourceRef source, CGKeyCode code, bool down,
                 const unichar *chars, NSUInteger count) {
  CGEventRef key = CGEventCreateKeyboardEvent(source, code, down);
  if (!key) return;
  CGEventSetFlags(key, 0);
  CGEventSetIntegerValueField(key, kCGEventSourceUserData, kWorkTyping);
  if (chars) CGEventKeyboardSetUnicodeString(key, count, chars);
  CGEventPost(kCGHIDEventTap, key);
  CFRelease(key);
}

/**
 * Types text into the app in front, a few whole characters per key event.
 * Stops as soon as the person takes the stretch over; false then.
 */
static bool type(NSString *text) {
  CGEventSourceRef source =
      CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
  NSUInteger length = text.length;
  NSUInteger start = 0;
  bool whole = true;
  while (start < length) {
    if (atomic_load(&stretchBroken)) {
      whole = false;
      break;
    }
    NSRange range = [text
        rangeOfComposedCharacterSequencesForRange:NSMakeRange(
                                                      start,
                                                      MIN((NSUInteger)16,
                                                          length - start))];
    unichar *chars = malloc(range.length * sizeof(unichar));
    if (!chars) {
      whole = false;
      break;
    }
    [text getCharacters:chars range:range];
    post(source, 0, true, chars, range.length);
    post(source, 0, false, chars, range.length);
    free(chars);
    start = NSMaxRange(range);
    usleep(4000);
  }
  if (source) CFRelease(source);
  return whole;
}

/** Presses Delete, as typing does, `count` times; false if taken over. */
static bool erase(NSUInteger count) {
  CGEventSourceRef source =
      CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
  bool whole = true;
  for (NSUInteger index = 0; index < count; index++) {
    if (atomic_load(&stretchBroken)) {
      whole = false;
      break;
    }
    post(source, 51, true, NULL, 0);
    post(source, 51, false, NULL, 0);
    usleep(2000);
  }
  if (source) CFRelease(source);
  return whole;
}

/** Whether a point on screen is inside an element's frame. */
static bool inside(CFTypeRef element, CGPoint point) {
  CFTypeRef position = copyAttribute(element, kAXPositionAttribute);
  CFTypeRef size = copyAttribute(element, kAXSizeAttribute);
  CGPoint origin = CGPointZero;
  CGSize extent = CGSizeZero;
  bool known =
      position && size &&
      AXValueGetValue((AXValueRef)position, kAXValueTypeCGPoint, &origin) &&
      AXValueGetValue((AXValueRef)size, kAXValueTypeCGSize, &extent);
  if (position) CFRelease(position);
  if (size) CFRelease(size);
  // Not knowing where the field is, a click anywhere might be in it.
  return !known || CGRectContainsPoint((CGRect){origin, extent}, point);
}

/** Whether a window is Work's own (its floating microphone, say). */
static bool worksWindow(int64_t number) {
  if (number <= 0) return false;
  CFArrayRef windows = CGWindowListCopyWindowInfo(
      kCGWindowListOptionIncludingWindow, (CGWindowID)number);
  if (!windows) return false;
  bool works = false;
  if (CFArrayGetCount(windows) > 0) {
    CFDictionaryRef info = CFArrayGetValueAtIndex(windows, 0);
    CFNumberRef owner = CFDictionaryGetValue(info, kCGWindowOwnerPID);
    pid_t pid = 0;
    works = owner && CFNumberGetValue(owner, kCFNumberIntType, &pid) &&
            pid == getppid();
  }
  CFRelease(windows);
  return works;
}

/**
 * A click since the last update in the stretch's field: the caret moved.
 * Never one on Work's own windows, which take no focus.
 */
static bool clickedInField(void) {
  if (!atomic_exchange(&clicked, false)) return false;
  os_unfair_lock_lock(&clickLock);
  CGPoint point = click;
  int64_t window = clickWindow;
  os_unfair_lock_unlock(&clickLock);
  if (worksWindow(window)) return false;
  return !liveElement || inside(liveElement, point);
}

/** The app in front and its focused window's title: names, never text. */
static void front(void) {
  NSRunningApplication *app = NSWorkspace.sharedWorkspace.frontmostApplication;
  NSMutableDictionary *place = [NSMutableDictionary dictionary];
  place[@"app"] = app.localizedName ?: @"";
  if (app) {
    AXUIElementRef element = AXUIElementCreateApplication(app.processIdentifier);
    CFTypeRef window = copyAttribute(element, kAXFocusedWindowAttribute);
    if (window) {
      CFTypeRef title = copyAttribute(window, kAXTitleAttribute);
      if (title && CFGetTypeID(title) == CFStringGetTypeID())
        place[@"window"] = (__bridge NSString *)title;
      if (title) CFRelease(title);
      CFRelease(window);
    }
    CFRelease(element);
  }
  NSData *json = [NSJSONSerialization dataWithJSONObject:place
                                                 options:0
                                                   error:nil];
  say("front", [json base64EncodedStringWithOptions:0].UTF8String ?: "");
}

/**
 * A stretch's words so far, typed where the cursor is: only the end that
 * changed is deleted and typed again, so the words settle in place. Never
 * once the person typed or clicked, focus moved to another element or
 * app, or into a password.
 */
static void dictate(long stretch, bool final, NSString *text) {
  if (stretch != liveStretch) {
    if (liveElement) CFRelease(liveElement);
    liveStretch = stretch;
    liveText = @"";
    liveElement = focusedElement();
    liveApp = frontApp();
    atomic_store(&clicked, false);
    atomic_store(&stretchBroken, secureNow(liveElement));
    atomic_store(&stretchLive, true);
  } else if (!atomic_load(&stretchBroken)) {
    CFTypeRef now = focusedElement();
    bool moved = frontApp() != liveApp ||
                 (liveElement && (!now || !CFEqual(now, liveElement))) ||
                 secureNow(now) || clickedInField();
    if (now) CFRelease(now);
    if (moved) atomic_store(&stretchBroken, true);
  }
  if (!atomic_load(&stretchBroken)) {
    NSUInteger common = 0;
    NSUInteger shorter = MIN(liveText.length, text.length);
    while (common < shorter &&
           [liveText characterAtIndex:common] == [text characterAtIndex:common])
      common++;
    // Never half a character: back to where a whole one starts.
    if (common < liveText.length)
      common = [liveText rangeOfComposedCharacterSequenceAtIndex:common]
                   .location;
    // One Delete per character on screen, however many units it takes.
    NSUInteger stale = 0;
    for (NSUInteger at = common; at < liveText.length;
         at = NSMaxRange([liveText rangeOfComposedCharacterSequenceAtIndex:at]))
      stale++;
    if (erase(stale) && type([text substringFromIndex:common]))
      liveText = text;
  }
  if (final) {
    atomic_store(&stretchLive, false);
    liveStretch = -1;
    liveText = @"";
    if (liveElement) CFRelease(liveElement);
    liveElement = NULL;
  }
}

static void command(NSString *line) {
  NSArray<NSString *> *parts = [line componentsSeparatedByString:@" "];
  if (parts.count == 4 && [parts[0] isEqualToString:@"bind"] &&
      parts[1].length > 0 && parts[1].length < 32) {
    NSString *name = parts[1];
    int64_t key = parts[2].longLongValue;
    int mask = parts[3].intValue;
    onTapThread(^{
      // Shortcuts changed mid-hold: the hold ends, and says so.
      if (held >= 0) say("up", bindings[held].name);
      held = -1;
      int index = 0;
      while (index < bindingCount &&
             strcmp(bindings[index].name, name.UTF8String) != 0)
        index++;
      if (key < 0) {
        if (index < bindingCount) bindings[index] = bindings[--bindingCount];
        return;
      }
      if (index == bindingCount) {
        if (bindingCount == MAX_BINDINGS) return;
        bindingCount++;
      }
      strlcpy(bindings[index].name, name.UTF8String,
              sizeof bindings[index].name);
      bindings[index].key = key;
      bindings[index].flags = ((mask & 1) ? kCGEventFlagMaskCommand : 0) |
                              ((mask & 2) ? kCGEventFlagMaskControl : 0) |
                              ((mask & 4) ? kCGEventFlagMaskAlternate : 0) |
                              ((mask & 8) ? kCGEventFlagMaskShift : 0);
    });
  } else if (parts.count == 4 && [parts[0] isEqualToString:@"dictate"]) {
    long stretch = parts[1].integerValue;
    bool final = [parts[2] isEqualToString:@"1"];
    // Nothing said (someone else, or noise) takes back what showed.
    NSData *data =
        parts[3].length == 0
            ? [NSData data]
            : [[NSData alloc] initWithBase64EncodedString:parts[3] options:0];
    NSString *text =
        data ? [[NSString alloc] initWithData:data
                                     encoding:NSUTF8StringEncoding]
             : nil;
    if (text)
      dispatch_async(dispatch_get_main_queue(), ^{
        @autoreleasepool {
          dictate(stretch, final, text);
        }
      });
  } else if (parts.count == 1 && [parts[0] isEqualToString:@"front"]) {
    dispatch_async(dispatch_get_main_queue(), ^{
      @autoreleasepool {
        front();
      }
    });
  } else if (parts.count == 2 && [parts[0] isEqualToString:@"send-watch"]) {
    bool on = [parts[1] isEqualToString:@"1"];
    onTapThread(^{
      watchSend = on;
    });
  }
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
      say("work-voice-keys 1", NULL);
      return 0;
    }
    if (argc != 1 || isatty(STDOUT_FILENO)) return 64;
    if (!AXIsProcessTrusted()) {
      say("untrusted", NULL);
      return 4;
    }
    // An app that does not answer is skipped, not waited on.
    AXUIElementRef system = AXUIElementCreateSystemWide();
    AXUIElementSetMessagingTimeout(system, kAskSeconds);
    dispatch_semaphore_t started = dispatch_semaphore_create(0);
    NSThread *keys = [[NSThread alloc] initWithBlock:^{
      CGEventMask mask = CGEventMaskBit(kCGEventKeyDown) |
                         CGEventMaskBit(kCGEventKeyUp) |
                         CGEventMaskBit(kCGEventFlagsChanged) |
                         CGEventMaskBit(kCGEventLeftMouseDown) |
                         CGEventMaskBit(kCGEventRightMouseDown) |
                         CGEventMaskBit(kCGEventOtherMouseDown);
      tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap,
                             kCGEventTapOptionDefault, mask, onEvent, NULL);
      if (tap) {
        tapLoop = CFRunLoopGetCurrent();
        CFRunLoopSourceRef source =
            CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0);
        CFRunLoopAddSource(tapLoop, source, kCFRunLoopCommonModes);
        CFRelease(source);
        CGEventTapEnable(tap, true);
      }
      dispatch_semaphore_signal(started);
      if (tap) CFRunLoopRun();
    }];
    keys.qualityOfService = NSQualityOfServiceUserInteractive;
    [keys start];
    dispatch_semaphore_wait(started, DISPATCH_TIME_FOREVER);
    if (!tap) {
      say("untrusted", NULL);
      return 4;
    }
    // Commands arrive on stdin; it closing means Work is gone.
    [NSThread detachNewThreadWithBlock:^{
      char buffer[65536];
      while (fgets(buffer, sizeof buffer, stdin)) {
        @autoreleasepool {
          // Only the line's end goes: an empty last field still counts.
          NSString *line = [[NSString stringWithUTF8String:buffer]
              stringByTrimmingCharactersInSet:NSCharacterSet
                                                  .newlineCharacterSet];
          if (line) command(line);
        }
      }
      exit(0);
    }];
    say("ready", NULL);
    CFRunLoopRun();
    CFRelease(system);
  }
  return 0;
}
