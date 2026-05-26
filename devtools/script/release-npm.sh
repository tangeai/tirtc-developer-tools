#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CLI_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

publish_flag="${TIRTC_DEVTOOLS_RELEASE_PUBLISH:-0}"
npm_tag="${TIRTC_DEVTOOLS_NPM_TAG:-latest}"
npm_userconfig=""

cleanup_npm_userconfig() {
  if [[ -n "$npm_userconfig" && -f "$npm_userconfig" ]]; then
    rm -f "$npm_userconfig"
  fi
}

configure_publish_auth() {
  if [[ "$publish_flag" == "0" ]]; then
    return 0
  fi

  if [[ -z "${NPM_TOKEN:-}" ]]; then
    echo "[release:npm] NPM_TOKEN is required for --publish" >&2
    exit 1
  fi

  npm_userconfig=$(mktemp "${TMPDIR:-/tmp}/tirtc-devtools-npmrc.XXXXXX")
  chmod 600 "$npm_userconfig"
  {
    echo "registry=https://registry.npmjs.org/"
    echo '//registry.npmjs.org/:_authToken=${NPM_TOKEN}'
  } > "$npm_userconfig"
  export NPM_CONFIG_USERCONFIG="$npm_userconfig"
  unset npm_config_userconfig
  trap cleanup_npm_userconfig EXIT
}

cd "$CLI_DIR"
configure_publish_auth

version=$(node -p "require('./package.json').version")
package_name=$(node -p "require('./package.json').name")
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "[release:npm] version must be stable semver X.Y.Z, got: $version" >&2
  exit 1
fi

verify_published_version() {
  local expected_version="$1"
  local expected_tag="$2"
  local published_version=""
  local tagged_version=""
  local attempt=1

  while [[ "$attempt" -le 20 ]]; do
    published_version=$(npm view "$package_name@$expected_version" version --json 2>/dev/null | tr -d '"' || true)
    tagged_version=$(npm view "$package_name" "dist-tags.$expected_tag" --json 2>/dev/null | tr -d '"' || true)
    if [[ "$published_version" == "$expected_version" && "$tagged_version" == "$expected_version" ]]; then
      echo "[release:npm] verified published version: $package_name@$expected_version tag=$expected_tag"
      return 0
    fi
    sleep 3
    attempt=$((attempt + 1))
  done

  echo "[release:npm] publish verification failed: version=$published_version tag=$tagged_version expected=$expected_version" >&2
  return 1
}

echo "[release:npm] version: $version"
echo "[release:npm] tag: $npm_tag"
echo "[release:npm] publish flag: $publish_flag"

echo "[release:npm] run lint"
npm run lint

echo "[release:npm] run publish verification"
npm run test:publish

echo "[release:npm] stage product runtime and native driver package assets"
TIRTC_RUNTIME_PLATFORMS="${TIRTC_RUNTIME_PLATFORMS:-macos-arm64 linux-x64}" ./script/package.sh

echo "[release:npm] stage token issue package assets"
./script/package_token_issue_assets.sh

mkdir -p "$CLI_DIR/.build/release"
echo "[release:npm] run npm pack -> .build/release"
tarball_name=$(npm pack --pack-destination "$CLI_DIR/.build/release")
tarball_path="$CLI_DIR/.build/release/$tarball_name"

echo "[release:npm] verify packaged token issue"
./script/verify_token_issue_package.sh "$tarball_path"

if [[ "$publish_flag" == "0" ]]; then
  echo "[release:npm] TIRTC_DEVTOOLS_RELEASE_PUBLISH=0, dry-run only, skip publish"
  exit 0
fi

echo "[release:npm] verify npm token"
npm whoami --registry https://registry.npmjs.org/ > /dev/null

echo "[release:npm] publish"
npm publish --tag "$npm_tag"

echo "[release:npm] verify published package"
verify_published_version "$version" "$npm_tag"

echo "[release:npm] done"
