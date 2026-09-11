#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
task_tmp=$(mktemp -d)
trap 'rm -rf "$task_tmp"' EXIT
for arch in arm64 x86_64; do
  xcrun clang -arch "$arch" -mmacosx-version-min=11.0 -Os -fobjc-arc \
    -Wall -Wextra -Werror -framework Foundation -framework Security -framework LocalAuthentication \
    keychain.m -o "$task_tmp/$arch"
done
mkdir -p bin
xcrun lipo -create "$task_tmp/arm64" "$task_tmp/x86_64" -output bin/browser-keychain
codesign --force --sign - --identifier dev.catamorphic.browser-keychain bin/browser-keychain
python3 - <<'META'
import hashlib,json,pathlib
p=pathlib.Path('.')
print('Helper bytes:',(p/'bin/browser-keychain').stat().st_size)
(p/'manifest.json').write_text(json.dumps({
  'protocol': 1, 'minimumMacOS': '11.0',
  'sourceSha256':hashlib.sha256((p/'keychain.m').read_bytes()).hexdigest(),
  'binarySha256':hashlib.sha256((p/'bin/browser-keychain').read_bytes()).hexdigest()
},indent=2)+'\n')
META
