/**
 * iStoreOS procd 安装器的安全解压工具（纯 JS，无外部命令依赖）。
 *
 * 设计要点：
 * - 只接受相对路径，拒绝绝对路径、盘符和 `..` 穿越，任何一条不合法就整包失败；
 * - zip 以中央目录为权威（条目数、压缩后大小），不信任本地头；
 * - tar.gz 支持 GNU longname/pax path 与符号链接，符号链接目标也必须落在解压根内；
 * - 不执行、不加载包内任何内容，只落盘。
 */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const UNSAFE_ENTRY = "ARCHIVE_ENTRY_UNSAFE";
const ZIP_INVALID = "ARCHIVE_ZIP_INVALID";
const TAR_INVALID = "ARCHIVE_TAR_INVALID";

/** 把包内条目名解析为解压根内的绝对路径；越界或绝对路径直接拒绝。 */
function resolveEntry(root, name) {
	const raw = typeof name === "string" ? name : "";
	const normalized = raw.replace(/\\/g, "/");
	if (
		!normalized ||
		normalized.startsWith("/") ||
		/^[A-Za-z]:/.test(normalized)
	) {
		throw new Error(`${UNSAFE_ENTRY}: ${raw}`);
	}
	const base = path.resolve(root);
	const target = path.resolve(base, normalized);
	const relative = path.relative(base, target);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`${UNSAFE_ENTRY}: ${raw}`);
	}
	return target;
}

/** 写入普通文件并尽量保留权限位；Windows 上 chmod 受限时忽略。 */
function writeFile(target, content, mode) {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content, { mode });
	try {
		fs.chmodSync(target, mode);
	} catch {
		// Windows 无 POSIX 权限模型；解压内容不依赖权限位。
	}
}

/** 建立符号链接；相对目标按链接所在目录解析，且结果必须仍在解压根内。 */
function linkFile(root, target, linkTarget) {
	if (linkTarget.startsWith("/") || /^[A-Za-z]:/.test(linkTarget)) {
		throw new Error(`${UNSAFE_ENTRY}: ${linkTarget}`);
	}
	const base = path.resolve(root);
	const resolved = path.resolve(path.dirname(target), linkTarget);
	const relative = path.relative(base, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`${UNSAFE_ENTRY}: ${linkTarget}`);
	}
	fs.mkdirSync(path.dirname(target), { recursive: true });
	try {
		fs.symlinkSync(linkTarget, target);
	} catch (error) {
		if (error && error.code === "EEXIST") return;
		// 只有在缺少符号链接权限的平台上才降级；其他错误不能被吞掉，
		// 否则安全校验会误以为链接已建立。
		if (
			process.platform === "win32" &&
			error &&
			(error.code === "EPERM" || error.code === "EACCES" || error.code === "ENOSYS")
		) {
			return;
		}
		throw error;
	}
}

/** 找到 zip 中央目录结束记录（EOCD），必须位于文件末尾 64 KiB 内。 */
function findEndOfCentralDirectory(buffer) {
	const min = Math.max(0, buffer.length - 22 - 65535);
	for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
		if (offset >= 0 && buffer.readUInt32LE(offset) === 0x06054b50) return offset;
	}
	throw new Error(ZIP_INVALID);
}

/**
 * 安全解压 zip 到 destDir。
 * @param {string} zipPath
 * @param {string} destDir
 */
function extractZip(zipPath, destDir) {
	const buffer = fs.readFileSync(zipPath);
	const eocd = findEndOfCentralDirectory(buffer);
	const total = buffer.readUInt16LE(eocd + 10);
	let offset = buffer.readUInt32LE(eocd + 16);
	for (let index = 0; index < total; index += 1) {
		if (
			offset + 46 > buffer.length ||
			buffer.readUInt32LE(offset) !== 0x02014b50
		) {
			throw new Error(ZIP_INVALID);
		}
		const method = buffer.readUInt16LE(offset + 10);
		const compressedSize = buffer.readUInt32LE(offset + 20);
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const externalAttributes = buffer.readUInt32LE(offset + 38);
		const localOffset = buffer.readUInt32LE(offset + 42);
		const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
		offset += 46 + nameLength + extraLength + commentLength;
		if (name.endsWith("/")) {
			fs.mkdirSync(resolveEntry(destDir, name), { recursive: true });
			continue;
		}
		const target = resolveEntry(destDir, name);
		const localNameLength = buffer.readUInt16LE(localOffset + 26);
		const localExtraLength = buffer.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		const raw = buffer.subarray(dataStart, dataStart + compressedSize);
		let content;
		if (method === 0) content = raw;
		else if (method === 8) content = zlib.inflateRawSync(raw);
		else throw new Error(`${ZIP_INVALID}: method ${method}`);
		const entryType = (externalAttributes >>> 16) & 0o170000;
		if (entryType === 0o120000) {
			const linkTarget = content.toString("utf8").trim();
			if (!linkTarget) throw new Error(`${ZIP_INVALID}: ${name} 符号链接目标为空`);
			linkFile(destDir, target, linkTarget);
			continue;
		}
		if (entryType !== 0 && entryType !== 0o100000) {
			throw new Error(`${ZIP_INVALID}: ${name} 条目类型不受支持`);
		}
		const mode = ((externalAttributes >>> 16) & 0o777) || 0o644;
		writeFile(target, content, mode);
	}
}

/** 按 512 字节块解析 tar，支持 GNU longname/pax 与普通目录、文件、符号链接。 */
function parseTar(buffer, destDir) {
	const root = path.resolve(destDir);
	let offset = 0;
	let pendingPath = null;
	let pendingLink = null;
	while (offset + 512 <= buffer.length) {
		const header = buffer.subarray(offset, offset + 512);
		offset += 512;
		if (header.every((byte) => byte === 0)) break;
		const sizeField = header
			.toString("ascii", 124, 136)
			.replace(/\0/g, "")
			.trim();
		const size = sizeField ? Number.parseInt(sizeField, 8) : 0;
		if (!Number.isSafeInteger(size) || size < 0) throw new Error(TAR_INVALID);
		const modeField = header
			.toString("ascii", 100, 108)
			.replace(/\0/g, "")
			.trim();
		const mode = modeField ? Number.parseInt(modeField, 8) : 0o644;
		const type = String.fromCharCode(header[156] || 48);
		const headerLink = header.toString("utf8", 157, 257).replace(/\0.*$/, "");
		let name = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
		const prefix = header.toString("utf8", 345, 500).replace(/\0.*$/, "");
		if (prefix && type !== "x") name = `${prefix}/${name}`;
		const data = buffer.subarray(offset, offset + size);
		offset += Math.ceil(size / 512) * 512;
		if (type === "x") {
			const match = /path=([^\n\0]+)/.exec(data.toString("utf8"));
			if (match) pendingPath = match[1];
			continue;
		}
		if (type === "L") {
			pendingPath = data.toString("utf8").replace(/\0.*$/, "");
			continue;
		}
		if (type === "K") {
			pendingLink = data.toString("utf8").replace(/\0.*$/, "");
			continue;
		}
		if (pendingPath) {
			name = pendingPath;
			pendingPath = null;
		}
		if (!name) continue;
		if (type === "5") {
			fs.mkdirSync(resolveEntry(root, name), { recursive: true });
			continue;
		}
		if (type === "0" || type === "\0" || type === "7") {
			writeFile(resolveEntry(root, name), data, mode & 0o777);
			continue;
		}
		if (type === "1") {
			const linkTarget = (pendingLink ?? headerLink).trim();
			pendingLink = null;
			if (!linkTarget) throw new Error(`${TAR_INVALID}: ${name} 硬链接目标为空`);
			const source = resolveEntry(root, linkTarget);
			const target = resolveEntry(root, name);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.copyFileSync(source, target);
			continue;
		}
		if (type === "2") {
			const linkTarget = (pendingLink ?? headerLink).trim();
			pendingLink = null;
			if (!linkTarget) throw new Error(TAR_INVALID);
			linkFile(root, resolveEntry(root, name), linkTarget);
			continue;
		}
		throw new Error(`${TAR_INVALID}: ${name} 条目类型 ${type} 不受支持`);
	}
}

/**
 * 安全解压 tar.gz 到 destDir。
 * @param {string} archivePath
 * @param {string} destDir
 */
function extractTarGz(archivePath, destDir) {
	parseTar(zlib.gunzipSync(fs.readFileSync(archivePath)), destDir);
}

module.exports = { extractTarGz, extractZip, resolveEntry };
