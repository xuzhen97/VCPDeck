/**
 * launcher 入口：加载配置并启动守护进程或系统 Supervisor。
 * 部署后冻结，不参与业务构件自动更新。详见 docs/design/release-and-update.md。
 *
 * 两种模式：
 * - `daemon`（默认）：单构件守护 + 版本切换，保持既有行为；
 * - `supervisor`：多组件监管（见 `supervisor.ts`），由 Supervisor 拥有进程信号，
 *   因此 Daemon 必须以 `manageSignals: false` 构造，避免它抢先 `process.exit`。
 */
import { createDaemonComponent } from "./components.js";
import { Daemon, loadConfigFromEnv, type DaemonConfig } from "./daemon.js";
import { Supervisor } from "./supervisor.js";

/** Supervisor 健康检查间隔。 */
const HEALTH_INTERVAL_MS = Number(process.env.VCPDECK_SUPERVISOR_HEALTH_MS ?? 15_000);

async function runDaemon(config: DaemonConfig): Promise<void> {
	const daemon = new Daemon(config);
	await daemon.start();
}

async function runSupervisor(config: DaemonConfig): Promise<void> {
	const daemon = new Daemon({ ...config, manageSignals: false });
	const supervisor = new Supervisor([createDaemonComponent(daemon, config.artifact)], {
		log: (message) => console.log(message),
	});

	const timer = setInterval(() => {
		void supervisor.runHealthCheck().catch(() => undefined);
	}, HEALTH_INTERVAL_MS);

	let stopping = false;
	const stop = async () => {
		if (stopping) return;
		stopping = true;
		clearInterval(timer);
		// 逆序停止全部组件后再退出，避免留下只停了一半的系统状态。
		await supervisor.stop().catch(() => undefined);
		process.exit(0);
	};
	process.on("SIGTERM", () => void stop());
	process.on("SIGINT", () => void stop());

	await supervisor.start();
}

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
	const mode = process.env.VCPDECK_LAUNCHER_MODE ?? "daemon";
	try {
		if (mode === "supervisor") {
			await runSupervisor(config);
			return;
		}
		await runDaemon(config);
	} catch (e) {
		console.error(
			`[launcher] 启动失败: ${e instanceof Error ? e.message : String(e)}`,
		);
		process.exit(1);
	}
}

void main();
