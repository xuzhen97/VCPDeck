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
	server: {
		host: "0.0.0.0",
		proxy: {
			"/api": "http://localhost:3001",
		},
	},
});
