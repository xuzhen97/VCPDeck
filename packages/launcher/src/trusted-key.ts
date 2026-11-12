/**
 * Launcher 侧发布者可信公钥（编译期内置）。
 *
 * 本文件只保存公钥，绝不包含私钥或生产凭据。生产公钥由打包流程从签名私钥派生后
 * 经 esbuild `define` 注入（见 scripts/build/bundle-apps.ts），或运行时通过
 * VCPDECK_RELEASE_PUBLIC_KEY_PEM 覆盖。
 */

/**
 * 打包时由 esbuild `define` 替换为公钥 PEM 字符串字面量；
 * 未打包运行（单测、tsx 直跑源码）时该标识符不存在。
 */
declare const __VCPDECK_RELEASE_PUBLIC_KEY_PEM__: string | undefined;

/** 编译期内置的占位 Ed25519 公钥（SPKI PEM，非生产密钥，不对应任何已知私钥）。 */
const BUILTIN_TRUSTED_PUBLIC_KEY_PEM =
	"-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAEeSJpoke01zzSGIVCi2CxxshSzkttRcMp5aN+XJQJa8=\n-----END PUBLIC KEY-----\n";

/** 返回打包时注入的公钥；未注入时返回 undefined。 */
function injectedPublicKeyPem(): string | undefined {
	if (
		typeof __VCPDECK_RELEASE_PUBLIC_KEY_PEM__ === "string" &&
		__VCPDECK_RELEASE_PUBLIC_KEY_PEM__.trim().length > 0
	) {
		return __VCPDECK_RELEASE_PUBLIC_KEY_PEM__;
	}
	return undefined;
}

/**
 * 返回当前可信发布者公钥 PEM。
 *
 * 优先级：运行时 VCPDECK_RELEASE_PUBLIC_KEY_PEM（轮换演练）→ 打包时注入的生产公钥 →
 * 内置占位值。落到占位值时真包验签必然失败（失败关闭），不会放行未签名或他签构件。
 */
export function loadTrustedPublicKeyPem(): string {
	const override = process.env.VCPDECK_RELEASE_PUBLIC_KEY_PEM;
	if (override && override.length > 0) return override;
	return injectedPublicKeyPem() ?? BUILTIN_TRUSTED_PUBLIC_KEY_PEM;
}
