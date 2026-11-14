/**
 * musl Client 构件的角色根过滤（ADR-0065）。
 *
 * musl 包只服务 iStoreOS/procd 上的 Client：允许 Launcher、Client 与安装材料三个根；
 * Server、Prisma、Windows 二进制、frps 与平台绑定包一律不入包。
 */
export function includeInMuslClientArchive(relativePath: string): boolean {
	const normalized = relativePath.replaceAll("\\", "/");
	if (normalized.length === 0) return false;
	// 绝对路径与目录穿越一律拒绝，避免把 staging 之外的文件带进签名清单。
	if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return false;
	const segments = normalized.split("/");
	if (segments.includes("..") || segments.includes(".")) return false;
	// Windows 可执行/调试产物与 frps（Server 侧 FRP）不属于 Client 包。
	if (/\.(exe|dll|pdb)$/i.test(normalized)) return false;
	const last = segments[segments.length - 1];
	if (last === "frps" || last === "frps.gz") return false;
	// frpc 以解压后的裸 ELF 注入；.gz 包装不再重复入包。
	if (last === "frpc.gz" && normalized.includes("/frp/")) return false;
	// 平台绑定依赖：musl 只保留 linux-x64 的 JS wrapper 与注入后的 pty.node。
	if (
		segments.some(
			(segment) =>
				segment === "win32" ||
				segment === "win-x64" ||
				segment.endsWith("-win32-x64") ||
				segment.endsWith("-win32-arm64"),
		)
	) {
		return false;
	}
	const root = segments[0];
	return root === "client" || root === "launcher" || root === "installers";
}
