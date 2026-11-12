/**
 * Launcher 侧发布构件路径预检、清单验签与硬链接组装（内容寻址增量包 Task 8）。
 *
 * 解压目录与清单都视为跨信任边界输入：先校验路径与符号链接，再逐文件按
 * sha256/size 校验后写入目标目录；delta 包缺失的文件从历史版本目录硬链接复用。
 */
import { createHash, verify } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
	canonicalReleaseManifestJson,
	isSafeReleaseFilePath,
	ReleaseArtifactErrorCode,
	type ReleaseFileEntry,
} from "@vcpdeck/shared";

/** ReleaseArtifactErrorCode 中的任一稳定错误码。 */
type ReleaseArtifactCode =
	(typeof ReleaseArtifactErrorCode)[keyof typeof ReleaseArtifactErrorCode];

/**
 * 携带稳定错误码的组装异常。
 * message 只描述失败类别，不含堆栈、密钥、签名 URL 或文件内容。
 */
class AssembleError extends Error {
	readonly code: ReleaseArtifactCode;

	constructor(code: ReleaseArtifactCode, message: string) {
		super(message);
		this.name = "AssembleError";
		this.code = code;
	}
}

/** 计算缓冲区的 sha256（64 位小写 hex）。 */
function sha256Hex(buf: Buffer): string {
	return createHash("sha256").update(buf).digest("hex");
}

/** delta 包元数据条目：允许存在于包内，但不得写入目标目录。 */
function isReleaseMetadataEntry(rel: string): boolean {
	return rel === "delta.json" || rel.endsWith(".sig");
}

interface TreeEntry {
	/** 相对解压目录的 POSIX 路径。 */
	rel: string;
	isDirectory: boolean;
	isSymlink: boolean;
}

/** 递归枚举条目；以 lstatSync 判定类型，绝不跟随符号链接。 */
function enumerateTree(root: string): TreeEntry[] {
	const out: TreeEntry[] = [];
	const walk = (dir: string, base: string): void => {
		for (const dirent of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, dirent.name);
			const rel = base ? `${base}/${dirent.name}` : dirent.name;
			const stat = lstatSync(full);
			const entry: TreeEntry = {
				rel,
				isDirectory: stat.isDirectory(),
				isSymlink: stat.isSymbolicLink(),
			};
			out.push(entry);
			if (entry.isDirectory && !entry.isSymlink) walk(full, rel);
		}
	};
	walk(root, "");
	return out;
}

/**
 * 预检解压目录：拒绝符号链接、不安全路径与非清单文件条目。
 *
 * 清单路径与枚举出的相对路径都必须通过 isSafeReleaseFilePath；文件条目必须落在
 * `new Set(files.map(f => f.path))` 白名单内。delta.json 与 *.sig 允许存在但不进
 * 目标目录；目录条目仅用于组织层级，不参与白名单比对。
 *
 * @throws AssembleError(MANIFEST_PATH_UNSAFE) 任一校验失败
 */
export function assertSafeExtractedTree(
	extractedDir: string,
	files: ReleaseFileEntry[],
): void {
	const allowed = new Set<string>();
	for (const file of files) {
		if (!isSafeReleaseFilePath(file.path)) {
			throw new AssembleError(
				ReleaseArtifactErrorCode.MANIFEST_PATH_UNSAFE,
				"清单含不安全文件路径",
			);
		}
		allowed.add(file.path);
	}

	for (const entry of enumerateTree(extractedDir)) {
		if (entry.isSymlink) {
			throw new AssembleError(
				ReleaseArtifactErrorCode.MANIFEST_PATH_UNSAFE,
				"解压目录含符号链接",
			);
		}
		if (entry.isDirectory || isReleaseMetadataEntry(entry.rel)) continue;
		if (!isSafeReleaseFilePath(entry.rel) || !allowed.has(entry.rel)) {
			throw new AssembleError(
				ReleaseArtifactErrorCode.MANIFEST_PATH_UNSAFE,
				"解压目录含非清单或不安全条目",
			);
		}
	}
}

/**
 * 校验清单的 Ed25519 签名。
 *
 * 必须与打包侧 signManifest 共用 canonicalReleaseManifestJson 的规范化字节，
 * 禁止各自拼接 JSON；非法输入或任何异常一律返回 false，不向外抛出。
 */
export function verifyManifestSignature(
	manifest: Record<string, unknown>,
	signatureBase64: string,
	publicKeyPem: string,
): boolean {
	try {
		if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
			return false;
		}
		if (typeof signatureBase64 !== "string" || signatureBase64.length === 0) {
			return false;
		}
		if (typeof publicKeyPem !== "string" || publicKeyPem.length === 0) {
			return false;
		}
		const json = canonicalReleaseManifestJson(manifest);
		return verify(
			null,
			Buffer.from(json, "utf8"),
			publicKeyPem,
			Buffer.from(signatureBase64, "base64"),
		);
	} catch {
		return false;
	}
}

/** 把清单相对路径解析到 targetDir 内，越界即拒绝。 */
function resolveWithin(targetDir: string, rel: string): string {
	const root = resolve(targetDir);
	const target = resolve(root, rel);
	if (target !== root && !target.startsWith(root + sep)) {
		throw new AssembleError(
			ReleaseArtifactErrorCode.MANIFEST_PATH_UNSAFE,
			"目标路径越界",
		);
	}
	return target;
}

/** 组装单个文件：包内复制并校验，包外从基线目录硬链接并校验。 */
function assembleOne(
	extractedDir: string,
	targetDir: string,
	baselineDir: string | null,
	file: ReleaseFileEntry,
): void {
	const target = resolveWithin(targetDir, file.path);
	mkdirSync(dirname(target), { recursive: true });

	const inPackage = join(extractedDir, file.path);
	if (existsSync(inPackage)) {
		const buf = readFileSync(inPackage);
		if (buf.length !== file.size || sha256Hex(buf) !== file.sha256) {
			throw new AssembleError(
				ReleaseArtifactErrorCode.FILE_HASH_MISMATCH,
				"包内文件校验失败",
			);
		}
		copyFileSync(inPackage, target);
	} else if (baselineDir !== null) {
		const baseline = join(baselineDir, file.path);
		if (!existsSync(baseline)) {
			throw new AssembleError(
				ReleaseArtifactErrorCode.DELTA_BASELINE_UNAVAILABLE,
				"基线文件缺失",
			);
		}
		linkSync(baseline, target);
		if (sha256Hex(readFileSync(target)) !== file.sha256) {
			throw new AssembleError(
				ReleaseArtifactErrorCode.FILE_HASH_MISMATCH,
				"基线硬链接校验失败",
			);
		}
	} else {
		throw new AssembleError(
			ReleaseArtifactErrorCode.DELTA_BASELINE_UNAVAILABLE,
			"缺少增量基线目录",
		);
	}
	chmodSync(target, file.mode);
}

/**
 * 组装目标版本目录：包内文件经校验后复制，delta 缺失文件从基线目录硬链接复用。
 *
 * 目标子目录逐级创建，并按清单 mode 显式 chmod。任一失败都会 rmSync 清理半成品
 * 目录：基线/hash 失败以对应稳定错误码冒泡，其余非预期异常统一包装为
 * ASSEMBLE_FAILED。
 *
 * @throws AssembleError 组装失败
 */
export async function assembleRelease(opts: {
	extractedDir: string;
	targetDir: string;
	baselineDir: string | null;
	files: ReleaseFileEntry[];
}): Promise<void> {
	const { extractedDir, targetDir, baselineDir, files } = opts;
	try {
		for (const file of files) {
			if (!isSafeReleaseFilePath(file.path)) {
				throw new AssembleError(
					ReleaseArtifactErrorCode.MANIFEST_PATH_UNSAFE,
					"清单含不安全文件路径",
				);
			}
		}
		mkdirSync(targetDir, { recursive: true });
		for (const file of files) {
			assembleOne(extractedDir, targetDir, baselineDir, file);
		}
	} catch (err) {
		rmSync(targetDir, { recursive: true, force: true });
		if (err instanceof AssembleError) throw err;
		throw new AssembleError(
			ReleaseArtifactErrorCode.ASSEMBLE_FAILED,
			"发布构件组装失败",
		);
	}
}
