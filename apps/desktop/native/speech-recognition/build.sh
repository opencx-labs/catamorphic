#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
task_tmp=$(mktemp -d)
trap 'rm -rf "$task_tmp"' EXIT
task_sdk=$(xcrun --show-sdk-path)
for arch in arm64 x86_64; do
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -Osize \
    -sdk "$task_sdk" -target "$arch-apple-macosx13.0" \
    -framework Foundation -framework AVFoundation -framework Speech \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist \
    speech.swift -o "$task_tmp/$arch"
done
mkdir -p bin
xcrun lipo -create "$task_tmp/arm64" "$task_tmp/x86_64" -output bin/speech-recognition
codesign --force --sign - --identifier software.work.speech-recognition bin/speech-recognition
python3 - <<'META'
import hashlib,json,pathlib
p=pathlib.Path('.')
print('Helper bytes:',(p/'bin/speech-recognition').stat().st_size)
(p/'manifest.json').write_text(json.dumps({
  'protocol': 1, 'minimumMacOS': '13.0',
  'sourceSha256':hashlib.sha256((p/'speech.swift').read_bytes()).hexdigest(),
  'infoPlistSha256':hashlib.sha256((p/'Info.plist').read_bytes()).hexdigest(),
  'binarySha256':hashlib.sha256((p/'bin/speech-recognition').read_bytes()).hexdigest()
},indent=2)+'\n')
META
