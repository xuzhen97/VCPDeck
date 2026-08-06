import * as fs from "node:fs";
import type { DiskInfo } from "@vcpdeck/shared";

export interface MountRow {
	majorMinor: string;
	mountpoint: string;
	fstype: string;
}

/** 本地块设备文件系统白名单；overlay 覆盖容器内根文件系统。
 *  ponytail: 网络文件系统（nfs/cifs 等）不报，挂死的 NFS 会卡死 statfs；需要时改为带超时探测 */
const ALLOWED_FSTYPES = new Set([
	"ext2", "ext3", "ext4", "xfs", "btrfs", "f2fs", "bcachefs", "jfs",
	"reiserfs", "zfs", "ntfs", "ntfs3", "vfat", "exfat", "hfsplus", "overlay",
]);

/** 解析 /proc/self/mountinfo 文本；挂载点含 \040 等八进制转义，需解码 */
export function parseMountInfo(content: string): MountRow[] {
	const rows: MountRow[] = [];
	for (const line of content.split("\n")) {
		const sep = line.indexOf(" - ");
		if (sep < 0) continue;
		const head = line.slice(0, sep).split(" ");
		const tail = line.slice(sep + 3).split(" ");
		if (head.length < 5 || tail.length < 1) continue;
		rows.push({
			majorMinor: head[2],
			mountpoint: unescapeOctal(head[4]),
			fstype: tail[0],
		});
	}
	return rows;
}

function unescapeOctal(value: string): string {
	return value.replace(/\\([0-7]{3})/g, (_, oct: string) =>
		String.fromCharCode(parseInt(oct, 8)),
	);
}

/** 白名单过滤 + 按 major:minor 去重（bind mount 只保留第一个；mountinfo 父挂载在前） */
export function pickDisks(rows: MountRow[]): MountRow[] {
	const seen = new Set<string>();
	const picked: MountRow[] = [];
	for (const row of rows) {
		if (!ALLOWED_FSTYPES.has(row.fstype)) continue;
		if (seen.has(row.majorMinor)) continue;
		seen.add(row.majorMinor);
		picked.push(row);
	}
	return picked;
}

function statfsDisk(path: string, name: string): DiskInfo | null {
	try {
		const s = fs.statfsSync(path);
		const total = Number(BigInt(s.blocks) * BigInt(s.bsize));
		const free = Number(BigInt(s.bavail) * BigInt(s.bsize));
		if (total === 0) return null;
		return {
			name,
			totalMB: Math.round(total / 1024 / 1024),
			usedPercent: Math.min(Math.round(((total - free) / total) * 100), 100),
		};
	} catch {
		return null; // 无介质 / 未连接 / 无权限的盘跳过
	}
}

function collectWindowsDisks(): DiskInfo[] {
	const disks: DiskInfo[] = [];
	for (let i = 0; i < 26; i++) {
		const name = `${String.fromCharCode(65 + i)}:`; // A: - Z:
		const disk = statfsDisk(`${name}\\`, name);
		if (disk) disks.push(disk);
	}
	return disks;
}

function collectLinuxDisks(): DiskInfo[] {
	try {
		const content = fs.readFileSync("/proc/self/mountinfo", "utf-8");
		return pickDisks(parseMountInfo(content))
			.map((m) => statfsDisk(m.mountpoint, m.mountpoint))
			.filter((d): d is DiskInfo => d !== null);
	} catch {
		return [];
	}
}

/** 所有盘：Windows 遍历盘符；Linux 白名单挂载点；其他平台退化为根分区 */
export function collectDisks(): DiskInfo[] {
	if (process.platform === "win32") return collectWindowsDisks();
	if (process.platform === "linux") return collectLinuxDisks();
	const root = statfsDisk("/", "/");
	return root ? [root] : [];
}
