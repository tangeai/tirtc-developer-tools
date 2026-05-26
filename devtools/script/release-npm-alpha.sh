#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CLI_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

publish_flag="${TIRTC_DEVTOOLS_RELEASE_PUBLISH:-0}"
npm_tag="${TIRTC_DEVTOOLS_NPM_TAG:-alpha}"

cd "$CLI_DIR"

version=$(node -p "require('./package.json').version")
if [[ ! "$version" =~ -alpha\.[0-9]+$ ]]; then
  echo "[release:npm:alpha] version must be pre-release alpha.N, got: $version" >&2
  exit 1
fi

echo "[release:npm:alpha] version: $version"
echo "[release:npm:alpha] tag: $npm_tag"
echo "[release:npm:alpha] publish flag: $publish_flag"

echo "[release:npm:alpha] run lint"
npm run lint

echo "[release:npm:alpha] run test"
npm run test:acceptance

echo "[release:npm:alpha] stage token issue package assets"
./script/package_token_issue_assets.sh

mkdir -p "$CLI_DIR/.build/release"
echo "[release:npm:alpha] run npm pack -> .build/release"
tarball_name=$(npm pack --pack-destination "$CLI_DIR/.build/release")
tarball_path="$CLI_DIR/.build/release/$tarball_name"

echo "[release:npm:alpha] verify packaged token issue"
./script/verify_token_issue_package.sh "$tarball_path"

if [[ "$publish_flag" == "0" ]]; then
  echo "[release:npm:alpha] TIRTC_DEVTOOLS_RELEASE_PUBLISH=0, dry-run only, skip publish"
  exit 0
fi

if [[ -z "${NPM_TOKEN:-}" ]]; then
  echo "[release:npm:alpha] NPM_TOKEN is required when publish is enabled" >&2
  exit 1
fi

echo "[release:npm:alpha] verify npm login"
npm whoami > /dev/null

echo "[release:npm:alpha] publish"
npm publish --tag "$npm_tag"

echo "[release:npm:alpha] done"
