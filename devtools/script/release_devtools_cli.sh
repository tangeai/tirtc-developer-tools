#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CLI_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

usage() {
  cat <<'EOF'
usage:
  ./developer-tools/devtools/script/release_devtools_cli.sh (--bump patch|minor|major | --version X.Y.Z) [options]

Options:
  --bump <level>       Compute the next stable SemVer from the latest npm version.
  --version <X.Y.Z>    Use an explicit stable SemVer version.
  --publish            Publish to npm. Without this flag the script runs a dry-run.
  --dry-run            Explicit dry-run; this is the default.
  --tag <tag>          npm dist-tag. Defaults to latest.
  --no-proxy           Unset proxy environment variables for npm registry commands.
  --yes                Required with --publish to acknowledge the external side effect.
  -h, --help           Show this help.

The script queries npm for the currently published package version, updates
developer-tools/devtools/package.json and package-lock.json, then delegates to release-npm.sh.
EOF
}

is_stable_semver() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

run_registry_cmd() {
  if [[ "$no_proxy" == "1" ]]; then
    env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
      NO_PROXY='*' no_proxy='*' "$@"
  else
    "$@"
  fi
}

compare_semver() {
  node - "$1" "$2" <<'NODE'
const left = process.argv[2].split('.').map(Number);
const right = process.argv[3].split('.').map(Number);
for (let i = 0; i < 3; i += 1) {
  if (left[i] > right[i]) {
    process.exit(0);
  }
  if (left[i] < right[i]) {
    process.exit(1);
  }
}
process.exit(1);
NODE
}

compute_bump() {
  node - "$1" "$2" <<'NODE'
const latest = process.argv[2].split('.').map(Number);
const bump = process.argv[3];
if (bump === 'major') {
  console.log(`${latest[0] + 1}.0.0`);
} else if (bump === 'minor') {
  console.log(`${latest[0]}.${latest[1] + 1}.0`);
} else if (bump === 'patch') {
  console.log(`${latest[0]}.${latest[1]}.${latest[2] + 1}`);
} else {
  process.exit(2);
}
NODE
}

write_version_files() {
  node - "$1" <<'NODE'
const fs = require('fs');
const path = require('path');
const target = process.argv[2];

function writeJson(file, mutate) {
  const fullPath = path.resolve(file);
  const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  mutate(data);
  fs.writeFileSync(fullPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

writeJson('package.json', (pkg) => {
  pkg.version = target;
});

if (fs.existsSync('package-lock.json')) {
  writeJson('package-lock.json', (lock) => {
    lock.version = target;
    if (lock.packages && lock.packages['']) {
      lock.packages[''].version = target;
    }
  });
}
NODE
}

bump_level=""
explicit_version=""
publish_flag="0"
npm_tag="latest"
no_proxy="0"
yes_flag="0"

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --bump)
      bump_level="${2:-}"
      shift 2
      ;;
    --version)
      explicit_version="${2:-}"
      shift 2
      ;;
    --publish)
      publish_flag="1"
      shift
      ;;
    --dry-run)
      publish_flag="0"
      shift
      ;;
    --tag)
      npm_tag="${2:-}"
      shift 2
      ;;
    --no-proxy)
      no_proxy="1"
      shift
      ;;
    --yes)
      yes_flag="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[release:devtools-cli] unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -n "$bump_level" && -n "$explicit_version" ]]; then
  echo "[release:devtools-cli] use either --bump or --version, not both" >&2
  exit 2
fi

if [[ -z "$bump_level" && -z "$explicit_version" ]]; then
  echo "[release:devtools-cli] --bump or --version is required" >&2
  usage >&2
  exit 2
fi

case "$bump_level" in
  ""|patch|minor|major)
    ;;
  *)
    echo "[release:devtools-cli] invalid bump level: $bump_level" >&2
    exit 2
    ;;
esac

if [[ "$publish_flag" == "1" && "$yes_flag" != "1" ]]; then
  echo "[release:devtools-cli] --publish requires --yes" >&2
  exit 2
fi

cd "$CLI_DIR"

package_name=$(node -p "require('./package.json').name")
local_version=$(node -p "require('./package.json').version")
latest_version=$(run_registry_cmd npm view "$package_name" version --json 2>/dev/null | tr -d '"' || true)

if [[ -z "$latest_version" || "$latest_version" == "null" ]]; then
  if is_stable_semver "$local_version"; then
    latest_version="$local_version"
  else
    latest_version="0.0.0"
  fi
fi

if ! is_stable_semver "$latest_version"; then
  echo "[release:devtools-cli] latest npm version is not a stable SemVer: $latest_version" >&2
  exit 1
fi

if [[ -n "$explicit_version" ]]; then
  target_version="$explicit_version"
else
  target_version=$(compute_bump "$latest_version" "$bump_level")
fi

if ! is_stable_semver "$target_version"; then
  echo "[release:devtools-cli] target version must be stable SemVer X.Y.Z, got: $target_version" >&2
  exit 1
fi

if ! compare_semver "$target_version" "$latest_version"; then
  echo "[release:devtools-cli] target version $target_version must be greater than latest npm version $latest_version" >&2
  exit 1
fi

existing_version=$(run_registry_cmd npm view "$package_name@$target_version" version --json 2>/dev/null | tr -d '"' || true)
if [[ "$existing_version" == "$target_version" ]]; then
  echo "[release:devtools-cli] target version already exists on npm: $package_name@$target_version" >&2
  exit 1
fi

echo "[release:devtools-cli] package: $package_name"
echo "[release:devtools-cli] local version: $local_version"
echo "[release:devtools-cli] npm latest: $latest_version"
echo "[release:devtools-cli] target version: $target_version"
echo "[release:devtools-cli] npm tag: $npm_tag"
echo "[release:devtools-cli] publish: $publish_flag"

if [[ "$local_version" != "$target_version" ]]; then
  echo "[release:devtools-cli] update package metadata to $target_version"
  write_version_files "$target_version"
fi

release_env=(env)

if [[ "$no_proxy" == "1" ]]; then
  release_env+=(
    -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY
    -u http_proxy -u https_proxy -u all_proxy
    "NO_PROXY=*" "no_proxy=*"
  )
fi

release_env+=(
  "TIRTC_DEVTOOLS_RELEASE_PUBLISH=$publish_flag"
  "TIRTC_DEVTOOLS_NPM_TAG=$npm_tag"
)

"${release_env[@]}" ./script/release-npm.sh

if [[ "$publish_flag" == "1" ]]; then
  echo "[release:devtools-cli] verify registry after publish"
  published_version=$(run_registry_cmd npm view "$package_name@$target_version" version --json | tr -d '"')
  tagged_version=$(run_registry_cmd npm view "$package_name" "dist-tags.$npm_tag" --json | tr -d '"')
  if [[ "$published_version" != "$target_version" || "$tagged_version" != "$target_version" ]]; then
    echo "[release:devtools-cli] registry verification failed: version=$published_version tag=$tagged_version expected=$target_version" >&2
    exit 1
  fi
  echo "[release:devtools-cli] published $package_name@$target_version with tag $npm_tag"
else
  echo "[release:devtools-cli] dry-run complete for $package_name@$target_version"
fi
