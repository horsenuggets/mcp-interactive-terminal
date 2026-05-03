#!/usr/bin/env bash
# Rename the Mach-O executable inside the Tauri-built .app bundle from
# the lowercase Cargo bin name "terminal-viewer" to "Terminal Viewer"
# (with a space) and update CFBundleExecutable to match. macOS uses
# CFBundleExecutable / the binary's basename as the displayed process
# name (in `ps`, Activity Monitor, the menu bar app menu, and Dock
# tooltips), so without this rename the app would show "terminal-viewer"
# despite productName being "Terminal Viewer".
#
# Idempotent — safe to run multiple times.
#
# Invoked from tauri.conf.json's `afterBundleCommand`, but can also be
# run manually after `cargo tauri build`.

set -euo pipefail

# macOS-only: this script uses `plutil` and `codesign`. On other
# platforms (Linux/Windows builds via cross-compilation) the .app
# bundle does not exist and the tools aren't available — exit 0 so
# `npm run tauri:build` doesn't fail there.
if [[ "$(uname)" != "Darwin" ]]; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="Terminal Viewer.app"
NEW_EXECUTABLE="Terminal Viewer"
OLD_EXECUTABLE="terminal-viewer"

# Resolve the bundle path. tauri.conf.json's afterBundleCommand runs
# from src-tauri/, so target/release/bundle/macos/<APP> is relative.
APP_PATH="${SCRIPT_DIR}/../target/release/bundle/macos/${APP_NAME}"
if [[ ! -d "$APP_PATH" ]]; then
  echo "warning: bundle not found at $APP_PATH — skipping rename" >&2
  exit 0
fi

EXEC_DIR="${APP_PATH}/Contents/MacOS"
PLIST="${APP_PATH}/Contents/Info.plist"

if [[ -f "${EXEC_DIR}/${OLD_EXECUTABLE}" && ! -f "${EXEC_DIR}/${NEW_EXECUTABLE}" ]]; then
  mv "${EXEC_DIR}/${OLD_EXECUTABLE}" "${EXEC_DIR}/${NEW_EXECUTABLE}"
fi

plutil -replace CFBundleExecutable -string "${NEW_EXECUTABLE}" "${PLIST}"

# Re-sign so the rename and plist edit don't break code-signing checks.
codesign --force --deep --sign - "${APP_PATH}" >/dev/null
echo "renamed bundle executable to '${NEW_EXECUTABLE}' and re-signed"
