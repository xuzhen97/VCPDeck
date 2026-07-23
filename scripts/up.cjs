const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function run(name, cwd, cmd, args) {
  const p = spawn(cmd, args, { cwd, stdio: "pipe", shell: true });
  p.stdout.on("data", (d) =>
    d
      .toString()
      .split("\n")
      .filter(Boolean)
      .forEach((l) => console.log(`[${name}] ${l}`)),
  );
  p.stderr.on("data", (d) =>
    d
      .toString()
      .split("\n")
      .filter(Boolean)
      .forEach((l) => console.error(`[${name}] ${l}`)),
  );
  p.on("close", (code) => {
    if (code !== 0 && code !== null)
      console.error(`[${name}] exited with code ${code}`);
  });
  return p;
}

console.log("Starting VCPDeck...");

const serverDir = path.join(root, "packages/server");
const clientDir = path.join(root, "packages/client");

run("server", serverDir, "pnpm", ["start"]);

setTimeout(() => {
  run("client", clientDir, "pnpm", ["start"]);
}, 3000);
