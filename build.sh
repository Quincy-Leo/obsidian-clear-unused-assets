#!/usr/bin/env bash
# Copyright (c) 2026 QuincyLeo (Quincy-Leo)
# SPDX-License-Identifier: MIT
#
# Build the plugin and (optionally) copy the artifacts into a target directory.
#
# Edit TARGET_DIR below to point at your Obsidian vault's plugin folder, e.g.
#   TARGET_DIR="PathToYourVault/.obsidian/plugins/clear-unused-assets"
# Leave TARGET_DIR empty to only build without copying.

set -euo pipefail

# --- Configuration ----------------------------------------------------------
TARGET_DIR=""

# --- Build ------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Building in $SCRIPT_DIR"
npm run build

# --- Copy artifacts ---------------------------------------------------------
if [[ -z "$TARGET_DIR" ]]; then
    echo "==> TARGET_DIR is empty; skipping copy."
    exit 0
fi

echo "==> Copying artifacts to $TARGET_DIR"
mkdir -p "$TARGET_DIR"

# Required artifacts — fail loudly if the build didn't produce them.
for f in main.js manifest.json; do
    if [[ ! -f "$f" ]]; then
        echo "error: expected build artifact '$f' not found" >&2
        exit 1
    fi
    cp "$f" "$TARGET_DIR/"
done

echo "==> Done."
