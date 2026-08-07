import { readdir, access } from "node:fs/promises";
import { homedir, platform } from "node:os";

/** 发现客户端可访问的根路径（Files 与 Pi 共用） */
export async function discoverRoots(): Promise<string[]> {
	if (platform() === "win32") {
		const results = await Promise.allSettled(
			Array.from({ length: 26 }, (_, i) => {
				const drive = String.fromCharCode(65 + i) + ":\\";
				return access(drive).then(() => drive);
			}),
		);
		return results
			.filter(
				(r): r is PromiseFulfilledResult<string> => r.status === "fulfilled",
			)
			.map((r) => r.value);
	}
	// Linux / macOS
	try {
		await readdir("/");
		return ["/"];
	} catch {
		return [homedir()];
	}
}
