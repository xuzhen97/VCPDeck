#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BOOTSTRAP="$SCRIPT_DIR/install-client-bootstrap.sh"
FIXTURES="$(mktemp -d "${TMPDIR:-/tmp}/vcpdeck-bootstrap-test.XXXXXX")"
trap 'rm -rf "$FIXTURES"' EXIT

cat >"$FIXTURES/bazzite" <<'EOF'
ID=bazzite
VERSION_ID=42
EOF
cat >"$FIXTURES/fedora" <<'EOF'
ID=fedora
VERSION_ID=42
ID_LIKE=fedora
EOF
cat >"$FIXTURES/kinoite" <<'EOF'
ID=kinoite
VERSION_ID=42
ID_LIKE="fedora"
EOF
cat >"$FIXTURES/ubuntu" <<'EOF'
ID=ubuntu
VERSION_ID=24.04
EOF
cat >"$FIXTURES/debian" <<'EOF'
ID=debian
VERSION_ID=12
EOF
cat >"$FIXTURES/rocky" <<'EOF'
ID=rocky
VERSION_ID=9.5
EOF
cat >"$FIXTURES/alma" <<'EOF'
ID=almalinux
VERSION_ID=9.5
EOF

assert_eq() {
  local expected="$1" actual="$2"
  [[ "$expected" == "$actual" ]] || {
    printf 'expected %q, got %q\n' "$expected" "$actual" >&2
    return 1
  }
}

assert_contains() {
  local expected="$1" actual="$2"
  [[ "$actual" == *"$expected"* ]] || {
    printf 'expected %q in %q\n' "$expected" "$actual" >&2
    return 1
  }
}

assert_not_contains() {
  local unexpected="$1" actual="$2"
  [[ "$actual" != *"$unexpected"* ]] || {
    printf 'did not expect %q in %q\n' "$unexpected" "$actual" >&2
    return 1
  }
}

run_bash() {
  bash -c "$1" _ "$BOOTSTRAP" "$FIXTURES"
}

# Server Origin 同时支持公开命令的旧位置参数和验收/自动化常用的具名参数。
origin_script='source "$1"; parse_bootstrap_args http://deck.example.com:3001/; a="$BOOTSTRAP_SERVER_ORIGIN"; parse_bootstrap_args --server-origin=https://deck.example.com:3001/; b="$BOOTSTRAP_SERVER_ORIGIN"; parse_bootstrap_args http://deck.example.com:3001 --migrate --migrate-from-user=alice; c="$BOOTSTRAP_SERVER_ORIGIN"; printf "%s\\n%s\\n%s\\n" "$a" "$b" "$c"; printf "MIGRATE=%s\\n" "${BOOTSTRAP_MIGRATION_ARGS[*]}"'
origin_output="$(run_bash "$origin_script")"
assert_eq $'http://deck.example.com:3001\nhttps://deck.example.com:3001\nhttp://deck.example.com:3001\nMIGRATE=--migrate=true --migrate-from-user=alice' "$origin_output"
if run_bash 'source "$1"; parse_bootstrap_args --server-origin=not-an-origin' >/dev/null 2>&1; then
  echo "invalid server origin must be rejected" >&2
  exit 1
fi

family_script='source "$1"; detect_linux_family "$2/bazzite"; detect_linux_family "$2/ubuntu"; detect_linux_family "$2/debian"; detect_linux_family "$2/rocky"; detect_linux_family "$2/alma"'
family_output="$(run_bash "$family_script")"
assert_eq $'bazzite\napt\napt\ndnf\ndnf' "$family_output"

if run_bash 'source "$1"; detect_linux_family "$2/fedora"' >/dev/null 2>&1; then
  echo "fedora must be rejected" >&2
  exit 1
fi
if run_bash 'source "$1"; detect_linux_family "$2/kinoite"' >/dev/null 2>&1; then
  echo "kinoite must be rejected" >&2
  exit 1
fi

missing_script='source "$1"; INSTALLER_LINUX_FAMILY=bazzite; command_exists() { case "$1" in curl|tar|rpm-ostree|ldconfig) return 0;; *) return 1;; esac; }; ldconfig() { printf "%s\\n" "libatomic.so.1 (libc6,x86-64) => /lib/libatomic.so.1"; }; ca_bundle_available() { return 0; }; collect_missing_dependencies; printf "%s\\n" "${MISSING_PACKAGES[@]}"'
missing_output="$(run_bash "$missing_script")"
assert_eq $'unzip\nxz' "$missing_output"

# Node.js Linux x64 运行时依赖：即使 curl/unzip/tar/xz 都存在，
# ldconfig 不含 libatomic.so.1 时也必须安装对应发行版包。
apt_atomic_script='source "$1"; INSTALLER_LINUX_FAMILY=apt; command_exists() { case "$1" in curl|unzip|tar|xz|ldconfig) return 0;; *) return 1;; esac; }; ca_bundle_available() { return 0; }; ldconfig() { return 1; }; calls="$2/apt-atomic.calls"; sudo() { printf "%s\\n" "$*" >>"$calls"; }; install_deps apt; cat "$calls"; rm -f "$calls"'
apt_atomic_output="$(run_bash "$apt_atomic_script")"
assert_contains 'apt-get install -y libatomic1' "$apt_atomic_output"

dnf_atomic_script='source "$1"; INSTALLER_LINUX_FAMILY=dnf; command_exists() { case "$1" in curl|unzip|tar|xz|ldconfig) return 0;; *) return 1;; esac; }; ca_bundle_available() { return 0; }; ldconfig() { return 1; }; calls="$2/dnf-atomic.calls"; sudo() { printf "%s\\n" "$*" >>"$calls"; }; install_deps dnf; cat "$calls"; rm -f "$calls"'
dnf_atomic_output="$(run_bash "$dnf_atomic_script")"
assert_contains 'dnf install -y libatomic' "$dnf_atomic_output"

no_layering_script='source "$1"; command_exists() { return 0; }; ldconfig() { printf "%s\\n" "libatomic.so.1 (libc6,x86-64) => /lib/libatomic.so.1"; }; ca_bundle_available() { return 0; }; run_rpm_ostree() { echo unexpected-rpm-ostree >&2; return 99; }; install_deps bazzite'
run_bash "$no_layering_script" >/dev/null

live_script='source "$1"; calls="$(mktemp)"; check=0; command_exists() { if [[ "$1" == "ldconfig" ]]; then return 0; fi; if (( check == 0 )); then case "$1" in curl|tar|xz|rpm-ostree) return 0;; *) return 1;; esac; else return 0; fi; }; ldconfig() { if (( check == 0 )); then return 1; fi; printf "%s\\n" "libatomic.so.1 (libc6,x86-64) => /lib/libatomic.so.1"; }; ca_bundle_available() { return 0; }; run_rpm_ostree() { printf "%s\\n" "$*" >>"$calls"; check=1; }; install_deps bazzite; cat "$calls"; rm -f "$calls"'
live_output="$(run_bash "$live_script")"
assert_contains 'install -y --apply-live' "$live_output"
assert_not_contains 'install -y '"'"'--apply-live'"'"' curl' "$live_output"

fallback_script='source "$1"; calls="$(mktemp)"; command_exists() { case "$1" in curl|unzip|tar|xz) return 1;; rpm-ostree) return 0;; esac; return 1; }; ca_bundle_available() { return 0; }; attempt=0; run_rpm_ostree() { printf "%s\\n" "$*" >>"$calls"; attempt=$((attempt + 1)); (( attempt == 1 )) && return 1; return 0; }; set +e; output="$(install_deps bazzite 2>&1)"; status=$?; cat "$calls"; printf "OUTPUT=%s\\nSTATUS=%s\\n" "$output" "$status"; rm -f "$calls"; exit 0'
fallback_output="$(run_bash "$fallback_script")"
assert_contains 'install -y --apply-live' "$fallback_output"
assert_contains 'install -y curl unzip tar xz' "$fallback_output"
assert_contains '重启' "$fallback_output"
assert_contains 'STATUS=75' "$fallback_output"
assert_not_contains 'reboot' "$fallback_output"
assert_not_contains 'dnf install' "$fallback_output"

missing_rpm_script='source "$1"; command_exists() { case "$1" in curl|unzip|tar|xz) return 1;; *) return 1;; esac; }; ca_bundle_available() { return 0; }; set +e; install_deps bazzite >/tmp/vcpdeck-missing-rpm-output 2>&1; status=$?; cat /tmp/vcpdeck-missing-rpm-output; rm -f /tmp/vcpdeck-missing-rpm-output; exit "$status"'
if run_bash "$missing_rpm_script" >/dev/null 2>&1; then
  echo "missing rpm-ostree must fail" >&2
  exit 1
fi

cleanup_script='source "$1"; dir="$(mktemp -d)"; register_cleanup_dir "$dir"; unset dir; exit 0'
run_bash "$cleanup_script"

# ── A2 权限门禁（ADR-0023） ──
# 模板：source bootstrap 后注入 id/command_exists/sudo mock，再跑 $3 断言体。
# 顶层 $1=bootstrap（source 用）；函数内 $1 为各函数自身参数（id/sudo/command_exists）。
priv_template='source "$1"; set +e; id() { if [[ "$1" == "-u" ]]; then echo __UID__; return; fi; echo __UID__; }; command_exists() { if [[ "$1" == "sudo" ]]; then return 0; fi; return 1; }; SUDO_CALLED=0; sudo() { SUDO_CALLED=1; if [[ "$1" == "-v" ]]; then if [[ __SUDO_OK__ == 1 ]]; then return 0; fi; return 1; fi; echo "SUDO-RAN $*"; }; __BODY__'
priv_test() {
  local s="${priv_template//__UID__/$1}"
  s="${s//__SUDO_OK__/$2}"
  s="${s//__BODY__/$3}"
  # 合并 stderr：require_sudo 的诊断/稳定码输出到 stderr，断言需一并捕获。
  run_bash "$s" 2>&1
}

# root：绕过 sudo（不调用 sudo），门禁通过
out="$(priv_test 0 1 'require_sudo; echo "RC=$? SUDO=$SUDO_CALLED"')"
assert_contains "RC=0" "$out"
assert_contains "SUDO=0" "$out"

# 普通用户 + sudo -v 成功：门禁通过（调用过 sudo -v）
out="$(priv_test 1000 1 'require_sudo; echo "RC=$? SUDO=$SUDO_CALLED"')"
assert_contains "RC=0" "$out"
assert_contains "SUDO=1" "$out"

# 普通用户 + sudo -v 失败：门禁失败且带稳定码 LINUX_SUDO_AUTH_FAILED，无回退
out="$(priv_test 1000 0 'require_sudo; echo "RC=$? SUDO=$SUDO_CALLED"')"
assert_contains "RC=1" "$out"
assert_contains "LINUX_SUDO_AUTH_FAILED" "$out"

# run_privileged：root 直接执行（不经 sudo）
out="$(priv_test 0 1 'run_privileged echo hi; echo "SUDO=$SUDO_CALLED"')"
assert_contains "hi" "$out"
assert_contains "SUDO=0" "$out"

# run_privileged：普通用户经 sudo 前缀执行
out="$(priv_test 1000 1 'run_privileged echo hi; echo "SUDO=$SUDO_CALLED"')"
assert_contains "SUDO-RAN echo hi" "$out"
assert_contains "SUDO=1" "$out"

echo "install-client-bootstrap tests: PASS"
