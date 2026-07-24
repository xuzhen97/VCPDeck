# 身份认证系统 — 人工验收指南

> 基于 `docs/superpowers/specs/2025-07-15-identity-authentication-design.md`
>
> 适用版本：身份认证 v1（浏览器登录 + CLI Token + admin 管理）

## 前置条件

- Server 已构建：`pnpm build`
- 项目依赖已安装：`pnpm install`

---

## 1. 启动 Server

```bash
cd packages/server && VCPDECK_ADMIN_PASSWORD=test123 VCPDECK_FRONTEND_ORIGIN=http://localhost:5173 pnpm start
```

首次启动会自动创建 admin 身份（用户名为 `VCPDECK_ADMIN_USERNAME`，默认 `admin`）。

预期输出：

```
[bootstrap] admin identity created: admin
[Nest] ... Nest application successfully started
VCPDeck server listening on http://localhost:3001
```

已有 admin 身份时不重复创建。

---

## 2. 验收公开接口

以下接口不需要认证：

```bash
node -e "fetch('http://localhost:3001/api/health').then(r=>r.json()).then(console.log)"
```

预期：`{ ok: true }`

---

## 3. 验收登录

### 3a. 正确密码登录

```bash
node -e "
fetch('http://localhost:3001/api/auth/login', {
  method:'POST',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify({username:'admin',password:'test123'})
}).then(r=>{console.log('Status:',r.status);console.log('Set-Cookie:',r.headers.get('set-cookie'));return r.json()}).then(console.log)
"
```

预期：

- Status: `201`
- Set-Cookie: 包含 `vcpdeck_session=...; HttpOnly; SameSite=Strict`
- Body: `{ identity: { id, username: "admin", displayName: "admin", isAdmin: true } }`

### 3b. 错误密码登录

```bash
node -e "
fetch('http://localhost:3001/api/auth/login', {
  method:'POST',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify({username:'admin',password:'wrong'})
}).then(r=>{console.log('Status:',r.status);return r.json()}).then(console.log)
"
```

预期：Status `401`，Body 包含 `code: "AUTH_INVALID"`

---

## 4. 验收认证守卫

### 4a. 无认证请求被拒绝

```bash
node -e "
fetch('http://localhost:3001/api/clients').then(r=>{console.log('Status:',r.status);return r.json()}).then(console.log)
"
```

预期：Status `401`，Body 包含 `code: "AUTH_REQUIRED"`

### 4b. 带 Cookie 可正常访问

用步骤 3a 保存的 Cookie：

```bash
node -e "
fetch('http://localhost:3001/api/clients', {
  headers:{'Cookie':'vcpdeck_session=<步骤3a获得的session-token>'}
}).then(r=>{console.log('Status:',r.status);return r.json()}).then(console.log)
"
```

预期：Status `200`，返回 `[]` 或 client 数组

### 4c. 查看当前身份

```bash
node -e "
fetch('http://localhost:3001/api/auth/me', {
  headers:{'Cookie':'vcpdeck_session=<步骤3a获得的session-token>'}
}).then(r=>{console.log('Status:',r.status);return r.json()}).then(console.log)
"
```

预期：返回 `{ id, username, displayName, isAdmin, disabledAt, createdAt }`

---

## 5. 验收 CLI Token

### 5a. 生成 Token

```bash
node -e "
fetch('http://localhost:3001/api/auth/tokens', {
  method:'POST',
  headers:{
    'Content-Type':'application/json',
    'Cookie':'vcpdeck_session=<session-token>'
  },
  body:JSON.stringify({label:'办公电脑'})
}).then(r=>{console.log('Status:',r.status);return r.json()}).then(console.log)
"
```

预期：

- Status `201`
- Body 包含 `token` 字段，以 `vcp_` 开头（**仅显示一次**）
- Body 包含 `label: "办公电脑"`

### 5b. 用 Bearer Token 调用 API

```bash
TOKEN=vcp_xxxxx  # 替换为步骤5a获得的token

node -e "
fetch('http://localhost:3001/api/clients', {
  headers:{'Authorization':'Bearer $TOKEN'}
}).then(r=>{console.log('Status:',r.status);return r.json()}).then(console.log)
"
```

预期：Status `200`，返回正常数据（与带 Cookie 相同）

### 5c. 撤销 Token

```bash
node -e "
fetch('http://localhost:3001/api/auth/tokens', {
  headers:{'Cookie':'vcpdeck_session=<session-token>'}
}).then(r=>r.json()).then(tokens=>{
  const id=tokens[tokens.length-1].id;
  fetch('http://localhost:3001/api/auth/tokens/'+id, {
    method:'DELETE',
    headers:{'Cookie':'vcpdeck_session=<session-token>'}
  }).then(r=>{console.log('Revoke status:',r.status);return r.json()}).then(console.log)
})
"
```

预期：Status `200`，`{ ok: true }`

### 5d. 确认撤销后的 Token 失效

```bash
TOKEN=vcp_xxxxx  # 同一token

node -e "
fetch('http://localhost:3001/api/clients', {
  headers:{'Authorization':'Bearer $TOKEN'}
}).then(r=>{console.log('Status:',r.status);return r.json()}).then(console.log)
"
```

预期：Status `401`，Body 包含 `code: "AUTH_REVOKED"` 或 `"AUTH_INVALID"`

---

## 6. 验收身份管理（admin）

### 6a. 创建身份

```bash
node -e "
fetch('http://localhost:3001/api/identities', {
  method:'POST',
  headers:{
    'Content-Type':'application/json',
    'Cookie':'vcpdeck_session=<session-token>'
  },
  body:JSON.stringify({username:'zhangsan',password:'pass456',displayName:'张三'})
}).then(r=>{console.log('Status:',r.status);return r.json()}).then(console.log)
"
```

预期：

- Status `201`
- Body 含 `{ id, username: "zhangsan", displayName: "张三", isAdmin: false, ... }`

### 6b. 列出所有身份

```bash
node -e "
fetch('http://localhost:3001/api/identities', {
  headers:{'Cookie':'vcpdeck_session=<session-token>'}
}).then(r=>r.json()).then(console.log)
"
```

预期：数组，包含 admin 和新创建的 zhangsan

### 6c. 禁用身份

```bash
# 用 6b 获取 zhangsan 的 id，替换 <identityId>
node -e "
fetch('http://localhost:3001/api/identities/<identityId>/disable', {
  method:'POST',
  headers:{'Cookie':'vcpdeck_session=<session-token>'}
}).then(r=>{console.log('Status:',r.status);return r.json()}).then(console.log)
"
```

预期：Status `201`

### 6d. 确认禁用后无法登录

```bash
node -e "
fetch('http://localhost:3001/api/auth/login', {
  method:'POST',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify({username:'zhangsan',password:'pass456'})
}).then(r=>{console.log('Status:',r.status);return r.json()}).then(console.log)
"
```

预期：Status `401`，含 `code: "IDENTITY_DISABLED"`

### 6e. 启用身份

```bash
node -e "
fetch('http://localhost:3001/api/identities/<identityId>/enable', {
  method:'POST',
  headers:{'Cookie':'vcpdeck_session=<session-token>'}
}).then(r=>{console.log('Status:',r.status);return r.json()}).then(console.log)
"
```

预期：Status `201`

### 6f. 启用后重新登录

```bash
node -e "
fetch('http://localhost:3001/api/auth/login', {
  method:'POST',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify({username:'zhangsan',password:'pass456'})
}).then(r=>{console.log('Status:',r.status);return r.json()}).then(console.log)
"
```

预期：Status `201`，正常返回 identity

---

## 7. 验收非 admin 权限限制

### 7a. 以 zhangsan 身份登录

```bash
node -e "
fetch('http://localhost:3001/api/auth/login', {
  method:'POST',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify({username:'zhangsan',password:'pass456'})
}).then(r=>{console.log('Status:',r.status);console.log('Cookie:',r.headers.get('set-cookie'));return r.json()}).then(console.log)
"
```

保存返回的 Cookie。

### 7b. 访问身份管理接口

```bash
node -e "
fetch('http://localhost:3001/api/identities', {
  headers:{'Cookie':'vcpdeck_session=<zhangsan的session>'}
}).then(r=>{console.log('Status:',r.status);return r.json()}).then(console.log)
"
```

预期：Status `403`，含 `code: "FORBIDDEN"`

### 7c. 但可以正常使用业务接口

```bash
node -e "
fetch('http://localhost:3001/api/clients', {
  headers:{'Cookie':'vcpdeck_session=<zhangsan的session>'}
}).then(r=>{console.log('Status:',r.status);return r.json()}).then(console.log)
"
```

预期：Status `200`，正常返回

---

## 8. 验收修改个人信息

### 8a. 修改用户名

```bash
node -e "
fetch('http://localhost:3001/api/auth/me', {
  method:'PUT',
  headers:{
    'Content-Type':'application/json',
    'Cookie':'vcpdeck_session=<session-token>'
  },
  body:JSON.stringify({username:'admin_new',currentPassword:'test123'})
}).then(r=>{console.log('Status:',r.status);return r.json()}).then(console.log)
"
```

预期：Status `200`，`{ ok: true }`

### 8b. 用新用户名登录

```bash
node -e "
fetch('http://localhost:3001/api/auth/login', {
  method:'POST',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify({username:'admin_new',password:'test123'})
}).then(r=>{console.log('Status:',r.status);return r.json()}).then(console.log)
"
```

预期：Status `201`，正常返回

### 8c. 改回原用户名（确认后清db测试数据时恢复）

---

## 9. 验收登出

### 9a. 登出

```bash
node -e "
fetch('http://localhost:3001/api/auth/logout', {
  method:'POST',
  headers:{'Cookie':'vcpdeck_session=<session-token>'}
}).then(r=>{console.log('Status:',r.status);return r.json()}).then(console.log)
"
```

预期：Status `201`，`{ ok: true }`

### 9b. 确认登出后 Session 失效

```bash
node -e "
fetch('http://localhost:3001/api/auth/me', {
  headers:{'Cookie':'vcpdeck_session=<刚才的session-token>'}
}).then(r=>{console.log('Status:',r.status);return r.json()}).then(console.log)
"
```

预期：Status `401`

---

## 10. 验收 Job 审计归属

### 10a. 以 admin 创建 Job

```bash
# 先登录 admin
# 获取 clientId
CLIENT_ID=$(node -e "
fetch('http://localhost:3001/api/clients',{headers:{'Cookie':'<cookie>'}}).then(r=>r.json()).then(c=>console.log(c[0]?.clientId))
")

# 创建 Job
node -e "
fetch('http://localhost:3001/api/jobs',{method:'POST',headers:{'Content-Type':'application/json','Cookie':'<cookie>'},body:JSON.stringify({clientId:'$CLIENT_ID',type:'exec',payload:{command:'echo hello'}})}).then(r=>r.json()).then(console.log)
"
```

预期：返回含 `jobId` 的对象

### 10b. 查看 Job 详情，确认审计字段

```bash
node -e "
fetch('http://localhost:3001/api/jobs/<jobId>', {
  headers:{'Cookie':'<cookie>'}
}).then(r=>r.json()).then(j=>console.log('createdBy:',j.createdByName,'via:',j.createdVia,'identity:',j.createdByIdentityId))
"
```

预期：

- `createdByName`：当前登录用户名（如 "admin"）
- `createdVia`：`"web"`（浏览器/API）或 `"cli"`（Token）
- `createdByIdentityId`：对应用户的 ID

---

## 11. 一键集成测试

```bash
node scripts/test.cjs
```

预期输出：`35/35 passed, 0 failed`

---

## 验收清单

| 功能 | 操作 | 预期结果 |
|---|---|---|
| 公开接口 | `GET /api/health` | `{ ok: true }` |
| 登录 | 正确密码 | Cookie + identity |
| 登录 | 错误密码 | 401 AUTH_INVALID |
| 无凭证 | `GET /api/clients` | 401 AUTH_REQUIRED |
| Cookie | 带 Cookie 访问 `/api/clients` | 200 |
| 当前身份 | `GET /api/auth/me` | 返回身份信息 |
| 生成 Token | `POST /api/auth/tokens` | 返回 `vcp_` Token |
| Bearer 调用 | `Authorization: Bearer` | 200 |
| 撤销 Token | `DELETE /api/auth/tokens/:id` | `{ ok: true }` |
| 失效 Token | 撤销后再次使用 | 401 |
| 创建身份(admin) | `POST /api/identities` | 成功创建 |
| 列出身份(admin) | `GET /api/identities` | 返回所有身份 |
| 禁用身份(admin) | `POST .../disable` | 被禁身份无法登录 |
| 启用身份(admin) | `POST .../enable` | 可再次登录 |
| 权限限制 | 非 admin 访问 `/api/identities` | 403 FORBIDDEN |
| 业务平等 | admin 和非 admin 都能调用业务接口 | 200 |
| 修改信息 | `PUT /api/auth/me` | 用户名/密码可改 |
| 登出 | `POST /api/auth/logout` | Session 失效 |
| Job 审计 | 查看 Job 详情 | `createdByName` `createdVia` 有值 |

---

## 配置速查

```bash
VCPDECK_ADMIN_USERNAME=admin        # admin 用户名（默认 admin）
VCPDECK_ADMIN_PASSWORD=xxx          # 首次启动必填
VCPDECK_FRONTEND_ORIGIN=http://localhost:5173   # 前端 Origin
VCPDECK_SESSION_TTL_SECONDS=604800  # Session 有效期（默认 7 天）
VCPDECK_COOKIE_SECURE=false         # 开发环境 false，生产 true
VCPDECK_CLIENT_PSK=xxx              # 远程客户端 PSK
```
