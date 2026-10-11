/**
 * Pi 扩展资源的**集中选择输入**（ADR-0042 决策 2）。
 *
 * 这份清单是 dev 与 release 构建的共同事实来源：新增社区扩展只改这里，
 * 不允许在 `build-dev-pi-bundle.ts` 与 `pack-release.ts` 各自维护一份资源清单，
 * 否则会出现「dev 有、release 没有」的静默漂移。
 *
 * 约束：
 * - 社区包必须固定到精确版本，并在仓库内保留许可原文（见 `licenses/`）；
 * - 一个 source 对应一个 extension 资源；同一包的多入口选择属于后续设计，本期拒绝；
 * - 这里只描述「构建期如何取到已审查的扩展源码」，不代表运行期可以动态安装。
 */

/** 自有扩展：源码在仓库内，直接按入口打包。 */
export interface LocalPiExtensionSource {
	kind: "local";
	/** Bundle 资源 ID（小写点分，需匹配 shared 的 manifest 校验）。 */
	id: string;
	/** Bundle 资源版本；自有资源由维护者显式维护。 */
	version: string;
	/** 相对仓库根的入口源码路径。 */
	entry: string;
	/**
	 * 可选：许可原文路径（相对仓库根或绝对路径），随 Bundle 复制到 `licenses/`。
	 *
	 * 第三方源码被 **vendor 进仓库**（而不是作为已安装的 npm 包引用）时必须提供：
	 * MIT 等许可要求保留版权声明，而 Bundle 产物是编译后的单文件，原始声明已不可见。
	 * 自有代码不需要此项。
	 */
	licenseFile?: string;
}

/** 社区扩展：来自已安装的固定版本标准 Pi 包。 */
export interface PackagePiExtensionSource {
	kind: "package";
	/** Bundle 资源 ID。 */
	id: string;
	/** npm 包名。 */
	packageName: string;
	/** 精确版本；与已安装包的实际版本不符时构建失败。 */
	version: string;
	/** 相对仓库根的许可原文路径，随 Bundle 复制。 */
	licenseFile: string;
}

export type PiExtensionSource =
	| LocalPiExtensionSource
	| PackagePiExtensionSource;

/**
 * 本期纳入构建的扩展资源。
 *
 * `vcp.tool-policy` 是宿主必需资源（Profile 未启用即拒绝保存），不可移除。
 * `community.pi-simplify` 是标准社区扩展复用验收对象：MIT、无运行依赖、
 * 只注册 `/simplify` 命令并通过 `pi.exec` 读取 git diff。
 *
 * 三条构建期「源码安装」路径（均在本文件登记，无运行期安装）：
 * 1. `kind: "local"` 指向仓库内自有源码（`vcp.tool-policy`）；
 * 2. `kind: "local"` 指向 **vendor 进仓库**的第三方源码，必须同时给 `licenseFile`；
 * 3. `kind: "package"` 指向已按 lockfile 固定版本安装的 npm 包（受信度最高：有 integrity）。
 * 从 `git:` 源在构建期克隆、或指向仓库外的任意绝对路径，均不开放：
 * 前者缺完整性锚点，后者使 Release 无法从仓库本身复现。
 */
export const PI_EXTENSION_SOURCES: readonly PiExtensionSource[] = [
	{
		kind: "local",
		id: "vcp.tool-policy",
		version: "3",
		entry: "packages/client/src/pi-bundle/tool-policy/index.ts",
	},
	{
		kind: "package",
		id: "community.pi-simplify",
		packageName: "pi-simplify",
		version: "0.2.3",
		licenseFile: "licenses/pi-simplify-LICENSE.txt",
	},
];
