/**
 * iStoreOS/procd 持久路径布局校验（ADR-0065）。
 *
 * 只允许三个批准路径，并且必须是真实持久文件系统：tmpfs、overlay 的上层落在
 * tmpfs、符号链接或非 root 拥有都视为不安全布局。纯函数，便于安装器与测试共用。
 */

/** 允许安装的持久路径（顺序即安装顺序）。 */
const APPROVED_PATHS = Object.freeze([
	"/opt/vcpdeck/client",
	"/opt/vcpdeck/state",
	"/etc/vcpdeck",
]);

/** 认作持久介质的文件系统类型。 */
const PERSISTENT_FS_TYPES = Object.freeze([
	"overlay",
	"ext4",
	"f2fs",
	"btrfs",
	"xfs",
]);

/**
 * 校验一个目标路径是否允许承载 root 服务的持久数据。
 *
 * 除目标本身外，还要求已存在的祖先目录不可被其他账户写入：任何一级祖先若是
 * 世界可写（例如 /opt 被 chmod 0777），root 服务落地后就能被替换。
 * @param {{path: string, fsType: string, uid: number, symlink: boolean, availableBytes: number,
 *   upperFsType?: string, ancestors: Array<{path: string, uid: number, mode: number}>}} facts 现场事实
 * @param {number} requiredBytes 该路径需要的最小可用字节数
 * @throws {Error} 不满足持久布局时抛 `PROCD_UNSAFE_LAYOUT`
 */
function validatePersistentPath(facts, requiredBytes) {
	const ancestors = Array.isArray(facts?.ancestors) ? facts.ancestors : [];
	// 祖先链必须完整走到 "/"：缺证据等于无法证明路径不可被替换，按不安全处理。
	const unsafeAncestor =
		ancestors.length === 0 ||
		ancestors.some(
			(entry) =>
				typeof entry !== "object" ||
				entry === null ||
				entry.uid !== 0 ||
				(typeof entry.mode === "number" &&
					((entry.mode & 0o002) !== 0 || (entry.mode & 0o020) !== 0)),
		) ||
		ancestors[ancestors.length - 1]?.path !== "/";
	// overlay 本身是联合挂载：必须证明上层目录落在持久介质上，否则重启丢状态。
	const unsafeOverlay =
		facts?.fsType === "overlay" &&
		(typeof facts.upperFsType !== "string" ||
			facts.upperFsType === "overlay" ||
			!PERSISTENT_FS_TYPES.includes(facts.upperFsType));
	const unsafe =
		typeof facts !== "object" ||
		facts === null ||
		!APPROVED_PATHS.includes(facts.path) ||
		!PERSISTENT_FS_TYPES.includes(facts.fsType) ||
		facts.uid !== 0 ||
		facts.symlink !== false ||
		unsafeAncestor ||
		unsafeOverlay ||
		!Number.isSafeInteger(requiredBytes) ||
		requiredBytes < 0 ||
		!Number.isSafeInteger(facts.availableBytes) ||
		facts.availableBytes < requiredBytes;
	if (unsafe) throw new Error("PROCD_UNSAFE_LAYOUT");
}

module.exports = {
	APPROVED_PATHS,
	PERSISTENT_FS_TYPES,
	validatePersistentPath,
};
