#!/usr/bin/env bash
# 在已批准的 musl x64 构建环境重建 pty.node 并注入 staging（ADR-0065）。
#
# 约束：
#  - 只处理 linux-x64-musl staging；旧平台 pty.node 由 npm 平台包自带，禁止覆盖。
#  - 运行时与原生源码都按固定版本、固定 SHA-256 下载，不联网取 latest。
#  - 源码取上游 node-pty（编译 src/unix/pty.cc），不使用 @lydell 分发包的空壳目录。
#  - pty.node 必须用 musl 工具链编译，ELF 不得依赖 GLIBC / libstdc++ / libgcc_s；
#    必须跑真实 spawn/IO/resize/exit。任一前置缺失都以非零退出，绝不用 glibc 二进制顶替。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

STAGING="${VCPDECK_MUSL_STAGING:-}"
LOCK_FILE="${SCRIPT_DIR}/musl-inputs.lock.json"
CACHE_DIR="${VCPDECK_MUSL_CACHE:-${TMPDIR:-/tmp}/vcpdeck-musl-pty}"
CXX_BIN="${MUSL_CXX:-musl-g++}"
READELF_BIN="${READELF:-readelf}"
NODE_BIN="${VCPDECK_MUSL_NODE:-}"

# 上游 node-pty 与本机构建所需头文件；版本与 @lydell/node-pty@1.2.0-beta.15 一致。
NODE_PTY_VERSION="1.2.0-beta.15"
NODE_PTY_URL="https://registry.npmjs.org/node-pty/-/node-pty-${NODE_PTY_VERSION}.tgz"
NODE_PTY_SHA="114ac80c3fe075eff76217a4122d135576582695f49c03a5da3835cdfc2f89c5"
NODE_ADDON_API_VERSION="7.1.1"
NODE_ADDON_API_URL="https://registry.npmjs.org/node-addon-api/-/node-addon-api-${NODE_ADDON_API_VERSION}.tgz"
NODE_ADDON_API_SHA="b10455d15a977c0cd17a1cb0eb679e03d939f8ef8d4302eb33e1f78dacc71f82"

usage() {
	cat <<'USAGE'
用法: build-musl-pty.sh --staging <发布 staging 目录> [选项]

  --staging <dir>   必填；pack-release 生成的 staging 根（包含 client/）
  --lock <file>     锁文件，默认 scripts/build/musl-inputs.lock.json
  --cache <dir>     下载与解包缓存，默认 $TMPDIR/vcpdeck-musl-pty
  --cxx <bin>       musl C++ 编译器，默认 musl-g++（或 $MUSL_CXX；Alpine 原生 g++ 也可）
  --node <bin>      musl Node 可执行文件，用于真实 PTY 冒烟（或 $VCPDECK_MUSL_NODE）
USAGE
}

fail() {
	echo "[build-musl-pty] $1" >&2
	exit 1
}

while [ $# -gt 0 ]; do
	case "$1" in
		--staging) STAGING="${2:-}"; shift 2 ;;
		--lock) LOCK_FILE="${2:-}"; shift 2 ;;
		--cache) CACHE_DIR="${2:-}"; shift 2 ;;
		--cxx) CXX_BIN="${2:-}"; shift 2 ;;
		--node) NODE_BIN="${2:-}"; shift 2 ;;
		-h|--help) usage; exit 0 ;;
		*) fail "未知参数: $1" ;;
	esac
done

[ -n "${STAGING}" ] || fail "缺少 --staging：musl PTY 必须注入明确的发布 staging"
[ -d "${STAGING}/client" ] || fail "staging 缺少 client/：${STAGING}"
[ -f "${LOCK_FILE}" ] || fail "缺少锁文件：${LOCK_FILE}（musl 构建输入未获批）"
command -v node >/dev/null 2>&1 || fail "缺少 node，无法读取锁文件"
command -v curl >/dev/null 2>&1 || fail "缺少 curl"
command -v tar >/dev/null 2>&1 || fail "缺少 tar"
command -v sha256sum >/dev/null 2>&1 || fail "缺少 sha256sum"
command -v "${CXX_BIN}" >/dev/null 2>&1 || fail "缺少 musl C++ 编译器: ${CXX_BIN}"
command -v "${READELF_BIN}" >/dev/null 2>&1 || fail "缺少 readelf: ${READELF_BIN}"
[ -n "${NODE_BIN}" ] || fail "缺少 musl Node 可执行文件（--node）：无法完成真实 PTY 冒烟"
[ -x "${NODE_BIN}" ] || fail "musl Node 不可执行: ${NODE_BIN}"
"${NODE_BIN}" -e 'if (process.report?.getReport?.().header?.glibcVersionRuntime) process.exit(1)' \
	|| fail "MUSL_NODE_REQUIRED：--node 不是 musl 运行时"

read -r VERSION URL SHA256 <<EOF
$(node -e '
const fs = require("node:fs");
const raw = fs.readFileSync(process.argv[1], "utf8");
let target;
try {
	target = JSON.parse(raw);
} catch {
	console.error("MUSL_INPUT_LOCK_INVALID_JSON");
	process.exit(1);
}
if (target?.schema !== 1 || target?.platform !== "linux-x64-musl" || target?.role !== "client") {
	console.error("MUSL_INPUT_LOCK_UNSUPPORTED_TARGET");
	process.exit(1);
}
const runtime = target.runtime ?? {};
if (typeof runtime.version !== "string" || !/^24\.\d+\.\d+$/.test(runtime.version)) {
	console.error("MUSL_INPUT_LOCK_BAD_VERSION");
	process.exit(1);
}
if (typeof runtime.url !== "string" || !/^https:\/\/(?:nodejs\.org|unofficial-builds\.nodejs\.org)\//.test(runtime.url)) {
	console.error("MUSL_INPUT_LOCK_BAD_URL");
	process.exit(1);
}
if (typeof runtime.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(runtime.sha256)) {
	console.error("MUSL_INPUT_LOCK_BAD_SHA256");
	process.exit(1);
}
process.stdout.write(`${runtime.version} ${runtime.url} ${runtime.sha256}\n`);
' "${LOCK_FILE}")
EOF
[ -n "${VERSION}" ] || fail "锁文件解析失败：${LOCK_FILE}"

PLATFORM_DIR="${STAGING}/client/node_modules/@lydell/node-pty-linux-x64"
PREBUILD_DIR="${PLATFORM_DIR}/prebuilds/linux-x64"
TARGET_PTY="${PREBUILD_DIR}/pty.node"
[ -d "${PLATFORM_DIR}" ] || fail "staging 未安装 @lydell/node-pty-linux-x64：${PLATFORM_DIR}"
[ -f "${PLATFORM_DIR}/lib/index.js" ] || fail "staging 平台包缺少 lib/index.js：${PLATFORM_DIR}"

mkdir -p "${CACHE_DIR}"

fetch_pinned() {
	url="$1"
	sha="$2"
	tarball="$3"
	if [ ! -f "${tarball}" ]; then
		echo "[build-musl-pty] 下载 $(basename "${tarball}")"
		curl -fL --proto '=https' --tlsv1.2 -o "${tarball}" "${url}"
	fi
	actual="$(sha256sum "${tarball}" | awk '{print $1}')"
	[ "${actual}" = "${sha}" ] || fail "MUSL_INPUT_SHA256_MISMATCH：期望 ${sha}，实际 ${actual}"
}

RUNTIME_TARBALL="${CACHE_DIR}/node-v${VERSION}-linux-x64-musl.tar.gz"
fetch_pinned "${URL}" "${SHA256}" "${RUNTIME_TARBALL}"

PTY_TARBALL="${CACHE_DIR}/node-pty-${NODE_PTY_VERSION}.tgz"
fetch_pinned "${NODE_PTY_URL}" "${NODE_PTY_SHA}" "${PTY_TARBALL}"
ADDON_TARBALL="${CACHE_DIR}/node-addon-api-${NODE_ADDON_API_VERSION}.tgz"
fetch_pinned "${NODE_ADDON_API_URL}" "${NODE_ADDON_API_SHA}" "${ADDON_TARBALL}"

HEADERS_DIR="${CACHE_DIR}/node-v${VERSION}-linux-x64-musl/include/node"
if [ ! -f "${HEADERS_DIR}/node.h" ]; then
	echo "[build-musl-pty] 解包 Node headers"
	tar -xzf "${RUNTIME_TARBALL}" -C "${CACHE_DIR}" "node-v${VERSION}-linux-x64-musl/include/node"
fi
[ -f "${HEADERS_DIR}/node.h" ] || fail "解包后仍缺少 node.h：${HEADERS_DIR}"

PTY_SRC_DIR="${CACHE_DIR}/node-pty-src"
ADDON_SRC_DIR="${CACHE_DIR}/node-addon-api-src"
rm -rf "${PTY_SRC_DIR}" "${ADDON_SRC_DIR}"
mkdir -p "${PTY_SRC_DIR}" "${ADDON_SRC_DIR}"
tar -xzf "${PTY_TARBALL}" -C "${PTY_SRC_DIR}"
tar -xzf "${ADDON_TARBALL}" -C "${ADDON_SRC_DIR}"
[ -f "${PTY_SRC_DIR}/package/src/unix/pty.cc" ] \
	|| fail "node-pty 源码缺少 src/unix/pty.cc：${PTY_SRC_DIR}"
[ -f "${ADDON_SRC_DIR}/package/napi.h" ] \
	|| fail "node-addon-api 缺少 napi.h：${ADDON_SRC_DIR}"

OUT="${CACHE_DIR}/pty.node"
echo "[build-musl-pty] 编译 pty.node（${CXX_BIN}）"
"${CXX_BIN}" -shared -fPIC -O2 -std=c++17 -DNDEBUG -DNAPI_CPP_EXCEPTIONS \
	-static-libstdc++ -static-libgcc -pthread \
	-I"${HEADERS_DIR}" \
	-I"${ADDON_SRC_DIR}/package" \
	-I"${PTY_SRC_DIR}/package/src" \
	-I"${PTY_SRC_DIR}/package/src/unix" \
	"${PTY_SRC_DIR}/package/src/unix/pty.cc" \
	-o "${OUT}"

if "${READELF_BIN}" -d "${OUT}" | grep -E 'NEEDED.*(GLIBC|libstdc\+\+|libgcc_s)' >/dev/null 2>&1; then
	fail "MUSL_PTY_GLIBC_LINKED：pty.node 仍依赖 GLIBC/libstdc++/libgcc_s，禁止注入"
fi

mkdir -p "${PREBUILD_DIR}"
cp "${OUT}" "${TARGET_PTY}"
chmod 0755 "${TARGET_PTY}"

echo "[build-musl-pty] 真实 PTY 冒烟（spawn / IO / resize / exit）"
SMOKE_DIR="$(mktemp -d)"
trap 'rm -rf "${SMOKE_DIR}"' EXIT
cat >"${SMOKE_DIR}/smoke.cjs" <<'SMOKE'
const pty = require(process.argv[2]);
const proc = pty.spawn("/bin/sh", ["-c", "printf ready; sleep 0.2; exit 7"], {
	name: "xterm-256color",
	cols: 80,
	rows: 24,
	env: { TERM: "xterm-256color", PATH: "/usr/bin:/bin" },
});
let output = "";
let sawExit = false;
proc.onData((chunk) => {
	output += chunk;
	if (output.includes("ready") && proc.cols === 80) proc.resize(100, 30);
});
proc.onExit(({ exitCode }) => {
	sawExit = true;
	if (exitCode !== 7) {
		console.error(`PTY_SMOKE_BAD_EXIT:${exitCode}`);
		process.exit(1);
	}
	if (proc.cols !== 100 || proc.rows !== 30) {
		console.error(`PTY_SMOKE_RESIZE_LOST:${proc.cols}x${proc.rows}`);
		process.exit(1);
	}
	if (!output.includes("ready")) {
		console.error("PTY_SMOKE_NO_OUTPUT");
		process.exit(1);
	}
	process.exit(0);
});
setTimeout(() => {
	if (!sawExit) {
		console.error("PTY_SMOKE_TIMEOUT");
		process.exit(1);
	}
}, 5000);
SMOKE
"${NODE_BIN}" "${SMOKE_DIR}/smoke.cjs" "${PLATFORM_DIR}"

PTY_SHA="$(sha256sum "${TARGET_PTY}" | awk '{print $1}')"
NODE_ABI="$("${NODE_BIN}" -p 'process.versions.modules')"
NODE_VERSION="$("${NODE_BIN}" -p 'process.versions.node')"
CXX_VERSION="$("${CXX_BIN}" --version | head -n 1)"
cat >"${PREBUILD_DIR}/build-meta.json" <<META
{
  "schema": 1,
  "platform": "linux-x64-musl",
  "role": "client",
  "runtime": { "version": "${VERSION}", "sha256": "${SHA256}" },
  "node": { "version": "${NODE_VERSION}", "abi": "${NODE_ABI}" },
  "compiler": "${CXX_VERSION}",
  "source": "node-pty@${NODE_PTY_VERSION}",
  "ptySha256": "${PTY_SHA}"
}
META

echo "[build-musl-pty] 完成：${TARGET_PTY} sha256=${PTY_SHA}"
