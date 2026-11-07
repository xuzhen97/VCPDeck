import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const sourceDir = fileURLToPath(new URL("./src", import.meta.url));

/** 未显式配置时的开发端口；与 `docs/deployment.md` 记载的默认值一致。 */
const DEFAULT_DEV_PORT = 5173;

/**
 * 解析开发端口。
 *
 * 显式设置 `VCPDECK_FRONTEND_PORT` 时严格占用：撞车直接启动失败，而不是像
 * Vite 默认行为那样静默 +1——换号后 `VCPDECK_FRONTEND_ORIGIN` 等外部配置
 * 仍指向旧端口，只有让启动失败才能逼出这处不一致。
 */
function resolveDevPort(): { port: number; strictPort: boolean } {
	const raw = process.env.VCPDECK_FRONTEND_PORT?.trim();
	if (!raw) return { port: DEFAULT_DEV_PORT, strictPort: false };
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(
			`VCPDECK_FRONTEND_PORT 非法: ${raw}（需要 1–65535 整数）`,
		);
	}
	return { port, strictPort: true };
}

const devPort = resolveDevPort();

export default defineConfig({
	plugins: [tailwindcss()],
	resolve: {
		alias: {
			"@": sourceDir,
		},
	},
	// ADR-0011 modern evergreen 浏览器基线：dev 转换与打包均使用 es2022
	// （build.target 仅影响打包，不影响 dev 转换）
	esbuild: { target: "es2022" },
	build: {
		target: "es2022",
		commonjsOptions: {
			include: [/node_modules/, /packages[\\/]shared[\\/]/],
		},
	},
	optimizeDeps: {
		// 链接的 CJS workspace 包需 esbuild 预打包才能在 dev 提供命名导出
		include: ["@vcpdeck/shared"],
		// workspace 包 dist 变化后强制重新预打包，避免陈旧缓存（如 Buffer 实现替换）
		force: true,
		esbuildOptions: { target: "es2022" },
	},
	server: {
		host: "0.0.0.0",
		// 5173 被占用时 Vite 默认静默 +1，这里保留该行为以便直接开工；
		// 要固定端口就设 VCPDECK_FRONTEND_PORT（此时 strictPort 为真，撞车即失败）
		port: devPort.port,
		strictPort: devPort.strictPort,
		proxy: {
			"/api": "http://localhost:3001",
			"/socket.io": { target: "http://localhost:3001", ws: true },
		},
	},
});
