// Catamorphic browser import helper, protocol version 1.
// System frameworks only. No Electron/Node ABI and no database/file access.
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <CommonCrypto/CommonKeyDerivation.h>
#include <unistd.h>

#ifndef CATAMORPHIC_KEYCHAIN_TEST
static int authenticateUser(NSString *account) {
  LAContext *context = [LAContext new];
  NSError *error = nil;
  if (![context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&error]) return 4;
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  __block int result = 4;
  [context evaluatePolicy:LAPolicyDeviceOwnerAuthentication
    localizedReason:[NSString stringWithFormat:@"Import saved passwords from %@ into Catamorphic", account]
    reply:^(BOOL success, NSError *failure) {
      result = success ? 0 : (failure.code == LAErrorUserCancel || failure.code == LAErrorSystemCancel || failure.code == LAErrorAppCancel ? 2 : 4);
      dispatch_semaphore_signal(done);
    }];
  if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 110 * NSEC_PER_SEC)) != 0) {
    [context invalidate];
    return 2;
  }
  [context invalidate];
  return result;
}
#endif

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
      puts("catamorphic-browser-keychain 1");
      return 0;
    }
    if (argc != 3 || isatty(STDOUT_FILENO)) return 64;
    NSString *service = [NSString stringWithUTF8String:argv[1]];
    NSString *account = [NSString stringWithUTF8String:argv[2]];
    NSSet *browsers = [NSSet setWithArray:@[@"Chrome", @"Microsoft Edge", @"Brave", @"Opera", @"Arc", @"Chromium"]];
    if (!service || !account || ![browsers containsObject:account] ||
        ![service isEqualToString:[account stringByAppendingString:@" Safe Storage"]]) return 64;
    int authentication = authenticateUser(account);
    if (authentication != 0) return authentication;
    // Matching reads only. Never create a key or modify access controls.
    NSDictionary *query = @{
      (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
      (__bridge id)kSecAttrService: service,
      (__bridge id)kSecAttrAccount: account,
      (__bridge id)kSecReturnData: @YES,
      (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitOne
    };
    CFTypeRef value = NULL;
    OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &value);
    if (status != errSecSuccess) {
      if (value) CFRelease(value);
      if (status == errSecUserCanceled) return 2;
      if (status == errSecItemNotFound) return 3;
      return 4;
    }
    if (!value || CFGetTypeID(value) != CFDataGetTypeID()) {
      if (value) CFRelease(value);
      return 4;
    }
    NSData *secret = CFBridgingRelease(value);
    if (secret.length == 0) return 4;
    unsigned char key[16];
    const unsigned char salt[] = "saltysalt";
    int derived = CCKeyDerivationPBKDF(kCCPBKDF2, secret.bytes, secret.length,
      salt, sizeof(salt) - 1, kCCPRFHmacAlgSHA1, 1003, key, sizeof(key));
    if (derived != 0) return 4;
    // Raw, bounded output goes only to the parent's pipe, never a terminal.
    ssize_t count = write(STDOUT_FILENO, key, sizeof(key));
    volatile unsigned char *wipe = key;
    for (size_t i = 0; i < sizeof(key); ++i) wipe[i] = 0;
    return count == sizeof(key) ? 0 : 74;
  }
}
