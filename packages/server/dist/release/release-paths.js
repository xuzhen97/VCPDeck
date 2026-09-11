"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.releasesDir = releasesDir;
exports.releaseZipPath = releaseZipPath;
const node_path_1 = require("node:path");
/** Release 归档存储目录（可由环境变量覆盖）。 */
function releasesDir() {
    return process.env.VCPDECK_RELEASES_DIR || "./data/releases";
}
/** Release zip 最终存储路径（按平台分开，返回绝对路径）。 */
function releaseZipPath(version, platform) {
    return (0, node_path_1.resolve)(releasesDir(), `vcpdeck-${version}-${platform}.zip`);
}
