/**
 * 将 vcpdeck CLI 安装为全局命令（不经过 npm/pnpm link，避免触碰 pnpm store）。
 *
 * 用法：
 *   node scripts/link-cli.cjs                     # 默认指向仓库构建产物 packages/cli/dist/index.js
 *   node scripts/link-cli.cjs --target=<file>     # 指定 CLI 入口（如 Skill 内的 vcpdeck.cjs 单文件包）
 *   node scripts/link-cli.cjs --dir=<dir>         # 覆盖安装目录（默认 node 可执行文件所在目录）
 *
 * 写入两个垫片：
 *   vcpdeck.cmd  —— CMD / PowerShell 使用
 *   vcpdeck      —— Git Bash / MSYS 使用（无扩展名 sh 包装）
 *
 * 卸载：直接删除上述两个文件。
 */

const fs = require("node:fs");
const path = require("node:path");

function parseArgs(argv) {
	const options = { target: undefined, dir: undefined };
	for (const arg of argv) {
		if (arg.startsWith("--target=")) {
			options.target = path.resolve(arg.slice("--target=".length));
		} else if (arg.startsWith("--dir=")) {
			options.dir = path.resolve(arg.slice("--dir=".length));
		} else {
			console.error(`未知参数: ${arg}`);
			process.exit(1);
		}
	}
	return options;
}

function main() {
	const root = path.resolve(__dirname, "..");
	const options = parseArgs(process.argv.slice(2));

	const target =
		options.target ?? path.join(root, "packages", "cli", "dist", "index.js");
	if (!fs.existsSync(target)) {
		console.error(
			`[vcpdeck:link] 目标入口不存在: ${target}\n先运行 pnpm --filter @vcpdeck/cli build，或用 --target= 指定其他入口。`,
		);
		process.exit(1);
	}

	const dir =
		options.dir ?? path.dirname(process.execPath); // 默认 node.exe 所在目录（已在 PATH）
	if (!fs.existsSync(dir)) {
		console.error(`[vcpdeck:link] 安装目录不存在: ${dir}`);
		process.exit(1);
	}

	const targetNative = target.split(path.sep).join("/");
	const cmdShim = `@echo off\r\nnode "${targetNative}" %*\r\n`;
	const shShim = `#!/bin/sh\nMSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1 exec node "${targetNative}" "$@"\n`;

	const cmdPath = path.join(dir, "vcpdeck.cmd");
	const shPath = path.join(dir, "vcpdeck");
	fs.writeFileSync(cmdPath, cmdShim);
	fs.writeFileSync(shPath, shShim);
	try {
		fs.chmodSync(shPath, 0o755);
	} catch {
		/* Windows 无关紧要 */
	}

	console.log("[vcpdeck:link] 已写入:");
	console.log(`  ${cmdPath}`);
	console.log(`  ${shPath}`);
	console.log(`[vcpdeck:link] 入口: ${target}`);
	console.log(
		"[vcpdeck:link] 新开终端后运行 `vcpdeck --version` 验证；环境切换用 `vcpdeck env use <name> --global`。",
	);
	console.log(
		"[vcpdeck:link] 注意: 入口指向的文件变化会即时生效（仓库构建产物随 pnpm build 更新）。",
	);
}

main();
