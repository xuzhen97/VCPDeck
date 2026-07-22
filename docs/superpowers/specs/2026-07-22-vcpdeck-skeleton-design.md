# VCPDeck 项目骨架设计

> 目的：创建 monorepo 骨架，`pnpm build` 可构建，零功能代码。

## 构建拓扑

```
        shared (tsc)
       /   |   \   \
    cli  server client frontend
   (tsc) (tsc) (tsc) (vite)
    |
    └→ skills/vcpdeck/dist/vcpdeck.cjs (cli postbuild: esbuild bundle)
```

## 包清单

| 包 | name | 构建 | 输出 | 依赖 |
|---|---|---|---|---|
| `packages/shared` | `@vcpdeck/shared` | `tsc` | `dist/` | 无 |
| `packages/server` | `@vcpdeck/server` | `tsc` | `dist/main.js` | `shared`, nestjs |
| `packages/client` | `@vcpdeck/client` | `tsc` | `dist/index.js` | `shared`, socket.io-client |
| `packages/cli` | `@vcpdeck/cli` | `tsc` + esbuild | `dist/` → `skills/vcpdeck/dist/vcpdeck.cjs` | `shared` |
| `packages/frontend` | `@vcpdeck/frontend` | `vite build` | `dist/` (静态) | `shared`, react, vite |
| `skills/vcpdeck` | — | 无（产物由 cli 写入） | `dist/vcpdeck.cjs` | 仅 Node.js |

## 根目录

### package.json

```json
{
  "name": "vcpdeck",
  "private": true,
  "scripts": {
    "build": "pnpm -r build",
    "dev": "pnpm -r --parallel dev",
    "lint": "pnpm -r lint"
  }
}
```

### pnpm-workspace.yaml

```yaml
packages:
  - "packages/*"
```

### tsconfig.base.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "composite": true,
    "skipLibCheck": true
  }
}
```

### .gitignore

```
node_modules/
dist/
*.tsbuildinfo
skills/vcpdeck/dist/
```

## 各包结构

### packages/shared

```
shared/
├── package.json
├── tsconfig.json
└── src/
    └── index.ts
```

`package.json`:

- `"name": "@vcpdeck/shared"`
- `"main": "./dist/index.js"`
- `"types": "./dist/index.d.ts"`
- `"exports": { ".": "./dist/index.js" }`
- `"scripts": { "build": "tsc" }`

`src/index.ts`: 占位 `export const VERSION = "0.0.0";`

### packages/server

```
server/
├── package.json
├── tsconfig.json
└── src/
    ├── main.ts
    └── app.module.ts
```

`package.json`:

- `"name": "@vcpdeck/server"`
- `"scripts": { "build": "tsc", "dev": "tsx watch src/main.ts" }`
- 依赖: `@vcpdeck/shared`, `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`, `@nestjs/platform-socket.io`, `reflect-metadata`, `rxjs`

`src/main.ts`: NestJS bootstrap，`NestFactory.create(AppModule)`，监听 3001，log 启动信息。

`src/app.module.ts`: 空 `@Module({})`。

### packages/client

```
client/
├── package.json
├── tsconfig.json
└── src/
    └── index.ts
```

`package.json`:

- `"name": "@vcpdeck/client"`
- `"scripts": { "build": "tsc" }`
- 依赖: `@vcpdeck/shared`, `socket.io-client`

`src/index.ts`: 占位 `export function connect() {} // TODO`

### packages/cli

```
cli/
├── package.json
├── tsconfig.json
├── scripts/
│   └── bundle.cjs
└── src/
    └── index.ts
```

`package.json`:

- `"name": "@vcpdeck/cli"`
- `"scripts": { "build": "tsc && node scripts/bundle.cjs" }`
- 依赖: `@vcpdeck/shared`, `esbuild` (devDep)

`src/index.ts`: 占位 `export function run(argv: string[]) { console.log("vcpdeck"); }`

`scripts/bundle.cjs`:

```js
const esbuild = require("esbuild");
const path = require("path");

esbuild.buildSync({
  entryPoints: [path.join(__dirname, "..", "dist", "index.js")],
  bundle: true,
  platform: "node",
  target: "node18",
  outfile: path.join(__dirname, "..", "..", "..", "skills", "vcpdeck", "dist", "vcpdeck.cjs"),
  banner: { js: "#!/usr/bin/env node" },
});
```

### packages/frontend

```
frontend/
├── package.json
├── tsconfig.json
├── tsconfig.node.json
├── vite.config.ts
├── index.html
└── src/
    ├── main.tsx
    └── App.tsx
```

`package.json`:

- `"name": "@vcpdeck/frontend"`
- `"scripts": { "build": "tsc && vite build", "dev": "vite" }`
- 依赖: `react`, `react-dom`; devDep: `@vitejs/plugin-react`, `vite`, `@types/react`, `@types/react-dom`, `@vcpdeck/shared`

`src/App.tsx`:

```tsx
export default function App() {
  return <h1>VCPDeck</h1>;
}
```

`src/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode><App /></StrictMode>
);
```

### skills/vcpdeck

```
skills/vcpdeck/
├── SKILL.md
├── run.cjs
└── dist/                 # gitignored，cli postbuild 产物
    └── vcpdeck.cjs
```

`SKILL.md`:

```markdown
---
name: vcpdeck
description: Use VCPDeck cockpit capabilities from Pi - manage machines, deploy, check logs, restart services, create TODOs. Trigger when user wants to interact with remote machines, deploy code, or manage tasks through VCPDeck.
---

# VCPDeck

Your personal AI collaboration cockpit.

## Setup

```bash
node ./run.cjs config show
```

## First Steps

```bash
node ./run.cjs --help
```

```

`run.cjs`:
```js
#!/usr/bin/env node
const path = require("node:path");
const entry = path.join(__dirname, "dist", "vcpdeck.cjs");
const cli = require(entry);
if (!cli || typeof cli.run !== "function") {
  throw new Error(`Bundled CLI does not export run(): ${entry}`);
}
Promise.resolve(cli.run(process.argv.slice(2))).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
```

## pnpm build 验证预期

```bash
pnpm build
```

应输出每个包的 `dist/`，`skills/vcpdeck/dist/vcpdeck.cjs` 存在且可执行：

```bash
node skills/vcpdeck/run.cjs
# → vcpdeck
```

`packages/frontend/dist/` 包含 `index.html` + 静态资源。
