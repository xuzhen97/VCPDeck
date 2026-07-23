const { defineConfig } = require("@prisma/config");

module.exports = defineConfig({
	datasource: {
		url: "file:./prisma/dev.db",
	},
});
