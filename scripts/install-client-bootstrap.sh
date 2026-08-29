#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "[vcpdeck] $*" >&2
  return 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

CLEANUP_DIRS=()

cleanup_dirs() {
  local dir
  for dir in "${CLEANUP_DIRS[@]}"; do
    rm -rf -- "$dir"
  done
}

register_cleanup_dir() {
  CLEANUP_DIRS+=("$1")
  trap cleanup_dirs EXIT
}

detect_linux_family() {
  local os_release_path="$1"
  [[ -r "$os_release_path" ]] || {
    fail "无法识别 Linux 发行版"
    return 1
  }
  local ID="" VERSION_ID=""
  # shellcheck disable=SC1090
  . "$os_release_path"
  case "${ID:-}:${VERSION_ID:-}" in
  bazzite:*) printf '%s\n' bazzite ;;
  ubuntu:22.04 | ubuntu:22.10 | ubuntu:23.* | ubuntu:24.* | ubuntu:25.* | ubuntu:26.*) printf '%s\n' apt ;;
  debian:12 | debian:13 | debian:14) printf '%s\n' apt ;;
  rocky:9* | almalinux:9*) printf '%s\n' dnf ;;
  *)
    fail "不支持的 Linux: ${ID:-unknown} ${VERSION_ID:-unknown}（需要 Ubuntu 22.04+、Debian 12+、Rocky/Alma 9+ 或 Bazzite x64）"
    return 1
    ;;
  esac
}

ca_bundle_available() {
  for path in \
    /etc/pki/tls/certs/ca-bundle.crt \
    /etc/ssl/certs/ca-certificates.crt \
    /etc/ssl/cert.pem; do
    [[ -r "$path" ]] && return 0
  done
  return 1
}

collect_missing_dependencies() {
  MISSING_COMMANDS=()
  MISSING_PACKAGES=()
  local cmd package
  for cmd in curl unzip tar xz; do
    if ! command_exists "$cmd"; then
      MISSING_COMMANDS+=("$cmd")
      case "${INSTALLER_LINUX_FAMILY:-}" in
      apt)
        case "$cmd" in
        xz) package="xz-utils" ;;
        *) package="$cmd" ;;
        esac
        ;;
      dnf | bazzite) package="$cmd" ;;
      *)
        fail "缺少受支持的包管理器"
        return 1
        ;;
      esac
      local already=false
      for existing in "${MISSING_PACKAGES[@]}"; do
        [[ "$existing" == "$package" ]] && already=true && break
      done
      [[ "$already" == true ]] || MISSING_PACKAGES+=("$package")
    fi
  done
  if ! ca_bundle_available; then
    MISSING_COMMANDS+=(ca-certificates)
    local already_ca=false
    for existing in "${MISSING_PACKAGES[@]}"; do
      [[ "$existing" == ca-certificates ]] && already_ca=true && break
    done
    [[ "$already_ca" == true ]] || MISSING_PACKAGES+=(ca-certificates)
  fi
}

run_rpm_ostree() {
  sudo rpm-ostree "$@"
}

install_bazzite_dependencies() {
  command_exists rpm-ostree || {
    fail "Bazzite 缺少 rpm-ostree，无法自动安装基础依赖"
    return 1
  }
  collect_missing_dependencies
  ((${#MISSING_PACKAGES[@]} == 0)) && return 0
  echo "[vcpdeck] Bazzite 将通过 rpm-ostree 分层安装缺失依赖: ${MISSING_PACKAGES[*]}" >&2
  echo "[vcpdeck] 注意：系统分层软件包可能延长或阻塞 Bazzite 系统更新。" >&2

  if run_rpm_ostree install -y --apply-live "${MISSING_PACKAGES[@]}"; then
    collect_missing_dependencies
    ((${#MISSING_PACKAGES[@]} == 0)) && return 0
  fi

  if run_rpm_ostree install -y "${MISSING_PACKAGES[@]}"; then
    echo "[vcpdeck] 系统依赖将在重启后生效；请手工重启 Bazzite，再运行同一条安装命令。" >&2
    return 75
  fi
  fail "Bazzite 基础依赖安装失败；请检查 rpm-ostree pending deployment、网络和 sudo 权限"
}

install_deps() {
  INSTALLER_LINUX_FAMILY="${1:-${INSTALLER_LINUX_FAMILY:-}}"
  collect_missing_dependencies
  ((${#MISSING_PACKAGES[@]} == 0)) && return 0
  echo "[vcpdeck] 安装缺失依赖: ${MISSING_COMMANDS[*]}" >&2
  case "$INSTALLER_LINUX_FAMILY" in
  bazzite) install_bazzite_dependencies ;;
  apt)
    sudo apt-get update
    sudo apt-get install -y curl ca-certificates unzip tar xz-utils
    ;;
  dnf)
    sudo dnf install -y curl ca-certificates unzip tar xz
    ;;
  *) fail "缺少受支持的包管理器" ;;
  esac
}

main() {
  local SERVER_ORIGIN="${1:-}"
  [[ -n "$SERVER_ORIGIN" ]] || {
    fail "缺少 Server Origin"
    return 1
  }
  SERVER_ORIGIN="${SERVER_ORIGIN%/}"
  command_exists bash || {
    fail "需要 Bash"
    return 1
  }
  [[ "$(uname -m)" == "x86_64" ]] || {
    fail "仅支持 Linux x64"
    return 1
  }
  local os_release_path="${VCPDECK_OS_RELEASE_PATH:-/etc/os-release}"
  INSTALLER_LINUX_FAMILY="$(detect_linux_family "$os_release_path")" || return $?
  getconf GNU_LIBC_VERSION >/dev/null 2>&1 || {
    fail "仅支持 glibc，不支持 musl/Alpine"
    return 1
  }
  [[ -d /run/systemd/system ]] || {
    fail "需要 systemd"
    return 1
  }
  [[ ! -e /proc/sys/fs/binfmt_misc/WSLInterop ]] && ! grep -qi microsoft /proc/version || {
    fail "不支持 WSL"
    return 1
  }
  if [[ -f /.dockerenv ]] || grep -Eqi '(docker|containerd|kubepods|lxc)' /proc/1/cgroup 2>/dev/null; then
    fail "不支持容器环境"
    return 1
  fi
  install_deps "$INSTALLER_LINUX_FAMILY" || return $?

  # 在准备 Node.js 前先让 Server 检查开关与 Release readiness，禁用时快速失败。
  local PREFLIGHT="$SERVER_ORIGIN/api/client-installer/preflight?platform=linux-x64"
  local JSON
  JSON="$(curl -fsSL --connect-timeout 15 --max-time 60 "$PREFLIGHT")" || {
    fail "Server 拒绝安装或不可达"
    return 1
  }

  node_ok() {
    command_exists node || return 1
    node -e 'process.exit(process.arch === "x64" && Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' >/dev/null 2>&1
  }

  local NODE_BIN=""
  if node_ok && command_exists npm; then
    NODE_BIN="$(command -v node)"
  else
    local RUNTIME_ROOT="$HOME/.vcpdeck/runtime/node"
    mkdir -p "$RUNTIME_ROOT"
    local BASE INDEX VERSION DIR TMP ARCHIVE
    for BASE in https://npmmirror.com/mirrors/node https://nodejs.org/dist; do
      echo "[vcpdeck] 尝试 Node.js 源: $BASE"
      INDEX="$(curl -fsSL --connect-timeout 15 --max-time 60 "$BASE/index.json" 2>/dev/null || true)"
      [[ -n "$INDEX" ]] || continue
      VERSION="$(printf '%s' "$INDEX" | tr '{' '\n' | grep '"lts":' | sed -n 's/.*"version":"v\([0-9][0-9.]*\)".*/\1/p' | awk -F. '$1 >= 24 {print}' | sort -V | tail -1)"
      [[ -n "$VERSION" ]] || continue
      DIR="$RUNTIME_ROOT/node-$VERSION"
      if [[ ! -x "$DIR/bin/node" ]]; then
        TMP="$(mktemp -d)"
        register_cleanup_dir "$TMP"
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
  [[ -x "$NODE_BIN" ]] || {
    fail "无法准备 Node.js 24+ x64（国内源和官方源均失败）"
    return 1
  }

  local TMP_DIR
  TMP_DIR="$(mktemp -d)"
  register_cleanup_dir "$TMP_DIR"
  local INSTALLER_URL INSTALLER_SHA
  INSTALLER_URL="$(printf '%s' "$JSON" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).installerUrl))')"
  INSTALLER_SHA="$(printf '%s' "$JSON" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).installerSha256))')"
  curl -fL --connect-timeout 15 --max-time 120 "$SERVER_ORIGIN$INSTALLER_URL" -o "$TMP_DIR/install-client.cjs"
  printf '%s  %s\n' "$INSTALLER_SHA" "$TMP_DIR/install-client.cjs" | sha256sum -c -
  "$NODE_BIN" "$TMP_DIR/install-client.cjs" --server-origin="$SERVER_ORIGIN" --platform=linux-x64 --node="$NODE_BIN" </dev/tty
}

if [[ -z "${BASH_SOURCE[0]:-}" || "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
