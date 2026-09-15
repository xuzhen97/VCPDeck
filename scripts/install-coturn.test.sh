#!/usr/bin/env bash
# install-coturn.sh 纯函数测试：source 安装脚本并断言行为。
set -euo pipefail

INSTALLER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install-coturn.sh"
FIXTURES="$(mktemp -d)"
trap 'rm -rf "$FIXTURES"' EXIT

pass=0
fail=0

assert_eq() {
	local expected="$1"
	local actual="$2"
	local desc="${3:-}"
	if [[ "$expected" == "$actual" ]]; then
		pass=$((pass + 1))
	else
		fail=$((fail + 1))
		echo "FAIL($desc): expected [$expected] got [$actual]" >&2
	fi
}

# fixture: ubuntu
cat >"$FIXTURES/ubuntu" <<'EOF'
ID=ubuntu
VERSION_ID="24.04"
EOF

# fixture: rocky
cat >"$FIXTURES/rocky" <<'EOF'
ID=rocky
ID_LIKE="rhel fedora"
VERSION_ID="9.4"
EOF

# fixture: unsupported (unknown id, no version)
cat >"$FIXTURES/unknown" <<'EOF'
ID=someos
EOF

# 1. 发行版家族识别
family_output="$(bash -c 'source "$1"; detect_linux_family "$2/ubuntu"; detect_linux_family "$2/rocky"' _ "$INSTALLER" "$FIXTURES")"
assert_eq $'apt\ndnf' "$family_output" "family detection"

# 2. 不支持发行版失败
if bash -c 'source "$1"; detect_linux_family "$2/unknown"' _ "$INSTALLER" "$FIXTURES"; then
	fail=$((fail + 1))
	echo "FAIL: unsupported family must fail" >&2
else
	pass=$((pass + 1))
fi

# 3. external-ip 渲染
assert_eq 'external-ip=203.0.113.10/10.0.0.4' \
	"$(bash -c 'source "$1"; render_external_ip 203.0.113.10 10.0.0.4' _ "$INSTALLER")" "external-ip dual"
assert_eq 'external-ip=203.0.113.10' \
	"$(bash -c 'source "$1"; render_external_ip 203.0.113.10 203.0.113.10' _ "$INSTALLER")" "external-ip single"

# 4. IPv4 校验
if bash -c 'source "$1"; validate_ipv4 "not-an-ip"' _ "$INSTALLER"; then
	fail=$((fail + 1))
	echo "FAIL: invalid IPv4 must fail" >&2
else
	pass=$((pass + 1))
fi

if bash -c 'source "$1"; validate_ipv4 "203.0.113.10"' _ "$INSTALLER"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	echo "FAIL: valid IPv4 must pass" >&2
fi

# 5. IPv4 超范围失败
if bash -c 'source "$1"; validate_ipv4 "256.0.0.1"' _ "$INSTALLER"; then
	fail=$((fail + 1))
	echo "FAIL: out-of-range octet must fail" >&2
else
	pass=$((pass + 1))
fi

echo "PASS=$pass FAIL=$fail"
if ((fail > 0)); then
	exit 1
fi
