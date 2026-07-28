const path = require("path");
const { execSync } = require("child_process");

// Resolve prisma CLI from pnpm store
const prismaDir = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "node_modules",
  ".pnpm",
  "prisma@7.9.0_@types+react-d_532c9a02ffea52eec9a4cd54aa643844",
  "node_modules",
  "prisma",
  "build",
  "index.js"
);

const schemaPath = path.join(__dirname, "..", "prisma", "schema.prisma");

const result = execSync(
  'node ' + JSON.stringify(prismaDir) + ' generate --schema=' + JSON.stringify(schemaPath),
  { cwd: path.join(__dirname, ".."), encoding: "utf8", maxBuffer: 1024 * 1024, shell: true }
);
console.log(result);
