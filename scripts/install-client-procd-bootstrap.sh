#!/bin/sh
# VCPDeck iStoreOS 24.10 x64（musl + procd）引导脚本（ADR-0065）。
#
# 用法（必须以 root 运行）：
#   sh install-client-procd-bootstrap.sh https://<server-origin>
#
# 做四件事：
#   1. 取 preflight（公开端点）拿低层安装器与其 SHA-256；
#   2. 取 bootstrap（公开端点）拿已发布 zip 的地址与 SHA-256、PSK；
#   3. 下载 zip 与 musl Node 运行时，按 SHA-256 逐字节校验后解压；
#   4. 调 install-client-procd.cjs 落盘、写 launcher.env、注册 procd 服务。
#
# 不安装任何 opkg 包，不修改系统 Node，不打印 URL 与 PSK。
set -eu

fail() {
	printf '%s\n' "$1" >&2
	exit 1
}

[ "$(id -u)" -eq 0 ] || fail "PROCD_ROOT_REQUIRED"

ORIGIN="${1:-}"
[ -n "$ORIGIN" ] || fail "PROCD_USAGE: 需要 Server Origin 参数"
case "$ORIGIN" in
http://* | https://*) ;;
*) fail "PROCD_ORIGIN_INVALID" ;;
esac
ORIGIN="${ORIGIN%/}"

for bin in node curl sha256sum; do
	command -v "$bin" >/dev/null 2>&1 || fail "PROCD_TOOL_MISSING: $bin"
done

# 安装器与 bootstrap 都用系统 Node 处理 JSON 与解压；20 以下缺少所需能力。
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null \
	|| fail "PROCD_TOOL_MISSING: node>=20"

WORK="$(mktemp -d /tmp/vcpdeck-procd.XXXXXX)" || fail "PROCD_WORKDIR_FAILED"
trap 'rm -rf "$WORK"' EXIT INT TERM

fetch() {
	curl -fsSL --retry 2 --max-time 120 -o "$2" "$1" || fail "PROCD_DOWNLOAD_FAILED"
}

# 需要逐字节可信的资产才用：下载后比对调用方给出的 SHA-256。
fetch_verified() {
	fetch "$1" "$2"
	actual="$(sha256sum "$2" | cut -d' ' -f1)"
	[ "$actual" = "$3" ] || fail "PROCD_ASSET_SHA256_MISMATCH"
}

# 从 JSON 文件取点路径字段（只输出值，不做 shell 求值）。
json_field() {
	node -e '
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
let current = value;
for (const key of process.argv[2].split(".")) current = current?.[key];
process.stdout.write(current === undefined || current === null ? "" : String(current));
' "$1" "$2"
}

PREFLIGHT="$WORK/preflight.json"
curl -fsSL --retry 2 --max-time 120 \
	-o "$PREFLIGHT" \
	"$ORIGIN/api/client-installer/preflight?platform=linux-x64-musl" ||
	fail "PROCD_PREFLIGHT_FAILED"
LOW_URL="$(json_field "$PREFLIGHT" lowLevelInstallerUrl)"
LOW_SHA="$(json_field "$PREFLIGHT" lowLevelInstallerSha256)"
RELEASE_VERSION="$(json_field "$PREFLIGHT" releaseVersion)"
if [ -z "$LOW_URL" ] || [ -z "$LOW_SHA" ] || [ -z "$RELEASE_VERSION" ]; then
	fail "PROCD_PREFLIGHT_INVALID"
fi

# 安装器的辅助模块：逐个按 preflight 下发的 SHA-256 校验；这些模块会以 root 执行。
ASSET_LIST="$(node -e '
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const list = Array.isArray(value.procdAssets) ? value.procdAssets : [];
if (list.length === 0) process.exit(3);
for (const item of list) {
	if (typeof item?.name !== "string" || typeof item?.sha256 !== "string") process.exit(3);
	process.stdout.write(item.name + " " + item.sha256 + "\n");
}
' "$PREFLIGHT")" || fail "PROCD_PREFLIGHT_INVALID"
printf '%s\n' "$ASSET_LIST" |
while read -r asset sha; do
	[ -n "$asset" ] && [ -n "$sha" ] || fail "PROCD_PREFLIGHT_INVALID"
	fetch_verified "$ORIGIN/api/client-installer/assets/$asset" "$WORK/$asset" "$sha"
done
fetch_verified "$ORIGIN$LOW_URL" "$WORK/install-client-procd.cjs" "$LOW_SHA"

node "$WORK/install-client-procd.cjs" --check-platform ||
	fail "PROCD_PLATFORM_UNSUPPORTED"

# bootstrap 端点返回本次要装的 zip、它的 SHA-256 与 PSK。
BOOTSTRAP="$WORK/bootstrap.json"
curl -fsSL --retry 2 --max-time 120 \
	-X POST \
	-H "content-type: application/json" \
	--data '{"platform":"linux-x64-musl"}' \
	-o "$BOOTSTRAP" \
	"$ORIGIN/api/client-installer/bootstrap" ||
	fail "PROCD_BOOTSTRAP_FAILED"
ARCHIVE_URL="$(json_field "$BOOTSTRAP" archiveUrl)"
ARCHIVE_SHA="$(json_field "$BOOTSTRAP" archiveSha256)"
PSK="$(json_field "$BOOTSTRAP" psk)"
BOOT_VERSION="$(json_field "$BOOTSTRAP" releaseVersion)"
if [ -z "$ARCHIVE_URL" ] || [ -z "$ARCHIVE_SHA" ] || [ -z "$PSK" ]; then
	fail "PROCD_BOOTSTRAP_INVALID"
fi
# Server 按字符串精确比较 PSK；空值、空白/控制字符或超长值在下载构件前就拒绝。
node -e '
const value = process.argv[1];
const ok =
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  !/[\s\u0000-\u001f\u007f]/.test(value);
process.exit(ok ? 0 : 1);
' "$PSK" 2>/dev/null || fail "PROCD_PSK_INVALID"
[ "$BOOT_VERSION" = "$RELEASE_VERSION" ] || fail "PROCD_RELEASE_MISMATCH"

ZIP="$WORK/release.zip"
fetch_verified "$ORIGIN$ARCHIVE_URL" "$ZIP" "$ARCHIVE_SHA"

STAGING="$WORK/staging"
mkdir -p "$STAGING"
node -e '
require(process.argv[1]).extractZip(process.argv[2], process.argv[3]);
' "$WORK/procd-archive.cjs" "$ZIP" "$STAGING" || fail "PROCD_ARCHIVE_EXTRACT_FAILED"

DESCRIPTOR="$STAGING/client/release-target.json"
[ -f "$DESCRIPTOR" ] || fail "PROCD_RELEASE_TARGET_MISSING"
RUNTIME_VERSION="$(json_field "$DESCRIPTOR" runtime.version)"
RUNTIME_URL="$(json_field "$DESCRIPTOR" runtime.url)"
RUNTIME_SHA="$(json_field "$DESCRIPTOR" runtime.sha256)"
if [ -z "$RUNTIME_VERSION" ] || [ -z "$RUNTIME_URL" ] || [ -z "$RUNTIME_SHA" ]; then
	fail "PROCD_RELEASE_TARGET_INVALID"
fi

RUNTIME_TGZ="$WORK/node-v$RUNTIME_VERSION-linux-x64-musl.tar.gz"
fetch_verified "$RUNTIME_URL" "$RUNTIME_TGZ" "$RUNTIME_SHA"

VCPDECK_PROCD_SERVER="$ORIGIN"
VCPDECK_PROCD_PSK="$PSK"
VCPDECK_PROCD_LOCK="$DESCRIPTOR"
VCPDECK_PROCD_RUNTIME="$RUNTIME_TGZ"
export VCPDECK_PROCD_SERVER VCPDECK_PROCD_PSK VCPDECK_PROCD_LOCK VCPDECK_PROCD_RUNTIME

node "$WORK/install-client-procd.cjs" --install --staging "$STAGING" >/dev/null ||
	fail "PROCD_INSTALL_FAILED"

printf 'installed\n'
