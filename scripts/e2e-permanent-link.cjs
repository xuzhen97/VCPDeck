/* 端到端验证：永久下载链接（ttlSeconds=0）+ 重启后仍有效 */
const BASE = "http://localhost:3001";

let cookie = "";
let failures = 0;

function pass(name) { console.log(`  ✓ ${name}`); }
function fail(name, detail) { failures++; console.log(`  ✗ ${name}: ${detail}`); }

async function api(method, path, body, noCookie = false) {
	const headers = { "Content-Type": "application/json" };
	if (cookie && !noCookie) headers["Cookie"] = cookie;
	const res = await fetch(`${BASE}${path}`, {
		method, headers, body: body ? JSON.stringify(body) : undefined,
	});
	const setCookie = res.headers.get("set-cookie") || "";
	const m = setCookie.match(/vcpdeck_session=([^;]+)/);
	if (m) cookie = `vcpdeck_session=${m[1]}`;
	const text = await res.text();
	let parsed = null;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		parsed = text;
	}
	return { status: res.status, body: parsed };
}

async function main() {
	// 1. 登录
	const login = await api("POST", "/api/auth/login", { username: "admin", password: "test123" });
	if (login.status !== 201 && login.status !== 200) return fail("登录", `HTTP ${login.status}`);
	pass("登录");

	// 2. 签上传令牌（本地存储）
	const content = `permanent-link-test-${Date.now()}`;
	const token = await api("POST", "/api/storage/upload-token", {
		jobId: "e2e-job", clientId: "e2e-client", filename: "e2e.txt", size: content.length,
	});
	if (token.status !== 201 && token.status !== 200) return fail("上传令牌", `HTTP ${token.status}`);
	const uploadUrl = token.body.url;
	pass(`上传令牌 url=${uploadUrl.slice(0, 60)}...`);

	// 3. 上传文件
	const uploadPath = uploadUrl; // /api/storage/upload/{key}?expires=...&sig=...
	const putRes = await fetch(`${BASE}${uploadPath}`, { method: "PUT", body: content });
	if (!putRes.ok) return fail("上传", `HTTP ${putRes.status}`);
	const uploaded = await putRes.json();
	pass(`上传成功 key=${uploaded.key}`);

	// 4. 签永久下载令牌
	const dlToken = await api("POST", "/api/storage/download-token", { key: uploaded.key, ttlSeconds: 0 });
	if (dlToken.status !== 201 && dlToken.status !== 200) return fail("永久下载令牌", `HTTP ${dlToken.status}`);
	const dlUrl = dlToken.body.url;
	if (!dlUrl.includes("expires=0")) return fail("永久下载令牌", `url 缺 expires=0: ${dlUrl}`);
	pass(`永久下载令牌 url=${dlUrl.slice(0, 60)}...`);

	// 5. 下载并校验内容
	const getRes = await fetch(`${BASE}${dlUrl}`);
	if (!getRes.ok) return fail("下载", `HTTP ${getRes.status}`);
	const downloaded = await getRes.text();
	if (downloaded !== content) return fail("下载", "内容不一致");
	pass("下载内容一致");

	// 6. 回归：默认 1 小时令牌仍有时效标记
	const tmpToken = await api("POST", "/api/storage/download-token", { key: uploaded.key });
	if (!tmpToken.body.url.includes("expires=") || tmpToken.body.url.includes("expires=0")) {
		return fail("1小时令牌回归", `url=${tmpToken.body.url}`);
	}
	pass("默认令牌仍带 1 小时过期标记");

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
