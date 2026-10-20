#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
task_tmp=$(mktemp -d)
trap 'rm -rf "$task_tmp"' EXIT
for arch in arm64 x86_64; do
  xcrun clang -arch "$arch" -mmacosx-version-min=13.0 -Os -fobjc-arc \
    -Wall -Wextra -Werror -framework Foundation -framework AVFoundation -framework CoreAudio \
    quiet.m -o "$task_tmp/$arch"
done
mkdir -p bin
xcrun lipo -create "$task_tmp/arm64" "$task_tmp/x86_64" -output bin/voice-quiet
codesign --force --sign - --identifier software.work.voice-quiet bin/voice-quiet
python3 - <<'META'
import hashlib,json,pathlib
p=pathlib.Path('.')
print('Helper bytes:',(p/'bin/voice-quiet').stat().st_size)
(p/'manifest.json').write_text(json.dumps({
  'protocol': 1, 'minimumMacOS': '13.0',
  'sourceSha256':hashlib.sha256((p/'quiet.m').read_bytes()).hexdigest(),
  'binarySha256':hashlib.sha256((p/'bin/voice-quiet').read_bytes()).hexdigest()
},indent=2)+'\n')
META
