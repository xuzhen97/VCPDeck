/**
 * 文件操作端到端验证脚本
 *
 * 使用方式：在已连接的 Client 进程中，通过 Server REST API 发起文件 Job
 *
 * 前置条件：
 * 1. Server 运行中 (pnpm --filter @vcpdeck/server dev)
 * 2. Client 已注册，capabilities 包含 "file.read" 和 "file.write"
 * 3. 有一个可访问的测试目录（如 /tmp/test-vcpdeck 或 D:/tmp/test-vcpdeck）
 *
 * 验证项：
 * 1. file.mkdir → file.list → file.stat
 * 2. file.writeText → file.readText
 * 3. file.move → file.delete
 *
 * 示例 API 调用（使用 curl 或 fetch）：
 *   POST /api/jobs { type:"file.mkdir", clientId:"<id>", payload:{ path:"test-vcpdeck", rootDir:"/tmp" } }
 */
console.log("=== File Ops E2E Manual Test ===\n");
console.log("请通过 REST API 手动测试以下流程：\n");

const baseUrl = "http://localhost:3000";
console.log(`Server base URL: ${baseUrl}\n`);

const steps = [
	{
		name: "1. 创建目录",
		request: `POST /api/jobs`,
		body: {
			type: "file.mkdir",
			clientId: "<client-id>",
			payload: { path: "test-vcpdeck", rootDir: "/tmp" },
			timeout: 10000,
		},
	},
	{
		name: "2. 列目录（验证创建成功）",
		request: `POST /api/jobs`,
		body: {
			type: "file.list",
			clientId: "<client-id>",
			payload: { path: "test-vcpdeck", rootDir: "/tmp" },
		},
	},
	{
		name: "3. stat 目录",
		request: `POST /api/jobs`,
		body: {
			type: "file.stat",
			clientId: "<client-id>",
			payload: { path: "test-vcpdeck", rootDir: "/tmp" },
		},
	},
	{
		name: "4. 写文本文件",
		request: `POST /api/jobs`,
		body: {
			type: "file.writeText",
			clientId: "<client-id>",
			payload: {
				path: "test-vcpdeck/hello.txt",
				rootDir: "/tmp",
				content: "Hello VCPDeck!",
			},
		},
	},
	{
		name: "5. 读文本文件",
		request: `POST /api/jobs`,
		body: {
			type: "file.readText",
			clientId: "<client-id>",
			payload: { path: "test-vcpdeck/hello.txt", rootDir: "/tmp" },
		},
	},
	{
		name: "6. 移动文件",
		request: `POST /api/jobs`,
		body: {
			type: "file.move",
			clientId: "<client-id>",
			payload: {
				source: "test-vcpdeck/hello.txt",
				destination: "test-vcpdeck/hello2.txt",
				rootDir: "/tmp",
			},
		},
	},
	{
		name: "7. 路径逃逸测试（应拒绝）",
		request: `POST /api/jobs`,
		body: {
			type: "file.readText",
			clientId: "<client-id>",
			payload: { path: "../../../etc/passwd", rootDir: "/tmp" },
		},
	},
	{
		name: "8. 删除测试目录",
		request: `POST /api/jobs`,
		body: {
			type: "file.delete",
			clientId: "<client-id>",
			payload: {
				path: "test-vcpdeck",
				rootDir: "/tmp",
				recursive: true,
			},
		},
	},
];

for (const step of steps) {
	console.log(`\n--- ${step.name} ---`);
	console.log(`curl -s -X POST ${baseUrl}/api/jobs \\`);
	console.log(`  -H "Content-Type: application/json" \\`);
	console.log(`  -d '${JSON.stringify(step.body, null, 2)}'`);
	console.log(`\n  curl command (replace <client-id> with actual):`);
	console.log(`    curl -s -X POST ${baseUrl}/api/jobs -H "Content-Type: application/json" -d '${JSON.stringify(step.body)}'`.replace(
		"<client-id>",
		"YOUR_CLIENT_ID",
	));
}

console.log("\n\n=== 预期结果 ===");
console.log("1-6: 应全部返回 jobId + status=running/pending");
console.log("7: 应返回 error (PATH_NOT_ALLOWED)");
console.log("8: 应返回 jobId + status=running");
console.log("\n通过 WebSocket 订阅 JOB_UPDATE 事件可跟踪执行结果。");
