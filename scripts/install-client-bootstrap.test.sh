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

missing_script='source "$1"; INSTALLER_LINUX_FAMILY=bazzite; command_exists() { case "$1" in curl|tar|rpm-ostree) return 0;; *) return 1;; esac; }; ca_bundle_available() { return 0; }; collect_missing_dependencies; printf "%s\\n" "${MISSING_PACKAGES[@]}"'
missing_output="$(run_bash "$missing_script")"
assert_eq $'unzip\nxz' "$missing_output"

no_layering_script='source "$1"; command_exists() { return 0; }; ca_bundle_available() { return 0; }; run_rpm_ostree() { echo unexpected-rpm-ostree >&2; return 99; }; install_deps bazzite'
run_bash "$no_layering_script" >/dev/null

live_script='source "$1"; calls="$(mktemp)"; check=0; command_exists() { if (( check == 0 )); then case "$1" in curl|tar|xz|rpm-ostree) return 0;; *) return 1;; esac; else return 0; fi; }; ca_bundle_available() { return 0; }; run_rpm_ostree() { printf "%s\\n" "$*" >>"$calls"; check=1; }; install_deps bazzite; cat "$calls"; rm -f "$calls"'
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

echo "install-client-bootstrap tests: PASS"
