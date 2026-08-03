const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { waitForServer } = require("./wait-for-server.cjs");

const servers = [];

after(async () => {
	await Promise.all(
		servers.map(
			(server) =>
				new Promise((resolve) => {
					server.close(() => resolve());
				}),
		),
	);
});

test("waitForServer retries until the health endpoint becomes ready", async () => {
	let requests = 0;
	const server = http.createServer((_req, res) => {
		requests += 1;
		res.writeHead(requests < 3 ? 503 : 200);
		res.end();
	});
	servers.push(server);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");

	await waitForServer(`http://127.0.0.1:${address.port}`, {
		pollMs: 5,
		requestTimeoutMs: 100,
		timeoutMs: 500,
	});

	assert.equal(requests, 3);
});

test("waitForServer fails with a useful timeout error", async () => {
	await assert.rejects(
		() =>
			waitForServer("http://127.0.0.1:1", {
				pollMs: 5,
				requestTimeoutMs: 10,
				timeoutMs: 30,
			}),
		(error) =>
			error instanceof Error &&
			/等待 Server 就绪超时/.test(error.message) &&
			/api\/health/.test(error.message),
	);
});
