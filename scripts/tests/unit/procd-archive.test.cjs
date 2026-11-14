/**
 * procd 安装器安全解压工具的单元测试（ADR-0065）。
 *
 * 现场不能依赖 unzip/busybox tar，因此 zip/tar.gz 由安装器自己解析；这里用
 * 手工构造的包证明：正常条目能落盘，绝对路径、`..` 穿越和坏包一定整包失败。
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { extractTarGz, extractZip, resolveEntry } = require("../../procd-archive.cjs");

function tempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "vcpdeck-archive-"));
}

/** 构造最小可用 zip（不压缩，CRC 记为 0；解压器不使用 CRC）。 */
function buildZip(entries) {
	const local = [];
	const central = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const data = Buffer.from(entry.content ?? "", "utf8");
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(0x0800, 6);
		header.writeUInt16LE(0, 8);
		header.writeUInt16LE(0, 10);
		header.writeUInt32LE(0, 14);
		header.writeUInt32LE(data.length, 18);
		header.writeUInt32LE(data.length, 22);
		header.writeUInt16LE(name.length, 26);
		header.writeUInt16LE(0, 28);
		local.push(header, name, data);
		const entryHeader = Buffer.alloc(46);
		entryHeader.writeUInt32LE(0x02014b50, 0);
		entryHeader.writeUInt16LE(0x031e, 4);
		entryHeader.writeUInt16LE(20, 6);
		entryHeader.writeUInt16LE(0x0800, 8);
		entryHeader.writeUInt16LE(0, 10);
		entryHeader.writeUInt32LE(0, 16);
		entryHeader.writeUInt32LE(data.length, 20);
		entryHeader.writeUInt32LE(data.length, 24);
		entryHeader.writeUInt16LE(name.length, 28);
		entryHeader.writeUInt32LE(((entry.mode ?? 0o644) << 16) >>> 0, 38);
		entryHeader.writeUInt32LE(offset, 42);
		central.push(entryHeader, name);
		offset += 30 + name.length + data.length;
	}
	const centralBuffer = Buffer.concat(central);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralBuffer.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, centralBuffer, eocd]);
}

/** 构造最小 tar 头（ustar）；校验和按规范以空格占位后再回填。 */
function tarHeader({ name, size, mode = 0o644, type = "0", linkname = "" }) {
	const header = Buffer.alloc(512);
	header.write(name, 0, 100, "utf8");
	header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
	header.write("0000000\0", 108, 8, "ascii");
	header.write("0000000\0", 116, 8, "ascii");
	header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
	header.write("00000000000\0", 136, 12, "ascii");
	header.write("        ", 148, 8, "ascii");
	header.write(type, 156, 1, "ascii");
	header.write(linkname, 157, 100, "utf8");
	header.write("ustar\0", 257, 6, "ascii");
	header.write("00", 263, 2, "ascii");
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
	return header;
}

/** 构造 tar.gz；entries.type 可取 "0"（文件）、"5"（目录）、"2"（符号链接）。 */
function buildTarGz(entries) {
	const parts = [];
	for (const entry of entries) {
		const data = Buffer.from(entry.content ?? "", "utf8");
		const size = entry.type === "2" || entry.type === "5" ? 0 : data.length;
		parts.push(
			tarHeader({
				name: entry.name,
				size,
				mode: entry.mode,
				type: entry.type,
				linkname: entry.linkname,
			}),
		);
		if (size > 0) {
			parts.push(data, Buffer.alloc((512 - (size % 512)) % 512));
		}
	}
	parts.push(Buffer.alloc(1024));
	return zlib.gzipSync(Buffer.concat(parts));
}

test("zip：按条目落盘，保持嵌套目录与内容", () => {
	const dir = tempDir();
	const zip = path.join(dir, "a.zip");
	fs.writeFileSync(
		zip,
		buildZip([
			{ name: "client/dist/index.js", content: "console.log(1)\n", mode: 0o644 },
			{ name: "client/bin/frpc", content: "binary", mode: 0o755 },
		]),
	);
	const out = path.join(dir, "out");
	extractZip(zip, out);
	assert.equal(fs.readFileSync(path.join(out, "client/dist/index.js"), "utf8"), "console.log(1)\n");
	assert.equal(fs.readFileSync(path.join(out, "client/bin/frpc"), "utf8"), "binary");
});

test("zip：绝对路径、盘符与 .. 穿越整包拒绝", () => {
	for (const name of ["/etc/passwd", "C:/windows/x", "client/../../escape.txt"]) {
		const dir = tempDir();
		const zip = path.join(dir, "bad.zip");
		fs.writeFileSync(zip, buildZip([{ name, content: "x" }]));
		assert.throws(() => extractZip(zip, path.join(dir, "out")), /ARCHIVE_ENTRY_UNSAFE/, name);
		assert.equal(fs.existsSync(path.join(dir, "out")), false, name);
	}
});

test("zip：坏包（无中央目录）稳定报 ARCHIVE_ZIP_INVALID", () => {
	const dir = tempDir();
	const zip = path.join(dir, "broken.zip");
	fs.writeFileSync(zip, "not a zip");
	assert.throws(() => extractZip(zip, path.join(dir, "out")), /ARCHIVE_ZIP_INVALID/);
});

test("tar.gz：目录、文件与符号链接均可解出", () => {
	const dir = tempDir();
	const archive = path.join(dir, "node.tar.gz");
	fs.writeFileSync(
		archive,
		buildTarGz([
			{ name: "node-v24.22.3-linux-x64-musl/", type: "5", mode: 0o755 },
			{ name: "node-v24.22.3-linux-x64-musl/bin/node", content: "ELF", mode: 0o755 },
			{
				name: "node-v24.22.3-linux-x64-musl/bin/npm",
				type: "2",
				linkname: "../lib/node_modules/npm/bin/npm-cli.js",
			},
		]),
	);
	const out = path.join(dir, "out");
	extractTarGz(archive, out);
	const bin = path.join(out, "node-v24.22.3-linux-x64-musl/bin/node");
	assert.equal(fs.readFileSync(bin, "utf8"), "ELF");
	const link = path.join(out, "node-v24.22.3-linux-x64-musl/bin/npm");
	if (process.platform !== "win32") {
		assert.equal(fs.readlinkSync(link), "../lib/node_modules/npm/bin/npm-cli.js");
	}
});

test("tar.gz：带 .. 的条目与越界符号链接都拒绝", () => {
	const dir = tempDir();
	const escapeArchive = path.join(dir, "escape.tar.gz");
	fs.writeFileSync(
		escapeArchive,
		buildTarGz([{ name: "../escape.txt", content: "x" }]),
	);
	assert.throws(
		() => extractTarGz(escapeArchive, path.join(dir, "out")),
		/ARCHIVE_ENTRY_UNSAFE/,
	);
	const link = path.join(dir, "link.tar.gz");
	fs.writeFileSync(
		link,
		buildTarGz([{ name: "bin/node", type: "2", linkname: "../../etc/passwd" }]),
	);
	assert.throws(() => extractTarGz(link, path.join(dir, "out2")), /ARCHIVE_ENTRY_UNSAFE/);
});

test("resolveEntry：只返回解压根内的路径", () => {
	const root = path.join(os.tmpdir(), "vcpdeck-root");
	assert.equal(resolveEntry(root, "a/b.txt"), path.join(root, "a/b.txt"));
	for (const name of ["", "/abs", "C:/x", "../up", "a/../../up"]) {
		assert.throws(() => resolveEntry(root, name), /ARCHIVE_ENTRY_UNSAFE/, name);
	}
});

test("zip：符号链接条目按目标建立，越界目标整包拒绝", () => {
	const dir = tempDir();
	const zip = path.join(dir, "link.zip");
	fs.writeFileSync(
		zip,
		buildZip([
			{ name: "node/bin/node", content: "ELF", mode: 0o100755 },
			{
				name: "node/bin/npm",
				content: "../lib/npm-cli.js",
				mode: 0o120777,
			},
		]),
	);
	const out = path.join(dir, "out");
	extractZip(zip, out);
	if (process.platform !== "win32") {
		assert.equal(fs.readlinkSync(path.join(out, "node/bin/npm")), "../lib/npm-cli.js");
	}
	const escapeZip = path.join(dir, "escape.zip");
	fs.writeFileSync(
		escapeZip,
		buildZip([{ name: "node/bin/x", content: "../../../etc/passwd", mode: 0o120777 }]),
	);
	assert.throws(
		() => extractZip(escapeZip, path.join(dir, "out2")),
		/ARCHIVE_ENTRY_UNSAFE/,
	);
});

test("zip：设备等不受支持的条目类型整包拒绝", () => {
	const dir = tempDir();
	const zip = path.join(dir, "device.zip");
	fs.writeFileSync(zip, buildZip([{ name: "dev/null", content: "", mode: 0o020644 }]));
	assert.throws(() => extractZip(zip, path.join(dir, "out")), /ARCHIVE_ZIP_INVALID/);
	assert.equal(fs.existsSync(path.join(dir, "out")), false);
});

test("tar.gz：硬链接按实体复制，未知类型整包拒绝", () => {
	const dir = tempDir();
	const archive = path.join(dir, "hard.tar.gz");
	fs.writeFileSync(
		archive,
		buildTarGz([
			{ name: "node/bin/node", content: "ELF", mode: 0o755 },
			{ name: "node/bin/node-hard", type: "1", linkname: "node/bin/node" },
		]),
	);
	const out = path.join(dir, "out");
	extractTarGz(archive, out);
	assert.equal(fs.readFileSync(path.join(out, "node/bin/node-hard"), "utf8"), "ELF");
	const fifo = path.join(dir, "fifo.tar.gz");
	fs.writeFileSync(fifo, buildTarGz([{ name: "node/run/fifo", type: "6" }]));
	assert.throws(() => extractTarGz(fifo, path.join(dir, "out2")), /ARCHIVE_TAR_INVALID/);
	assert.equal(fs.existsSync(path.join(dir, "out2")), false);
});
