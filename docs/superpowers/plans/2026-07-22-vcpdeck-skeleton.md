# VCPDeck 项目骨架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建 monorepo 骨架，`pnpm build` 可构建，零功能代码。

**Architecture:** pnpm workspace monorepo，5 个 packages + 1 个 Pi skill。`shared` 为基础，其余并行依赖它。`cli` postbuild 通过 esbuild 将产物写入 `skills/vcpdeck/dist/`。

**Tech Stack:** TypeScript, pnpm, tsc, esbuild, NestJS, React, Vite

## Global Constraints

- Node.js >= 18
- pnpm >= 8
- 零功能代码 — 仅构建骨架
- 包名 `@vcpdeck/*`
- CLI 命令前缀 `vcpdeck`

---

### Task 1: 根目录配置文件

**Files:**

- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`

**Interfaces:**

- Produces: workspace 配置，`pnpm -r build` 可用

- [ ] **Step 1: 创建 root `package.json`**

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

- [ ] **Step 2: 创建 `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 3: 创建 `tsconfig.base.json`**

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

- [ ] **Step 4: 创建 `.gitignore`**

```
node_modules/
dist/
*.tsbuildinfo
skills/vcpdeck/dist/
```

- [ ] **Step 5: 提交**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .gitignore
git commit -m "chore: 根目录 monorepo 配置"
```

---

### Task 2: packages/shared

**Files:**

- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`

**Interfaces:**

- Produces: `@vcpdeck/shared` — 可由其他包引用的共享包

- [ ] **Step 1: 创建目录结构**

```bash
mkdir -p packages/shared/src
```

- [ ] **Step 2: 创建 `packages/shared/package.json`**

```json
{
  "name": "@vcpdeck/shared",
  "version": "0.0.0",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  }
}
```

- [ ] **Step 3: 创建 `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

- [ ] **Step 4: 创建 `packages/shared/src/index.ts`**

```ts
export const VERSION = "0.0.0";
```

- [ ] **Step 5: 验证构建**

```bash
cd packages/shared && pnpm build
```

Expected: 输出 `dist/index.js` + `dist/index.d.ts`

- [ ] **Step 6: 提交**

```bash
git add packages/shared/
git commit -m "chore: packages/shared 骨架"
```

---

### Task 3: packages/server

**Files:**

- Create: `packages/server/package.json`
- Create: `packages/server/tsconfig.json`
- Create: `packages/server/src/main.ts`
- Create: `packages/server/src/app.module.ts`

**Interfaces:**

- Consumes: `@vcpdeck/shared` (workspace 引用)
- Produces: NestJS 空应用，监听 :3001

- [ ] **Step 1: 创建目录结构**

```bash
mkdir -p packages/server/src
```

- [ ] **Step 2: 创建 `packages/server/package.json`**

```json
{
  "name": "@vcpdeck/server",
  "version": "0.0.0",
  "private": true,
  "main": "./dist/main.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/main.ts"
  },
  "dependencies": {
    "@vcpdeck/shared": "workspace:*",
    "@nestjs/common": "^10.4.0",
    "@nestjs/core": "^10.4.0",
    "@nestjs/platform-express": "^10.4.0",
    "@nestjs/platform-socket.io": "^10.4.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1"
  },
  "devDependencies": {
    "tsx": "^4.19.0"
  }
}
```

- [ ] **Step 3: 创建 `packages/server/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: 创建 `packages/server/src/app.module.ts`**

```ts
import { Module } from "@nestjs/common";

@Module({})
export class AppModule {}
```

- [ ] **Step 5: 创建 `packages/server/src/main.ts`**

```ts
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3001);
  console.log("VCPDeck server listening on http://localhost:3001");
}

bootstrap();
```

- [ ] **Step 6: 验证构建**

```bash
cd packages/server && pnpm build
```

Expected: 输出 `dist/main.js` + `dist/app.module.js`，无类型错误

- [ ] **Step 7: 提交**

```bash
git add packages/server/
git commit -m "chore: packages/server 骨架"
```

---

### Task 4: packages/client

**Files:**

- Create: `packages/client/package.json`
- Create: `packages/client/tsconfig.json`
- Create: `packages/client/src/index.ts`

**Interfaces:**

- Consumes: `@vcpdeck/shared`
- Produces: 占位函数 `connect()`

- [ ] **Step 1: 创建目录结构**

```bash
mkdir -p packages/client/src
```

- [ ] **Step 2: 创建 `packages/client/package.json`**

```json
{
  "name": "@vcpdeck/client",
  "version": "0.0.0",
  "private": true,
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsc"
  },
  "dependencies": {
    "@vcpdeck/shared": "workspace:*",
    "socket.io-client": "^4.7.5"
  }
}
```

- [ ] **Step 3: 创建 `packages/client/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

- [ ] **Step 4: 创建 `packages/client/src/index.ts`**

```ts
export function connect() {
  // TODO: Socket.IO client 连接逻辑
}
```

- [ ] **Step 5: 验证构建**

```bash
cd packages/client && pnpm build
```

Expected: 输出 `dist/index.js`

- [ ] **Step 6: 提交**

```bash
git add packages/client/
git commit -m "chore: packages/client 骨架"
```

---

### Task 5: packages/cli

**Files:**

- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/src/index.ts`
- Create: `packages/cli/scripts/bundle.cjs`

**Interfaces:**

- Consumes: `@vcpdeck/shared`
- Produces: `cli.run(argv)` 函数；postbuild 写入 `skills/vcpdeck/dist/vcpdeck.cjs`

- [ ] **Step 1: 创建目录结构**

```bash
mkdir -p packages/cli/src packages/cli/scripts
```

- [ ] **Step 2: 创建 `packages/cli/package.json`**

```json
{
  "name": "@vcpdeck/cli",
  "version": "0.0.0",
  "private": true,
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsc && node scripts/bundle.cjs"
  },
  "dependencies": {
    "@vcpdeck/shared": "workspace:*"
  },
  "devDependencies": {
    "esbuild": "^0.24.0"
  }
}
```

- [ ] **Step 3: 创建 `packages/cli/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

- [ ] **Step 4: 创建 `packages/cli/src/index.ts`**

```ts
export function run(argv: string[]) {
  console.log("vcpdeck");
}
```

- [ ] **Step 5: 创建 `packages/cli/scripts/bundle.cjs`**

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

- [ ] **Step 6: 验证构建**

```bash
mkdir -p skills/vcpdeck/dist
cd packages/cli && pnpm build
```

Expected: `skills/vcpdeck/dist/vcpdeck.cjs` 生成

- [ ] **Step 7: 提交**

```bash
git add packages/cli/
git commit -m "chore: packages/cli 骨架"
```

---

### Task 6: packages/frontend

**Files:**

- Create: `packages/frontend/package.json`
- Create: `packages/frontend/tsconfig.json`
- Create: `packages/frontend/tsconfig.node.json`
- Create: `packages/frontend/vite.config.ts`
- Create: `packages/frontend/index.html`
- Create: `packages/frontend/src/main.tsx`
- Create: `packages/frontend/src/App.tsx`

**Interfaces:**

- Consumes: `@vcpdeck/shared`, `react`, `react-dom`
- Produces: Vite SPA，渲染 `<h1>VCPDeck</h1>`

- [ ] **Step 1: 创建目录结构**

```bash
mkdir -p packages/frontend/src
```

- [ ] **Step 2: 创建 `packages/frontend/package.json`**

```json
{
  "name": "@vcpdeck/frontend",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc && vite build",
    "dev": "vite"
  },
  "dependencies": {
    "@vcpdeck/shared": "workspace:*",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.5.0",
    "vite": "^5.4.0"
  }
}
```

- [ ] **Step 3: 创建 `packages/frontend/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "rootDir": "src",
    "outDir": "dist",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "noEmit": true
  },
  "include": ["src"],
  "references": [
    { "path": "./tsconfig.node.json" }
  ]
}
```

- [ ] **Step 4: 创建 `packages/frontend/tsconfig.node.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "composite": true
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 5: 创建 `packages/frontend/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
});
```

- [ ] **Step 6: 创建 `packages/frontend/index.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>VCPDeck</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 7: 创建 `packages/frontend/src/App.tsx`**

```tsx
export default function App() {
  return <h1>VCPDeck</h1>;
}
```

- [ ] **Step 8: 创建 `packages/frontend/src/main.tsx`**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

- [ ] **Step 9: 验证构建**

```bash
cd packages/frontend && pnpm build
```

Expected: `dist/` 包含 `index.html` + 静态 JS/CSS

- [ ] **Step 10: 提交**

```bash
git add packages/frontend/
git commit -m "chore: packages/frontend 骨架"
```

---

### Task 7: skills/vcpdeck

**Files:**

- Create: `skills/vcpdeck/SKILL.md`
- Create: `skills/vcpdeck/run.cjs`

**Interfaces:**

- Consumes: `skills/vcpdeck/dist/vcpdeck.cjs`（由 cli postbuild 写入）
- Produces: Pi Agent Skill，描述触发条件和入口

- [ ] **Step 1: 创建目录结构**

```bash
mkdir -p skills/vcpdeck
```

- [ ] **Step 2: 创建 `skills/vcpdeck/SKILL.md`**

````markdown
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
````

- [ ] **Step 3: 创建 `skills/vcpdeck/run.cjs`**

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

- [ ] **Step 4: 提交**

```bash
git add skills/vcpdeck/
git commit -m "chore: skills/vcpdeck Pi Agent Skill"
```

---

### Task 8: 全量构建验证

**Files:** 无新建

**Interfaces:** 无

- [ ] **Step 1: 安装依赖**

```bash
pnpm install
```

Expected: 所有 workspace 包依赖安装成功

- [ ] **Step 2: 全量构建**

```bash
pnpm build
```

Expected: 每个包 `dist/` 生成，`skills/vcpdeck/dist/vcpdeck.cjs` 存在

- [ ] **Step 3: 验证 CLI 产物可执行**

```bash
node skills/vcpdeck/run.cjs
```

Expected: 输出 `vcpdeck`

- [ ] **Step 4: 验证 server 可启动**

```bash
cd packages/server && node dist/main.js
# Ctrl+C 停止确认启动正常
```

Expected: log `VCPDeck server listening on http://localhost:3001`

- [ ] **Step 5: 提交**

```bash
git add pnpm-lock.yaml
git commit -m "chore: pnpm-lock.yaml"
```
