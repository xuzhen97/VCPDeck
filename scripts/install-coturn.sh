#!/usr/bin/env bash
# VCPDeck coturn 一键安装配置脚本（ADR-0026）。
# 仅直接执行时运行 main；可被测试 source 以复用纯函数（source 不启用 errexit）。

readonly MARKER="# managed-by: vcpdeck-coturn"
readonly CONF="/etc/turnserver.conf"
readonly SECRET_DIR="/etc/vcpdeck"
readonly SECRET_FILE="/etc/vcpdeck/turn-secret"
readonly LISTEN_PORT="${LISTEN_PORT:-3478}"
readonly RELAY_MIN_PORT="${RELAY_MIN_PORT:-49160}"
readonly RELAY_MAX_PORT="${RELAY_MAX_PORT:-49200}"

# ── 纯函数（可被测试 source 调用） ──────────────────────────────

# 读取 /etc/os-release 并返回 apt 或 dnf；不支持则返回非 0
detect_linux_family() {
	local os_release="$1"
	local id=""
	local id_like=""
	local version_id=""
	if [[ -f "$os_release" ]]; then
		id="$(grep -E '^ID=' "$os_release" 2>/dev/null | head -n1 | tr -d 'ID=')"
		id_like="$(grep -E '^ID_LIKE=' "$os_release" 2>/dev/null | head -n1 | tr -d 'ID_LIKE=')"
		version_id="$(grep -E '^VERSION_ID=' "$os_release" 2>/dev/null | head -n1 | tr -d 'VERSION_ID=')"
	fi
	id="${id//\"/}"
	id_like="${id_like//\"/}"
	version_id="${version_id//\"/}"

	case "$id" in
	ubuntu|debian|linuxmint)
		echo "apt"
		return 0
		;;
	esac
	case " $id_like " in
	*" debian "*|*" ubuntu "*)
		echo "apt"
		return 0
		;;
	esac
	case "$id" in
	centos|rhel|rocky|almalinux|fedora)
		echo "dnf"
		return 0
		;;
	esac
	case " $id_like " in
	*" fedora "*|*" rhel "*)
		echo "dnf"
		return 0
		;;
	esac
	# 未知 ID 但带版本号时按 dnf 兜底（RHEL 系）
	if [[ -n "$version_id" ]]; then
		echo "dnf"
		return 0
	fi
	return 1
}

# 渲染 external-ip：公网与内网相同时只保留公网，否则 external-ip=公网/内网
render_external_ip() {
	local external="$1"
	local internal="$2"
	if [[ -z "$internal" || "$external" == "$internal" ]]; then
		echo "external-ip=$external"
	else
		echo "external-ip=$external/$internal"
	fi
}

# 校验 IPv4；非法返回非 0
validate_ipv4() {
	local ip="$1"
	if [[ ! "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
		return 1
	fi
	local IFS='.'
	local -a octets=($ip)
	for o in "${octets[@]}"; do
		if ((o > 255)); then
			return 1
		fi
	done
	return 0
}

# 探测外部 IPv4（未显式提供时）
detect_external_ip() {
	curl -4fsS --max-time 10 https://api.ipify.org 2>/dev/null || true
}

# 探测本机默认出口 IPv4（internal/relay-ip）
detect_internal_ip() {
	ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++){if($i=="src"){print $(i+1);exit}}}' || true
}

# 生成 32 字节随机密钥的 Base64 字符串；必须单行：base64 默认每 76 列插入换行，
# 多行 secret 会让 Server 与 coturn 的 HMAC key 不一致，导致 TURN 分配全部 401。
generate_secret() {
	od -An -N 32 -v -tx1 /dev/urandom | tr -d " \n" | base64 2>/dev/null | tr -d "\n" \
		|| head -c 32 /dev/urandom | base64 | tr -d "\n"
}

# ── 副作用函数 ──────────────────────────────────────────────────

install_packages() {
	local family="$1"
	case "$family" in
	apt)
		apt-get update
		apt-get install -y coturn
		;;
	dnf)
		if ! dnf install -y coturn 2>/dev/null; then
			dnf install -y epel-release
			dnf install -y coturn
		fi
		;;
	*)
		echo "不支持的发行版：$family" >&2
		return 1
		;;
	esac
}

ensure_secret() {
	local server_user="$1"
	mkdir -p "$SECRET_DIR"
	if [[ -f "$SECRET_FILE" ]]; then
		# 重跑保留既有 secret，校验 owner/mode
		if [[ "$(stat -c '%U' "$SECRET_FILE" 2>/dev/null)" != "root" ]]; then
			echo "secret 文件 owner 必须为 root" >&2
			return 1
		fi
		if [[ "$(stat -c '%a' "$SECRET_FILE" 2>/dev/null)" != "640" ]]; then
			chmod 0640 "$SECRET_FILE"
		fi
		chown "root:$server_user" "$SECRET_FILE" 2>/dev/null || true
		# 归一历史版本用 base64（默认 76 列换行）写出的多行 secret：
		# 换行会进入 HMAC key，使 coturn 与 Server 签名口径不一致。
		local normalized
		normalized="$(tr -d '\r\n' <"$SECRET_FILE")"
		if [[ -n "$normalized" && "$normalized" != "$(<"$SECRET_FILE")" ]]; then
			umask 077
			printf '%s' "$normalized" >"$SECRET_FILE"
		fi
		return 0
	fi
	local secret
	secret="$(generate_secret)"
	if [[ -z "$secret" ]]; then
		echo "无法生成 secret" >&2
		return 1
	fi
	umask 077
	printf '%s' "$secret" >"$SECRET_FILE"
	chown "root:$server_user" "$SECRET_FILE"
	chmod 0640 "$SECRET_FILE"
}

# 渲染 coturn 配置正文（纯函数，供测试断言）。
# secret 不写进配置：coturn 4.6.x 没有 static-auth-secret-file 选项，
# 改为由 systemd drop-in 从 $SECRET_FILE 注入，保持单一来源。
render_config() {
	local external_ip="$1"
	local internal_ip="$2"
	local realm="$3"
	local external_line
	external_line="$(render_external_ip "$external_ip" "$internal_ip")"
	echo "$MARKER"
	echo "listening-port=$LISTEN_PORT"
	echo "listening-ip=0.0.0.0"
	[[ -n "$internal_ip" ]] && echo "relay-ip=$internal_ip"
	echo "$external_line"
	echo "min-port=$RELAY_MIN_PORT"
	echo "max-port=$RELAY_MAX_PORT"
	echo "realm=$realm"
	echo "use-auth-secret=yes"
	echo "no-cli=yes"
	echo "no-multicast-peers=yes"
	echo "fingerprint=yes"
}

# 渲染 systemd drop-in 正文（纯函数，供测试断言）：把 --static-auth-secret
# 从 secret 文件注入 coturn，替代 4.5+ 已不存在的配置文件写法。
render_secret_dropin() {
	echo "[Service]"
	echo "ExecStart="
	echo "ExecStart=/bin/sh -c 'exec /usr/bin/turnserver -c $CONF --static-auth-secret=\"\$(cat $SECRET_FILE)\" --pidfile='"
}

write_config() {
	local external_ip="$1"
	local internal_ip="$2"
	local realm="$3"
	local server_user="$4"
	if [[ -f "$CONF" ]] && ! grep -q "$MARKER" "$CONF"; then
		echo "检测到非 VCPDeck 管理的 /etc/turnserver.conf，拒绝覆盖" >&2
		return 1
	fi
	render_config "$external_ip" "$internal_ip" "$realm" >"$CONF"
}

# 安装 drop-in 并重载 systemd，使 coturn 启动时带上 secret
install_secret_dropin() {
	local unit="$1"
	local dir="/etc/systemd/system/${unit}.d"
	mkdir -p "$dir"
	render_secret_dropin >"$dir/10-auth-secret.conf"
	systemctl daemon-reload
}

ensure_service() {
	local unit=""
	if systemctl cat coturn.service >/dev/null 2>&1; then
		unit="coturn.service"
	elif systemctl cat turnserver.service >/dev/null 2>&1; then
		unit="turnserver.service"
	else
		echo "未找到 coturn/turnserver systemd 服务" >&2
		return 1
	fi
	systemctl enable --now "$unit"
	install_secret_dropin "$unit" || return 1
	systemctl restart "$unit"
	if ! systemctl is-active --quiet "$unit"; then
		echo "$unit 未处于 active 状态" >&2
		return 1
	fi
}

print_summary() {
	local external_ip="$1"
	local realm="$2"
	echo
	echo "=== coturn 安装完成 ==="
	echo "需开放端口：TCP/UDP $LISTEN_PORT；UDP $RELAY_MIN_PORT-$RELAY_MAX_PORT"
	echo "VCPDECK_TURN_SECRET_FILE=$SECRET_FILE"
	echo "STUN/TURN URL：stun:${external_ip}:${LISTEN_PORT}；turn:${external_ip}:${LISTEN_PORT}"
	echo "realm：$realm"
	echo "将上述 URL 填入 Web 设置 → 网络 完成配置。"
}

main() {
	local server_user=""
	local external_ip=""
	local internal_ip=""
	local realm=""
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--server-user)
				server_user="${2:?}"; shift 2 ;;
			--external-ip)
				external_ip="${2:?}"; shift 2 ;;
			--internal-ip)
				internal_ip="${2:?}"; shift 2 ;;
			--realm)
				realm="${2:?}"; shift 2 ;;
			--listening-port)
				LISTEN_PORT="${2:?}"; shift 2 ;;
			--relay-min-port)
				RELAY_MIN_PORT="${2:?}"; shift 2 ;;
			--relay-max-port)
				RELAY_MAX_PORT="${2:?}"; shift 2 ;;
			*)
				echo "未知参数：$1" >&2
				exit 1 ;;
		esac
	done

	if [[ -z "$server_user" ]]; then
		server_user="$(id -un)"
	fi

	local family
	family="$(detect_linux_family /etc/os-release)"
	if [[ -z "$family" ]]; then
		echo "不支持的 Linux 发行版" >&2
		exit 1
	fi

	if [[ -z "$internal_ip" ]]; then
		internal_ip="$(detect_internal_ip)"
	fi
	if [[ -n "$internal_ip" ]] && ! validate_ipv4 "$internal_ip"; then
		internal_ip=""
	fi

	if [[ -z "$external_ip" ]]; then
		external_ip="$(detect_external_ip)"
	fi
	if [[ -z "$external_ip" ]] && [[ -n "$internal_ip" ]]; then
		external_ip="$internal_ip"
	fi
	if [[ -z "$external_ip" ]] || ! validate_ipv4 "$external_ip"; then
		echo "无法确定有效 external IPv4，请显式提供 --external-ip" >&2
		exit 1
	fi
	if [[ -n "$internal_ip" ]] && ! validate_ipv4 "$internal_ip"; then
		echo "internal IP 非法：$internal_ip" >&2
		exit 1
	fi

	if [[ -z "$realm" ]]; then
		realm="$external_ip"
	fi

	install_packages "$family"
	ensure_secret "$server_user"
	write_config "$external_ip" "$internal_ip" "$realm" "$server_user"
	ensure_service
	print_summary "$external_ip" "$realm"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	set -euo pipefail
	main "$@"
fi
