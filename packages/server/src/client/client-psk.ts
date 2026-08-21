/** 返回 Server 与 Client 安装入口共同使用的共享 PSK。 */
export function clientPsk(): string {
	return process.env.VCPDECK_PSK || "vcpdeck-dev-psk";
}
