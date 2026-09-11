import type { ReleasePlatform } from "@vcpdeck/shared";
/** Release 归档存储目录（可由环境变量覆盖）。 */
export declare function releasesDir(): string;
/** Release zip 最终存储路径（按平台分开，返回绝对路径）。 */
export declare function releaseZipPath(version: string, platform: ReleasePlatform): string;
