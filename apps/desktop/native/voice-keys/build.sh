#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
task_tmp=$(mktemp -d)
trap 'rm -rf "$task_tmp"' EXIT
for arch in arm64 x86_64; do
  xcrun clang -arch "$arch" -mmacosx-version-min=11.0 -Os -fobjc-arc \
    -Wall -Wextra -Werror -framework Foundation -framework AppKit -framework ApplicationServices -framework Carbon \
    keys.m -o "$task_tmp/$arch"
done
mkdir -p bin
xcrun lipo -create "$task_tmp/arm64" "$task_tmp/x86_64" -output bin/voice-keys
codesign --force --sign - --identifier software.work.voice-keys bin/voice-keys
python3 - <<'META'
import hashlib,json,pathlib
p=pathlib.Path('.')
print('Helper bytes:',(p/'bin/voice-keys').stat().st_size)
(p/'manifest.json').write_text(json.dumps({
  'protocol': 1, 'minimumMacOS': '11.0',
  'sourceSha256':hashlib.sha256((p/'keys.m').read_bytes()).hexdigest(),
  'binarySha256':hashlib.sha256((p/'bin/voice-keys').read_bytes()).hexdigest()
},indent=2)+'\n')
META
