import type { DiskInfo } from "@vcpdeck/shared";
export interface MountRow {
    majorMinor: string;
    mountpoint: string;
    fstype: string;
}
/** 解析 /proc/self/mountinfo 文本；挂载点含 \040 等八进制转义，需解码 */
export declare function parseMountInfo(content: string): MountRow[];
/** 白名单过滤 + 按 major:minor 去重（bind mount 只保留第一个；mountinfo 父挂载在前） */
export declare function pickDisks(rows: MountRow[]): MountRow[];
/** 所有盘：Windows 遍历盘符；Linux 白名单挂载点；其他平台退化为根分区 */
export declare function collectDisks(): DiskInfo[];
