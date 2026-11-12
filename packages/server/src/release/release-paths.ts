import { resolve } from "node:path";
import type { ReleasePlatform } from "@vcpdeck/shared";

/** Release 归档存储目录（可由环境变量覆盖）。 */
export function releasesDir(): string {
	return process.env.VCPDECK_RELEASES_DIR || "./data/releases";
}

/** Release zip 最终存储路径（按平台分开，返回绝对路径）。
 * 传入 fromVersion 时定位该基线对应的增量包，缺省仍为全量包（旧行为不变）。 */
export function releaseZipPath(
	version: string,
	platform: ReleasePlatform,
	fromVersion?: string,
): string {
	return resolve(
		releasesDir(),
		fromVersion
			? `vcpdeck-${version}-${platform}-delta-${fromVersion}.zip`
			: `vcpdeck-${version}-${platform}.zip`,
	);
}
