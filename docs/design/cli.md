# CLI 与多环境配置设计

> 状态：Current｜维护责任：CLI/SDK 维护者｜最后核验：2026-08-18｜适用版本：当前 `main`

本文描述当前 VCPDeck CLI 的职责、环境配置、安全边界和已落地命令。长期取舍见 [ADR-0017](../adr/0017-cli-multi-environment-configuration.md)；REST 与认证语义见 [`protocols.md`](../protocols.md) 和 [`design/identity-and-authentication.md`](./identity-and-authentication.md)。

## 1. 定位与边界

CLI 是操作员和 Pi Skill 使用的命令入口，复用 `@vcpdeck/sdk` 访问 Server。当前已落地：

- 多环境注册、查看、选择与项目默认环境；
- `release upload` 双平台发布上传和自更新触发。

CLI 不直接控制目标机器，不持有 Server 业务状态机，也不在 Skill 中复制 HTTP。SDK 不读取 HOME、当前目录或 CLI 配置，只接受解析后的 `baseUrl` 和认证。

## 2. 配置模型

### 2.1 用户级注册表

固定路径：

```text
~/.vcpdeck/cli/config.json
```

结构版本为 `1`。示例：

```json
{
  "version": 1,
  "defaultEnvironment": "dev",
  "environments": {
    "dev": {
      "server": "http://127.0.0.1:3001",
      "auth": {
        "type": "password",
        "username": "admin",
        "passwordEnv": "VCPDECK_DEV_PASSWORD"
      }
    },
    "prod": {
      "server": "https://deck.example.com",
      "auth": {
        "type": "bearer",
        "tokenEnv": "VCPDECK_PROD_TOKEN"
      }
    }
  }
}
```

配置只保存凭据环境变量名，不保存密码、Token 或 Cookie。非 Windows 下 CLI 将目录和文件权限收紧为 `0700` / `0600`，写入使用同目录临时文件加 rename。

### 2.2 项目级选择器

固定文件名：

```text
.vcpdeck.json
```

唯一有效结构：

```json
{
  "version": 1,
  "environment": "dev"
}
```

项目文件可以提交 Git，但只能选择用户级已注册环境，不能定义 Server、认证或凭据变量。不同操作者需要在本机注册同名环境。

## 3. 环境选择与查找

业务命令按以下顺序选择环境：

1. `--env=<name>` 或 `--environment=<name>`；
2. `VCPDECK_ENVIRONMENT`；
3. 从 cwd 向上找到的最近 `.vcpdeck.json`；
4. 用户级 `defaultEnvironment`；
5. 都不存在时失败。

在 Git 仓库内查找最多到仓库根，不继承仓库外选择器。`env use --local` 优先更新最近已有选择器，否则写到 Git 根；非 Git 目录写到当前目录。

项目配置损坏、字段未知、版本不支持或引用不存在环境时立即失败，不回退到全局默认。`env current` 不要求凭据变量已经设置，只输出安全摘要；真正业务命令缺少凭据时失败。

## 4. 环境命令

```text
vcpdeck env list
vcpdeck env show <name>
vcpdeck env current [--env=<name>]
vcpdeck env add <name> --server=<url> --auth=password --username=<name> --password-env=<VAR>
vcpdeck env add <name> --server=<url> --auth=bearer --token-env=<VAR>
vcpdeck env remove <name>
vcpdeck env use <name> --global|--local
```

行为：

- `list`：列出环境安全摘要，`*` 标记全局默认；
- `show`：显示单个环境的 Server、认证引用和默认状态；
- `current`：按完整优先级输出最终环境、Server、来源和凭据变量名；
- `add`：严格校验并新增环境，不覆盖同名环境；
- `remove`：删除环境；若它是全局默认，同时清除默认；不遍历项目文件；
- `use --global`：设置用户级默认；
- `use --local`：写入项目选择器。

Server 必须是 HTTP/HTTPS origin，不允许内嵌用户名密码、query、fragment 或业务路径。环境名最长 64，只允许字母、数字、点、下划线和连字符，且以字母或数字开头。

## 5. Release 命令

推荐使用当前环境：

```bash
vcpdeck release upload \
  vcpdeck-x.y.z-win-x64.zip \
  vcpdeck-x.y.z-linux-x64.zip
```

临时覆盖：

```bash
vcpdeck release upload ... --env=prod
```

保留的直连兼容模式：

```bash
vcpdeck release upload ... \
  --server=https://deck.example.com \
  --username=admin
```

直连密码优先来自 `VCPDECK_ADMIN_PASSWORD`；`--password` 仍兼容但会暴露在 Shell history/进程参数中，不推荐。`--server` 不能与 `--env` 同时使用，命名环境模式也不能混入 `--username` / `--password`。

Password 环境先通过 SDK 登录取得进程内 Cookie，再上传；Bearer 环境直接通过 SDK Authorization 上传。CLI 上传前显示最终环境安全摘要，并校验两个 archive 版本一致、平台互补；上传完成不表示自更新终态完成。

## 6. 安全与故障边界

- 用户级配置、项目配置和所有 CLI 参数都视为不可信输入并严格解析；
- 项目选择器不能改变 Server 或凭据引用，降低不可信仓库诱导泄密风险；
- 项目仍可选择本机已注册生产环境，因此副作用命令必须展示最终 Server 并取得确认；
- 输出不得包含密码、Token、Cookie、PSK、签名 URL 或原始敏感响应；
- 非幂等 POST 网络结果不明时先查询 Server 权威状态，不盲目重试；
- `env current` 的成功只表示配置可解析，不表示 Server 可达或凭据有效；
- 环境删除不会修复项目引用，被删除环境的项目后续明确失败。

## 7. Skill 与后续扩展

`skills/vcpdeck/SKILL.md` 通过 CLI `env current` 取得环境权威摘要，不直接读取 JSON。后续每个 CLI 业务命令都复用同一环境解析结果，并在 Skill 中新增对应功能章节。Server/SDK 已有 API 不等于 CLI 命令已落地。

## 8. 测试与验收

当前单元/集成测试覆盖：

- 严格配置 parser 与未知字段/明文秘密拒绝；
- flag、环境变量、项目、全局默认优先级；
- 最近父目录、Git 根和 `--local` 写入位置；
- 项目损坏/未知环境 fail closed；
- 缺失凭据和直连冲突；
- 配置原子写入及 POSIX `0600`；
- `env add/list/show/current/use/remove`；
- 命名 Bearer 环境通过真实本地 HTTP Server 上传两个平台构件。

当前已知非能力：系统凭据存储、共享环境目录、`--json`、交互式密码输入、环境健康检查、Release 状态轮询，以及 Release 之外的业务 CLI 命令。
