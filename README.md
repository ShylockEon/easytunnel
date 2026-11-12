# EasyTunnel

零依赖的内网穿透工具：一台有公网 IP 的服务器 + 任意内网机器（Windows 单文件客户端），
浏览器里配置映射，保存即生效，无需改配置文件、无需重启。

支持 **TCP 端口映射**（HTTP / SSH / 数据库 / 远程桌面等）与 **HTTPS 路径映射**
（共用管理端口，按路径前缀分流到不同内网服务），并支持 **多台客户端同时在线**：
每台机器一个独立令牌，映射可指定目标客户端，互不干扰。

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

## 许可

内部/自用工具，未附带开源许可证，如需开源请自行补充。
