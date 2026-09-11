#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include <assert.h>
#include <unistd.h>
static OSStatus fakeStatus = errSecSuccess;
static int calls = 0;
static OSStatus readFixture(CFDictionaryRef query, CFTypeRef *result) {
  calls++;
  NSDictionary *value = (__bridge NSDictionary *)query;
  assert(value.count == 5);
  assert([value[(__bridge id)kSecClass] isEqual:(__bridge id)kSecClassGenericPassword]);
  assert([value[(__bridge id)kSecAttrService] isEqual:@"Chrome Safe Storage"]);
  assert([value[(__bridge id)kSecAttrAccount] isEqual:@"Chrome"]);
  assert([value[(__bridge id)kSecReturnData] isEqual:@YES]);
  assert([value[(__bridge id)kSecMatchLimit] isEqual:(__bridge id)kSecMatchLimitOne]);
  if (fakeStatus == errSecSuccess) {
    *result = CFBridgingRetain([@"synthetic-fixture" dataUsingEncoding:NSUTF8StringEncoding]);
  }
  return fakeStatus;
}
static int authResult = 0;
static int authenticateUser(NSString *account) {
  assert([account isEqualToString:@"Chrome"]);
  return authResult;
}
#define CATAMORPHIC_KEYCHAIN_TEST
#define SecItemCopyMatching readFixture
#define main helperMain
#include "keychain.m"
#undef main
#undef SecItemCopyMatching
int main(void) {
  @autoreleasepool {
    int descriptors[2];
    assert(pipe(descriptors) == 0);
    int saved = dup(STDOUT_FILENO);
    assert(dup2(descriptors[1], STDOUT_FILENO) >= 0);
    close(descriptors[1]);
    const char *args[] = {"helper", "Chrome Safe Storage", "Chrome"};
    assert(helperMain(3, args) == 0);
    unsigned char actual[16];
    assert(read(descriptors[0], actual, 16) == 16);
    // Independent PBKDF2 vector generated with Python hashlib.
    const unsigned char expected[] = {0x1f, 0xe0, 0xb, 0x69, 0xe4, 0x33, 0x6b, 0x83, 0x4c, 0x1b, 0x95, 0x9b, 0x57, 0x37, 0x89, 0x4f};
    assert(memcmp(actual, expected, 16) == 0);
    fakeStatus = errSecUserCanceled; assert(helperMain(3, args) == 2);
    fakeStatus = errSecItemNotFound; assert(helperMain(3, args) == 3);
    fakeStatus = errSecAuthFailed; assert(helperMain(3, args) == 4);
    assert(calls == 4);
    authResult = 2; assert(helperMain(3, args) == 2);
    authResult = 4; assert(helperMain(3, args) == 4);
    assert(calls == 4);
    const char *invalid[] = {"helper", "Unrelated key", "Chrome"};
    assert(helperMain(3, invalid) == 64);
    assert(calls == 4);
    assert(dup2(saved, STDOUT_FILENO) >= 0);
    close(saved); close(descriptors[0]);
    puts("Native Keychain protocol tests passed (synthetic data only).");
  }
  return 0;
}
