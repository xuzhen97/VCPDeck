const esbuild = require("esbuild");
const path = require("path");

esbuild.buildSync({
	entryPoints: [path.join(__dirname, "..", "dist", "index.js")],
	bundle: true,
	platform: "node",
	target: "node18",
	outfile: path.join(
		__dirname,
		"..",
		"..",
		"..",
		"plugins",
		"vcpdeck",
		"index.cjs",
	),
	banner: { js: "#!/usr/bin/env node" },
});
