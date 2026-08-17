/**
 * VCPDeck 快速卸载脚本：从 Launcher 应用目录移除指定版本并维护 current 指针。
 *
 * 用法：
 *   node uninstall.cjs --version=x.y.z [--app-dir=<dir>] [--yes] [--dry-run]
 *   node uninstall.cjs --current  [--app-dir=<dir>] [--yes] [--dry-run]
 *
 * 本脚本同时随发布包分发（zip 根目录）：解压 zip 后即可直接运行，无需仓库源码。
 *
 * 行为：
 *   - 删除 apps/<version> 版本目录（仅应用构件；数据库/Release/Storage 等
 *     持久数据位于版本目录之外，不受影响）；
 *   - 若 current 指向被卸载版本：重定向到剩余最高版本；无剩余版本时清空指针
 *     （Windows state.json 写 {"current":null}，Linux 删除 symlink）；
 *   - --dry-run 只预览不执行；--yes 跳过交互确认（非 TTY 环境自动执行）。
 */
const {
	existsSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} = require("node:fs");
const { homedir, platform } = require("node:os");
const { join, resolve } = require("node:path");
const { stdin, stdout } = require("node:process");
const readline = require("node:readline");

const isWin = platform() === "win32";
const VERSION_RE = /^\d+\.\d+\.\d+$/;

function fail(message) {
	throw new Error(message);
}

/** 解析参数：--version=<x.y.z> 或 --current，app-dir/sha 等；返回 { version, current, appDir, yes, dryRun } */
function parseArgs(argv) {
	const args = { appDir: join(homedir(), ".vcpdeck", "launcher") };
	for (const raw of argv) {
		const eq = raw.indexOf("=");
		const key = eq > 0 ? raw.slice(0, eq) : raw;
		const value = eq > 0 ? raw.slice(eq + 1) : "";
		switch (key) {
			case "--version":
				if (!VERSION_RE.test(value)) fail("--version 格式应为 x.y.z");
				args.version = value;
				break;
			case "--current":
				args.current = true;
				break;
			case "--app-dir":
				args.appDir = resolve(value);
				break;
			case "--yes":
				args.yes = true;
				break;
			case "--dry-run":
				args.dryRun = true;
				break;
			default:
				fail(`未知参数: ${raw}`);
		}
	}
	if (args.current && args.version) fail("--version 与 --current 只能二选一");
	if (!args.current && !args.version)
		fail("缺少 --version=<x.y.z> 或 --current");
	return args;
}

/** 当前生效版本（与 Launcher VersionStore 同语义） */
function currentVersion(appDir) {
	if (isWin) {
		try {
			const state = JSON.parse(
				readFileSync(join(appDir, "apps", "state.json"), "utf-8"),
			);
			return typeof state.current === "string" ? state.current : null;
		} catch {
			return null;
		}
	}
	// Linux/macOS：apps/current 是 symlink
	const { readlinkSync } = require("node:fs");
	try {
		const target = readlinkSync(join(appDir, "apps", "current"));
		const base = target.split(/[\\/]/).pop() ?? "";
		return VERSION_RE.test(base) ? base : null;
	} catch {
		return null;
	}
}

/** 剩余版本目录（数字排序，降序；排除指定版本） */
function remainingVersions(appDir, excludeVersion) {
	const appsDir = join(appDir, "apps");
	let entries;
	try {
		entries = readdirSync(appsDir);
	} catch {
		return [];
	}
	const num = (v) => v.split(".").map((n) => parseInt(n, 10) || 0);
	return entries
		.filter((n) => VERSION_RE.test(n) && n !== excludeVersion)
		.sort((a, b) => {
			const [aa, bb] = [num(a), num(b)];
			for (let i = 0; i < 3; i++) {
				if (aa[i] !== bb[i]) return bb[i] - aa[i];
			}
			return 0;
		});
}

/** 设置 current 指针：version 为 null 时清空（Linux 删 symlink / Windows 写 null） */
function setCurrentPointer(appDir, version) {
	const appsDir = join(appDir, "apps");
	if (isWin) {
		writeFileSync(
			join(appsDir, "state.json"),
			JSON.stringify({ current: version }, null, 2),
		);
		return;
	}
	const link = join(appsDir, "current");
	if (existsSync(link)) rmSync(link, { force: true });
	if (version) symlinkSync(version, link);
}

/**
 * 卸载指定版本：删除版本目录；若 current 指向它则重定向到剩余最高版本或清空。
 * 返回 { removedVersion, newCurrent }；dryRun 时仅返回预测结果不执行。
 */
function uninstallVersion(appDir, version, { dryRun = false } = {}) {
	const versionDir = join(appDir, "apps", version);
	if (!existsSync(versionDir))
		fail(`版本 ${version} 未安装（无目录 ${versionDir}）`);
	const cur = currentVersion(appDir);
	const newCurrent =
		cur === version ? (remainingVersions(appDir, version)[0] ?? null) : cur;
	if (dryRun) {
		return { removedVersion: version, newCurrent, dryRun: true };
	}
	rmSync(versionDir, { recursive: true, force: true });
	if (cur === version) {
		setCurrentPointer(appDir, newCurrent);
	}
	return { removedVersion: version, newCurrent, dryRun: false };
}

/** 交互确认：--yes 或非 TTY 时自动通过；否则询问 y/N */
function confirmRemoval(version, yes, dryRun) {
	if (dryRun) return true;
	if (yes || !stdin.isTTY) return true;
	return new Promise((resolve) => {
		const rl = readline.createInterface({ input: stdin, output: stdout });
		rl.question(`确认卸载 ${version} ？（应用构件将被删除；y/N) `, (answer) => {
			rl.close();
			resolve(
				answer.trim().toLowerCase() === "y" ||
					answer.trim().toLowerCase() === "yes",
			);
		});
	});
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const version = args.version ?? currentVersion(args.appDir) ?? undefined;
	if (!version) {
		fail("--current 但当前没有生效版本，请显式指定 --version=<x.y.z>");
	}
	const preview = uninstallVersion(args.appDir, version, { dryRun: true });
	console.log(
		`[uninstall] 将卸载 ${version}；${preview.newCurrent ? `current 将指向 ${preview.newCurrent}` : "current 将被清空"}`,
	);
	if (args.dryRun) {
		console.log("[uninstall] --dry-run 预览，未执行任何删除");
		return;
	}
	const confirmed = await confirmRemoval(version, args.yes, args.dryRun);
	if (!confirmed) {
		console.log("[uninstall] 已取消");
		return;
	}
	try {
		const result = uninstallVersion(args.appDir, version);
		console.log(
			`[uninstall] 已卸载版本 ${result.removedVersion}（版本目录已删除）`,
		);
		console.log(
			result.newCurrent
				? `[uninstall] current 现指向 ${result.newCurrent}`
				: "[uninstall] 无剩余版本，current 指针已清空",
		);
	} catch (e) {
		fail(
			`卸载失败: ${e instanceof Error ? e.message : String(e)}（版本目录可能被正在运行的进程占用）`,
		);
	}
}

// 供测试导入；直接运行时不带参数给出用法提示
if (require.main === module) {
	if (process.argv.length <= 2) {
		console.log(
			"用法: node uninstall.cjs --version=x.y.z [--app-dir=<dir>] [--yes] [--dry-run]",
		);
		console.log(
			"      node uninstall.cjs --current [--app-dir=<dir>] [--yes] [--dry-run]",
		);
		process.exit(1);
	}
	void main().catch((e) => {
		console.error(
			`[uninstall] 失败: ${e instanceof Error ? e.message : String(e)}`,
		);
		process.exit(1);
	});
}

module.exports = {
	parseArgs,
	currentVersion,
	remainingVersions,
	setCurrentPointer,
	uninstallVersion,
	confirmRemoval,
};
