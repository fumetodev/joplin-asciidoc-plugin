#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/release.sh [patch|minor|major]
# Default: patch

BUMP_TYPE="${1:-patch}"

if [[ "$BUMP_TYPE" != "patch" && "$BUMP_TYPE" != "minor" && "$BUMP_TYPE" != "major" ]]; then
  echo "Usage: $0 [patch|minor|major]"
  exit 1
fi

# Ensure working directory is clean
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: Working directory is not clean. Commit or stash changes first."
  exit 1
fi

# Ensure we're on main
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "main" ]]; then
  echo "Error: Must be on the main branch (currently on '$BRANCH')."
  exit 1
fi

# Get current version
OLD_VERSION=$(node -p "require('./package.json').version")

# Bump version in package.json (without git tag — we do that ourselves)
NEW_VERSION=$(npm version "$BUMP_TYPE" --no-git-tag-version)
NEW_VERSION="${NEW_VERSION#v}"  # strip leading 'v' if present

echo "Bumping version: $OLD_VERSION -> $NEW_VERSION"

# Sync version to src/manifest.json
node -e "
const fs = require('fs');
const path = './src/manifest.json';
const manifest = JSON.parse(fs.readFileSync(path, 'utf8'));
manifest.version = '$NEW_VERSION';
fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
"
echo "Updated src/manifest.json"

# Build the plugin
echo "Building plugin..."
npm run build

# Prepare publish directory
mkdir -p publish
cp com.asciidoc.joplin-plugin.jpl publish/

# Stage, commit, tag
git add package.json package-lock.json src/manifest.json
git commit -m "Release v$NEW_VERSION"
git tag "v$NEW_VERSION"

# Push commit and tag
echo "Pushing to origin..."
git push origin main
git push origin "v$NEW_VERSION"

# Create GitHub release with .jpl asset
echo "Creating GitHub release..."
gh release create "v$NEW_VERSION" ./com.asciidoc.joplin-plugin.jpl \
  --title "v$NEW_VERSION" \
  --notes "Release v$NEW_VERSION" \
  --latest

# Publish to npm
echo "Publishing to npm..."
npm publish

echo ""
echo "Done! Released v$NEW_VERSION"
echo "  - Git tag: v$NEW_VERSION"
echo "  - GitHub release: https://github.com/fumetodev/joplin-asciidoc-plugin/releases/tag/v$NEW_VERSION"
echo "  - npm: https://www.npmjs.com/package/com.asciidoc.joplin-plugin"
echo "  - Joplin plugin directory will pick it up within ~30 minutes"
