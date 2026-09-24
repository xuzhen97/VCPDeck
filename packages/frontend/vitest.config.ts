import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const sourceDir = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			"@": sourceDir,
		},
	},
	test: {
		environment: "jsdom",
		setupFiles: ["./src/test-setup.ts"],
		// vendored pi-web 上游测试用 node:test + jiti，由 `test:pi-web` 独立运行，不走 vitest
		exclude: [...configDefaults.exclude, "src/pi-web/**"],
	},
});
