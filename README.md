# EasyTunnel

**简体中文** · [English](#english)

零依赖的内网穿透工具：一台有公网 IP 的服务器 + 任意内网机器（Windows 单文件客户端），
浏览器里配置映射，保存即生效，无需改配置文件、无需重启。

A zero-dependency intranet-penetration tool: one server with a public IP + any internal machine (a single-file Windows client). Configure mappings in the browser and they take effect immediately — no config files, no restarts.

---

## 简介

支持 **TCP 端口映射**（HTTP / SSH / 数据库 / 远程桌面等）与 **HTTPS 路径映射**
（共用管理端口，按路径前缀分流到不同内网服务），并支持 **多台客户端同时在线**：
每台机器一个独立令牌，映射可指定目标客户端，互不干扰。

> 想先了解全貌？看 **[项目介绍](docs/项目介绍.md)**（背景、架构、原理、验证数据、FAQ）；英文版见 **[Project Introduction](docs/project-introduction.en.md)**。

## 快速部署（约 5 分钟）

> 前提：一台可配置安全组的 Linux 公网服务器，一台内网 Windows 机器。

### 1. 服务端：启动

把 `server/` 目录整体上传到服务器（示例路径 `/opt/easytunnel`），执行：

```bash
cd /opt/easytunnel
cp config.example.json config.json     # 可选；不复制则首次启动自动生成密码/令牌
docker compose up -d
docker compose logs easytunnel | tail -20   # 记下「管理密码」和「客户端令牌」
```

> 不用 Docker 也可以：装 Node.js 18+ 后执行 `node server.js`。
> 若提示 `docker compose` 不存在，把命令换成 `docker-compose`（旧版）。

### 2. 放行端口

在云安全组 / 防火墙放行：

- `9000`：管理页（建议只对你的来源 IP 开放）
- `9001`：客户端连入
- 之后新增映射时，对应的**公网端口**（如 `18080`）

### 3. 登录管理页

浏览器打开 `http://<公网IP>:9000`，用管理密码登录。

### 4. 添加客户端并复制配置

「客户端」卡片 →「添加客户端」→ 填名称 → 在该行点「复制配置」，得到该客户端的 `client.json`：

```json
{ "server": "<公网IP>:9001", "token": "<该客户端令牌>", "name": "" }
```

### 5. 内网机器：运行客户端

把 `EasyTunnelClient.exe` 与 `client.json` 放在**同一目录**，双击运行。窗口显示「已连接」即成功，可最小化到托盘常驻。

### 6. 添加映射并验证

「映射列表 → 添加映射」：目标客户端选刚添加的客户端，填公网端口 `18080` → 内网 `127.0.0.1:8080`，保存。
外网访问 `http://<公网IP>:18080` 应到达内网服务；目标客户端离线时映射会显示「等待客户端」。

### 升级与回滚

```bash
cd /opt/easytunnel
cp server.js server.js.bak && cp admin.html admin.html.bak     # 备份
# 覆盖新的 server.js / admin.html 后：
docker compose restart easytunnel

# 回滚：把 .bak 覆盖回去，再 restart
```

> 服务端源码是挂载进容器的，更新文件只需 `restart`，无需重建镜像；`config.json` 不要覆盖。
> 旧版单客户端配置会自动迁移为「默认客户端」，原令牌继续可用。

## 特性

- **服务端零依赖**：纯 Node.js 标准库，`node server.js` 即可运行，也可用 Docker
- **客户端单文件**：Windows 下打包成 ~84 MB 的 `EasyTunnelClient.exe`，不需要装 Node
- **管理页即配置**：端口映射、路径映射、服务端地址、令牌都在网页里增删改，实时生效
- **暗色控制台**：实时速率曲线、逐映射流量统计、连接数、HTTPS 证书信息
- **稳定转发**：自带帧协议（9 字节头 + 通道多路复用）、背压 pause/resume、
  心跳与 40 秒超时自愈、断线自动重连、keep-alive 连接软关闭（大文件不截断）
- **HTTPS 路径映射**：管理端口按首字节分流 TLS / 明文，自签证书可下载安装
- **多客户端**：连接池按客户端隔离；映射绑定目标客户端；单台掉线只影响自己的映射
- **安全**：管理页与 API 需密码；每客户端独立令牌；登录失败限速；恒定时间比较

## 目录结构

```
.
├── source/                 完整源码（开发、打包用）
│   ├── server.js           服务端
│   ├── admin.html          管理页（单文件，暗色 UI）
│   ├── client.js           客户端（协议 + 图形窗口调度）
│   ├── gui.ps1             客户端图形界面（WinForms，内嵌）
│   ├── build-exe.js        打包成单文件 exe（Node SEA + postject）
│   ├── default.example.json 内置客户端配置示例（复制为 default.json 后打包）
│   ├── docker-compose.yml
│   └── icon/ tools/        图标与 rcedit（写 exe 图标/版本信息）
├── server/                 服务端部署目录
│   ├── server.js  admin.html  docker-compose.yml
│   ├── config.example.json 配置模板（复制为 config.json）
│   ├── certs/              HTTPS 证书（cert.pem / key.pem，自签即可）
│   └── downloads/          管理页「下载客户端」用的 client.zip
└── client/                 客户端分发目录
    ├── client.example.json 配置模板（复制为 client.json）
    └── （EasyTunnelClient.exe 构建产物，未入库）
```

> 仓库不包含 exe 与 zip 发布包；运行时生成的 `config.json`、`client.json`、
> `default.json` 含密码/令牌，已在 `.gitignore` 中排除。

## 快速开始

### 1. 服务端（公网服务器）

```bash
cd server
cp config.example.json config.json     # 首次也可直接启动，会随机生成密码/令牌
docker compose up -d                   # 或：node server.js
docker compose logs easytunnel         # 查看管理密码与客户端令牌
```

管理页：`http://<公网IP>:9000`（密码见配置文件或启动日志）。

> `docker-compose.yml` 使用 `network_mode: host`：映射的公网端口在网页里随时新增，
> 容器直接监听宿主机端口，加端口不用改 compose、不用重建容器。
> 需在安全组/防火墙放行 9000、9001 以及每条映射的公网端口。

### 2. 客户端（内网机器，可多台）

管理页「客户端」卡片 →「添加客户端」→ 填名称 → 在该行点「复制配置」，
把得到的 `client.json` 与 `EasyTunnelClient.exe` 放到目标机器同一目录，双击即可
（也可在图形窗口里直接填地址和令牌）。多台机器各自使用自己的配置，互不顶替。

> 旧版单客户端配置（只有 `token` 没有 `clients`）启动时会自动迁移为「默认客户端」，
> 原令牌继续可用，升级不影响已部署的客户端。

### 3. 配置映射

管理页「映射列表 → 添加映射」：选择**目标客户端**（或「自动」= 任一在线），
填公网端口 → 内网地址:端口（如 `18080 → 127.0.0.1:8080`）。
外网访问 `http://<公网IP>:18080` 即到达该客户端机器上的服务。
路径映射同理，形如 `https://<公网IP>:9000/kod/`。目标客户端离线时映射显示「等待客户端」。

## 从源码构建

```bash
# 客户端 exe（Windows，Node >= 20，首次会通过 npx 获取 postject）
cd source
cp default.example.json default.json   # 填入自己的服务器地址与令牌（可选，不打进去也行）
node build-exe.js                      # 产物：EasyTunnelClient.exe

# 服务端无需构建
node server.js
```

## 协议摘要

单条 TCP 控制连接上多路复用：帧头 `type(1) | channelId(4) | length(4)`，`type=1` 为 JSON
控制帧，`type=2` 为原始数据帧。`auth / auth_ok / open / ready / close / pause / resume / ping / pong`
构成会话；`open` 携带内网目标地址，客户端连上后回 `ready` 并双向转发。
客户端认证时携带 `token`（服务端据此识别属于哪个客户端）与 `clientId`（展示用）；
客户端需每 ≤30 秒发送一次 `ping`；服务端按客户端独立计时，30 秒收不到任何帧即判定该客户端离线，
主动断开并清理通道（应对断网/休眠造成的 TCP 半开），此时管理页映射状态显示「等待客户端」。

## 安全提示

- 管理端口（9000）建议只对你的来源 IP 开放，或放在内网/VPN 后
- 隧道端口（9001）是明文 TCP + 令牌认证，公网暴露时请使用强令牌并限制来源
- 自签 HTTPS 证书仅用于路径映射，浏览器首次访问需手动信任

## 使用须知

本工具用于**自有或已获授权**的网络与服务，便于远程运维与联调。
请勿用于未经授权的访问、穿透他人网络或规避访问控制；由此产生的责任由使用者承担。

## 许可

本项目以 **Apache License 2.0** 开源，见 [LICENSE](LICENSE)。

分发时包含的第三方组件（Node.js 运行时、rcedit 构建工具）及其许可见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 [NOTICE](NOTICE)；
Node.js 的完整许可文本随客户端包分发放于 `LICENSES/Node.js-LICENSE.txt`。

> 使用「EasyTunnel」名称不构成商标授权；Apache 2.0 仅授予版权与专利许可。

---

## English

### Overview

EasyTunnel supports **TCP port mappings** (HTTP, SSH, databases, RDP, and any other TCP service) and **HTTPS path mappings** (sharing the admin port and routing by path prefix to different internal services). Multiple clients can be online at the same time: each machine has its own token, mappings can target a specific client, and one client going offline only affects its own mappings.

> Want the full picture first? See the **[Project Introduction (English)](docs/project-introduction.en.md)** — or the [Chinese version](docs/项目介绍.md).

### Quick deployment (~5 minutes)

> Prerequisites: a Linux server with a public IP (where you can edit the security group) and a Windows machine on the internal network.

#### 1. Server: start it

Upload the whole `server/` directory (e.g. to `/opt/easytunnel`) and run:

```bash
cd /opt/easytunnel
cp config.example.json config.json     # optional; a password/token is generated on first run otherwise
docker compose up -d
docker compose logs easytunnel | tail -20   # note the admin password and client tokens
```

> No Docker? Install Node.js 18+ and run `node server.js`.
> If `docker compose` is not available, use `docker-compose` (v1).

#### 2. Open the ports

Allow these in your cloud security group / firewall:

- `9000` — admin page (restrict it to your own source IPs)
- `9001` — client connections
- the **public port** of every mapping you add later (e.g. `18080`)

#### 3. Sign in

Open `http://<PUBLIC_IP>:9000` and sign in with the admin password.

#### 4. Add a client and copy its config

“Clients” card → “Add client” → enter a name → click “Copy config” on that row. You get that client's `client.json`:

```json
{ "server": "<PUBLIC_IP>:9001", "token": "<client token>", "name": "" }
```

#### 5. Internal machine: run the client

Put `EasyTunnelClient.exe` and `client.json` in the **same directory** and double-click the exe. When the window shows “connected”, it works; you can minimize it to the tray.

#### 6. Add a mapping and verify

“Mappings” → “Add mapping”: pick the client you just added, public port `18080` → internal `127.0.0.1:8080`, save.
Then `http://<PUBLIC_IP>:18080` should reach the internal service. If the target client is offline, the mapping shows “waiting for client”.

#### Upgrade and rollback

```bash
cd /opt/easytunnel
cp server.js server.js.bak && cp admin.html admin.html.bak     # back up
# overwrite with the new server.js / admin.html, then:
docker compose restart easytunnel

# rollback: copy the .bak files back and restart
```

> Source files are mounted into the container, so a `restart` is enough — no image rebuild. Do not overwrite `config.json`.
> A legacy single-client config is migrated to a “Default client”; the original token keeps working.

### Features

- **Zero-dependency server**: plain Node.js standard library — run with `node server.js`, or use Docker
- **Single-file client**: a ~84 MB `EasyTunnelClient.exe` for Windows; no Node.js installation required
- **Configure in the browser**: port mappings, path mappings, public host and tokens are all managed in the admin page and take effect immediately
- **Dark admin console**: live throughput chart, per-mapping traffic stats, connection counts, HTTPS certificate info
- **Reliable forwarding**: custom frame protocol (9-byte header + channel multiplexing), backpressure via `pause`/`resume`, heartbeat with 40-second self-healing, automatic reconnect, and soft-close of keep-alive connections (large downloads are never truncated)
- **HTTPS path mapping**: the admin port dispatches TLS vs. plaintext by the first byte; the self-signed certificate can be downloaded and installed
- **Multi-client**: an isolated per-client connection pool; mappings are bound to a target client; one client dropping out affects only its own mappings
- **Security**: admin page and API require a password; per-client tokens; login rate limiting; constant-time comparisons

### Project layout

```
.
├── source/                 Full source code (for development and packaging)
│   ├── server.js           Server
│   ├── admin.html          Admin console (single file, dark UI)
│   ├── client.js           Client (protocol + GUI launcher)
│   ├── gui.ps1             Client GUI (WinForms, embedded into the exe)
│   ├── build-exe.js        Builds the single-file exe (Node SEA + postject)
│   ├── default.example.json Built-in client config template (copy to default.json before building)
│   ├── docker-compose.yml
│   └── icon/ tools/        Icon and rcedit (writes exe icon/version info)
├── server/                 Deployment directory for the server
│   ├── server.js  admin.html  docker-compose.yml
│   ├── config.example.json Config template (copy to config.json)
│   ├── certs/              HTTPS certificate (cert.pem / key.pem, self-signed is fine)
│   └── downloads/          client.zip served by the admin page's "Download client" button
└── client/                 Distribution directory for the client
    ├── client.example.json Config template (copy to client.json)
    └── (EasyTunnelClient.exe is a build artifact and is not committed)
```

> The repository does not include the exe or the zip release packages. Runtime-generated
> `config.json`, `client.json` and `default.json` contain passwords/tokens and are excluded by `.gitignore`.

### Quick start

#### 1. Server (public server)

```bash
cd server
cp config.example.json config.json     # Optional: it also works without this; a password/token is generated on first run
docker compose up -d                   # or: node server.js
docker compose logs easytunnel         # shows the admin password and client tokens
```

Admin page: `http://<PUBLIC_IP>:9000` (password from the config file or the startup log).

> `docker-compose.yml` uses `network_mode: host`: public ports are added from the web UI at any time and
> the container listens on the host directly, so you never edit compose or recreate the container for a new port.
> Remember to allow 9000, 9001 and every mapping's public port in your cloud security group / firewall.

#### 2. Client (internal machine; multiple are supported)

Admin page → "Clients" card → "Add client" → enter a name → click "Copy config" on that row, then put the resulting `client.json` next to `EasyTunnelClient.exe` on the target machine and double-click it (you can also type the address and token directly in the GUI). Each machine uses its own config; none of them replaces another.

> A legacy single-client config (only `token`, no `clients`) is migrated to a "Default client" on startup;
> the original token keeps working, so upgrading does not break deployed clients.

#### 3. Add a mapping

Admin page → "Mappings" → "Add mapping": pick the **target client** (or "Auto" = any online client), enter the public port → internal `host:port` (e.g. `18080 → 127.0.0.1:8080`). Visiting `http://<PUBLIC_IP>:18080` then reaches the service on that client machine. Path mappings work the same way, e.g. `https://<PUBLIC_IP>:9000/kod/`. When the target client is offline, the mapping shows "waiting for client".

### Build from source

```bash
# Client exe (Windows, Node >= 20; postject is fetched via npx on the first build)
cd source
cp default.example.json default.json   # Fill in your own server address and token (optional; you can also leave it empty)
node build-exe.js                      # Output: EasyTunnelClient.exe

# The server needs no build step
node server.js
```

### Protocol summary

Everything is multiplexed over a single TCP control connection. Frame header: `type(1) | channelId(4) | length(4)`, where `type=1` is a JSON control frame and `type=2` is a raw data frame. The session is built from `auth / auth_ok / open / ready / close / pause / resume / ping / pong`; `open` carries the internal target address, and the client replies `ready` after connecting, then forwards data in both directions.

A client authenticates with a `token` (which identifies the client) and a `clientId` (for display). Clients must send a `ping` at least every 30 seconds; the server times each client independently and, after 30 seconds without any frame, marks that client offline, closes the socket and cleans up its channels (covering TCP half-open connections caused by network loss or sleep). Mappings of that client then show "waiting for client".

### Security notes

- Restrict the admin port (9000) to your own source IPs, or put it behind a VPN
- The tunnel port (9001) is plaintext TCP with token authentication — use a strong token and restrict sources when exposed to the internet
- The self-signed HTTPS certificate is only used for path mappings; browsers need to trust it manually on first visit

### Acceptable use

This tool is intended for networks and services that you **own or are authorized to access**, for remote operations and integration testing. Do not use it for unauthorized access, to penetrate networks you do not own, or to bypass access controls. You are responsible for how you use it.

### License

Licensed under the **Apache License 2.0** — see [LICENSE](LICENSE).

Third-party components distributed with this project (the Node.js runtime and the rcedit build tool) and their licenses are described in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [NOTICE](NOTICE). The full Node.js license text ships with the client package at `LICENSES/Node.js-LICENSE.txt`.

> The "EasyTunnel" name is not granted as a trademark; Apache 2.0 grants copyright and patent rights only.
