/**
 * Tailnet 官方材料安装（ADR-0062）。
 *
 * 只接受计划锁定的版本与官方地址；校验和/签名不符则不执行安装。
 * 安装器本身不接收 auth key，也不启用 SSH、Exit 或 subnet 路由。
 */
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { TailnetErrorCode } from "@vcpdeck/shared";
import { TAILNET_ARTIFACTS, selectTailnetInstall } from "./platform.js";

/** 官方材料的 SHA256（计划阶段核实，来自官方同源清单）。 */
export const TAILNET_ARTIFACT_SHA256 = {
	windows: "3c41318c83c5d95d0b017b1baa08ba7c99fd5334166122bbb1931e55af99839c",
	linux: "720cbbccbfc03d8b55df72afc19e5a72e31b0f65934700aa6fa38074d4ad7bf7",
} as const;

/** 下载体积上限。 */
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;

/** 安装器可注入依赖；生产默认值见 createDefaultTailnetInstallDeps。 */
export interface TailnetInstallDeps {
	platform: NodeJS.Platform;
	arch: string;
	osRelease: Record<string, string>;
	privileged: boolean;
	pathExists: (path: string) => Promise<boolean>;
	makeTempDir: () => Promise<string>;
	removePath: (path: string) => Promise<void>;
	download: (
		url: string,
		destPath: string,
		signal: AbortSignal,
	) => Promise<void>;
	sha256File: (path: string) => Promise<string>;
	verifyWindowsSignature: (path: string) => Promise<boolean>;
	run: (
		command: string,
		args: string[],
		options: { signal: AbortSignal; timeoutMs: number },
	) => Promise<TailnetInstallRunResult>;
	placeLinuxFiles: (extractDir: string) => Promise<void>;
}

/** 安装命令结果。 */
export interface TailnetInstallRunResult {
	code: number;
	stdout: string;
}

function installError(code: TailnetErrorCode, message: string): Error {
	return Object.assign(new Error(message), { code });
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		throw installError("TAILNET_INSTALL_FAILED", "安装已取消");
	}
}

function readOsReleaseSync(): Record<string, string> {
	try {
		const text = readFileSync("/etc/os-release", "utf8");
		const result: Record<string, string> = {};
		for (const line of text.split(/\r?\n/)) {
			const match = /^([A-Z_]+)=(.*)$/.exec(line);
			if (match?.[1]) {
				result[match[1]] = (match[2] ?? "").replace(/^"|"$/g, "");
			}
		}
		return result;
	} catch {
		return {};
	}
}

function isPrivileged(): boolean {
	if (process.platform === "win32") {
		try {
			execFileSync("net", ["session"], {
				stdio: "ignore",
				windowsHide: true,
				timeout: 3_000,
			});
			return true;
		} catch {
			return false;
		}
	}
	return typeof process.getuid === "function" && process.getuid() === 0;
}

function defaultRun(
	command: string,
	args: string[],
	options: { signal: AbortSignal; timeoutMs: number },
): Promise<TailnetInstallRunResult> {
	return new Promise((resolve) => {
		execFile(
			command,
			args,
			{
				timeout: options.timeoutMs,
				signal: options.signal,
				maxBuffer: 4 * 1024 * 1024,
				windowsHide: true,
			},
			(error, stdout) => {
				if (!error) {
					resolve({ code: 0, stdout: String(stdout ?? "") });
					return;
				}
				const raw = (error as NodeJS.ErrnoException).code;
				resolve({
					code: typeof raw === "number" ? raw : 1,
					stdout: String(stdout ?? ""),
				});
			},
		);
	});
}

function downloadOfficialArtifact(
	url: string,
	destPath: string,
	signal: AbortSignal,
): Promise<void> {
	const parsed = new URL(url);
	if (parsed.protocol !== "https:" || parsed.hostname !== "pkgs.tailscale.com") {
		return Promise.reject(
			installError("TAILNET_INSTALL_FAILED", "拒绝非官方安装源"),
		);
	}
	return new Promise<void>((resolve, reject) => {
		const request = httpsGet(
			parsed,
			{
				signal,
				timeout: 120_000,
				headers: { "User-Agent": "VCPDeck-tailnet-installer" },
			},
			(response) => {
				const status = response.statusCode ?? 0;
				if (status >= 300 && status < 400) {
					response.resume();
					reject(installError("TAILNET_INSTALL_FAILED", "拒绝安装源重定向"));
					return;
				}
				if (status !== 200) {
					response.resume();
					reject(
						installError("TAILNET_INSTALL_FAILED", "安装包下载失败"),
					);
					return;
				}
				const declared = Number(response.headers["content-length"] ?? 0);
				if (declared > MAX_ARTIFACT_BYTES) {
					response.destroy();
					reject(
						installError("TAILNET_INSTALL_FAILED", "安装包超出体积上限"),
					);
					return;
				}
				const file = createWriteStream(destPath, { mode: 0o600 });
				let seen = 0;
				response.on("data", (chunk: Buffer) => {
					seen += chunk.length;
					if (seen > MAX_ARTIFACT_BYTES) {
						request.destroy();
						file.destroy();
						reject(
							installError("TAILNET_INSTALL_FAILED", "安装包超出体积上限"),
						);
					}
				});
				response.pipe(file);
				file.on("finish", () => {
					file.close((error) => {
						if (error) {
							reject(error);
						} else {
							resolve();
						}
					});
				});
				file.on("error", reject);
			},
		);
		request.on("timeout", () => {
			request.destroy(
				installError("TAILNET_INSTALL_FAILED", "安装包下载超时"),
			);
		});
		request.on("error", reject);
	});
}

function sha256File(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("end", () => resolve(hash.digest("hex")));
		stream.on("error", reject);
	});
}

function verifyWindowsSignature(path: string): Promise<boolean> {
	const literal = path.replace(/'/g, "''");
	const script = [
		`$s = Get-AuthenticodeSignature -LiteralPath '${literal}'`,
		"[pscustomobject]@{ Status = $s.Status.ToString(); Subject = $s.SignerCertificate.Subject } | ConvertTo-Json -Compress",
	].join("; ");
	return new Promise((resolve) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", script],
			{ timeout: 30_000, windowsHide: true },
			(error, stdout) => {
				if (error) {
					resolve(false);
					return;
				}
				try {
					const parsed = JSON.parse(String(stdout ?? "")) as {
						Status?: unknown;
						Subject?: unknown;
					};
					resolve(
						parsed.Status === "Valid" &&
							typeof parsed.Subject === "string" &&
							/CN=Tailscale/i.test(parsed.Subject),
					);
				} catch {
					resolve(false);
				}
			},
		);
	});
}

async function placeLinuxFiles(extractDir: string): Promise<void> {
	const entries = await fs.readdir(extractDir, { withFileTypes: true });
	const root = entries.find(
		(entry) => entry.isDirectory() && entry.name.startsWith("tailscale_"),
	);
	const base = root ? join(extractDir, root.name) : extractDir;
	await fs.mkdir("/usr/local/bin", { recursive: true });
	for (const binary of ["tailscale", "tailscaled"]) {
		const target = join("/usr/local/bin", binary);
		await fs.copyFile(join(base, binary), target);
		await fs.chmod(target, 0o755);
	}
	await fs.mkdir("/etc/systemd/system", { recursive: true });
	await fs.copyFile(
		join(base, "systemd", "tailscaled.service"),
		"/etc/systemd/system/tailscaled.service",
	);
}

/** 生产默认依赖。 */
export function createDefaultTailnetInstallDeps(): TailnetInstallDeps {
	return {
		platform: process.platform,
		arch: process.arch,
		osRelease: readOsReleaseSync(),
		privileged: isPrivileged(),
		pathExists: async (path) => {
			try {
				await fs.access(path);
				return true;
			} catch {
				return false;
			}
		},
		makeTempDir: () => fs.mkdtemp(join(tmpdir(), "vcp-tailnet-install-")),
		removePath: async (path) => {
			try {
				await fs.rm(path, {
					recursive: true,
					force: true,
					maxRetries: 3,
					retryDelay: 100,
				});
			} catch {
				// 清理失败不影响安装结论。
			}
		},
		download: downloadOfficialArtifact,
		sha256File,
		verifyWindowsSignature,
		run: defaultRun,
		placeLinuxFiles,
	};
}

async function assertNoExistingInstall(
	target: "windows-msi-x64" | "linux-static-x64-systemd",
	deps: TailnetInstallDeps,
): Promise<void> {
	const paths =
		target === "windows-msi-x64"
			? [
					"C:\\Program Files\\Tailscale\\tailscale.exe",
					"C:\\ProgramData\\Tailscale",
				]
			: [
					"/usr/bin/tailscale",
					"/usr/local/bin/tailscale",
					"/etc/systemd/system/tailscaled.service",
					"/var/lib/tailscale",
				];
	for (const path of paths) {
		if (await deps.pathExists(path)) {
			throw installError(
				"TAILNET_EXISTING_CONFIG",
				"检测到已有 Tailscale 安装或状态，拒绝覆盖",
			);
		}
	}
}

function assertSafeTarMembers(listing: string): void {
	for (const line of listing.split(/\r?\n/)) {
		if (!line.trim()) {
			continue;
		}
		const type = line.trimStart()[0];
		if (type !== "-" && type !== "d") {
			throw installError(
				"TAILNET_INSTALL_FAILED",
				"安装包包含不允许的成员类型",
			);
		}
		if (/(^|[\s/])\.\.(\/|\s|$)/.test(line)) {
			throw installError(
				"TAILNET_INSTALL_FAILED",
				"安装包包含路径穿越成员",
			);
		}
		if (/(^|\s)\//.test(line)) {
			throw installError(
				"TAILNET_INSTALL_FAILED",
				"安装包包含绝对路径成员",
			);
		}
	}
}

/**
 * 下载并安装固定版本 Tailscale。
 *
 * 只允许计划矩阵内的平台；任何不确定情况都安全失败，不做降级安装。
 */
export async function installTailnet(
	signal: AbortSignal,
	overrides: Partial<TailnetInstallDeps> = {},
): Promise<void> {
	const deps: TailnetInstallDeps = {
		...createDefaultTailnetInstallDeps(),
		...overrides,
	};
	const target = selectTailnetInstall(
		deps.platform,
		deps.arch,
		deps.osRelease,
		deps.privileged,
	);
	throwIfAborted(signal);
	await assertNoExistingInstall(target, deps);
	throwIfAborted(signal);

	const tempDir = await deps.makeTempDir();
	try {
		const url =
			target === "windows-msi-x64"
				? TAILNET_ARTIFACTS.windows
				: TAILNET_ARTIFACTS.linux;
		const artifactPath = join(tempDir, basename(new URL(url).pathname));
		await deps.download(url, artifactPath, signal);
		throwIfAborted(signal);

		const expected =
			target === "windows-msi-x64"
				? TAILNET_ARTIFACT_SHA256.windows
				: TAILNET_ARTIFACT_SHA256.linux;
		const actual = (await deps.sha256File(artifactPath)).toLowerCase();
		if (actual !== expected) {
			throw installError("TAILNET_INSTALL_FAILED", "安装包校验失败");
		}

		if (target === "windows-msi-x64") {
			if (!(await deps.verifyWindowsSignature(artifactPath))) {
				throw installError(
					"TAILNET_INSTALL_FAILED",
					"安装包签名校验失败",
				);
			}
			const result = await deps.run(
				"msiexec",
				["/i", artifactPath, "/qn", "/norestart", "TS_NOLAUNCH=1"],
				{ signal, timeoutMs: 10 * 60_000 },
			);
			throwIfAborted(signal);
			if (result.code === 3010) {
				throw installError(
					"TAILNET_INSTALL_REBOOT_REQUIRED",
					"安装完成但需要重启系统",
				);
			}
			if (result.code !== 0) {
				throw installError("TAILNET_INSTALL_FAILED", "安装程序返回失败");
			}
			return;
		}

		const listing = await deps.run("tar", ["-tvzf", artifactPath], {
			signal,
			timeoutMs: 60_000,
		});
		throwIfAborted(signal);
		if (listing.code !== 0) {
			throw installError("TAILNET_INSTALL_FAILED", "无法读取安装包目录");
		}
		assertSafeTarMembers(listing.stdout);

		const extractDir = join(tempDir, "extract");
		await fs.mkdir(extractDir, { recursive: true });
		const extracted = await deps.run(
			"tar",
			["-xzf", artifactPath, "-C", extractDir],
			{ signal, timeoutMs: 120_000 },
		);
		throwIfAborted(signal);
		if (extracted.code !== 0) {
			throw installError("TAILNET_INSTALL_FAILED", "安装包解压失败");
		}
		await deps.placeLinuxFiles(extractDir);
		throwIfAborted(signal);

		const enabled = await deps.run(
			"systemctl",
			["enable", "--now", "tailscaled"],
			{ signal, timeoutMs: 60_000 },
		);
		if (enabled.code !== 0) {
			throw installError("TAILNET_INSTALL_FAILED", "无法启用 tailscaled 服务");
		}
	} finally {
		await deps.removePath(tempDir).catch(() => undefined);
	}
}
