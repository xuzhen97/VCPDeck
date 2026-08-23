/**
 * vcpdeck CLI 远程引导安装（自包含，零依赖；目标机器只需有 Node 18+）。
 *
 * 从 GitHub raw 下载随 tag 提交的单文件 CLI 包（skills/vcpdeck/vcpdeck.cjs，
 * esbuild 打包、零 npm 依赖），写入本地 bin 目录并生成 vcpdeck 垫片。
 *
 * 用法（目标机器只需有 Node 18+ 和外网访问）：
 *   Linux / Git Bash（单命令，含三次重试与正确退出码）：
 *     node -e 'const u="https://raw.githubusercontent.com/xuzhen97/VCPDeck/main/scripts/install-cli.cjs";const g=()=>fetch(u).then(r=>{if(!r.ok)throw new Error("HTTP "+r.status);return r.text()});(async()=>{let t;for(let i=0;i<3;i++){try{t=await g();break}catch(e){if(i===2)throw e;await new Promise(r=>setTimeout(r,1500))}}eval(t)})().catch(e=>{console.error("安装失败:",String(e));process.exit(1)})' -- --tag=v0.4.0
 *   Windows PowerShell（两步形式；PS 5.1 原生参数传递会吞掉内嵌双引号，勿用单命令）：
 *     irm https://raw.githubusercontent.com/xuzhen97/VCPDeck/main/scripts/install-cli.cjs -OutFile "$env:TEMP\install-cli.cjs"; node "$env:TEMP\install-cli.cjs" --tag=v0.4.0
 *
 * 两步等价形式（先把脚本落盘再执行）：
 *   curl -fsSL <脚本URL> -o install-cli.cjs && node install-cli.cjs --tag=v0.4.0
 *   irm  <脚本URL> -OutFile install-cli.cjs ; node install-cli.cjs --tag=v0.4.0
 *
 * 注意 node -e 后接额外参数必须先写 "--" 分隔符，否则被当作 Node 自身选项。
 *
 * 参数：
 *   --tag=<tag>     源 Git tag 或分支（推荐固定版本 tag；默认 main）
 *   --repo=<owner/repo>（默认 xuzhen97/VCPDeck）
 *   --dir=<dir>     安装目录（默认 ~/.vcpdeck/bin）
 *
 * 注意：私有仓库的 raw 下载需要该机器具备访问凭据；此时可改用
 *   git clone --depth 1 --branch <tag> 后 node scripts/link-cli.cjs --target=skills/vcpdeck/vcpdeck.cjs
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function parseArgs(argv) {
	const options = { tag: "main", repo: "xuzhen97/VCPDeck", dir: undefined };
	// 兼容两种入口形态：node script.cjs --tag=… 与 node -e '<script>' --tag=…
	for (const arg of argv.filter((a) => a.startsWith("--"))) {
		if (arg.startsWith("--tag=")) options.tag = arg.slice(6);
		else if (arg.startsWith("--repo=")) options.repo = arg.slice(7);
		else if (arg.startsWith("--dir=")) options.dir = path.resolve(arg.slice(6));
		else {
			console.error(`未知参数: ${arg}`);
			process.exit(1);
		}
	}
	return options;
}

const DOWNLOAD_ATTEMPTS = 3;

/** 多源重试下载：raw 主源 + jsDelivr 镜像；404 视为致命（tag/repo 错误），网络类错误重试。 */
async function downloadResilient(repo, tag, entry, dest) {
	const mirrors = [
		{ label: "raw", url: `https://raw.githubusercontent.com/${repo}/${tag}/${entry}` },
		{ label: "jsDelivr", url: `https://cdn.jsdelivr.net/gh/${repo}@${tag}/${entry}` },
	];
	let lastError = null;
	let sawNotFound = false;
	for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
		for (const mirror of mirrors) {
			try {
				const response = await fetch(mirror.url);
				if (response.status === 404) {
					sawNotFound = true;
					throw new Error(`HTTP 404（检查 --tag/--repo 是否正确）`);
				}
				if (!response.ok) {
					throw new Error(`HTTP ${response.status}`);
				}
				const text = await response.text();
				fs.writeFileSync(dest, text);
				return { source: mirror.label, bytes: text.length };
			} catch (error) {
				lastError = error;
				console.log(
					`[vcpdeck:install] 第 ${attempt}/${DOWNLOAD_ATTEMPTS} 次尝试失败（${mirror.label}）：${error.message}`,
				);
			}
		}
		if (attempt < DOWNLOAD_ATTEMPTS && !sawNotFound) {
			await new Promise((r) => setTimeout(r, 1500));
		}
	}
	throw lastError ?? new Error("下载失败");
}

/** POSIX：自动追加到 ~/.bashrc（带标记，幂等）。 */
function pathAutoAppendPosix(dir) {
	try {
		const rc = path.join(os.homedir(), ".bashrc");
		const marker = "# vcpdeck CLI";
		const existing = fs.existsSync(rc) ? fs.readFileSync(rc, "utf8") : "";
		if (existing.includes(marker)) {
			console.log("[vcpdeck:install] ~/.bashrc 已含 vcpdeck PATH 配置。");
			return;
		}
		fs.appendFileSync(
			rc,
			`
${marker}（由 install-cli.cjs 写入）
export PATH="${dir}:$PATH"
`,
		);
		console.log(
			"[vcpdeck:install] 已追加到 ~/.bashrc；source ~/.bashrc 或重开终端生效。",
		);
	} catch {
		console.log(`[vcpdeck:install] 请手动将 ${dir} 加入 PATH。`);
	}
}
function addToUserPathWindows(dir) {
	try {
		const script = [
			"$p = [Environment]::GetEnvironmentVariable('Path','User');",
			`if ($p -notlike '*${dir}*') {`,
			`  [Environment]::SetEnvironmentVariable('Path', "$p;${dir}", 'User');`,
			"  Write-Output 'PATH-UPDATED'",
			"} else { Write-Output 'PATH-EXISTS' }",
		].join(" ");
		const out = execFileSync(
			"powershell",
			["-NoProfile", "-NonInteractive", "-Command", script],
			{ encoding: "utf8" },
		);
		return out.includes("PATH-UPDATED");
	} catch {
		return false;
	}
}

function main() {
	const options = parseArgs(process.argv);
	const dir = options.dir ?? path.join(os.homedir(), ".vcpdeck", "bin");
	const entry = "skills/vcpdeck/vcpdeck.cjs";

	fs.mkdirSync(dir, { recursive: true });
	const cliPath = path.join(dir, "vcpdeck.cjs");

	console.log(
		`[vcpdeck:install] 下载 ${options.repo}@${options.tag}（raw + jsDelivr 镜像，自动重试）`,
	);
	downloadResilient(options.repo, options.tag, entry, cliPath)
		.then(({ source, bytes }) => {
			console.log(`[vcpdeck:install] 已写入 ${cliPath}（${bytes} bytes，源: ${source}）`);

			const targetNative = cliPath.split(path.sep).join("/");
			fs.writeFileSync(
				path.join(dir, "vcpdeck.cmd"),
				`@echo off\r\nnode "${targetNative}" %*\r\n`,
			);
			const shPath = path.join(dir, "vcpdeck");
			fs.writeFileSync(shPath, `#!/bin/sh\nexec node "${targetNative}" "$@"\n`);
			try {
				fs.chmodSync(shPath, 0o755);
			} catch {
				/* Windows 无关紧要 */
			}

			// 安装即验收：直接跑一次 --version
			const version = execFileSync(process.execPath, [cliPath, "--version"], {
				encoding: "utf8",
			}).trim();
			console.log(`[vcpdeck:install] 验收通过: vcpdeck ${version}`);

			if (process.platform === "win32") {
				const updated = addToUserPathWindows(dir);
				console.log(
					updated
						? "[vcpdeck:install] 已加入用户 PATH；请重开终端使 PATH 生效。"
						: "[vcpdeck:install] PATH 已包含该目录或自动追加失败；请手动确认 PATH 含:",
				);
			} else {
				pathAutoAppendPosix(dir);
			}
			console.log("[vcpdeck:install] 完成。环境配置: vcpdeck env add/list/use。");
		})
		.catch((error) => {
			const message = String(error?.message ?? error);
			console.error(`[vcpdeck:install] ${message}`);
			if (/404/.test(message)) {
				console.error(
					"[vcpdeck:install] 未找到目标文件：请核对 --tag 与 --repo 是否正确；私有仓库请改用: git clone --depth 1 --branch <tag> 后 node scripts/link-cli.cjs --target=skills/vcpdeck/vcpdeck.cjs",
				);
			} else {
				console.error(
					"[vcpdeck:install] 多次尝试（含镜像）仍失败，通常是到 GitHub 的网络不稳定；请稍后重跑同一命令。",
				);
			}
			process.exit(1);
		});
}

main();
