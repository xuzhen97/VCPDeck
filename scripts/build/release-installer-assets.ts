import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { extname } from "node:path";

/** 复制 Client 安装资产；Shell 脚本统一为 Linux LF。 */
export function copyInstallerAsset(source: string, target: string): void {
  if (extname(source).toLowerCase() === ".sh") {
    const normalized = readFileSync(source, "utf8").replace(/\r\n?/g, "\n");
    writeFileSync(target, normalized);
    return;
  }
  copyFileSync(source, target);
}
