/**
 * musl 构建输入锁定（ADR-0065）。
 *
 * 只校验本地字节与已批准锁文件，不联网、不自动选择 latest；
 * 锁文件本身就是随产物签名覆盖的 MuslReleaseTarget 描述。
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import {
	type MuslReleaseTarget,
	parseMuslReleaseTarget,
} from "@vcpdeck/shared";

/** 锁文件固定位置：与构建脚本同目录，便于仓库内审查与 diff。 */
export const MUSL_INPUT_LOCK_PATH = "scripts/build/musl-inputs.lock.json";

/**
 * 校验下载字节与锁定 SHA-256 完全一致。
 *
 * 顺序上先拒绝非法 SHA 形态，再比较摘要，避免把格式错误当作内容不匹配。
 */
export function verifyPinnedBytes(bytes: Uint8Array, sha256: string): void {
	if (!/^[a-f0-9]{64}$/.test(sha256)) {
		throw new Error("MUSL_INPUT_SHA256_INVALID");
	}
	if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
		throw new Error("MUSL_INPUT_SHA256_MISMATCH");
	}
}

/**
 * 读取并严格解析锁文件。
 *
 * 缺失即视为构建输入未获批：调用方必须让 musl 构建明确失败，不能退回 latest 或占位值。
 */
export function loadMuslInputLock(
	lockPath: string = MUSL_INPUT_LOCK_PATH,
): MuslReleaseTarget {
	let raw: string;
	try {
		raw = fs.readFileSync(lockPath, "utf8");
	} catch {
		throw new Error(`MUSL_INPUT_LOCK_MISSING: ${lockPath}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`MUSL_INPUT_LOCK_INVALID_JSON: ${lockPath}`);
	}
	return parseMuslReleaseTarget(parsed);
}
