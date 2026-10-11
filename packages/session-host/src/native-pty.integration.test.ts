import { describe, expect, it } from "vitest";
import { createNativeBackend, probeNativeBackend } from "./native-pty.js";
import { type PtySessionFrame, createPtySession } from "./pty-session.js";

/**
 * 真实原生后端集成测试。
 *
 * 目的不是覆盖分支，而是证明「生产装配点」真的接上了：默认加载器、真实 PTY、
 * 真实终端模拟器与 serialize 快照。单元测试里的假模块永远测不到这条链路。
 */

const WORKER = [
	"process.stdout.write('ready\\r\\n');",
	"process.stdin.setEncoding('utf8');",
	"process.stdin.on('data', (chunk) => process.stdout.write('echo:' + chunk.replace(/\\r|\\n/g, '') + '\\r\\n'));",
	"process.stdin.resume();",
].join("");

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return false;
}

describe("原生后端集成（真实 PTY）", () => {
	it("默认加载器可用", async () => {
		await expect(probeNativeBackend()).resolves.toEqual({ available: true });
	});

	it(
		"真实 PTY 输出进入快照，输入可写入，停止得到退出确认",
		async () => {
			const backend = await createNativeBackend({
				commands: { pi: { file: process.execPath, args: ["-e", WORKER] } },
			});
			const frames: PtySessionFrame[] = [];
			const session = createPtySession({
				instanceId: "inst_integration",
				kind: "pi",
				cwd: process.cwd(),
				cols: 100,
				rows: 30,
				spawn: (options) => backend.spawnPty({ kind: options.kind, cwd: options.cwd, cols: options.cols, rows: options.rows }),
				screen: backend.createScreen({ cols: 100, rows: 30 }),
				emit: (frame) => {
					frames.push(frame);
					return true;
				},
			});
			try {
				const ready = await waitFor(async () => (await session.snapshot()).snapshot.includes("ready"));
				expect(ready).toBe(true);

				session.write("ping\r");
				const echoed = await waitFor(async () => (await session.snapshot()).snapshot.includes("echo:ping"));
				expect(echoed).toBe(true);

				const result = await session.stop();
				expect(result).toEqual({ exited: true });
				expect(session.state).toBe("stopped");
			} finally {
				await session.stop();
			}
		},
		40000,
	);
});
