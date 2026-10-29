#!/bin/sh
# Xcode build step: copies the web app into the iPhone app (Resources/web), so
# the app's code is built in rather than downloaded when it runs.
set -eu
DEST="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/web"
rm -rf "$DEST"
mkdir -p "$DEST"
cd "$SRCROOT/.."
cp -R index.html manifest.webmanifest css js icons "$DEST/"
echo "Copied web app to $DEST"
