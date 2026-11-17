#!/bin/sh
# Skill Conductor bootstrap installer for Linux/macOS (POSIX sh).
# Installs a project-owned app under .skill-conductor/app and a local Node runtime
# under .skill-conductor/runtime when no supported Node is already available.
# No admin, PATH, profile, TEMP, pip or global npm changes are made.
set -eu

NODE_VERSION_PIN='24.22.3'
PROJECT=$(pwd)
HOST=''
ARCHIVE=''
REF='main'
HOME_PATH=''
NODE_ARCHIVE=''
NODE_SHA256=''
FORCE_PORTABLE_NODE=0
NO_SETUP=0
VERIFY_HOST=0
STAGE=''
NODE_STAGE=''
APP_BACKUP=''

usage() {
  cat <<'EOF'
Usage: sh install.sh [options]
  --project PATH          project directory (default: current directory)
  --host HOST             cursor|workbuddy|qoder|deepseek-harness|opencode|generic
  --archive PATH          local source archive (.tar.gz/.tgz/.zip) for offline installs
  --ref REF               GitHub branch/tag name (default: main)
  --home PATH             user home used by setup discovery (advanced/testing)
  --node-archive PATH     local Node archive (advanced/testing)
  --node-sha256 HEX       expected SHA256 for --node-archive
  --force-portable-node   ignore an existing node and use the pinned portable runtime
  --no-setup              install files only
  --verify-host           run the generated MCP stdio handshake after setup
  --help
EOF
}

log() { printf '[skill-conductor] %s\n' "$*" >&2; }
fail() { printf '[skill-conductor] %s\n' "$*" >&2; exit 1; }

assert_inside() {
  parent=$1
  child=$2
  label=$3
  case "$child" in
    "$parent"/*) ;;
    *) fail "$label escapes its allowed directory: $child" ;;
  esac
}

assert_no_symlink() {
  path=$1
  label=$2
  if [ -L "$path" ]; then fail "$label is a symlink and is not followed: $path"; fi
}

assert_tree_contained() {
  root=$1
  label=$2
  if [ -n "$(find "$root" -type l -print 2>/dev/null)" ]; then
    fail "$label contains a symlink"
  fi
}

cleanup() {
  if [ -n "${APP_BACKUP:-}" ] && [ -d "$APP_BACKUP" ] && [ ! -d "$SC_DIR/app" ]; then
    mv "$APP_BACKUP" "$SC_DIR/app" || printf '[skill-conductor] could not restore previous app from %s\n' "$APP_BACKUP" >&2
  fi
  if [ -n "${STAGE:-}" ] && [ -d "$STAGE" ]; then
    case "$STAGE" in
      "$SC_DIR"/.install-stage.*) rm -rf "$STAGE" ;;
      *) printf '[skill-conductor] refusing to remove unexpected staging path: %s\n' "$STAGE" >&2 ;;
    esac
  fi
  if [ -n "${NODE_STAGE:-}" ] && [ -d "$NODE_STAGE" ]; then
    case "$NODE_STAGE" in
      "$SC_DIR"/.node-stage.*) rm -rf "$NODE_STAGE" ;;
      *) printf '[skill-conductor] refusing to remove unexpected node staging path: %s\n' "$NODE_STAGE" >&2 ;;
    esac
  fi
}
trap cleanup EXIT HUP INT TERM

while [ $# -gt 0 ]; do
  case "$1" in
    --project) [ $# -ge 2 ] || { usage >&2; exit 2; }; PROJECT=$2; shift 2 ;;
    --host) [ $# -ge 2 ] || { usage >&2; exit 2; }; HOST=$2; shift 2 ;;
    --archive) [ $# -ge 2 ] || { usage >&2; exit 2; }; ARCHIVE=$2; shift 2 ;;
    --ref) [ $# -ge 2 ] || { usage >&2; exit 2; }; REF=$2; shift 2 ;;
    --home) [ $# -ge 2 ] || { usage >&2; exit 2; }; HOME_PATH=$2; shift 2 ;;
    --node-archive) [ $# -ge 2 ] || { usage >&2; exit 2; }; NODE_ARCHIVE=$2; shift 2 ;;
    --node-sha256) [ $# -ge 2 ] || { usage >&2; exit 2; }; NODE_SHA256=$2; shift 2 ;;
    --force-portable-node) FORCE_PORTABLE_NODE=1; shift ;;
    --no-setup) NO_SETUP=1; shift ;;
    --verify-host) VERIFY_HOST=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$REF" in
  *[!A-Za-z0-9._-]*) printf 'Ref may contain only letters, digits, dot, underscore and hyphen\n' >&2; exit 2 ;;
esac
case "$HOST" in
  ''|cursor|workbuddy|qoder|deepseek-harness|opencode|generic) ;;
  *) printf 'Unsupported host: %s\n' "$HOST" >&2; exit 2 ;;
esac

if [ ! -d "$PROJECT" ]; then
  printf 'Project path is not a directory: %s\n' "$PROJECT" >&2
  exit 1
fi
case "$PROJECT" in
  /*) ;;
  *) PROJECT=$(cd "$PROJECT" && pwd) ;;
esac
PROJECT=$(cd "$PROJECT" && pwd)
SC_DIR="$PROJECT/.skill-conductor"
mkdir -p "$SC_DIR"
assert_no_symlink "$SC_DIR" 'Project state directory'
STAGE=$(mktemp -d "$SC_DIR/.install-stage.XXXXXX")
assert_inside "$SC_DIR" "$STAGE" 'App staging directory'

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print tolower($1)}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print tolower($1)}'
  else
    printf 'No SHA256 tool found (sha256sum or shasum)\n' >&2
    exit 1
  fi
}

fetch() {
  url=$1
  out=$2
  case "$url" in
    https://*) ;;
    *) printf 'Refusing non-HTTPS download URL: %s\n' "$url" >&2; exit 1 ;;
  esac
  if command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --location "$url" --output "$out"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$out"
  else
    printf 'curl or wget is required to download the archive\n' >&2
    exit 1
  fi
}

validate_archive_entries() {
  archive=$1
  label=$2
  list="$STAGE/archive-entries.txt"
  case "$archive" in
    *.zip)
      command -v unzip >/dev/null 2>&1 || fail 'unzip is required to inspect .zip archives'
      unzip -Z1 "$archive" > "$list" || fail "$label could not be listed"
      ;;
    *.tar.gz|*.tgz)
      tar -tzf "$archive" > "$list" || fail "$label could not be listed"
      tar -tvzf "$archive" > "$STAGE/archive-types.txt" || fail "$label could not be inspected"
      if grep -q '^[lh]' "$STAGE/archive-types.txt"; then
        fail "$label contains a symlink or hardlink entry"
      fi
      ;;
    *) fail 'Archive must be .tar.gz, .tgz or .zip' ;;
  esac
  [ -s "$list" ] || fail "$label is empty"
  while IFS= read -r name; do
    case "$name" in
      /*|[A-Za-z]:*|*\\*) fail "$label contains an unsafe absolute entry: $name" ;;
    esac
    normalized=$(printf '%s' "$name" | tr '\\' '/')
    case "/$normalized/" in
      *"/../"*) fail "$label contains a traversal entry: $name" ;;
    esac
  done < "$list"
}

extract_archive() {
  archive=$1
  destination=$2
  validate_archive_entries "$archive" 'Source archive'
  assert_inside "$STAGE" "$destination" 'Archive extraction directory'
  assert_no_symlink "$destination" 'Archive extraction directory'
  mkdir -p -- "$destination"
  case "$archive" in
    *.zip)
      if command -v unzip >/dev/null 2>&1; then
        unzip -q "$archive" -d "$destination"
      else
        fail 'unzip is required for .zip archives on this platform'
      fi
      ;;
    *.tar.gz|*.tgz)
      tar -xzf "$archive" -C "$destination"
      ;;
    *) fail 'Archive must be .tar.gz, .tgz or .zip' ;;
  esac
  assert_tree_contained "$destination" 'Extracted archive'
}

supported_node() {
  candidate=$1
  if [ -z "$candidate" ] || [ ! -x "$candidate" ]; then return 1; fi
  version=$("$candidate" --version 2>/dev/null | tr -d 'v' | head -n 1) || return 1
  major=${version%%.*}
  rest=${version#*.}
  minor=${rest%%.*}
  case "$major" in
    ''|*[!0-9]*) return 1 ;;
  esac
  case "$minor" in
    ''|*[!0-9]*) return 1 ;;
  esac
  if [ "$major" -gt 20 ]; then return 0; fi
  if [ "$major" -eq 20 ] && [ "$minor" -ge 11 ]; then return 0; fi
  return 1
}

find_node() {
  if [ "$FORCE_PORTABLE_NODE" -eq 1 ]; then return 1; fi
  if [ -n "${SKILL_CONDUCTOR_NODE:-}" ] && supported_node "$SKILL_CONDUCTOR_NODE"; then
    printf '%s\n' "$SKILL_CONDUCTOR_NODE"
    return 0
  fi
  if [ -d "$SC_DIR/runtime" ]; then
    for candidate in "$SC_DIR"/runtime/node-v*/bin/node "$SC_DIR"/runtime/node-v*/node; do
      if [ -f "$candidate" ] && supported_node "$candidate"; then
        printf '%s\n' "$candidate"
        return 0
      fi
    done
  fi
  found=$(command -v node 2>/dev/null || true)
  if [ -n "$found" ] && supported_node "$found"; then
    printf '%s\n' "$found"
    return 0
  fi
  return 1
}

install_portable_node() {
  system=$(uname -s)
  machine=$(uname -m)
  case "$system" in
    Linux) os_name='linux' ;;
    Darwin) os_name='darwin' ;;
    *) printf 'Unsupported operating system: %s\n' "$system" >&2; exit 1 ;;
  esac
  case "$machine" in
    x86_64|amd64) node_arch='x64' ;;
    arm64|aarch64) node_arch='arm64' ;;
    *) printf 'Unsupported architecture: %s\n' "$machine" >&2; exit 1 ;;
  esac
  file="node-v$NODE_VERSION_PIN-$os_name-$node_arch.tar.gz"
  case "$file" in
    node-v24.22.3-linux-x64.tar.gz) expected='061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2' ;;
    node-v24.22.3-linux-arm64.tar.gz) expected='261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8' ;;
    node-v24.22.3-darwin-x64.tar.gz) expected='977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7' ;;
    node-v24.22.3-darwin-arm64.tar.gz) expected='ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd' ;;
    *) printf 'No pinned hash for %s\n' "$file" >&2; exit 1 ;;
  esac

  NODE_STAGE=$(mktemp -d "$SC_DIR/.node-stage.XXXXXX")
  assert_inside "$SC_DIR" "$NODE_STAGE" 'Node staging directory'
  node_archive="$NODE_STAGE/$file"
  if [ -n "$NODE_ARCHIVE" ]; then
    [ -f "$NODE_ARCHIVE" ] || { printf 'Node archive not found: %s\n' "$NODE_ARCHIVE" >&2; exit 1; }
    cp "$NODE_ARCHIVE" "$node_archive"
    if [ -n "$NODE_SHA256" ]; then expected=$NODE_SHA256; fi
  else
    log "downloading official Node $NODE_VERSION_PIN ($os_name-$node_arch) from nodejs.org"
    fetch "https://nodejs.org/dist/v$NODE_VERSION_PIN/$file" "$node_archive"
  fi
  actual=$(hash_file "$node_archive")
  if [ "$actual" != "$(printf '%s' "$expected" | tr 'A-Z' 'a-z')" ]; then
    printf 'Node archive SHA256 mismatch: expected %s, got %s\n' "$expected" "$actual" >&2
    exit 1
  fi
  # The signed-hash Node distribution legitimately includes npm symlinks.
  # This product needs only the regular bin/node member: extract that exact
  # member after checksum validation instead of rejecting or unpacking links.
  node_member="node-v$NODE_VERSION_PIN-$os_name-$node_arch/bin/node"
  node_member_info=$(tar -tvzf "$node_archive" "$node_member") || fail 'Node archive does not contain the expected binary'
  case "$node_member_info" in
    -*) ;;
    *) fail 'Node binary archive member is not a regular file' ;;
  esac
  [ "$(printf '%s\n' "$node_member_info" | wc -l | tr -d ' ')" = '1' ] || fail 'Node binary archive member is duplicated'
  mkdir -p "$NODE_STAGE/extract"
  tar -xzf "$node_archive" -C "$NODE_STAGE/extract" "$node_member" || fail 'Node binary extraction failed'
  node_bin="$NODE_STAGE/extract/$node_member"
  [ -n "$node_bin" ] || { printf 'Downloaded Node archive did not contain a node binary\n' >&2; exit 1; }
  supported_node "$node_bin" || { printf 'Downloaded Node is not supported\n' >&2; exit 1; }
  runtime_root="$SC_DIR/runtime"
  mkdir -p "$runtime_root"
  assert_no_symlink "$runtime_root" 'Runtime directory'
  final="$runtime_root/node-v$NODE_VERSION_PIN-$os_name-$node_arch"
  assert_inside "$runtime_root" "$final" 'Portable Node target'
  assert_no_symlink "$final" 'Portable Node target'
  if [ -x "$final/bin/node" ] && supported_node "$final/bin/node"; then
    INSTALLED_NODE="$final/bin/node"
    assert_inside "$SC_DIR" "$NODE_STAGE" 'Node staging directory'
    rm -rf "$NODE_STAGE"
    NODE_STAGE=''
    return 0
  fi
  if [ -e "$final" ]; then
    printf 'Portable Node target exists but is not usable: %s\n' "$final" >&2
    exit 1
  fi
  node_root=$(dirname "$(dirname "$node_bin")")
  case "$node_root" in
    "$NODE_STAGE"/*) ;;
    *) printf 'Unexpected Node extraction path: %s\n' "$node_root" >&2; exit 1 ;;
  esac
  assert_inside "$NODE_STAGE" "$node_root" 'Extracted Node runtime'
  mv "$node_root" "$final"
  INSTALLED_NODE="$final/bin/node"
  assert_inside "$SC_DIR" "$NODE_STAGE" 'Node staging directory'
  rm -rf "$NODE_STAGE"
  NODE_STAGE=''
}

APP_SOURCE=''
if [ -n "$ARCHIVE" ]; then
  [ -f "$ARCHIVE" ] || { printf 'Archive not found: %s\n' "$ARCHIVE" >&2; exit 1; }
  extract_archive "$ARCHIVE" "$STAGE/extract"
else
  app_archive="$STAGE/skill-conductor.tar.gz"
  log "downloading https://github.com/ok888laity/skill-conductor/archive/refs/heads/$REF.tar.gz"
  fetch "https://github.com/ok888laity/skill-conductor/archive/refs/heads/$REF.tar.gz" "$app_archive"
  extract_archive "$app_archive" "$STAGE/extract"
fi

entries=$(find "$STAGE/extract" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')
if [ "$entries" -eq 1 ] && [ -d "$(find "$STAGE/extract" -mindepth 1 -maxdepth 1 | head -n 1)" ]; then
  APP_SOURCE=$(find "$STAGE/extract" -mindepth 1 -maxdepth 1 | head -n 1)
else
  APP_SOURCE="$STAGE/extract"
fi
[ -f "$APP_SOURCE/package.json" ] || { printf 'Archive does not look like a Skill Conductor source tree\n' >&2; exit 1; }
[ -f "$APP_SOURCE/bin/skill-conductor.mjs" ] || { printf 'Archive is missing bin/skill-conductor.mjs\n' >&2; exit 1; }
package_name=$(sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$APP_SOURCE/package.json" | head -n 1)
[ "$package_name" = 'skill-conductor' ] || { printf 'Unexpected package name: %s\n' "$package_name" >&2; exit 1; }
package_version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$APP_SOURCE/package.json" | head -n 1)
log "archive version $package_version"

APP="$SC_DIR/app"
assert_inside "$SC_DIR" "$APP" 'App target'
assert_no_symlink "$APP" 'Existing app directory'
if [ -e "$APP" ] && [ ! -d "$APP" ]; then fail "Existing app target is not a directory: $APP"; fi
if [ -d "$APP" ]; then
  backup="$SC_DIR/app.backup-$(date -u +%Y%m%dT%H%M%S)"
  suffix=1
  while [ -e "$backup" ]; do
    backup="$SC_DIR/app.backup-$(date -u +%Y%m%dT%H%M%S)-$suffix"
    suffix=$((suffix + 1))
  done
  assert_inside "$SC_DIR" "$backup" 'App backup directory'
  assert_no_symlink "$backup" 'App backup directory'
  mv "$APP" "$backup"
  APP_BACKUP=$backup
  log "preserved previous app at $backup"
fi
assert_inside "$STAGE" "$APP_SOURCE" 'Extracted source tree'
if [ "$APP_SOURCE" = "$STAGE/extract" ]; then
  mkdir -p "$APP"
  (cd "$APP_SOURCE" && find . -mindepth 1 -maxdepth 1 -exec cp -R {} "$APP/" \;)
else
  mv "$APP_SOURCE" "$APP"
fi
APP_BACKUP=''

NODE_BIN=''
NODE_SOURCE='existing'
if NODE_BIN=$(find_node); then
  :
else
  INSTALLED_NODE=''
  install_portable_node
  NODE_BIN=$INSTALLED_NODE
  NODE_SOURCE='portable-24.22.3-pinned-sha256'
fi
supported_node "$NODE_BIN" || { printf 'No supported Node runtime available: %s\n' "$NODE_BIN" >&2; exit 1; }
NODE_VERSION=$("$NODE_BIN" --version | tr -d 'v')
log "node $NODE_VERSION at $NODE_BIN ($NODE_SOURCE)"

SETUP_RAN='false'
if [ "$NO_SETUP" -eq 0 ]; then
  set -- setup
  if [ -n "$HOST" ]; then set -- "$@" --host "$HOST"; fi
  if [ -n "$HOME_PATH" ]; then set -- "$@" --home "$HOME_PATH"; fi
  if [ "$VERIFY_HOST" -eq 1 ]; then set -- "$@" --verify-host; fi
  (cd "$PROJECT" && "$NODE_BIN" "$APP/bin/skill-conductor.mjs" "$@")
  SETUP_RAN='true'
fi

printf 'app=%s\n' "$APP"
printf 'node=%s\n' "$NODE_BIN"
printf 'nodeVersion=%s\n' "$NODE_VERSION"
printf 'nodeSource=%s\n' "$NODE_SOURCE"
printf 'config=%s\n' "$SC_DIR/config.json"
printf 'setupRan=%s\n' "$SETUP_RAN"
if [ "$NO_SETUP" -eq 0 ]; then
  printf 'nextAction=%s\n' 'Ask your agent to use the generated MCP/host config; reload the host if required.'
else
  printf 'nextAction=Run: "%s" "%s/bin/skill-conductor.mjs" setup\n' "$NODE_BIN" "$APP"
fi
