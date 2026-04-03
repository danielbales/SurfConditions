#!/bin/bash
set -e

APP_NAME="SurfConditions"
DISPLAY_NAME="Surf Conditions"
BUNDLE_ID="com.danielbales.surfconditions"
MIN_MACOS="14.0"
APP_BUNDLE="${APP_NAME}.app"

echo "▶ Building release binary..."
swift build -c release 2>&1 | grep -v "^Build complete" || true
swift build -c release --quiet

BINARY=".build/release/${APP_NAME}"
if [ ! -f "$BINARY" ]; then
  echo "✗ Build failed — binary not found at $BINARY"
  exit 1
fi

echo "▶ Creating .app bundle..."
rm -rf "${APP_BUNDLE}"
mkdir -p "${APP_BUNDLE}/Contents/MacOS"
mkdir -p "${APP_BUNDLE}/Contents/Resources"

cp "$BINARY" "${APP_BUNDLE}/Contents/MacOS/${APP_NAME}"

cat > "${APP_BUNDLE}/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>${APP_NAME}</string>
    <key>CFBundleIdentifier</key>
    <string>${BUNDLE_ID}</string>
    <key>CFBundleName</key>
    <string>${DISPLAY_NAME}</string>
    <key>CFBundleDisplayName</key>
    <string>${DISPLAY_NAME}</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>NSPrincipalClass</key>
    <string>NSApplication</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>LSMinimumSystemVersion</key>
    <string>${MIN_MACOS}</string>
    <key>LSApplicationCategoryType</key>
    <string>public.app-category.weather</string>
</dict>
</plist>
PLIST

echo "▶ Signing..."
codesign --sign - --force --deep "${APP_BUNDLE}" 2>/dev/null

echo ""
echo "✓ Built: $(pwd)/${APP_BUNDLE}"
echo ""
echo "Options:"
echo "  Open now:        open '${APP_BUNDLE}'"
echo "  Add to Dock:     drag '${APP_BUNDLE}' to your Dock"
echo "  Install globally: cp -r '${APP_BUNDLE}' /Applications/"
