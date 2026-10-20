// Other apps' audio, lowered while voice listens (ADR 0268). macOS lowers
// every other sound while an app runs its voice processing on a
// microphone, as it does for a call; this helper runs it, and hears
// nothing: Work's own page listens and transcribes.
//
// stdin, one command per line:
//   quiet <base64 UTF-8 label of the microphone voice listens with>
//   loud
// stdout, one event per line: ready, quiet, loud, unavailable <reason>.
// It exits when stdin closes, so it never outlives Work.

#import <AVFoundation/AVFoundation.h>
#import <CoreAudio/CoreAudio.h>
#import <Foundation/Foundation.h>
#include <stdio.h>
#include <unistd.h>

static AVAudioEngine *engine = nil;
static id changes = nil;

static void say(NSString *line) {
  printf("%s\n", line.UTF8String);
  fflush(stdout);
}

static AudioObjectID defaultInput(void) {
  AudioObjectPropertyAddress address = {
      kAudioHardwarePropertyDefaultInputDevice,
      kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  AudioObjectID device = kAudioObjectUnknown;
  UInt32 size = sizeof(device);
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL,
                                 &size, &device) != noErr)
    return kAudioObjectUnknown;
  return device;
}

static NSString *deviceName(AudioObjectID device) {
  AudioObjectPropertyAddress address = {kAudioObjectPropertyName,
                                        kAudioObjectPropertyScopeGlobal,
                                        kAudioObjectPropertyElementMain};
  CFStringRef name = NULL;
  UInt32 size = sizeof(name);
  if (AudioObjectGetPropertyData(device, &address, 0, NULL, &size, &name) !=
          noErr ||
      name == NULL)
    return nil;
  return CFBridgingRelease(name);
}

// Chromium labels a microphone with macOS's name for it, after "Default - "
// for the system's and before its transport: "MacBook Pro Microphone
// (Built-in)".
static BOOL labelNames(NSString *label, NSString *name) {
  if ([label hasPrefix:@"Default - "])
    label = [label substringFromIndex:10];
  return name.length > 0 &&
         ([label isEqualToString:name] ||
          [label hasPrefix:[name stringByAppendingString:@" ("]]);
}

static void loud(void) {
  if (changes) {
    [[NSNotificationCenter defaultCenter] removeObserver:changes];
    changes = nil;
  }
  if (!engine)
    return;
  [engine stop];
  [engine.inputNode removeTapOnBus:0];
  engine = nil;
}

// Voice processing opens the system's input. It runs only when that is
// the microphone voice listens with: another one, such as a Bluetooth
// headset's, would switch that headset to its call mode.
static NSString *quiet(NSString *label) {
  if (engine)
    return nil;
  if (!labelNames(label, deviceName(defaultInput())))
    return @"microphone";
  AVAudioEngine *next = [[AVAudioEngine alloc] init];
  AVAudioInputNode *input = next.inputNode;
  NSError *error = nil;
  if (![input setVoiceProcessingEnabled:YES error:&error])
    return @"voice-processing";
  // The microphone keeps the gain the system gives it (ADR 0236).
  input.voiceProcessingAGCEnabled = NO;
  if (@available(macOS 14.0, *)) {
    AVAudioVoiceProcessingOtherAudioDuckingConfiguration ducking = {
        .enableAdvancedDucking = NO,
        .duckingLevel = AVAudioVoiceProcessingOtherAudioDuckingLevelMid};
    input.voiceProcessingOtherAudioDuckingConfiguration = ducking;
  }
  [input installTapOnBus:0
              bufferSize:4096
                  format:nil
                   block:^(AVAudioPCMBuffer *__unused buffer,
                           AVAudioTime *__unused when){
                   }];
  if (![next startAndReturnError:&error]) {
    [input removeTapOnBus:0];
    return @"start";
  }
  engine = next;
  // Devices that change stop the engine: other audio comes back up.
  changes = [[NSNotificationCenter defaultCenter]
      addObserverForName:AVAudioEngineConfigurationChangeNotification
                  object:next
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(NSNotification *__unused note) {
                if (engine != next)
                  return;
                loud();
                say(@"unavailable changed");
              }];
  return nil;
}

static void handle(NSString *line) {
  if ([line isEqualToString:@"loud"]) {
    loud();
    say(@"loud");
    return;
  }
  if ([line hasPrefix:@"quiet "]) {
    NSData *bytes = [[NSData alloc]
        initWithBase64EncodedString:[line substringFromIndex:6]
                            options:0];
    NSString *label =
        bytes ? [[NSString alloc] initWithData:bytes
                                      encoding:NSUTF8StringEncoding]
              : nil;
    NSString *failure = label ? quiet(label) : @"label";
    say(failure ? [@"unavailable " stringByAppendingString:failure]
                : @"quiet");
  }
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc > 1 && strcmp(argv[1], "--version") == 0) {
      say(@"work-voice-quiet 1");
      return 0;
    }
    if (isatty(STDOUT_FILENO)) {
      fprintf(stderr, "voice-quiet speaks to Work over pipes.\n");
      return 2;
    }
    say(@"ready");
    // Commands are read off the main thread and run on it, where
    // AVFoundation delivers what it reports.
    dispatch_async(
        dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
          char buffer[4096];
          while (fgets(buffer, sizeof(buffer), stdin)) {
            NSString *line = [[NSString stringWithUTF8String:buffer]
                stringByTrimmingCharactersInSet:
                    [NSCharacterSet whitespaceAndNewlineCharacterSet]];
            if (!line)
              continue;
            dispatch_sync(dispatch_get_main_queue(), ^{
              handle(line);
            });
          }
          dispatch_sync(dispatch_get_main_queue(), ^{
            loud();
          });
          exit(0);
        });
    dispatch_main();
  }
}
