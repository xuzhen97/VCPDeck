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

# 6. secret 必须单行且为 Base64（base64 默认 76 列换行会写出多行 secret，
#    导致 Server 与 coturn 的 HMAC key 不一致）
secret_output="$(bash -c 'source "$1"; generate_secret' _ "$INSTALLER")"
assert_eq "$secret_output" "$(printf '%s' "$secret_output" | tr -d '\n')" "secret must be single-line"
if [[ "$secret_output" =~ ^[A-Za-z0-9+/]+=*$ ]]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	echo "FAIL: secret must be base64, got [$secret_output]" >&2
fi

# 7. 配置不得包含 coturn 不支持的 static-auth-secret-file，且启用 REST secret
config_output="$(bash -c 'source "$1"; render_config 203.0.113.10 10.0.0.4 203.0.113.10' _ "$INSTALLER")"
if grep -qF 'static-auth-secret-file' <<<"$config_output"; then
	fail=$((fail + 1))
	echo "FAIL: config must not use static-auth-secret-file" >&2
else
	pass=$((pass + 1))
fi
assert_eq 'use-auth-secret=yes' "$(grep -x 'use-auth-secret=yes' <<<"$config_output")" "config use-auth-secret"
assert_eq 'realm=203.0.113.10' "$(grep -x 'realm=203.0.113.10' <<<"$config_output")" "config realm"

# 8. drop-in 必须重置 ExecStart 并从 secret 文件注入 --static-auth-secret
dropin_output="$(bash -c 'source "$1"; render_secret_dropin' _ "$INSTALLER")"
assert_eq 'ExecStart=' "$(grep -x 'ExecStart=' <<<"$dropin_output")" "dropin resets ExecStart"
if grep -qF -- '--static-auth-secret="$(cat /etc/vcpdeck/turn-secret)"' <<<"$dropin_output"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	echo "FAIL: dropin must inject static-auth-secret from secret file, got [$dropin_output]" >&2
fi

echo "PASS=$pass FAIL=$fail"
if ((fail > 0)); then
	exit 1
fi
