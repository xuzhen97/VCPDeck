/**
 * 本机 launcher 控制通道客户端（客户端侧，与服务端 release/launcher-client.ts 同协议）。
 * 设计文档 §6.3：launcher 监听 127.0.0.1 + token，写 control.json。
 * - prepare：launcher 下载/校验/解压新版本（客户端进程仍在运行）
 * - apply：launcher 停掉本进程并切换版本（响应无法送达属正常，视为成功）
 */
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface LauncherControl {
	port: number;
	token: string;
}

export interface ClientLauncherOptions {
	/** control.json 路径（默认 ~/.vcpdeck/launcher/control.json） */
	controlFile?: string;
	/** fetch 实现（测试注入） */
	fetchImpl?: typeof fetch;
}

const DEFAULT_CONTROL_FILE = join(
	homedir(),
	".vcpdeck",
	"launcher",
	"control.json",
);

export class ClientLauncher {
	private readonly controlFile: string;
	private readonly fetchImpl: typeof fetch;

	constructor(options: ClientLauncherOptions = {}) {
		this.controlFile = options.controlFile ?? DEFAULT_CONTROL_FILE;
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	private async readControl(): Promise<LauncherControl> {
		const raw = await readFile(this.controlFile, "utf-8");
		let parsed: Partial<LauncherControl>;
		try {
			parsed = JSON.parse(raw) as Partial<LauncherControl>;
		} catch {
			throw new Error(`launcher control.json 无效: ${this.controlFile}`);
		}
		if (!parsed?.port || !parsed?.token) {
			throw new Error(`launcher control.json 无效: ${this.controlFile}`);
		}
		return { port: parsed.port, token: parsed.token };
	}

	private async post(
		ctl: LauncherControl,
		path: string,
		body: unknown,
	): Promise<void> {
		const res = await this.fetchImpl(`http://127.0.0.1:${ctl.port}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-launcher-token": ctl.token,
			},
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`launcher ${path} 失败: HTTP ${res.status} ${text}`);
		}
	}

	/** 第一阶段：让 launcher 准备新版本（下载/校验/解压） */
	async prepareUpdate(input: {
		version: string;
		url: string;
		sha256: string;
	}): Promise<void> {
		const ctl = await this.readControl();
		await this.post(ctl, "/prepare", input);
	}

	/** 第二阶段：让 launcher 停掉本进程并切换版本（连接被掐断=成功） */
	async applyUpdate(): Promise<void> {
		const ctl = await this.readControl();
		try {
			await this.post(ctl, "/apply", {});
		} catch (e) {
			if (e instanceof TypeError) return;
			throw e;
		}
	}
}
