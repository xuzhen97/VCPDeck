import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const sourceDir = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
	plugins: [tailwindcss()],
	resolve: {
		alias: {
			"@": sourceDir,
			// vendored pi-web 渲染层的 node 内建适配（ADR-0032：本地文件功能不接线）
			path: "path-browserify",
			fs: fileURLToPath(new URL("./src/pi-web/shims/fs.ts", import.meta.url)),
			crypto: fileURLToPath(new URL("./src/pi-web/shims/crypto.ts", import.meta.url)),
		},
	},
	// noVNC 1.7 的 WebCodecs 能力探测使用顶层 await，dev 转换也需 es2022；
	// 与 ADR-0011 modern evergreen 浏览器基线一致（build.target 仅影响打包，不影响 dev 转换）
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
		// 依赖预打包同样需支持顶层 await（noVNC）
		esbuildOptions: { target: "es2022" },
	},
	server: {
		host: "0.0.0.0",
		proxy: {
			"/api": "http://localhost:3001",
			"/socket.io": { target: "http://localhost:3001", ws: true },
		},
	},
});
