"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseMountInfo = parseMountInfo;
exports.pickDisks = pickDisks;
exports.collectDisks = collectDisks;
const fs = __importStar(require("node:fs"));
/** 本地块设备文件系统白名单；overlay 覆盖容器内根文件系统。
 *  ponytail: 网络文件系统（nfs/cifs 等）不报，挂死的 NFS 会卡死 statfs；需要时改为带超时探测 */
const ALLOWED_FSTYPES = new Set([
    "ext2", "ext3", "ext4", "xfs", "btrfs", "f2fs", "bcachefs", "jfs",
    "reiserfs", "zfs", "ntfs", "ntfs3", "vfat", "exfat", "hfsplus", "overlay",
]);
/** 解析 /proc/self/mountinfo 文本；挂载点含 \040 等八进制转义，需解码 */
function parseMountInfo(content) {
    const rows = [];
    for (const line of content.split("\n")) {
        const sep = line.indexOf(" - ");
        if (sep < 0)
            continue;
        const head = line.slice(0, sep).split(" ");
        const tail = line.slice(sep + 3).split(" ");
        if (head.length < 5 || tail.length < 1)
            continue;
        rows.push({
            majorMinor: head[2],
            mountpoint: unescapeOctal(head[4]),
            fstype: tail[0],
        });
    }
    return rows;
}
function unescapeOctal(value) {
    return value.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}
/** 白名单过滤 + 按 major:minor 去重（bind mount 只保留第一个；mountinfo 父挂载在前） */
function pickDisks(rows) {
    const seen = new Set();
    const picked = [];
    for (const row of rows) {
        if (!ALLOWED_FSTYPES.has(row.fstype))
            continue;
        if (seen.has(row.majorMinor))
            continue;
        seen.add(row.majorMinor);
        picked.push(row);
    }
    return picked;
}
function statfsDisk(path, name) {
    try {
        const s = fs.statfsSync(path);
        const total = Number(BigInt(s.blocks) * BigInt(s.bsize));
        const free = Number(BigInt(s.bavail) * BigInt(s.bsize));
        if (total === 0)
            return null;
        return {
            name,
            totalMB: Math.round(total / 1024 / 1024),
            usedPercent: Math.min(Math.round(((total - free) / total) * 100), 100),
        };
    }
    catch {
        return null; // 无介质 / 未连接 / 无权限的盘跳过
    }
}
function collectWindowsDisks() {
    const disks = [];
    for (let i = 0; i < 26; i++) {
        const name = `${String.fromCharCode(65 + i)}:`; // A: - Z:
        const disk = statfsDisk(`${name}\\`, name);
        if (disk)
            disks.push(disk);
    }
    return disks;
}
function collectLinuxDisks() {
    try {
        const content = fs.readFileSync("/proc/self/mountinfo", "utf-8");
        return pickDisks(parseMountInfo(content))
            .map((m) => statfsDisk(m.mountpoint, m.mountpoint))
            .filter((d) => d !== null);
    }
    catch {
        return [];
    }
}
/** 所有盘：Windows 遍历盘符；Linux 白名单挂载点；其他平台退化为根分区 */
function collectDisks() {
    if (process.platform === "win32")
        return collectWindowsDisks();
    if (process.platform === "linux")
        return collectLinuxDisks();
    const root = statfsDisk("/", "/");
    return root ? [root] : [];
}
