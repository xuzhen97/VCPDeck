#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "[vcpdeck] $*" >&2
  return 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

is_root() {
  [[ "$(id -u 2>/dev/null || echo 1)" == "0" ]]
}

parse_bootstrap_args() {
  BOOTSTRAP_MIGRATION_ARGS=()
  local value=""
  local arg
  for arg in "$@"; do
    case "$arg" in
    --server-origin=*)
      [[ -z "$value" ]] || {
        fail "Server Origin 只能指定一次"
        return 1
      }
      value="${arg#--server-origin=}"
      ;;
    --migrate)
      BOOTSTRAP_MIGRATION_ARGS+=("--migrate=true")
      ;;
    --migrate=true | --migrate=false)
      BOOTSTRAP_MIGRATION_ARGS+=("$arg")
      ;;
    --migrate-from-user=*)
      BOOTSTRAP_MIGRATION_ARGS+=("$arg")
      ;;
    http://* | https://*)
      [[ -z "$value" ]] || {
        fail "Server Origin 只能指定一次"
        return 1
      }
      value="$arg"
      ;;
    *)
      fail "未知参数: $arg"
      return 1
      ;;
    esac
  done
  value="${value%/}"
  [[ "$value" =~ ^https?://[^[:space:]/]+$ ]] || {
    fail "用法: install-client-bootstrap.sh <server-origin> 或 --server-origin=<server-origin>"
    return 1
  }
  BOOTSTRAP_SERVER_ORIGIN="$value"
}

# 权限门禁（ADR-0023 A2）：root 直接放行；普通用户必须通过 sudo -v；
# 失败以稳定码 LINUX_SUDO_AUTH_FAILED 退出，不回退到用户态安装。
require_sudo() {
  if is_root; then
    return 0
  fi
  if ! command_exists sudo; then
    echo "[vcpdeck] LINUX_SUDO_AUTH_FAILED 无法使用 sudo（未安装或不可用）" >&2
    return 1
  fi
  if ! sudo -v; then
    echo "[vcpdeck] LINUX_SUDO_AUTH_FAILED sudo 认证失败；请确认当前用户可免密或可交互 sudo 后重试" >&2
    return 1
  fi
  return 0
}

# 以 root 身份执行命令：已 root 直接跑，否则经 sudo 前缀（不弹回退）。
run_privileged() {
  if is_root; then
    "$@"
  else
    sudo "$@"
  fi
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

runtime_library_available() {
  # glibc 发行版通常提供 ldconfig；若目标环境无法探测，则不额外猜测，
  # 让 Node 启动时自行暴露真实错误，避免在未知平台误装包。
  command_exists ldconfig || return 0
  ldconfig -p 2>/dev/null | grep -qE 'libatomic\.so\.1([[:space:]]|$)'
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

  # Node.js 官方 Linux x64 构件依赖 libatomic.so.1；Ubuntu/Debian 与
  # Rocky/Alma/Bazzite 的包名不同。只在 ldconfig 明确探测不到时补包。
  if ! runtime_library_available; then
    MISSING_COMMANDS+=(libatomic)
    case "${INSTALLER_LINUX_FAMILY:-}" in
    apt) package="libatomic1" ;;
    dnf | bazzite) package="libatomic" ;;
    *) package="" ;;
    esac
    if [[ -n "$package" ]]; then
      local already_atomic=false
      for existing in "${MISSING_PACKAGES[@]}"; do
        [[ "$existing" == "$package" ]] && already_atomic=true && break
      done
      [[ "$already_atomic" == true ]] || MISSING_PACKAGES+=("$package")
    fi
  fi
}

run_rpm_ostree() {
  run_privileged rpm-ostree "$@"
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
    run_privileged apt-get update
    run_privileged apt-get install -y "${MISSING_PACKAGES[@]}"
    ;;
  dnf)
    run_privileged dnf install -y "${MISSING_PACKAGES[@]}"
    ;;
  *) fail "缺少受支持的包管理器" ;;
  esac
}

main() {
  local SERVER_ORIGIN
  local MIGRATION_ARGS=()
  parse_bootstrap_args "$@" || return $?
  SERVER_ORIGIN="$BOOTSTRAP_SERVER_ORIGIN"
  MIGRATION_ARGS=("${BOOTSTRAP_MIGRATION_ARGS[@]}")
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
  if [[ -e /proc/sys/fs/binfmt_misc/WSLInterop ]] || grep -qi microsoft /proc/version; then
    fail "不支持 WSL"
    return 1
  fi
  if [[ -f /.dockerenv ]] || grep -Eqi '(docker|containerd|kubepods|lxc)' /proc/1/cgroup 2>/dev/null; then
    fail "不支持容器环境"
    return 1
  fi
  require_sudo || return 1
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
    # A2：bootstrap Node 仅作提权前的一次性引导，放临时目录（不落用户 HOME）。
    local RUNTIME_ROOT
    RUNTIME_ROOT="$(mktemp -d)"
    register_cleanup_dir "$RUNTIME_ROOT"
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
  local INSTALLER_URL INSTALLER_SHA LOW_LEVEL_URL LOW_LEVEL_SHA
  local BOOTSTRAP_JSON RELEASE_VERSION ARCHIVE_URL ARCHIVE_SHA
  INSTALLER_URL="$(printf '%s' "$JSON" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).installerUrl))')"
  INSTALLER_SHA="$(printf '%s' "$JSON" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).installerSha256))')"
  LOW_LEVEL_URL="$(printf '%s' "$JSON" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).lowLevelInstallerUrl))')"
  LOW_LEVEL_SHA="$(printf '%s' "$JSON" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).lowLevelInstallerSha256))')"

  # Bootstrap 响应含 PSK 与构件下载信息；PSK 只由 A2 installer 自己通过 HTTPS
  # 取回，不进入 shell 参数/日志。此处仅提取版本、archive URL 与 SHA-256。
  BOOTSTRAP_JSON="$(curl -fsSL --connect-timeout 15 --max-time 60 \
    -X POST -H 'content-type: application/json' \
    --data '{"platform":"linux-x64"}' \
    "$SERVER_ORIGIN/api/client-installer/bootstrap")" || {
    fail "Server bootstrap 信息获取失败"
    return 1
  }
  RELEASE_VERSION="$(printf '%s' "$BOOTSTRAP_JSON" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).releaseVersion||""))')"
  ARCHIVE_URL="$(printf '%s' "$BOOTSTRAP_JSON" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).archiveUrl||""))')"
  ARCHIVE_SHA="$(printf '%s' "$BOOTSTRAP_JSON" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).archiveSha256||""))')"
  [[ "$RELEASE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    fail "Server bootstrap 未返回合法 Release 版本"
    return 1
  }
  [[ "$ARCHIVE_SHA" =~ ^[a-fA-F0-9]{64}$ ]] || {
    fail "Server bootstrap 未返回合法 archive sha256"
    return 1
  }
  [[ "$ARCHIVE_URL" == /* || "$ARCHIVE_URL" == http://* || "$ARCHIVE_URL" == https://* ]] || {
    fail "Server bootstrap 返回非法 archive URL"
    return 1
  }

  curl -fsSL --connect-timeout 15 --max-time 120 "$SERVER_ORIGIN$INSTALLER_URL" -o "$TMP_DIR/install-client-linux.cjs"
  printf '%s  %s\n' "$INSTALLER_SHA" "$TMP_DIR/install-client-linux.cjs" | sha256sum -c -
  curl -fsSL --connect-timeout 15 --max-time 120 "$SERVER_ORIGIN$LOW_LEVEL_URL" -o "$TMP_DIR/install.cjs"
  printf '%s  %s\n' "$LOW_LEVEL_SHA" "$TMP_DIR/install.cjs" | sha256sum -c -
  local ARCHIVE_DOWNLOAD_URL="$ARCHIVE_URL"
  [[ "$ARCHIVE_DOWNLOAD_URL" == http://* || "$ARCHIVE_DOWNLOAD_URL" == https://* ]] ||
    ARCHIVE_DOWNLOAD_URL="$SERVER_ORIGIN$ARCHIVE_DOWNLOAD_URL"
  curl -fsSL --connect-timeout 15 --max-time 1800 "$ARCHIVE_DOWNLOAD_URL" -o "$TMP_DIR/client.zip"
  printf '%s  %s\n' "$ARCHIVE_SHA" "$TMP_DIR/client.zip" | sha256sum -c -
  run_privileged "$NODE_BIN" "$TMP_DIR/install-client-linux.cjs" \
    --server-origin="$SERVER_ORIGIN" \
    --bootstrap-node="$NODE_BIN" \
    --release-version="$RELEASE_VERSION" \
    --archive-cache="$TMP_DIR/client.zip" \
    --archive-sha256="$ARCHIVE_SHA" \
    --install-cjs="$TMP_DIR/install.cjs" \
    "${MIGRATION_ARGS[@]}" </dev/tty
}

if [[ -z "${BASH_SOURCE[0]:-}" || "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
