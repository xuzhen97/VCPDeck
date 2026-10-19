import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
	createDshWebHost,
	extractToken,
	isPortListening,
	parseListeningPids,
	parseLsofPids,
} from "./dsh-web-host.js";

/** 造一个能吐出 token 的假子进程。 */
interface FakeChild extends EventEmitter {
	stdout: EventEmitter;
	stderr: EventEmitter;
	kill: () => boolean;
}

function fakeChild(): FakeChild {
	const child = new EventEmitter() as FakeChild;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = vi.fn(() => {
		child.emit("exit", 0);
		return true;
	});
	return child;
}

function asChild(child: FakeChild): ChildProcess {
	return child as unknown as ChildProcess;
}

describe("受管 dsh web 主机", () => {
	it("从输出里取 token，忽略无 token 的日志行", () => {
		expect(
			extractToken("dsh web: http://127.0.0.1:30999/?token=abcDEF123456"),
		).toBe("abcDEF123456");
		expect(extractToken("listening on 30999")).toBeNull();
		expect(extractToken("http://x/?token=short")).toBeNull();
	});

	it("解析 netstat 监听 PID", () => {
		const out = [
			"  活动连接",
			"",
			"  TCP    127.0.0.1:33919        0.0.0.0:0              LISTENING       9832",
			"  TCP    127.0.0.1:33919        127.0.0.1:50123        ESTABLISHED     4040",
			"  TCP    0.0.0.0:17000          0.0.0.0:0              LISTENING       9240",
		].join("\r\n");
		expect(parseListeningPids(out, 33919)).toEqual([9832]);
		expect(parseListeningPids(out, 17000)).toEqual([9240]);
		expect(parseListeningPids(out, 1234)).toEqual([]);
	});

	it("解析 lsof 输出", () => {
		expect(parseLsofPids("123\r\n456\r\n")).toEqual([123, 456]);
		expect(parseLsofPids("")).toEqual([]);
	});

	it("start 拿到 token 后进入运行态；stop 按端口兜底清理", async () => {
		const child = fakeChild();
		const killByPort = vi.fn(async () => undefined);
		const host = createDshWebHost({
			spawnImpl: (() => asChild(child)) as never,
			killByPortImpl: killByPort,
			isPortListeningImpl: async () => false,
		});

		const pending = host.start({ port: 33_919 });
		child.stdout.emit(
			"data",
			Buffer.from("dsh web: http://127.0.0.1:33919/?token=abcdefgh12345678\n"),
		);
		await expect(pending).resolves.toEqual({
			port: 33_919,
			token: "abcdefgh12345678",
		});
		expect(host.running()).toBe(true);

		await host.stop(33_919);
		expect(host.running()).toBe(false);
		expect(killByPort).toHaveBeenCalledWith(33_919);
	});

	it("句柄已丢失（Client 重启）时仍按端口清理", async () => {
		const killByPort = vi.fn(async () => undefined);
		const host = createDshWebHost({
			killByPortImpl: killByPort,
			isPortListeningImpl: async () => false,
		});
		expect(host.running()).toBe(false);
		await host.stop(33_919);
		expect(killByPort).toHaveBeenCalledWith(33_919);
	});

	it("端口仍在监听时明确报错，不假装成功", async () => {
		const host = createDshWebHost({
			killByPortImpl: async () => undefined,
			isPortListeningImpl: async () => true,
			stopVerifyTimeoutMs: 60,
		});
		await expect(host.stop(33_919)).rejects.toMatchObject({
			code: "DSH_WEB_STOP_INCOMPLETE",
		});
	});

	it("端口延迟释放时不误报失败", async () => {
		let calls = 0;
		const host = createDshWebHost({
			killByPortImpl: async () => undefined,
			// 前两次仍占用，第三次才释放，模拟 taskkill 到真正释放的延迟。
			isPortListeningImpl: async () => ++calls < 3,
			stopVerifyTimeoutMs: 3_000,
		});
		await expect(host.stop(33_919)).resolves.toBeUndefined();
	});

	it("isPortListening 对已关闭端口返回 false", async () => {
		await expect(isPortListening(1)).resolves.toBe(false);
	});
});
