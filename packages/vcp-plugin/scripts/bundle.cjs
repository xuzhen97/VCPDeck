const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");
const archiverModule = require("archiver");
const ZipArchive = archiverModule.ZipArchive || archiverModule.default || archiverModule;

const rootDir = path.join(__dirname, "..", "..", "..");
const pluginDir = path.join(rootDir, "plugins", "vcpdeck");
const distDir = path.join(rootDir, "dist");

// 1. esbuild 打包 index.cjs
esbuild.buildSync({
	entryPoints: [path.join(__dirname, "..", "dist", "index.js")],
	bundle: true,
	platform: "node",
	target: "node18",
	outfile: path.join(pluginDir, "index.cjs"),
	banner: { js: "#!/usr/bin/env node" },
});

// 2. 将 plugins/vcpdeck 打包为 dist/VCPDeckBridge.zip 供商店索引下载
if (!fs.existsSync(distDir)) {
	fs.mkdirSync(distDir, { recursive: true });
}

const zipPath = path.join(distDir, "VCPDeckBridge.zip");
const output = fs.createWriteStream(zipPath);
const archive = typeof ZipArchive === "function" ? (ZipArchive.prototype ? new ZipArchive({ zlib: { level: 9 } }) : ZipArchive("zip", { zlib: { level: 9 } })) : new archiverModule.ZipArchive({ zlib: { level: 9 } });

output.on("close", () => {
	console.log(
		`[vcp-plugin] Successfully packaged dist/VCPDeckBridge.zip (${archive.pointer()} bytes)`,
	);
});

archive.on("error", (err) => {
	throw err;
});

archive.pipe(output);
archive.file(path.join(pluginDir, "plugin-manifest.json"), {
	name: "plugin-manifest.json",
});
archive.file(path.join(pluginDir, "index.cjs"), { name: "index.cjs" });
archive.file(path.join(pluginDir, "config.env.example"), {
	name: "config.env.example",
});
archive.finalize();
