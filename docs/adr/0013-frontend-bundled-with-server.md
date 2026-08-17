# ADR-0013：Frontend 构建产物随 Server 构件分发并同源托管

- 状态：Accepted
- 日期：2026-08-17
- 决策者：项目维护者
- 关联：[`docs/quickstart.md`](../quickstart.md)、[`docs/deployment.md`](../deployment.md)、[`docs/architecture.md`](../architecture.md)、[`ADR-0012`](./0012-bundled-release-artifacts.md)

## 背景

ADR-0012 之后发布包完成了 Server/Client 的"单包交付"，但 Frontend 仍是唯一缺口：`packages/frontend/dist` 不在任何发布构件内，运维需要单独构建、自备静态托管或反向代理，并与 Server 保持同版本（quickstart/deployment 均将其列为独立部署项）。对控制面主机来说，这增加了部署拓扑与版本漂移成本。

## 决策

### 1. Frontend 构建产物打进 server 构件

- `pnpm release` 在 staging 阶段先构建 `@vcpdeck/frontend`，把 `packages/frontend/dist` 复制到 server 构件的 `public/` 目录（manifest 结构与 Launcher 行为不变，entry 仍是 `dist/main.js`）；
- 找不到构建产物时打包直接失败（防静默缺失），开发者可明确用 `pnpm --filter @vcpdeck/frontend build` 修复。

### 2. Server 用 express.static 同源托管 + SPA 回退

- Server 启动时按候选目录解析静态根（发布构件 `<server>/public`、monorepo 构建产物 `packages/frontend/dist`，兼容 tsc/tsx/esbuild 三种编译形态的 `__dirname` 深度），找不到时仅提供 API 并告警，不阻断启动（开发环境仍由 Vite 提供）；
- `app.useStaticAssets()` 挂 express.static（仅服务真实文件），随后挂一个自实现的 SPA 回退中间件：非 `/api`、`/client`、`/app` 前缀的 HTML GET/HEAD 请求返回 `index.html`（react-router 前端路由），其余交给 Nest 路由保持 API 404 JSON 语义；
- 不引入 `@nestjs/serve-static`：express.static 已由 platform-express 提供，回退行为用约 10 行中间件显式控制，避免 serve-static 的 exclude/renderPath 语义依赖。

### 3. socket.io 同源 CORS

- Nest 的 namespace 级 cors 装饰器在 Engine 层只取第一个网关配置；同源模式下页面 Origin 为 `http://<host>:3001`，会与默认 `localhost:5173` 不符导致 `/app`（浏览器终端等）被 CORS 拒绝；
- 自定义 `FrontendOriginIoAdapter`（继承 IoAdapter，必须传入 `app.getHttpServer()`）把 socket.io Server 级 cors 改为函数形式，在每个 Engine 请求上拿到完整 req，判定：无 Origin（Node/CLI 客户端）、显式配置跨源（`VCPDECK_FRONTEND_ORIGIN` / `VCPDECK_CORS_ORIGIN`）或同源（Origin 等于请求 Host）放行，其余跨源拒绝；
- 不放宽到 `origin: true`：`/app` 以 Cookie session 鉴权（CSWSH 风险真实存在），同源反射 + 配置白名单是安全上界。

## 不做的事

- 不做前端资源 hash 缓存协商之外的缓存策略（随包走 ETag/Last-Modified）；
- 不把 Frontend 与 Server 拆进程或容器化的托管纳管进本 ADR；
- 不改变开发模式：dev 仍由 Vite :5173 提供，`VCPDECK_FRONTEND_ORIGIN` 默认值不变。

## 后果

**正面**：

- 发布包成为真正的"单包交付"：控制面主机解压 server 构件即可获得同版本 Frontend，无需单独构建、静态托管或版本对齐；
- 部署拓扑简化：无反向代理也可用，跨源部署仍支持（设置 `VCPDECK_FRONTEND_ORIGIN`）；
- 自动更新后 Frontend 与 Server 天然同版本（随包）。

**风险与代价**：

- 发布冒烟需新增"首页可达 + API 同源可用"验证点；
- SPA 回退对非前端资源误回归的风险存在，通过前缀白名单与 `/assets/` 真实文件优先规避；
- 同源判定依赖 Host 头，代理部署场景（x-forwarded-host）需在反向代理层修正 Host 或在 `VCPDECK_FRONTEND_ORIGIN` 显式配置。
