"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const {
	COTURN_ERROR,
	CoturnConfigError,
	assertComposeIsStunOnly,
	assertStunOnlyConfig,
	normalizePublicIp,
	parseArgs,
	parseCoturnConfig,
	planStunOnlyDeployment,
	DEFAULT_COMPOSE,
	DEFAULT_TEMPLATE,
} = require("./install-coturn.cjs");

function repoFile(path) {
	return readFileSync(path, "utf8");
}

test("仓库自带模板与 compose 保持 STUN-only", () => {
	const template = assertStunOnlyConfig(repoFile(DEFAULT_TEMPLATE));
	assert.equal(template.port, 3478);
	assert.equal(assertComposeIsStunOnly(repoFile(DEFAULT_COMPOSE)), true);
});

test("任何中继指令都会让模板校验失败", () => {
	const cases = [
		["relay-ip", "172.17.0.1"],
		["min-port", "49152"],
		["max-port", "65535"],
		["lt-cred-mech", ""],
		["use-auth-secret", ""],
		["static-auth-secret", "0123456789abcdef"],
	];
	for (const [key, value] of cases) {
		const text = `listening-port=3478\nno-auth\nno-tcp-relay\nno-udp-relay\n${key}=${value}\n`;
		assert.throws(
			() => assertStunOnlyConfig(text),
			(error) => error instanceof CoturnConfigError && error.code === COTURN_ERROR.RELAY_ENABLED,
			`${key} 必须被拒绝`,
		);
	}
});

test("缺少 no-auth 或 no-*-relay 时模板校验失败", () => {
	assert.throws(
		() => assertStunOnlyConfig("listening-port=3478\nno-tcp-relay\nno-udp-relay\n"),
		(error) => error.code === COTURN_ERROR.RELAY_ENABLED,
	);
	assert.throws(
		() => assertStunOnlyConfig("listening-port=3478\nno-auth\nno-udp-relay\n"),
		(error) => error.code === COTURN_ERROR.RELAY_ENABLED,
	);
});

test("未知指令与非法端口会被拒绝", () => {
	assert.throws(
		() => assertStunOnlyConfig("listening-port=3478\nno-auth\nno-tcp-relay\nno-udp-relay\nfingerprint\n"),
		(error) => error.code === COTURN_ERROR.TEMPLATE_INVALID,
	);
	assert.throws(
		() => assertStunOnlyConfig("listening-port=0\nno-auth\nno-tcp-relay\nno-udp-relay\n"),
		(error) => error.code === COTURN_ERROR.TEMPLATE_INVALID,
	);
	assert.throws(
		() => assertStunOnlyConfig("no-auth\nno-tcp-relay\nno-udp-relay\n"),
		(error) => error.code === COTURN_ERROR.TEMPLATE_INVALID,
	);
});

test("compose 校验拒绝中继参数与端口范围映射", () => {
	assert.throws(
		() => assertComposeIsStunOnly(`${repoFile(DEFAULT_COMPOSE)}\n      - --relay-ip=0.0.0.0\n`),
		(error) => error.code === COTURN_ERROR.RELAY_ENABLED,
	);
	assert.throws(
		() => assertComposeIsStunOnly(`${repoFile(DEFAULT_COMPOSE)}\n      - "49152-65535:49152-65535/udp"\n`),
		(error) => error.code === COTURN_ERROR.RELAY_ENABLED,
	);
	assert.throws(
		() => assertComposeIsStunOnly("services: {}\n"),
		(error) => error.code === COTURN_ERROR.RELAY_ENABLED,
	);
	assert.throws(
		() =>
			assertComposeIsStunOnly(
				["--no-auth", "--no-tcp-relay", "--no-udp-relay"].join("\n"),
			),
		(error) => error.code === COTURN_ERROR.MISSING_PUBLIC_IP,
	);
});

test("公网地址必须显式提供且形状合法", () => {
	assert.equal(normalizePublicIp(" 203.0.113.9 "), "203.0.113.9");
	assert.equal(normalizePublicIp("stun.example.test"), "stun.example.test");
	assert.throws(
		() => normalizePublicIp(""),
		(error) => error.code === COTURN_ERROR.MISSING_PUBLIC_IP,
	);
	assert.throws(
		() => normalizePublicIp("bad ip"),
		(error) => error.code === COTURN_ERROR.INVALID_INPUT,
	);
	assert.throws(
		() => normalizePublicIp(`${"a".repeat(260)}`),
		(error) => error.code === COTURN_ERROR.INVALID_INPUT,
	);
});

test("部署计划产出 STUN URL、UDP 端口且不带任何凭据", () => {
	const plan = planStunOnlyDeployment({ VCPDECK_STUN_PUBLIC_IP: "203.0.113.9" });
	assert.equal(plan.policy, "p2p-only");
	assert.deepEqual(plan.stunUrls, ["stun:203.0.113.9:3478"]);
	assert.deepEqual(plan.requiredUdpPorts, [3478]);
	assert.deepEqual(plan.envFile, { VCPDECK_STUN_PUBLIC_IP: "203.0.113.9" });
	const serialized = JSON.stringify(plan);
	assert.ok(!serialized.includes("credential"));
	assert.ok(!serialized.includes("secret"));
	assert.ok(!serialized.includes("username"));
});

test("relay-allowed 会被拒绝，避免自托管 coturn 变成中继", () => {
	assert.throws(
		() =>
			planStunOnlyDeployment({
				VCPDECK_ICE_POLICY: "relay-allowed",
				VCPDECK_STUN_PUBLIC_IP: "203.0.113.9",
			}),
		(error) => error.code === COTURN_ERROR.RELAY_ENABLED,
	);
});

test("缺少公网地址时拒绝生成计划", () => {
	assert.throws(
		() => planStunOnlyDeployment({}),
		(error) => error.code === COTURN_ERROR.MISSING_PUBLIC_IP,
	);
});

test("参数解析拒绝未知参数并支持两种公网地址写法", () => {
	assert.deepEqual(parseArgs(["--check-only"]), { help: false, checkOnly: true, publicIp: undefined });
	assert.equal(parseArgs(["--stun-public-ip", "203.0.113.9"]).publicIp, "203.0.113.9");
	assert.equal(parseArgs(["--stun-public-ip=203.0.113.9"]).publicIp, "203.0.113.9");
	assert.equal(parseArgs(["--help"]).help, true);
	assert.throws(
		() => parseArgs(["--nope"]),
		(error) => error.code === COTURN_ERROR.INVALID_INPUT,
	);
});

test("配置文件解析忽略注释与空 value", () => {
	const directives = parseCoturnConfig("# comment\n\nno-auth\nstale-nonce=600\n");
	assert.equal(directives.get("no-auth"), "");
	assert.equal(directives.get("stale-nonce"), "600");
	assert.equal(directives.size, 2);
});
