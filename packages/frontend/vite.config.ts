import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const sourceDir = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
	plugins: [tailwindcss()],
	resolve: {
		alias: {
			"@": sourceDir,
		},
	},
	build: {
		commonjsOptions: {
			include: [/node_modules/, /packages[\\/]shared[\\/]/],
		},
	},
	optimizeDeps: {
		// 链接的 CJS workspace 包需 esbuild 预打包才能在 dev 提供命名导出
		include: ["@vcpdeck/shared"],
		// workspace 包 dist 变化后强制重新预打包，避免陈旧缓存（如 Buffer 实现替换）
		force: true,
	},
	server: {
		host: "0.0.0.0",
		proxy: {
			"/api": "http://localhost:3001",
			"/socket.io": { target: "http://localhost:3001", ws: true },
		},
	},
});
