/**
 * 发版打包（设计文档 §5/§11）：
 *   pnpm release --version 1.2.1 [--output dist-release/] [--node-constraint ">=24"]
 *
 * 步骤：
 *   1. 注入版本号 → 全量构建（shared/server/client）→ 多平台 frp
 *   2. staging 组装：server/ 与 client/（dist + generated + schema + 生产依赖）
 *   3. 生成 manifest + 压缩（Windows zip / Linux tar.gz）+ 计算 sha256
 *   4. 恢复版本号为 0.0.0
 *
 * 注意：manifest.sha256 由服务端上传时计算并写入 Release 表（zip 内含 manifest，
 * 无法自指），此处留空；客户端校验以服务端下发的 sha256 为准。
 */
import { execSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

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

function run(cmd: string, label: string): void {
	console.log(`[pack-release] ${label}`);
	try {
		execSync(cmd, { cwd: ROOT, stdio: "inherit" });
	} catch (e) {
		throw new Error(`${label} 失败: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** 组装单个构件的生产部署目录（dist + 额外文件 + pnpm 生产依赖） */
function stagePackage(
	pkgName: "server" | "client",
	stagingDir: string,
): void {
	const pkgDir = join(ROOT, "packages", pkgName);
	const target = join(stagingDir, pkgName);

	// 源码产物
	cpSync(join(pkgDir, "dist"), join(target, "dist"), { recursive: true });

	// frp 多平台二进制校验（缺失说明下载步骤未生效，直接失败避免产出缺构件的包；
	// linux 平台以 .gz 包装副本为准：开发机杀毒会删除裸 ELF 字节序列）
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
			throw new Error(
				`${pkgName} 缺少 frp 二进制: ${p}/${names.join("|")}`,
			);
		}
	}
	// linux 目录只保留 .gz 包装（裸 ELF 会被杀毒删除，且会由 zip 追加步骤注入）
	for (const bare of ["frpc", "frps", "frpc.bin", "frps.bin"]) {
		const p = join(target, "dist", "frp", "linux-x64", bare);
		if (existsSync(p)) rmSync(p, { force: true });
	}
	if (pkgName === "server") {
		cpSync(join(pkgDir, "generated"), join(target, "generated"), {
			recursive: true,
		});
		cpSync(
			join(pkgDir, "prisma", "schema.prisma"),
			join(target, "schema.prisma"),
		);
	}

	// 生产依赖安装（workspace:* 改写为 file: 引用，pnpm 拍平为真实文件）
	let pkgJson: { dependencies?: Record<string, string> };
	try {
		pkgJson = JSON.parse(
			readFileSync(join(pkgDir, "package.json"), "utf-8"),
		) as { dependencies?: Record<string, string> };
	} catch (e) {
		throw new Error(
			`读取 ${pkgName}/package.json 失败: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	const deps: Record<string, string> = {};
	for (const [name, spec] of Object.entries(pkgJson.dependencies ?? {})) {
		deps[name] =
			spec === "workspace:*"
				? `file:${resolve(ROOT, "packages", "shared").replace(/\\/g, "/")}`
				: spec;
	}
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
	// 参数全部为固定字面量；Windows 经 cmd.exe 调 pnpm.cmd（避免 DEP0190）
	try {
		if (process.platform === "win32") {
			execFileSync(
				"cmd.exe",
				["/c", "pnpm", "install", "--prod", "--ignore-scripts", "--prefer-offline"],
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
			`${pkgName} 生产依赖安装失败: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

function createArchive(stagingDir: string, version: string, output: string): string {
	const archiveName =
		process.platform === "win32"
			? `vcpdeck-${version}.zip`
			: `vcpdeck-${version}.tar.gz`;
	const archivePath = join(ROOT, output, archiveName);
	mkdirSync(join(ROOT, output), { recursive: true });
	if (existsSync(archivePath)) rmSync(archivePath, { force: true });

	// 压缩：Windows 用系统 bsdtar 建 zip（Compress-Archive 对 pnpm 硬链接文件报权限错）；
	// Linux 用 tar.gz。路径统一正斜杠（GNU tar 反斜杠转义问题）。
	const fwd = (p: string) => p.replace(/\\/g, "/");
	try {
		if (process.platform === "win32") {
			execFileSync(
				"C:\\Windows\\System32\\tar.exe",
				["-a", "-cf", fwd(archivePath), "-C", fwd(stagingDir), "."],
				{ stdio: "inherit" },
			);
		} else {
			execFileSync("tar", ["-czf", archivePath, "-C", stagingDir, "."], {
				stdio: "inherit",
			});
		}
	} catch (e) {
		throw new Error(
			`压缩更新包失败: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	return archivePath;
}

/**
 * 把 linux frp 二进制从 .gz 包装解压后直接追加进 zip：
 * 裸 ELF 在磁盘只存在秒级窗口（开发机杀毒来不及），且 zip 内条目与 bsdtar 前缀无关。
 * 仅 Windows zip 需要（Linux 用 tar.gz 时 .gz 直接随包，解压后裸文件保留可执行位）。
 */
function appendFrpBinariesFromGz(archivePath: string, stagingDir: string): void {
	if (process.platform !== "win32") return;
	const entries: Array<{ gz: string; entry: string }> = [
		{
			gz: join(stagingDir, "client", "dist", "frp", "linux-x64", "frpc.gz"),
			entry: "client/dist/frp/linux-x64/frpc",
		},
		{
			gz: join(stagingDir, "server", "dist", "frp", "linux-x64", "frps.gz"),
			entry: "server/dist/frp/linux-x64/frps",
		},
	];
	const fwd = (p: string) => p.replace(/\\/g, "/");
	try {
		for (const { gz, entry } of entries) {
			if (!existsSync(gz)) {
				throw new Error(`缺少 gz 包装: ${gz}`);
			}
			// 内存流解压追加：GZipStream 解压 → ZipEntry 流写入，裸 ELF 字节永不落盘
			// （开发机杀毒会删除裸 ELF 文件，PowerShell 进程启动的 1 秒窗口内都不安全）
			const script = [
				"$ErrorActionPreference = 'Stop'",
				"Add-Type -AssemblyName System.IO.Compression",
				"Add-Type -AssemblyName System.IO.Compression.FileSystem",
				`$gzs = [System.IO.File]::OpenRead('${fwd(gz)}')`,
				"$gz = New-Object System.IO.Compression.GZipStream($gzs, [System.IO.Compression.CompressionMode]::Decompress)",
				`$z = [System.IO.Compression.ZipFile]::Open('${fwd(archivePath)}', 'Update')`,
				`$e = $z.CreateEntry('${entry}')`,
				"$es = $e.Open()",
				"$gz.CopyTo($es)",
				"$gz.Dispose()",
				"$gzs.Dispose()",
				"$es.Dispose()",
				"$z.Dispose()",
			].join("; ");
			execFileSync("powershell", ["-NoProfile", "-Command", script], {
				stdio: "inherit",
			});
		}
	} catch (e) {
		throw new Error(
			`zip 追加 frp 二进制失败: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

function main(): void {
	const args = parseArgs(process.argv.slice(2));
	// staging 必须放在 workspace 之外（OS 临时目录），否则 pnpm 视其为 workspace 成员
	const stagingDir = join(tmpdir(), "vcpdeck-release-staging");
	rmSync(stagingDir, { recursive: true, force: true });
	mkdirSync(stagingDir, { recursive: true });

	try {
		// 1. 注入版本并全量构建
		run(
			`node scripts/inject-version.cjs ${args.version}`,
			"注入版本号",
		);
		run("pnpm --filter @vcpdeck/shared build", "shared 构建");
		run("pnpm --filter @vcpdeck/server build", "server 构建");
		run("pnpm --filter @vcpdeck/client build", "client 构建");
		run(
			`npx tsx scripts/download-frp.ts --platform=${PLATFORMS}`,
			"多平台 frp 下载",
		);

		// 2. staging 组装
		stagePackage("server", stagingDir);
		stagePackage("client", stagingDir);
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
							preStart: "prisma db push",
						},
						client: { dir: "client", entry: "dist/index.js" },
					},
				},
				null,
				2,
			),
		);

		// 3. 压缩 + 追加 linux frp 二进制 + sha256
		const archivePath = createArchive(stagingDir, args.version, args.output);
		appendFrpBinariesFromGz(archivePath, stagingDir);
		const sha256 = createHash("sha256")
			.update(readFileSync(archivePath))
			.digest("hex");
		console.log("");
		console.log(`[pack-release] 完成: ${archivePath}`);
		console.log(`[pack-release] sha256: ${sha256}`);
		console.log(
			`[pack-release] 上传: curl -X POST "<server>/api/releases/upload?version=${args.version}&sha256=${sha256}" -H "content-type: application/zip" --data-binary "@${archivePath}"`,
		);
	} finally {
		// 4. 恢复版本号
		run("node scripts/inject-version.cjs 0.0.0", "恢复版本号");
		rmSync(stagingDir, { recursive: true, force: true });
	}
}

main();
