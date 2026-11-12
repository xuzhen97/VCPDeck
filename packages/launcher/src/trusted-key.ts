/**
 * Launcher 侧发布者可信公钥（编译期内置）。
 *
 * 本文件只保存公钥占位常量，绝不包含私钥或生产凭据。生产公钥由构建流程替换，
 * 或运行时通过 VCPDECK_RELEASE_PUBLIC_KEY_PEM 注入。
 */

/** 编译期内置的占位 Ed25519 公钥（SPKI PEM，非生产密钥，不对应任何已知私钥）。 */
const BUILTIN_TRUSTED_PUBLIC_KEY_PEM =
	"-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAEeSJpoke01zzSGIVCi2CxxshSzkttRcMp5aN+XJQJa8=\n-----END PUBLIC KEY-----\n";

/**
 * 返回当前可信发布者公钥 PEM。
 *
 * 允许通过 VCPDECK_RELEASE_PUBLIC_KEY_PEM 覆盖内置占位值以便公钥轮换演练；
 * 未覆盖时返回编译期内置常量。
 */
export function loadTrustedPublicKeyPem(): string {
	const override = process.env.VCPDECK_RELEASE_PUBLIC_KEY_PEM;
	return override && override.length > 0
		? override
		: BUILTIN_TRUSTED_PUBLIC_KEY_PEM;
}
