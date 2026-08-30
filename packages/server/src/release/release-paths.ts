import { resolve } from "node:path";
import type { ReleasePlatform } from "@vcpdeck/shared";

/** Release 归档存储目录（可由环境变量覆盖）。 */
export function releasesDir(): string {
	return process.env.VCPDECK_RELEASES_DIR || "./data/releases";
}

/** Release zip 最终存储路径（按平台分开，返回绝对路径）。 */
export function releaseZipPath(
	version: string,
	platform: ReleasePlatform,
): string {
	return resolve(
		releasesDir(),
		`vcpdeck-${version}-${platform}.zip`,
	);
}
