# VCPDeck P2P/relay TCP 隧道 —— 功能验收

> 本手册用于对「浏览器 ↔ Client 的 WebRTC TCP 隧道（P2P 直连 + coturn relay 回退）」做人工/半自动验收。
> 每个阶段都给出**前置、步骤、判定（PASS/FAIL 标准）、证据（看什么）**。全部 PASS 即视为本功能验收通过。
>
> 配套阅读：[`p2p-tunnel.md`](./p2p-tunnel.md)（设计与已验证记录）、[`docs/deployment.md`](../deployment.md)（部署）、[`scripts/install-coturn.sh`](../../scripts/install-coturn.sh)。

---

## 0. 验收前置

- **环境**：
  - VCPDeck Server（`pnpm --filter @vcpdeck/server build` 后 `pnpm dev` 或发布版），数据库为全新或已含 `TunnelConfig` 表（跑过 `prisma migrate`）。
  - VCPDeck Client ≥ 1.1.14（含 `tunnel` capability），登录 Server。
  - 一台能打开 Frontend 的浏览器（Chrome/Edge 等 Chromium 系）。
- **判定总原则**：
  - 直连（P2P）：两端同网络可直连时，隧道命中 `path=direct`，且能访问目标本地服务。
  - 中继（relay）：两端网络不通（无法 P2P）时，隧道命中 `path=relay`，且能访问目标本地服务。
  - 任一场景：目标本地服务**关闭**时应得到 `TUNNEL_TARGET_REFUSED`，**不是**超时或无响应。

---

## 1. 验收 A：P2P 直连（同网络）

**前置**：Server、Client 在**同一局域网**（能直连）；Client 上跑一个本地 HTTP 目标服务。

**步骤**：
1. Client 机器上起一个本地 HTTP 服务（示例，端口 3999）：
   ```bash
   # Linux
   python3 -m http.server 3999
   # 或任意服务，确保 127.0.0.1:3999 可访问
   ```
2. 打开 Frontend → 目标机器 → **Tunnel** 页（`/machines/:id?tunnel=1`）。
3. 填 `targetPort = 3999`，点「连接」。
4. 连接成功后点「Probe 目标」。

**判定**：
- 状态栏 `path=direct`（或 `connected` 且无 relay 标记）。
- Probe 返回目标服务的内容（如目录列表 / 你放好的 marker 文件内容），`ok=true`。
- **证据**：页面显示连接成功 + probe 内容；Client 日志无 relay 字样。

**负向**：
- 关闭目标服务后再 Probe → 得到 `TUNNEL_TARGET_REFUSED`（不是超时）。
- 填一个没监听的端口（如 3998）→ `TUNNEL_TARGET_REFUSED`。

---

## 2. 验收 B：coturn 中继（跨网络）—— 需要两台不同网络的机器

> 这是「浏览器→coturn→Client」字节流动的真实验收，**必须**浏览器与 Client 分处两个网络。

**机器分配（二选一）**：
- **方案 1（两台云 VM）**：
  - **VM-1**：跑 VCPDeck Server + Client + 本地 HTTP 目标 + coturn。
  - **VM-2**：跑浏览器（访问 VM-1 的 Frontend）。
  - 两 VM **不同网段**（不同 AZ/不同 VPC/不同公网），确保无法 P2P 直连。
- **方案 2（物理机 + 云 VM）**：
  - **物理机**：跑浏览器。
  - **云 VM**：跑 Server + Client + 目标 + coturn。
  - 物理机能访问云 VM 的 Frontend 端口，但物理机与云 VM 无法 P2P 直连（被 NAT 挡住）。

**步骤**：
1. **coturn 部署**（在跑 Server 的那台机器上，公网可达）：
   ```bash
   cd VCPDeck 仓库
   ./scripts/install-coturn.sh \
     --external-ip <该机公网IP> \
     --port 3478 \
     --min-udp 49152 --max-udp 65535 \
     --secret-file /etc/vcpdeck/turn-secret \
     --systemd
   ```
   - 确认 `systemctl status coturn` 为 active；`ss -ulnp | grep 3478` 有监听；`/etc/vcpdeck/turn-secret` 存在且权限 0600。
   - **公网可达性**：从另一台机器 `nc -u -z -w3 <公网IP> 3478` 或用 `turnutils_uclient -t 5 -u <user>:<pass> turn:<公网IP>:3478 -v`（凭据用下面第 2 步签发的）确认能连上 coturn。
2. **签发凭据自检**（验证 Server 的凭据与 coturn 兼容，在 coturn 机器上）：
   - 用 Frontend 的 Settings→Tunnel 页保存一次（或调 `PUT /tunnel/config` 存 `publicIceConfig`，`usePublicStun=false`），使 Server 签发 `iceServers`。
   - 拿到 `iceServers[0]` 的 `urls/username/credential`，在 coturn 机器执行：
     ```bash
     turnutils_uclient -t 5 -u <username> -p <credential> \
       turn:<公网IP>:3478 -v
     ```
   - **PASS 标准**：coturn **分配到一个 relay 端点**（输出里有 allocated relay address / `You have been allocated`）。
   - 若返回 `401/403` 或 `Unable to authenticate` → FAIL（凭据/secret 不匹配，检查 `VCPDECK_TURN_SECRET_FILE` 与 coturn `use-auth-secret` 是否同串）。
3. **触发 relay**：
   - 确保浏览器（VM-2/物理机）与 Client（VM-1）**无法 P2P 直连**：临时用防火墙/安全组挡住 Client 的入站，或确认两者确在不同 NAT 后。
   - 打开 Frontend→目标机器→Tunnel 页，填 `targetPort`（如 3999），点「连接」。
4. **观察**：
   - 连接成功，状态栏 `path=relay`（**关键**：必须是 relay，不是 direct）。
   - 点「Probe 目标」→ 返回目标服务内容。
   - **coturn 侧证据**（在 coturn 机器）：`journalctl -u coturn | grep -iE 'allocat|session|relay'` 能看到来自浏览器公网 IP 的 Allocate/会话；或 `turnserver` 的 debug 日志里有该 IP 的 TURN 流量。
   - **Client 日志**：能看到 `tunnel-bridge` attach + `relay` 路径字样（若有）。

**判定（全 PASS 才算 relay 验收通过）**：
- ✅ `path=relay`（不是 direct）。
- ✅ Probe 目标返回内容（数据真过了 coturn）。
- ✅ coturn 日志有该浏览器 IP 的 TURN Allocate/会话（字节确实过了 coturn）。
- ✅ 关闭目标服务后再 Probe → `TUNNEL_TARGET_REFUSED`。

**常见 FAIL 排查**：
- 连接成功但 `path=direct` → 两端其实能直连（NAT 没挡死），回到「确认无法 P2P」那步。
- `path=relay` 但 Probe 无响应 → coturn 的 relay UDP 端口段（49152-65535）未对公网开放，或 Client 出站 UDP 被挡。
- coturn 日志无浏览器流量 → 浏览器到 coturn 公网 3478 的 UDP 被运营商/安全组挡（Chrome 正常出站 UDP 的环境才测得出来；本机受限 VM 网络会这样，见设计文档 §11 记录）。

---

## 3. 验收 C：凭据与配置安全（单台即可）

**步骤**：
1. Frontend→Settings→Tunnel 页：
   - 填 `publicIceConfig`（如 `stun:stun.l.google.com:19302`）、`usePublicStun=true`、`turnHost/turnPort/turnTransport`。
   - 点保存。
2. **secret 不进 Web**：确认 Settings 页**没有**「turn secret」输入框；secret 只存在于 coturn 机器的 `VCPDECK_TURN_SECRET_FILE` 文件。
3. 保存后，`iceServers` 由 Server 自动签发（含 `turn:<turnHost>:<port>?transport=udp` + 短期 `username/credential`）。

**判定**：
- ✅ 保存成功，`turnHost/turnPort/turnTransport` 与 coturn 实际一致。
- ✅ 数据库/REST **查不到** secret 明文（secret 只在文件里）。
- ✅ 签发的 `credential` 是短期（HMAC，24h 内过期）——可等过期后再 `turnutils_uclient` 复测，确认过期后被 coturn 拒（`437/438`）。

---

## 4. 验收 D：负向与边界

| 场景 | 操作 | 期望 |
|---|---|---|
| 目标端口未监听 | 连一个空端口 | `TUNNEL_TARGET_REFUSED`（非超时） |
| 目标服务中途关闭 | 连接中关掉目标服务，再 Probe | `TUNNEL_TARGET_REFUSED` / 连接断开 |
| 非法 targetPort | 填 0 / 70000 / 非数字 | 前端校验拦截或 `BAD_REQUEST`，Client 不执行 |
| Client 离线 | 断开 Client 再连 | 连接失败（无可用 Client），非挂起 |
| coturn 宕机（relay 场景） | 停 coturn，跨网络连 | 连接失败/超时，**不**回退成 direct（两端本就不通） |
| 凭据过期 | 24h 后用旧 credential | coturn 拒（`437/438`），重连时 Server 重新签发 |

---

## 5. 验收记录模板

| 阶段 | 环境/机器 | 结果 | 证据（日志/截图/命令输出） | 日期 |
|---|---|---|---|---|
| A 直连 | | PASS/FAIL | | |
| B 中继（两台） | | PASS/FAIL | | |
| C 凭据安全 | | PASS/FAIL | | |
| D 负向 | | PASS/FAIL | | |

**总体结论**：A 必须 PASS；B 若具备两台机器则必须 PASS（无两台机器时，以设计文档 §11 的组件级验证记录为据，注明「relay 字节流待两台机器复测」）；C、D 全部 PASS。

---

## 附：快速命令速查

```bash
# coturn 部署
./scripts/install-coturn.sh --external-ip <公网IP> --secret-file /etc/vcpdeck/turn-secret --systemd

# coturn 状态/监听
systemctl status coturn
ss -ulnp | grep 3478

# 凭据自检（在 coturn 机器，凭据来自 Frontend 保存后 Server 签发）
turnutils_uclient -t 5 -u <username> -p <credential> turn:<公网IP>:3478 -v

# coturn 看 TURN 流量
sudo journalctl -u coturn -f | grep -iE 'allocat|session|relay|<浏览器IP>'

# Client 起目标 HTTP 服务
python3 -m http.server 3999
```
