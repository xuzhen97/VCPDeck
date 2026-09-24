/**
 * Pi 能力探测 Worker：在独立子进程中加载 Pi SDK（主进程不静态 import）。
 * 只输出 { sdkVersion, providerIds, error }，不输出路径、凭据或模型元数据。
 */
import type { ProbeWorkerResult } from "./capability.js";

/** Pi SDK 是 ESM-only；Client 编译为 CJS，必须运行时动态 import（同 agent-session/session-reader）。 */
type PiSdk = typeof import("@earendil-works/pi-coding-agent");
let sdkPromise: Promise<PiSdk> | null = null;
function getSdk(): Promise<PiSdk> {
	if (!sdkPromise) sdkPromise = import("@earendil-works/pi-coding-agent");
	return sdkPromise;
}

/** 读取 Pi SDK 版本：唯一版本事实来源，禁止硬编码。 */
export async function readSdkVersion(): Promise<string> {
	return (await getSdk()).VERSION;
}

/**
 * 读取 Pi 内置模型的 Provider ID 列表（去重、排序）。
 *
 * 只读 SDK 自带的静态目录：不读用户 ~/.pi、不读 models.json、不允许网络刷新，
 * 也不会上报任何模型元数据（体积与权威性都不需要）。
 */
export async function readCatalogProviderIds(): Promise<string[]> {
	const { ModelRuntime } = await getSdk();
	const runtime = await ModelRuntime.create({
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	return [...new Set(runtime.getModels().map((model) => model.provider))].sort();
}

async function runProbe(): Promise<ProbeWorkerResult> {
	try {
		const sdkVersion = await readSdkVersion();
		// 目录探测失败不阻止 Pi 可用：只降低模型发现时的来源建议质量。
		let providerIds: string[] = [];
		try {
			providerIds = await readCatalogProviderIds();
		} catch {
			providerIds = [];
		}
		return { sdkVersion, providerIds, error: null };
	} catch (error) {
		return {
			sdkVersion: "",
			providerIds: [],
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
