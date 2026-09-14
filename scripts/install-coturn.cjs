#!/usr/bin/env node
"use strict";
/**
 * 自托管 STUN-only coturn 的构件检查与配置生成。
 *
 * 这里刻意不做任何网络绑定，也不安装系统包：
 * - `planStunOnlyDeployment()` 只根据传入的环境生成 docker compose 参数与模板校验结果；
 * - `assertStunOnlyConfig()` 在部署前静态拒绝任何会打开中继的配置。
 *
 * 真实 STUN 绑定与「中继不可用」验证由 `scripts/test-coturn.cjs` 在具备
 * Docker/coturn 的主机上执行，不能由本脚本伪造。
 */

const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const REPO_ROOT = join(__dirname, "..");
const DEFAULT_TEMPLATE = join(REPO_ROOT, "deploy", "coturn", "turnserver.conf.template");
const DEFAULT_COMPOSE = join(REPO_ROOT, "deploy", "coturn", "docker-compose.yml");

const COTURN_ERROR = {
	INTERNAL: "COTURN_INTERNAL_ERROR",
	INVALID_INPUT: "COTURN_INVALID_INPUT",
	RELAY_ENABLED: "COTURN_RELAY_ENABLED",
	TEMPLATE_INVALID: "COTURN_TEMPLATE_INVALID",
	MISSING_PUBLIC_IP: "COTURN_MISSING_PUBLIC_IP",
};

class CoturnConfigError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "CoturnConfigError";
		this.code = code;
	}
}

/** 只有这些指令允许出现在 STUN-only 模板中。 */
const ALLOWED_DIRECTIVES = new Set([
	"listening-port",
	"listening-ip",
	"no-auth",
	"no-tcp-relay",
	"no-udp-relay",
	"no-cli",
	"simple-log",
	"log-file",
	"stale-nonce",
	"external-ip",
]);

/** 一旦出现就等于打开了 TURN 中继；出现即拒绝。 */
const RELAY_DIRECTIVES = new Set([
	"relay-ip",
	"min-port",
	"max-port",
	"lt-cred-mech",
	"use-auth-secret",
	"static-auth-secret",
	"realm",
	"user",
	"no-multicast-peers",
]);

/** 解析 coturn 配置文本；忽略注释和空行。 */
function parseCoturnConfig(text) {
	const directives = new Map();
	for (const rawLine of String(text ?? "").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		const separator = line.indexOf("=");
		const key = (separator === -1 ? line : line.slice(0, separator)).trim();
		const value = separator === -1 ? "" : line.slice(separator + 1).trim();
		if (key.length === 0) continue;
		directives.set(key, value);
	}
	return directives;
}

/**
 * 静态校验模板必须是 STUN-only：
 * 缺少 `no-auth`、缺少 `no-*-relay`、或出现任何中继指令都会被拒绝。
 */
function assertStunOnlyConfig(text) {
	const directives = parseCoturnConfig(text);
	// 先判定中继指令：它比“未知指令”更具体，诊断信息也更有用。
	const relay = [...directives.keys()].filter((key) => RELAY_DIRECTIVES.has(key));
	if (relay.length > 0) {
		throw new CoturnConfigError(
			COTURN_ERROR.RELAY_ENABLED,
			`STUN-only 模板不得包含中继指令: ${relay.join(", ")}`,
		);
	}
	const unknown = [...directives.keys()].filter((key) => !ALLOWED_DIRECTIVES.has(key));
	if (unknown.length > 0) {
		throw new CoturnConfigError(
			COTURN_ERROR.TEMPLATE_INVALID,
			`模板包含未允许的指令: ${unknown.join(", ")}`,
		);
	}
	if (!directives.has("no-auth")) {
		throw new CoturnConfigError(COTURN_ERROR.RELAY_ENABLED, "缺少 no-auth：无法保证拒绝 TURN 分配");
	}
	if (!directives.has("no-tcp-relay") || !directives.has("no-udp-relay")) {
		throw new CoturnConfigError(COTURN_ERROR.RELAY_ENABLED, "缺少 no-tcp-relay / no-udp-relay");
	}
	const port = Number.parseInt(directives.get("listening-port") ?? "", 10);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new CoturnConfigError(COTURN_ERROR.TEMPLATE_INVALID, "listening-port 无效");
	}
	return {
		port,
		listeningIp: directives.get("listening-ip") ?? "0.0.0.0",
		directives,
	};
}

/** 校验 compose 文件没有映射中继端口范围，且确实要求显式公网地址。 */
function assertComposeIsStunOnly(text) {
	const content = String(text ?? "");
	if (!content.includes("--no-auth")) {
		throw new CoturnConfigError(COTURN_ERROR.RELAY_ENABLED, "compose 缺少 --no-auth");
	}
	if (!content.includes("--no-tcp-relay") || !content.includes("--no-udp-relay")) {
		throw new CoturnConfigError(COTURN_ERROR.RELAY_ENABLED, "compose 缺少 --no-*-relay");
	}
	if (/--relay-ip|--min-port|--max-port|--lt-cred-mech|--use-auth-secret/.test(content)) {
		throw new CoturnConfigError(COTURN_ERROR.RELAY_ENABLED, "compose 不得包含中继参数");
	}
	// 只检查真正的端口映射行；注释里提到范围不算违规。
	const instruction = content
		.split(/\r?\n/)
		.filter((line) => !line.trim().startsWith("#"))
		.join("\n");
	for (const published of publishedPorts(instruction)) {
		if (published >= 49152 && published <= 65535) {
			throw new CoturnConfigError(
				COTURN_ERROR.RELAY_ENABLED,
				`compose 不得映射中继端口范围: ${published}`,
			);
		}
	}
	if (!content.includes("VCPDECK_STUN_PUBLIC_IP")) {
		throw new CoturnConfigError(
			COTURN_ERROR.MISSING_PUBLIC_IP,
			"compose 必须要求显式设置 VCPDECK_STUN_PUBLIC_IP",
		);
	}
	return true;
}

/** 提取映射字符串（如 `"3478:3478/udp"`）中的主机侧与容器侧起始端口。 */
function publishedPorts(text) {
	const ports = [];
	const pattern = /"(\d{1,5})(?:-\d{1,5})?:(\d{1,5})(?:-\d{1,5})?(?:\/\w+)?"/g;
	for (const match of String(text).matchAll(pattern)) {
		ports.push(Number.parseInt(match[1], 10), Number.parseInt(match[2], 10));
	}
	return ports;
}

/** 规范化并校验 STUN 公网地址。 */
function normalizePublicIp(value) {
	const ip = String(value ?? "").trim();
	if (ip.length === 0) {
		throw new CoturnConfigError(COTURN_ERROR.MISSING_PUBLIC_IP, "必须设置 STUN 公网地址");
	}
	if (ip.length > 253 || !/^[A-Za-z0-9.:_-]+$/.test(ip)) {
		throw new CoturnConfigError(COTURN_ERROR.INVALID_INPUT, "STUN 公网地址格式无效");
	}
	return ip;
}

/**
 * 生成部署计划；不做任何副作用。
 *
 * `p2p-only` 是唯一允许的策略：本脚本负责打包 STUN，不负责中继。
 */
function planStunOnlyDeployment(env = {}, options = {}) {
	const policy = String(env.VCPDECK_ICE_POLICY ?? "p2p-only").trim();
	if (policy !== "p2p-only") {
		throw new CoturnConfigError(
			COTURN_ERROR.RELAY_ENABLED,
			"自托管 coturn 只支持 p2p-only；外部 TURN 请使用独立部署",
		);
	}
	const templatePath = options.templatePath ?? DEFAULT_TEMPLATE;
	const composePath = options.composePath ?? DEFAULT_COMPOSE;
	const templateText = options.templateText ?? readFileSync(templatePath, "utf8");
	const composeText = options.composeText ?? readFileSync(composePath, "utf8");
	const template = assertStunOnlyConfig(templateText);
	assertComposeIsStunOnly(composeText);

	const publicIp = normalizePublicIp(options.publicIp ?? env.VCPDECK_STUN_PUBLIC_IP);
	return {
		policy: "p2p-only",
		publicIp,
		port: template.port,
		listeningIp: template.listeningIp,
		stunUrls: [`stun:${publicIp}:${template.port}`],
		composeArgs: ["compose", "-f", "deploy/coturn/docker-compose.yml", "up", "-d"],
		envFile: { VCPDECK_STUN_PUBLIC_IP: publicIp },
		// 该字段供部署脚本判断是否需要额外开放防火墙 UDP 端口。
		requiredUdpPorts: [template.port],
	};
}

function parseArgs(argv = []) {
	const args = { help: false, checkOnly: false, publicIp: undefined };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") args.help = true;
		else if (arg === "--check-only") args.checkOnly = true;
		else if (arg === "--stun-public-ip") {
			args.publicIp = argv[index + 1];
			index += 1;
		}
		else if (arg.startsWith("--stun-public-ip=")) args.publicIp = arg.slice("--stun-public-ip=".length);
		else throw new CoturnConfigError(COTURN_ERROR.INVALID_INPUT, `未知参数: ${arg}`);
	}
	return args;
}

function main(argv = process.argv.slice(2)) {
	const args = parseArgs(argv);
	if (args.help) {
		process.stdout.write(
			[
				"用法: node scripts/install-coturn.cjs [--stun-public-ip <IP>] [--check-only]",
				"",
				"  --stun-public-ip <IP>  coturn 对外可达地址；也可用 VCPDECK_STUN_PUBLIC_IP 提供",
				"  --check-only          只校验模板与 compose 是否保持 STUN-only，不做任何部署动作",
			].join("\n") + "\n",
		);
		return 0;
	}
	if (args.checkOnly) {
		assertStunOnlyConfig(readFileSync(DEFAULT_TEMPLATE, "utf8"));
		assertComposeIsStunOnly(readFileSync(DEFAULT_COMPOSE, "utf8"));
		process.stdout.write("coturn 模板保持 STUN-only\n");
		return 0;
	}
	const plan = planStunOnlyDeployment(process.env, { publicIp: args.publicIp });
	process.stdout.write(
		[
			"自托管 coturn 部署计划（STUN-only）：",
			`  公网地址: ${plan.publicIp}`,
			`  监听端口: ${plan.port}/udp`,
			`  STUN URL: ${plan.stunUrls.join(", ")}`,
			`  需要开放的 UDP 端口: ${plan.requiredUdpPorts.join(", ")}`,
			"",
			"执行以下命令完成部署：",
			`  VCPDECK_STUN_PUBLIC_IP=${plan.publicIp} docker ${plan.composeArgs.join(" ")}`,
		].join("\n") + "\n",
	);
	return 0;
}

if (require.main === module) {
	try {
		process.exitCode = main();
	} catch (error) {
		const code = error instanceof CoturnConfigError ? error.code : COTURN_ERROR.INTERNAL;
		process.stderr.write(`coturn 部署失败: ${code} ${error instanceof Error ? error.message : ""}\n`);
		process.exitCode = 1;
	}
}

module.exports = {
	COTURN_ERROR,
	CoturnConfigError,
	ALLOWED_DIRECTIVES,
	RELAY_DIRECTIVES,
	parseCoturnConfig,
	assertStunOnlyConfig,
	assertComposeIsStunOnly,
	publishedPorts,
	normalizePublicIp,
	planStunOnlyDeployment,
	parseArgs,
	main,
	DEFAULT_TEMPLATE,
	DEFAULT_COMPOSE,
};
