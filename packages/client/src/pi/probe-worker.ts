/**
 * Pi 能力探测 Worker：在独立子进程中加载 Pi SDK（主进程不静态 import）。
 * 只输出 { sdkVersion, modelCount, error }，不输出路径、凭据或模型详情。
 */
import type { ProbeWorkerResult } from "./capability.js";

async function runProbe(): Promise<ProbeWorkerResult> {
	try {
		const { ModelRuntime } = await import(
			"@earendil-works/pi-coding-agent"
		);
		const runtime = await ModelRuntime.create();
		const models = await runtime.getAvailable();
		return {
			sdkVersion: "0.84.0",
			modelCount: models.length,
			error: null,
		};
	} catch (error) {
		return {
			sdkVersion: "",
			modelCount: 0,
			error: {
				code: "PI_RUNTIME_UNAVAILABLE",
				message: error instanceof Error ? error.message : "Pi SDK load failed",
			},
		};
	}
}

process.on("message", (msg: unknown) => {
	if (typeof msg !== "object" || msg === null || (msg as { type?: string }).type !== "probe") {
		return;
	}
	void runProbe().then((result) => {
		if (process.send) process.send(result);
		setTimeout(() => process.exit(0), 50);
	});
});
