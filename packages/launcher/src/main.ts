/**
 * launcher 入口：加载配置并启动守护进程。
 * 部署后冻结，不参与业务构件自动更新。详见 docs/design/release-and-update.md。
 */
import { Daemon, loadConfigFromEnv } from "./daemon.js";

async function main(): Promise<void> {
	let config;
	try {
		config = loadConfigFromEnv();
	} catch (e) {
		console.error(
			`[launcher] 配置错误: ${e instanceof Error ? e.message : String(e)}`,
		);
		process.exit(1);
	}
	const daemon = new Daemon(config);
	try {
		await daemon.start();
	} catch (e) {
		console.error(
			`[launcher] 启动失败: ${e instanceof Error ? e.message : String(e)}`,
		);
		process.exit(1);
	}
}

void main();
