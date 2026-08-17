/**
 * Release 构件打包（详见 docs/design/release-and-update.md 与 docs/adr/0012-bundled-release-artifacts.md）：
 *   pnpm release --version=1.2.1 [--output=dist-release/] [--node-constraint=">=24"]
 *
 * 步骤：
 *   1. 注入版本号 → 全量构建（shared/server/client）→ 多平台 frp 下载
 *   2. esbuild 将业务代码 + 纯 JS 依赖打成少量单文件（原生模块、Prisma 运行时、
 *      Pi SDK 等外部保留，staging 只安装这部分依赖）
 *   3. staging 组装：server/ 与 client/（bundle + generated + schema + 精简依赖）
 *   4. 产出 win-x64 / linux-x64 两份 zip（archiver，构建机平台无关），供分发与自动
 *      更新上传（Server 按目标机平台选择对应包）；linux frp 裸 ELF 从 .gz 内存解压
 *      直接注入 zip（规避开发机杀毒删除裸 ELF）；计算 sha256
 *   5. 恢复版本号为 0.0.0
 *
 * 注意：manifest.sha256 由服务端上传时计算并写入 Release 表（zip 内含 manifest，
 * 无法自指），此处留空；客户端校验以服务端下发的 sha256 为准。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
	createWriteStream,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { ZipArchive } from "archiver";
import { bundleServer, bundleClient } from "./bundle-apps.js";

const ROOT = resolve(__dirname, "..");
const PLATFORMS = "win-x64,linux-x64";

interface Args {
	version: string;
	output: string;
	nodeConstraint: string;
}

function parseArgs(argv: string[]): Args {
	const version = argv.find((a) => a.startsWith("--version="))?.split("=")[1];
	if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
		throw new Error("用法: pnpm release --version=<x.y.z> [--output=<dir>]");
	}
	const output =
		argv.find((a) => a.startsWith("--output="))?.split("=")[1] ??
		"dist-release";
	// 输出目录白名单：仅允许路径安全字符，防命令注入
	if (!/^[A-Za-z0-9._/\\-]+$/.test(output)) {
		throw new Error(`--output 含非法字符: ${output}`);
	}
	const nodeConstraint =
		argv.find((a) => a.startsWith("--node-constraint="))?.split("=")[1] ??
		">=24";
	if (!/^>=\d+$/.test(nodeConstraint)) {
		throw new Error(`--node-constraint 格式应为 >=数字: ${nodeConstraint}`);
	}
	return { version, output, nodeConstraint };
}

/** 以 argv 数组执行命令（无 shell 拼接）。Windows 下 pnpm/npx 等 shell 包装脚本需经 .cmd。 */
const CMD_ALIASES = new Set(["pnpm", "npx"]);

function run(argv: string[], label: string): void {
	console.log(`[pack-release] ${label}`);
	try {
		const [bin, ...rest] = argv;
		if (process.platform === "win32" && CMD_ALIASES.has(bin)) {
			// .cmd 不能被 execFile 直接 spawn，需经 cmd.exe（Node 自行转义参数）
			execFileSync("cmd.exe", ["/c", bin, ...rest], {
				cwd: ROOT,
				stdio: "inherit",
			});
		} else {
			execFileSync(bin, rest, { cwd: ROOT, stdio: "inherit" });
		}
	} catch (e) {
		throw new Error(
			`${label} 失败: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

/**
 * 发布构件外部保留的依赖（原生模块、引擎、大体积且含动态加载的 SDK 不入 bundle）。
 * 版本优先取源码 package.json 的声明；平台绑定包（构建机可能未安装目标平台）
 * 从父包 optionalDependencies 取精确版本。
 */
const EXTERNAL_DEPS: Record<"server" | "client", string[]> = {
	server: [
		"@prisma/client-runtime-utils",
		"@prisma/adapter-libsql",
		"@libsql/client",
		"@libsql/win32-x64-msvc",
		"@libsql/linux-x64-gnu",
		"prisma",
	],
	client: [
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-coding-agent",
		"@lydell/node-pty",
		"@lydell/node-pty-win32-x64",
		"@lydell/node-pty-linux-x64",
	],
};

/** 平台绑定包的父包（读取 optionalDependencies 用） */
const PLATFORM_PKG_PARENT: Record<string, string> = {
	"@libsql/win32-x64-msvc": "libsql",
	"@libsql/linux-x64-gnu": "libsql",
	"@lydell/node-pty-win32-x64": "@lydell/node-pty",
	"@lydell/node-pty-linux-x64": "@lydell/node-pty",
};

interface PkgJson {
	name?: string;
	version?: string;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
}

function readPkgJson(path: string): PkgJson {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as PkgJson;
	} catch (e) {
		throw new Error(
			`解析 ${path} 失败: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

/**
 * 从 pnpm 虚拟 store（node_modules/.pnpm）按编码目录名找已安装包的 package.json。
 * 不依赖 require 解析路径：嵌套依赖（如 @libsql/client 的 libsql）在严格隔离下
 * 无法从工作区根解析，但一定存在于 store。多个版本时取最高版本。
 */
function findStorePkgJson(name: string): PkgJson {
	const storeDir = join(ROOT, "node_modules", ".pnpm");
	const prefix = name.replace("/", "+");
	let best: { version: string; pj: PkgJson } | null = null;
	for (const d of readdirSync(storeDir)) {
		if (!d.startsWith(`${prefix}@`)) continue;
		const pjPath = join(storeDir, d, "node_modules", name, "package.json");
		if (!existsSync(pjPath)) continue;
		const pj = readPkgJson(pjPath);
		const v = pj.version ?? "0.0.0";
		if (!best || compareVersions(v, best.version) > 0) {
			best = { version: v, pj };
		}
	}
	if (!best) throw new Error(`store 中未找到已安装包: ${name}`);
	return best.pj;
}

/** 简单语义化版本比较（x.y.z[-pre]；预发布低于正式版） */
function compareVersions(a: string, b: string): number {
	const [aCore, aPre] = a.split("-");
	const [bCore, bPre] = b.split("-");
	const aParts = aCore.split(".").map(Number);
	const bParts = bCore.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const d = (aParts[i] ?? 0) - (bParts[i] ?? 0);
		if (d !== 0) return d;
	}
	if (!aPre && !bPre) return 0;
	if (!aPre) return 1;
	if (!bPre) return -1;
	return aPre < bPre ? -1 : 1;
}

function resolveExternalDeps(
	pkgName: "server" | "client",
): Record<string, string> {
	const srcPkg = readPkgJson(join(ROOT, "packages", pkgName, "package.json"));
	const deps: Record<string, string> = {};
	for (const name of EXTERNAL_DEPS[pkgName]) {
		const fromSrc = srcPkg.dependencies?.[name];
		if (fromSrc) {
			deps[name] = fromSrc;
			continue;
		}
		const parent = PLATFORM_PKG_PARENT[name];
		if (!parent) throw new Error(`无法解析依赖版本: ${name}`);
		const parentPkg = findStorePkgJson(parent);
		const spec =
			parentPkg.optionalDependencies?.[name] ?? parentPkg.dependencies?.[name];
		if (!spec) throw new Error(`${parent} 未声明平台包 ${name}`);
		deps[name] = spec;
	}
	return deps;
}

/** 组装单个构件的生产部署目录（esbuild 单文件 + frp + 外部依赖精简安装） */
async function stagePackage(
	pkgName: "server" | "client",
	stagingDir: string,
): Promise<void> {
	const pkgDir = join(ROOT, "packages", pkgName);
	const target = join(stagingDir, pkgName);
	mkdirSync(join(target, "dist"), { recursive: true });

	// 1. frp 多平台二进制（缺失直接失败；linux 平台以 .gz 包装副本为准：
	//    开发机杀毒会删除裸 ELF，裸文件由打包步骤从 .gz 内存解压注入 zip）
	cpSync(join(pkgDir, "dist", "frp"), join(target, "dist", "frp"), {
		recursive: true,
	});
	const checks: Array<[string, string[]]> =
		pkgName === "server"
			? [
					["win-x64", ["frps.exe"]],
					["linux-x64", ["frps.gz"]],
				]
			: [
					["win-x64", ["frpc.exe"]],
					["linux-x64", ["frpc.gz"]],
				];
	for (const [p, names] of checks) {
		const dir = join(target, "dist", "frp", p);
		const found = names.some((name) => existsSync(join(dir, name)));
		if (!found) {
			throw new Error(`${pkgName} 缺少 frp 二进制: ${p}/${names.join("|")}`);
		}
	}
	for (const bare of ["frpc", "frps", "frpc.bin", "frps.bin"]) {
		const p = join(target, "dist", "frp", "linux-x64", bare);
		if (existsSync(p)) rmSync(p, { force: true });
	}

	// 2. esbuild 打包（server 单文件；client 主进程 + pi/probe 两个 fork worker）
	console.log(`[pack-release] ${pkgName} esbuild 打包`);
	if (pkgName === "server") {
		await bundleServer(join(target, "dist", "main.js"));
	} else {
		await bundleClient([
			{
				entry: "packages/client/src/index.ts",
				outfile: join(target, "dist", "index.js"),
			},
			{
				entry: "packages/client/src/pi/worker.ts",
				outfile: join(target, "dist", "pi", "worker.js"),
			},
			{
				entry: "packages/client/src/pi/probe-worker.ts",
				outfile: join(target, "dist", "probe-worker.js"),
			},
		]);
	}

	// 3. server 额外文件（Prisma 运行时与 preStart 共用）
	if (pkgName === "server") {
		cpSync(join(pkgDir, "generated"), join(target, "generated"), {
			recursive: true,
		});
		cpSync(
			join(pkgDir, "prisma", "schema.prisma"),
			join(target, "schema.prisma"),
		);
		// Prisma 7 CLI 强制要求 config 文件（preStart db push 与运行时共用 DATABASE_URL）
		cpSync(
			join(pkgDir, "prisma.config.cjs"),
			join(target, "prisma.config.cjs"),
		);
	}

	// 4. 外部依赖精简安装：supportedArchitectures（pnpm 11 从 pnpm-workspace.yaml 读取）
	//    允许 Windows 构建机同时安装 linux 平台绑定包（libsql / node-pty），实现单包跨平台
	const deps = resolveExternalDeps(pkgName);
	writeFileSync(
		join(target, "package.json"),
		JSON.stringify(
			{
				name: `@vcpdeck/${pkgName}-release`,
				version: "0.0.0",
				private: true,
				dependencies: deps,
			},
			null,
			2,
		),
	);
	writeFileSync(
		join(target, "pnpm-workspace.yaml"),
		[
			"supportedArchitectures:",
			"  os: [win32, linux]",
			"  cpu: [x64]",
			// hoisted：扁平 node_modules（真实目录、无软链），保证 zip 解压后模块可解析
			"nodeLinker: hoisted",
			"",
		].join("\n"),
	);
	console.log(`[pack-release] ${pkgName} 外部依赖安装`);
	try {
		// 参数全部为固定字面量；Windows 经 cmd.exe 调 pnpm.cmd（避免 DEP0190）
		if (process.platform === "win32") {
			execFileSync(
				"cmd.exe",
				[
					"/c",
					"pnpm",
					"install",
					"--prod",
					"--ignore-scripts",
					"--prefer-offline",
				],
				{ cwd: target, stdio: "inherit" },
			);
		} else {
			execFileSync(
				"pnpm",
				["install", "--prod", "--ignore-scripts", "--prefer-offline"],
				{ cwd: target, stdio: "inherit" },
			);
		}
	} catch (e) {
		throw new Error(
			`${pkgName} 外部依赖安装失败: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

/**
 * 用 archiver 生成 zip（构建机平台无关），按平台产出两份：
 *  - win-x64 / linux-x64：仅含对应平台构件，供手动分发与自动更新上传
 *    （Server 更新流程按目标机平台选择对应包，见 ADR-0012）。
 * linux frp 裸 ELF 由 .gz 内存解压后直接追加进 zip（开发机杀毒会删除磁盘上的裸 ELF），
 * 仅 linux-x64 变体需要。
 */
type ArchiveVariant = "win-x64" | "linux-x64";

const VARIANT_EXCLUDES: Record<ArchiveVariant, string[]> = {
	"win-x64": [
		"server/dist/frp/linux-x64",
		"client/dist/frp/linux-x64",
		"server/node_modules/@libsql/linux-x64-gnu",
		"client/node_modules/@lydell/node-pty-linux-x64",
	],
	"linux-x64": [
		"server/dist/frp/win-x64",
		"client/dist/frp/win-x64",
		"server/node_modules/@libsql/win32-x64-msvc",
		"client/node_modules/@lydell/node-pty-win32-x64",
	],
};

/** 递归收集 staging 文件（正斜杠相对路径），按目录级排除列表过滤 */
function collectFiles(
	root: string,
	excludes: string[],
): Array<{ abs: string; name: string }> {
	const out: Array<{ abs: string; name: string }> = [];
	const walk = (dir: string, rel: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const abs = join(dir, entry.name);
			const relPath = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (excludes.includes(relPath)) continue;
				walk(abs, relPath);
			} else if (entry.isFile()) {
				out.push({ abs, name: relPath });
			}
		}
	};
	walk(root, "");
	return out;
}

function createArchive(
	stagingDir: string,
	version: string,
	output: string,
	variant: ArchiveVariant,
): Promise<string> {
	const archivePath = join(ROOT, output, `vcpdeck-${version}-${variant}.zip`);
	mkdirSync(join(ROOT, output), { recursive: true });
	if (existsSync(archivePath)) rmSync(archivePath, { force: true });

	const linuxElfs: Array<{ gz: string; entry: string }> =
		variant === "win-x64"
			? []
			: [
					{
						gz: join(
							stagingDir,
							"client",
							"dist",
							"frp",
							"linux-x64",
							"frpc.gz",
						),
						entry: "client/dist/frp/linux-x64/frpc",
					},
					{
						gz: join(
							stagingDir,
							"server",
							"dist",
							"frp",
							"linux-x64",
							"frps.gz",
						),
						entry: "server/dist/frp/linux-x64/frps",
					},
				];
	for (const { gz } of linuxElfs) {
		if (!existsSync(gz)) throw new Error(`缺少 gz 包装: ${gz}`);
	}

	const files = collectFiles(stagingDir, VARIANT_EXCLUDES[variant]);
	return new Promise((resolvePromise, reject) => {
		const out = createWriteStream(archivePath);
		const archive = new ZipArchive({ zlib: { level: 6 } });
		out.on("close", () => resolvePromise(archivePath));
		out.on("error", reject);
		archive.on("error", reject);
		archive.pipe(out);
		for (const f of files) archive.file(f.abs, { name: f.name });
		for (const { gz, entry } of linuxElfs) {
			// mode 0o755：zip 内记录 Unix 可执行位，Linux unzip 解压后 frpc/frps 可直接运行
			archive.append(gunzipSync(readFileSync(gz)), {
				name: entry,
				mode: 0o755,
			});
		}
		void archive.finalize();
	});
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	// staging 必须放在 workspace 之外（OS 临时目录），否则 pnpm 视其为 workspace 成员
	const stagingDir = join(tmpdir(), "vcpdeck-release-staging");
	rmSync(stagingDir, { recursive: true, force: true });
	mkdirSync(stagingDir, { recursive: true });

	try {
		// 1. 注入版本并全量构建（tsc 构建同时充当类型检查门禁）
		run(["node", "scripts/inject-version.cjs", args.version], "注入版本号");
		run(["pnpm", "--filter", "@vcpdeck/shared", "build"], "shared 构建");
		run(["pnpm", "--filter", "@vcpdeck/server", "build"], "server 构建");
		run(["pnpm", "--filter", "@vcpdeck/client", "build"], "client 构建");
		run(
			["npx", "tsx", "scripts/download-frp.ts", `--platform=${PLATFORMS}`],
			"多平台 frp 下载",
		);

		// 2. staging 组装
		await stagePackage("server", stagingDir);
		await stagePackage("client", stagingDir);
		writeFileSync(
			join(stagingDir, "manifest.json"),
			JSON.stringify(
				{
					version: args.version,
					nodeVersion: args.nodeConstraint,
					launcherMinVersion: "0.0.0",
					sha256: "",
					artifacts: {
						server: {
							dir: "server",
							entry: "dist/main.js",
							// 不依赖 PATH/.bin（shell 执行时环境无 node_modules/.bin）
							preStart: "node node_modules/prisma/build/index.js db push",
						},
						client: { dir: "client", entry: "dist/index.js" },
					},
				},
				null,
				2,
			),
		);

		// 3. 压缩（win-x64 / linux-x64 两份）+ linux frp 内存注入 + sha256
		const variants: ArchiveVariant[] = ["win-x64", "linux-x64"];
		const results: Array<{ name: string; sha256: string; platform: string }> =
			[];
		for (const variant of variants) {
			const archivePath = await createArchive(
				stagingDir,
				args.version,
				args.output,
				variant,
			);
			const sha256 = createHash("sha256")
				.update(readFileSync(archivePath))
				.digest("hex");
			results.push({ name: archivePath, sha256, platform: variant });
		}
		console.log("");
		for (const { name, sha256, platform } of results) {
			console.log(`[pack-release] 完成: ${name}`);
			console.log(`[pack-release] sha256: ${sha256}`);
			console.log(
				`[pack-release] 上传（${platform}）: curl -X POST "<server>/api/releases/upload?version=${args.version}&platform=${platform}&sha256=${sha256}" -H "content-type: application/zip" --data-binary "@${name}"`,
			);
		}
		console.log(
			"[pack-release] 或使用 CLI：vcpdeck release upload <win-x64.zip> <linux-x64.zip> --server=<url>",
		);
	} finally {
		// 4. 恢复版本号
		run(["node", "scripts/inject-version.cjs", "0.0.0"], "恢复版本号");
		rmSync(stagingDir, { recursive: true, force: true });
	}
}

void main();
