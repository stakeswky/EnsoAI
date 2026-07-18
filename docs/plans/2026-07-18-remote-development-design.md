# 远程开发功能设计(Tailscale 局域网)

## 概述

允许一台机器上的 EnsoAI(客户端,如 MacBook Air)连接到另一台机器上的 EnsoAI(主机,如 Mac mini),在客户端 UI 中远程使用主机的终端、Agent CLI、文件系统与 Git。两台机器处于同一 Tailscale 网络。

模式类似 VS Code Remote:主机端 app 内置一个"远程主机服务",客户端窗口连接后进入远程模式,渲染层 UI 不感知差异。

## 架构

```
┌─────────────── MacBook Air(客户端)───────────────┐      ┌─────────────── Mac mini(主机)────────────────┐
│  渲染进程                                          │      │                                               │
│  window.electronAPI.<domain>.<method>  (不变)      │      │  RemoteHostServer (ws + http, token 认证)      │
│        │ ipcRenderer.invoke                        │      │        │ 按 channel 分发                        │
│        ▼                                           │  WS  │        ▼                                      │
│  主进程 IPC 拦截层 (handlerRegistry)                │◄────►│  handlerRegistry.get(channel)(virtualEvent,…) │
│    ├─ 本窗口未连远程 → 本地 handler                  │ JSON │        │                                      │
│    └─ 本窗口已连远程 → RemoteClientManager 转发      │      │        ▼                                      │
│  push 事件: ws ev → sender.send(channel, payload)  │      │  PtyManager / files / git / search(现有服务)   │
└───────────────────────────────────────────────────┘      └───────────────────────────────────────────────┘
```

核心洞察:渲染进程的全部后端能力都经由 preload 的 `electronAPI` 单层封装,invoke/push 模式可 1:1 映射为 WebSocket RPC。因此远程开发 = 在主进程为白名单 channel 换一个 transport,渲染层与各域 handler 代码几乎不动。

## 技术决策

| 决策点 | 选择 | 原因 |
|--------|------|------|
| 架构 | App 内置 Host 模式 | 复用 ClaudeIdeBridge 已验证的 ws+token 模式,无需独立打包 headless 产物 |
| 转发粒度 | 窗口级远程模式 | 整窗口连到一台主机,路径全部为主机路径,避免混合模式的路径歧义 |
| 拦截方式 | 包装 `ipcMain.handle` 注册 | 各域 handler 文件零改动;同一 registry 同时服务客户端路由与主机端分发 |
| 协议 | JSON 消息 (req/res/ev) | LAN 带宽充裕,JSON 足够;终端数据高频但量小,预留二进制帧优化空间 |
| 认证 | 配对 Token | 主机生成随机 token 持久化于 settings.json,握手时校验,同 ClaudeIdeBridge |
| 监听地址 | 默认 Tailscale 网卡 IP | 自动检测 100.64.0.0/10 地址;检测不到回退 127.0.0.1;可手动改 0.0.0.0 |
| 默认端口 | 48925 | 避开常用端口,可配置 |
| 断线 PTY | 连接断开即销毁 | 复用 `sender.once('destroyed') → destroyByOwner` 现有清理链;持久化留给 v2(tmux) |

## 协议

### 握手

客户端连接 `ws://<host>:<port>/`,请求头携带 `x-enso-remote-token`。校验失败返回 401 并关闭。成功后主机发送:

```typescript
{ t: 'hello', protocolVersion: 1, host: { platform, home, hostname, appVersion } }
```

`protocolVersion` 不一致时拒绝连接并提示升级。

### 消息帧

```typescript
// 客户端 → 主机(请求)
{ t: 'req', id: number, ch: string, args: unknown[] }
// 主机 → 客户端(响应)
{ t: 'res', id: number, ok: boolean, result?: unknown, error?: string }
// 主机 → 客户端(推送,对应 event.sender.send)
{ t: 'ev', ch: string, payload: unknown[] }
```

心跳用 ws 内置 ping/pong(15s),超时判定断线。客户端指数退避自动重连(1s 起,上限 30s),重连成功后渲染层收到 `remote:statusChanged`,由 UI 决定重建终端。

### 主机端分发与虚拟 sender

主机收到 `req` 后从 handlerRegistry 取原 handler,以 `virtualEvent` 调用。`virtualEvent.sender` 是一个 VirtualWebContents:

- `id`:每连接分配唯一合成 id(≥ 1_000_000,避免与真实 webContents.id 冲突)
- `send(channel, payload)`:转为 `ev` 帧推给客户端
- `isDestroyed()` / `once('destroyed', cb)`:绑定 ws 连接生命周期

这样 `terminal.ts` 里的 `ensureTerminalCleanup`(sender destroyed → `ptyManager.destroyByOwner`)对远程连接原样生效:客户端断线,主机上该连接创建的所有 PTY 自动销毁。

## 转发白名单(分阶段,均已实现)

| 阶段 | 域 | 说明 |
|------|-----|------|
| P1 ✅ | `terminal:*`、`shell:*` | 远程终端 + Agent CLI(agent 就是 PTY 里的 initialCommand,天然可用) |
| P2 ✅ | `file:*`、`search:*`、`git:*`、`worktree:*`、`temp:*` | 完整远程工作区:文件树、Monaco 编辑、Git 面板、临时工作区 |
| P3 ✅ | 预览与深度集成 | `local-file://`/`local-image://` 远程取字节(WS 通道 `remoteFs:readFile`)、agent 通知与 auto-fetch 事件扇出、远程目录选择器替代原生 dialog |

不转发:`settings:*`(客户端自己的设置)、`window:*`、`dialog:*`(远程模式下由 RemoteDirectoryPicker 替代)、`updater:*`、`app:*` 大部分。

### P3 补充机制

- **预览字节流**:`protocol.handle` 拿不到发起请求的 webContents,因此客户端协议 handler 在存在活跃远程连接时,先经 `remoteFs:readFile`(WS 专用通道,上限 64MB)向主机取字节,失败再回落本地。远程视频为整体传输,不支持 Range。
- **广播扇出**:agent 通知(ClaudeIdeBridge 的 `agent:*`)与 `git:autoFetch:completed` 原本只发给主机本地窗口(`getAllWindows()`/绑定的 mainWindow),虚拟 sender 不在其中,故通过 `broadcastToRemoteClients()` 显式扇出给所有远程连接。
- **主机环境接管**:渲染层通过 `stores/remote.ts` 的 `getEffectiveEnv()/useEffectiveEnv()` 取得"实际执行机器"的 home/platform/分隔符(连接时为主机,否则为本机),用于终端默认 cwd、临时工作区路径、克隆路径拼接、`~` 展示与 Markdown 路径归一化。

## 新增 IPC 通道(本地,客户端/主机各自 UI 用)

- `remoteHost:start` / `remoteHost:stop` / `remoteHost:getStatus` / `remoteHost:regenerateToken` — 主机端开关与状态
- `remoteHost:statusChanged` — 推送(监听地址、端口、连接数)
- `remote:connect` / `remote:disconnect` / `remote:getStatus` — 客户端连接管理(connect 参数 `{host, port, token}`)
- `remote:statusChanged` — 推送(connected / reconnecting / disconnected + 主机信息)

## 组件清单

| 组件 | 文件位置 | 说明 |
|------|----------|------|
| 协议类型 | `src/shared/types/remote.ts` | 帧类型、握手类型、转发白名单、新 IPC 通道加入 `ipc.ts` |
| 拦截层 | `src/main/services/remote/handlerRegistry.ts` | 包装 `ipcMain.handle`,登记 channel→handler,白名单 channel 按窗口路由 |
| 主机服务 | `src/main/services/remote/RemoteHostServer.ts` | http+ws server、token 校验、虚拟 sender、分发、Tailscale IP 检测 |
| 客户端管理 | `src/main/services/remote/RemoteClientManager.ts` | ws 客户端、req/res 关联、ev 转发至 webContents、重连 |
| IPC | `src/main/ipc/remote.ts` | 上述本地通道 handlers;注册进 `ipc/index.ts`,清理挂入 cleanup 链 |
| Preload | `src/preload/index.ts` | 新增 `remote` 与 `remoteHost` 命名空间 |
| 主机 UI | `src/renderer/components/settings/RemoteSettings.tsx` | 设置新分类:主机开关、地址/端口、token 显示/复制/重新生成、连接数;客户端连接表单 |
| 客户端状态 | `src/renderer/stores/remote.ts` | 连接状态 store + `getEffectiveEnv()/useEffectiveEnv()` 主机环境接管 |
| 预览字节流 | `src/main/services/remote/remoteFileFetch.ts` | 客户端协议 handler 的远程取字节助手 + MIME 映射;主机端 handler 在 `ipc/remote.ts` |
| 广播扇出 | `RemoteHostServer.broadcastToClients` | `ClaudeIdeBridge.ts`(broadcastAgentEvent)与 `GitAutoFetchService.ts` 调用 |
| 远程目录选择器 | `src/renderer/components/remote/RemoteDirectoryPicker.tsx` | 基于转发的 `file:list` 浏览主机目录;已接入 `AddRepositoryDialog` |

## 安全

- Token 为 32 字节随机 hex,存主机 `settings.json`(`remoteHost.token`),UI 可查看/重新生成;重新生成后旧连接立即断开。
- 默认仅监听 Tailscale 网卡地址,不暴露公网;Tailscale 链路自带 WireGuard 加密,ws 上不再叠加 TLS。
- 客户端保存的主机凭据后续可迁移至 Electron `safeStorage`(v1 明文存 settings,风险限于本机文件读取)。
- 不复用 cloudflared 公网隧道路径——本功能明确限定局域网/tailnet。

## 边界与已知限制

- 断线后 PTY 销毁,远程会话不保留(后续可选 tmux 持久化,项目已有 TmuxDetector)。
- 连接前已打开的本地终端在连接后写入会被转发到主机而失效,建议连接后重建终端;远程 PTY id 带 `remote:` 前缀避免与本地冲突。
- 仓库列表(localStorage)在本地/远程模式间共用:远程模式下添加的是主机路径,断开后这些条目在本地无效(未来可按主机分组)。
- `app:recentProjects` 显示的是客户端本地的最近项目,远程模式下参考价值有限。
- 设置页中的目录选择(临时路径、worktree 路径、clone 基目录、背景图)仍用原生对话框(本地路径);仅添加仓库流程接入了远程目录选择器。
- 远程视频预览为整体传输(无 Range),预览文件上限 64MB。
- `file:revealInFileManager` 被转发后会在主机上打开 Finder,对客户端用户不可见。
- 多客户端可同时连接同一主机,PTY 按连接隔离,不做协同编辑冲突处理。

## 实现状态

1. ✅ 协议类型 + 拦截层(P1)
2. ✅ RemoteHostServer + RemoteClientManager(P1)
3. ✅ IPC + preload + 设置 UI 与连接 UI(P1)
4. ✅ 文件/搜索/Git/worktree/temp 域转发与渲染层主机信息接管(P2)
5. ✅ 预览字节流、agent 通知转发、远程目录选择器(P3)
