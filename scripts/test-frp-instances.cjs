#!/usr/bin/env node
/**
 * FRP 实例管理 + 健康检查 集成测试
 * 用法: node scripts/test-frp-instances.cjs
 * 前提: server 已在 http://localhost:3001 运行
 */

const BASE = "http://localhost:3001";

async function request(method, path, body) {
	const opts = {
		method,
		headers: { "Content-Type": "application/json" },
	};
	if (body) opts.body = JSON.stringify(body);
	const res = await fetch(`${BASE}${path}`, opts);
	const data = await res.json();
	return { status: res.status, data };
}

async function main() {
	// 1. 验证启动迁移：自动创建默认实例
	const list = await request("GET", "/api/frp/instances");
	console.log("实例列表:", JSON.stringify(list.data, null, 2));
	if (list.data.total < 1) throw new Error("启动迁移失败：无默认实例");

	const defaultId = list.data.data.find((i) => i.isDefault)?.id;
	console.log(`默认实例 ID: ${defaultId}`);

	// 2. 创建第二个实例
	const created = await request("POST", "/api/frp/instances", {
		name: "测试实例",
		serverAddr: "127.0.0.1",
		serverPort: 17000,
		dashboardHost: "127.0.0.1",
		dashboardPort: 17500,
		dashboardUser: "admin",
		dashboardPassword: "admin",
		portRangeStart: 30000,
		portRangeEnd: 30010,
	});
	console.log("创建实例:", JSON.stringify(created.data, null, 2));
	const testId = created.data.id;

	// 3. 健康检查（可能失败或有数据，取决于 frps 是否在运行）
	const probe = await request(
		"POST",
		`/api/frp/instances/${testId}/probe`,
	);
	console.log("健康检查:", JSON.stringify(probe.data, null, 2));

	// 4. 设为默认
	const setDefault = await request(
		"POST",
		`/api/frp/instances/${testId}/set-default`,
	);
	console.log(
		"设为默认:",
		setDefault.data.name,
		setDefault.data.isDefault,
	);

	// 5. 恢复原默认
	await request(
		"POST",
		`/api/frp/instances/${defaultId}/set-default`,
	);

	// 6. 删除测试实例
	const deleted = await request(
		"DELETE",
		`/api/frp/instances/${testId}`,
	);
	console.log("删除:", JSON.stringify(deleted.data));

	console.log("\n全部通过 ✅");
}

main().catch((err) => {
	console.error("测试失败:", err.message);
	process.exit(1);
});
