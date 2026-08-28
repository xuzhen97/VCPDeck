#!/usr/bin/env bash
set -euo pipefail

SERVER_ORIGIN="${1:-}"
if [[ -z "$SERVER_ORIGIN" || ! "$SERVER_ORIGIN" =~ ^https?://[^/]+$ ]]; then
  echo "[vcpdeck] 缺少或无效的 Server Origin" >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  while IFS= read -r candidate; do
    if [[ -x "$candidate" ]]; then
      NODE_BIN="$candidate"
      break
    fi
  done < <(find "$HOME/.vcpdeck/runtime/node" -type f -path '*/bin/node' 2>/dev/null | sort -V -r)
fi
[[ -n "$NODE_BIN" ]] || { echo "[vcpdeck] 找不到 Node.js；请先安装 Node.js 后重试" >&2; exit 1; }

TMP="$(mktemp "${TMPDIR:-/tmp}/vcpdeck-uninstall-client.XXXXXX.cjs")"
trap 'rm -f "$TMP"' EXIT
curl -fsSL --connect-timeout 15 --max-time 120 \
  "$SERVER_ORIGIN/api/client-installer/assets/uninstall-client.cjs" -o "$TMP"
"$NODE_BIN" "$TMP"
