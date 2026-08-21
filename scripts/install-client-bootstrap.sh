#!/usr/bin/env bash
set -euo pipefail

SERVER_ORIGIN="${1:-}"
if [[ -z "$SERVER_ORIGIN" ]]; then
  echo "[vcpdeck] 缺少 Server Origin" >&2
  exit 1
fi
SERVER_ORIGIN="${SERVER_ORIGIN%/}"

fail() {
  echo "[vcpdeck] $*" >&2
  exit 1
}
command -v bash >/dev/null 2>&1 || fail "需要 Bash"
[[ "$(uname -m)" == "x86_64" ]] || fail "仅支持 Linux x64"
[[ -r /etc/os-release ]] || fail "无法识别 Linux 发行版"
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}:${VERSION_ID:-}" in
ubuntu:22.04 | ubuntu:22.10 | ubuntu:23.* | ubuntu:24.* | ubuntu:25.* | ubuntu:26.*) ;;
debian:12 | debian:13 | debian:14) ;;
rocky:9* | almalinux:9*) ;;
*) fail "不支持的 Linux: ${ID:-unknown} ${VERSION_ID:-unknown}（需要 Ubuntu 22.04+、Debian 12+、Rocky/Alma 9+）" ;;
esac
getconf GNU_LIBC_VERSION >/dev/null 2>&1 || fail "仅支持 glibc，不支持 musl/Alpine"
[[ -d /run/systemd/system ]] || fail "需要 systemd"
[[ ! -e /proc/sys/fs/binfmt_misc/WSLInterop ]] && ! grep -qi microsoft /proc/version || fail "不支持 WSL"
if [[ -f /.dockerenv ]] || grep -Eqi '(docker|containerd|kubepods|lxc)' /proc/1/cgroup 2>/dev/null; then
  fail "不支持容器环境"
fi

install_deps() {
  local missing=()
  for cmd in curl unzip tar xz; do command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd"); done
  ((${#missing[@]} == 0)) && return
  echo "[vcpdeck] 安装缺失依赖: ${missing[*]}"
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y curl ca-certificates unzip tar xz-utils
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y curl ca-certificates unzip tar xz
  else
    fail "缺少受支持的包管理器"
  fi
}
install_deps

# 在准备 Node.js 前先让 Server 检查开关与 Release readiness，禁用时快速失败。
PREFLIGHT="$SERVER_ORIGIN/api/client-installer/preflight?platform=linux-x64"
JSON="$(curl -fsSL --connect-timeout 15 --max-time 60 "$PREFLIGHT")" || fail "Server 拒绝安装或不可达"

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'process.exit(process.arch === "x64" && Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' >/dev/null 2>&1
}

NODE_BIN=""
if node_ok && command -v npm >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  RUNTIME_ROOT="$HOME/.vcpdeck/runtime/node"
  mkdir -p "$RUNTIME_ROOT"
  for BASE in https://npmmirror.com/mirrors/node https://nodejs.org/dist; do
    echo "[vcpdeck] 尝试 Node.js 源: $BASE"
    INDEX="$(curl -fsSL --connect-timeout 15 --max-time 60 "$BASE/index.json" 2>/dev/null || true)"
    [[ -n "$INDEX" ]] || continue
    VERSION="$(printf '%s' "$INDEX" | tr '{' '\n' | grep '"lts":' | sed -n 's/.*"version":"v\([0-9][0-9.]*\)".*/\1/p' | awk -F. '$1 >= 24 {print}' | sort -V | tail -1)"
    [[ -n "$VERSION" ]] || continue
    DIR="$RUNTIME_ROOT/node-$VERSION"
    if [[ ! -x "$DIR/bin/node" ]]; then
      TMP="$(mktemp -d)"
      trap 'rm -rf "$TMP"' EXIT
      ARCHIVE="node-v$VERSION-linux-x64.tar.xz"
      curl -fL --connect-timeout 15 --max-time 600 "$BASE/v$VERSION/$ARCHIVE" -o "$TMP/$ARCHIVE" || continue
      curl -fsSL --connect-timeout 15 --max-time 60 "$BASE/v$VERSION/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt" || continue
      (cd "$TMP" && grep "  $ARCHIVE$" SHASUMS256.txt | sha256sum -c -) || continue
      rm -rf "$DIR"
      mkdir -p "$DIR"
      tar -xJf "$TMP/$ARCHIVE" --strip-components=1 -C "$DIR"
    fi
    NODE_BIN="$DIR/bin/node"
    break
  done
fi
[[ -x "$NODE_BIN" ]] || fail "无法准备 Node.js 24+ x64（国内源和官方源均失败）"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
INSTALLER_URL="$(printf '%s' "$JSON" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).installerUrl))')"
INSTALLER_SHA="$(printf '%s' "$JSON" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).installerSha256))')"
curl -fL --connect-timeout 15 --max-time 120 "$SERVER_ORIGIN$INSTALLER_URL" -o "$TMP_DIR/install-client.cjs"
printf '%s  %s\n' "$INSTALLER_SHA" "$TMP_DIR/install-client.cjs" | sha256sum -c -
"$NODE_BIN" "$TMP_DIR/install-client.cjs" --server-origin="$SERVER_ORIGIN" --platform=linux-x64 --node="$NODE_BIN" </dev/tty
