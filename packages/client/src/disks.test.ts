import { expect, it } from "vitest";
import { parseMountInfo, pickDisks } from "./disks.js";

const FIXTURE = [
	"23 19 0:21 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw",
	"24 19 0:22 / /sys rw,nosuid,nodev,noexec,relatime - sysfs sysfs rw",
	"26 19 0:1 / /dev rw,nosuid,relatime - devtmpfs devtmpfs rw",
	"31 25 0:23 / /run rw,nosuid,nodev,relatime - tmpfs tmpfs rw",
	"36 19 8:1 / / rw,relatime - ext4 /dev/sda1 rw",
	"38 36 8:1 /home /home rw,relatime - ext4 /dev/sda1 rw",
	"40 19 8:2 / /data rw,relatime - xfs /dev/sda2 rw",
	"45 19 0:24 / /var/lib/snapd/snaps/x1.snap ro,nodev,relatime - squashfs /dev/loop0 ro",
	"50 19 0:30 / /mnt/nas rw,relatime - nfs4 10.0.0.5:/share rw",
	"53 19 0:31 / /var/lib/docker/overlay2/abc rw,relatime - overlay overlay rw",
	"60 19 0:32 / /mnt/My\\040Disk rw,relatime - ext4 /dev/sdb1 rw",
].join("\n");

it("解析 mountinfo 文本，解码八进制转义", () => {
	const rows = parseMountInfo(FIXTURE);
	expect(rows).toHaveLength(11);
	expect(rows[4]).toEqual({ majorMinor: "8:1", mountpoint: "/", fstype: "ext4" });
	expect(rows[10]).toEqual({
		majorMinor: "0:32",
		mountpoint: "/mnt/My Disk",
		fstype: "ext4",
	});
});

it("跳过不含分隔符的行", () => {
	expect(parseMountInfo("no separator here\n")).toEqual([]);
});

it("白名单过滤并按键去重：保留根挂载，丢弃 bind、伪文件系统与网络文件系统", () => {
	const picked = pickDisks(parseMountInfo(FIXTURE));
	expect(picked.map((m) => m.mountpoint)).toEqual([
		"/",
		"/data",
		"/var/lib/docker/overlay2/abc",
		"/mnt/My Disk",
	]);
});
