#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
task_tmp=$(mktemp -d)
trap 'rm -rf "$task_tmp"' EXIT
xcrun clang -mmacosx-version-min=11.0 -Os -fobjc-arc -Wall -Wextra -Werror \
  -framework Foundation -framework Security -framework LocalAuthentication keychain.test.m -o "$task_tmp/test"
"$task_tmp/test"
codesign --verify --strict bin/browser-keychain
bin/browser-keychain --version
