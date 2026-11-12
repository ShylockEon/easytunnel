# EasyTunnel — Project Introduction

> A self-hosted tool that safely exposes internal services to the public internet:
> **one public server + one single-file client + one web console**.
> No dependencies to install, no config files to edit, no restart when you change a mapping.

> 中文版：[项目介绍（中文）](项目介绍.md)

---

## 1. What it is

EasyTunnel is a lightweight intranet-penetration system. It exposes services running on internal machines (web sites, SSH, databases, RDP, and so on) to the public internet.

It has three parts:

| Component | Where it runs | Form |
|---|---|---|
| Server | Any machine with a public IP | A single `server.js` (Node.js standard library, zero third-party deps, Docker-friendly) |
| Client | An internal Windows machine | A single `EasyTunnelClient.exe` (~84 MB, Node runtime embedded, no installation) |
| Admin console | A browser | Dark web UI served by the server (port mappings, path mappings, clients, traffic stats) |

Typical use: run an internal system on an office PC and reach it over a public domain/port while traveling; or temporarily expose a home NAS or a dev machine's SSH.

---

## 2. Why we built it

Common tunneling options each involve trade-offs:

- **frp** is full-featured and fast, but you hand-write `frpc.toml`; adding a mapping means editing config and restarting the process.
- **Cloudflare Tunnel** needs no server, but requires domain hosting and public HTTP, and can be slow in mainland China.
- **Commercial services** (cpolar, natapp, …) are the easiest to start with, but the free tiers are rate-limited and everything is configured in a vendor dashboard.
- **Tailscale/ZeroTier** build a network; they do not publish a port to the public internet.

EasyTunnel's goal is narrow and explicit: **given a public server, adding a mapping should be two clicks in a browser**, and the client should be a single file with nothing to install. Three design decisions follow from that:

1. Mappings live on the server; creating, editing or deleting one **takes effect immediately** (the server opens/closes port listeners on demand and drops stale connections).
2. The client is one executable; double-click it, a config window appears, and once connected it minimizes to the tray.
3. Multiple internal machines can be **online at the same time**, each with its own token, and each mapping targets a specific client — they do not interfere.

---

## 3. Core features

**Configuration and operations**

- Everything is configured in the browser: port mappings, HTTPS path mappings, the public host, and client tokens
- Add/edit mappings in a modal form; press Enter to submit; changes apply immediately without restarting the server or client
- Multi-client management: add, rename, reset token, delete, copy that client's config
- Configuration is persisted in `config.json` and survives restarts/migrations; legacy single-client configs are migrated automatically

**Forwarding**

- TCP port mappings: any TCP service — HTTP/HTTPS sites, SSH, MySQL, Redis, RDP, …
- HTTPS path mappings: share the admin port, dispatch TLS vs. plaintext by the first byte, and forward by path prefix to different internal services (optionally strip the prefix; optionally verify the upstream certificate)
- keep-alive connection reuse: consecutive requests on the same public connection reuse the channel; large downloads are never truncated
- Backpressure: bidirectional `pause`/`resume` flow control; a slow internal service cannot blow up memory; a 1 MB buffer cap applies

**Reliability**

- Frame-protocol multiplexing: one control connection carries every mapping channel
- Heartbeat and self-healing: the client pings every 5 s and reconnects after 40 s without a response; the server marks a client offline after 30 s without any frame and cleans up its channels
- Automatic reconnect with backoff (200 ms for the first two attempts, then gradually up to 10 s)
- Live mapping states: `running / disabled / error / waiting for client`

**Performance**

- Zero-copy data frames: header and payload are written separately with `cork/uncork`, avoiding a full copy of every chunk
- Chunk-queue decoder: zero-copy slicing when a frame fits in one socket chunk; a single copy when it spans chunks
- Measured on localhost: decode throughput rose from ~1.1 GB/s to 6.5 GB/s (83% less time); 20 MB transfers through the tunnel ran at 318–408 MB/s

**Security**

- The admin page and every admin API require a password; 5 consecutive failures from one IP lock it for 60 s
- Each client has its own token and is identified by it; password/token comparisons are constant-time
- Admin port 9000 and tunnel port 9001 can be separated and restricted to trusted sources when needed
- The self-signed HTTPS certificate can be downloaded and installed (used for path mappings)

---

## 4. How it works

### 4.1 The path of one external request

```
Browser / external client
   │  GET http://PUBLIC_IP:18080
   ▼
Server (server.js)
   │  ① the 18080 listener accepts the connection and looks up the mapping:
   │     18080 → 127.0.0.1:8080, owned by "Machine A"
   │  ② sends {t:'open', host, port} on that client's control connection
   │     and allocates channel id ch
   ▼
Internal client (EasyTunnelClient.exe on Machine A)
   │  ③ connects to 127.0.0.1:8080 and replies {t:'ready', ch} on success
   │  ④ forwards both ways: public data → internal service,
   │     internal responses → the public connection
   ▼
Internal service (e.g. a local web app)
```

### 4.2 Frame protocol

All traffic is multiplexed over one TCP control connection. The header is 9 bytes:

```
| type(1) | channelId(4, big-endian) | length(4, big-endian) | payload(length) |
```

- `type=1`: control frame, JSON (UTF-8)
- `type=2`: data frame, raw bytes

Control messages: `auth / auth_ok / err / open / ready / close / pause / resume / ping / pong`.

### 4.3 Key design decisions

- **A channel is a connection**: one channel id per public connection; server and client each keep a local socket map
- **Soft close**: closing the internal socket does not close the public connection; the channel is kept for 60 s awaiting keep-alive reuse, so trailing bytes are not lost to an RST
- **Unified backpressure**: when either write buffer is full, a `pause` is sent and the peer stops reading; `resume` follows on `drain`, with a timeout that recovers automatically
- **Multi-client isolation**: a connection pool `clients: Map<clientId, conn>`; channels record their owning connection and mappings are routed by `clientId`

---

## 5. Admin console

- **Tunnel status**: online/offline, current client, uptime, tunnel port, service address
- **Live traffic**: 60-second upstream/downstream chart, peaks, per-mapping rate bars
- **Mappings**: public address, target client, internal address, state, connections, rates and cumulative traffic
- **Clients**: online state, IP, mapping count, active connections; add / rename / reset token / delete / copy config
- **Path mappings**: HTTPS path, internal scheme and port, strip-prefix, verify-upstream-certificate
- **Server settings**: public host, tunnel port, client config distribution
- **HTTPS certificate**: state, subject, expiry, downloadable

Add/edit use a modal form (Enter submits, Esc or clicking the backdrop closes); delete and reset-token use a “click again to confirm” pattern to avoid accidents.

---

## 6. Quick start

### 6.1 Server

```bash
cd server
cp config.example.json config.json        # optional; a password/token is generated on first run
docker compose up -d                      # or: node server.js
docker compose logs easytunnel            # shows the admin password and client tokens
```

Open `http://<PUBLIC_IP>:9000` and sign in with the admin password.

> `docker-compose.yml` uses `network_mode: host`: public ports are added in the web UI at any time and
> the container listens on the host directly — adding a port needs no compose edit.
> Allow 9000, 9001 and every mapping's public port in your security group / firewall.

### 6.2 Client

Admin page → “Clients” → pick a client → “Copy config”; put the resulting `client.json` next to `EasyTunnelClient.exe` and double-click it. Once connected the window shows “connected” and can be minimized to the tray.

Each machine uses its own config; none of them replaces another.

### 6.3 Add a mapping

“Mappings” → “Add mapping”: pick the target client (or “Auto”), enter the public port → internal `127.0.0.1:port`, save. Visiting `http://<PUBLIC_IP>:<public port>` reaches the service on that machine.

---

## 7. Project structure

```
.
├── source/                 Source and build (development)
│   ├── server.js           Server: admin page/API, port mappings, HTTPS path mappings, client pool
│   ├── admin.html          Admin console (single file, dark UI)
│   ├── client.js           Client: protocol engine, reconnect, config watch, GUI launcher
│   ├── gui.ps1             Client GUI (WinForms, embedded into the exe)
│   ├── build-exe.js        Builds the single-file exe (Node SEA + postject + rcedit)
│   ├── default.example.json Built-in client config template
│   └── icon/ tools/        Icon and rcedit
├── server/                 Server deployment directory
│   ├── server.js  admin.html  docker-compose.yml
│   ├── config.example.json Config template
│   ├── certs/              HTTPS certificate (cert.pem / key.pem)
│   └── downloads/          client.zip served by “Download client”
└── client/                 Client distribution directory
    └── client.example.json Config template (the exe is a build artifact and is not committed)
```

---

## 8. Deployment and operations

- **Release**: back up `server.js` / `admin.html` / `config.json` → upload the new files → `docker compose restart` (source is mounted; no image rebuild needed)
- **Rollback**: restore the backups and restart
- **Config**: `config.json` stores the admin password, client list and tokens, mappings, public host, HTTPS switch; generated on first start
- **Logs**: `docker compose logs` for the container; `client.log` next to the client (batched async writes so the forwarding path never blocks on disk)
- **Note**: the startup log prints the admin password and each client token — restrict access to the logs

---

## 9. Security notes

- The tunnel control port is **plaintext TCP with token auth**. Use a strong token and restrict source IPs when exposing it.
- Restrict the admin port (security-group allowlist / VPN); do not open it to the whole internet.
- The self-signed HTTPS certificate is only used for path mappings and must be trusted manually on first visit.
- A token equals account authority: if leaked, use “Reset token” in the admin page — it affects only that client.

---

## 10. Verified

| Scenario | Result |
|---|---|
| Single client: auth, forwarding, 300 KB payload, keep-alive requests, traffic stats | Pass |
| Multi-client: isolated forwarding, one client dropping out only marks its own mappings “waiting”, reconnect does not replace others, wrong token rejected, delete blocked while mappings exist | 14/14 pass |
| Offline detection: half-open connection detected at 30 s, healthy heartbeat not misjudged for 36 s, immediate offline on graceful close | 10/10 pass |
| Admin UI (headless browser): modal, selects, prefill, submit, rename, token double-confirm | Pass |
| Production deploy: config auto-migrated, legacy client reconnected, real external access through a temporary mapping, existing mappings unaffected | Pass |
| Performance: decode time −83% (~5.9×); 20 MB transfer through the tunnel at 318–408 MB/s | Pass |

---

## 11. Version history

- **v2.4.0**: multi-client (pool + mapping binding + per-client tokens), client rename, modal mapping forms, tunnel offline detection, zero-copy writes and decoder optimization
- **v2.3.0**: HTTPS path mappings, self-signed certificate download, per-mapping rate stats, dark admin redesign
- Earlier: single-client version, Docker deployment, Windows single-file exe

---

## 12. FAQ

**Q: A mapping shows “waiting for client”.**
The target client is offline. Check that the exe is running on that machine, the token matches, and port 9001 is reachable.

**Q: External access times out, and the server log shows no request.**
Most likely the cloud security group / firewall did not allow that public port. Confirm the listener is up, then check the allowlist.

**Q: How many mappings can one client have?**
No hard limit; it is bounded by ports and memory. Each mapping has its own listener and stats.

**Q: Can the client be killed in the background?**
The Windows client can stay in the tray; for Linux/server use, run `--no-gui` under a service manager.

**Q: Are large downloads truncated?**
No. Keep-alive soft close plus backpressure preserves trailing bytes; verified with 300 KB and 20 MB transfers.

---

## 13. Roadmap

- TLS at the tunnel layer (client ↔ server encryption)
- Client auto-start and service packaging
- Mapping import/export, grouping by client
- Access logs and simple monitoring/alerting
- Non-Windows client builds (Linux/macOS single file)

---

## 14. Project information

- Repository: https://gitee.com/ShylockEon/easytunnel
- Releases: https://gitee.com/ShylockEon/easytunnel/releases/tag/v2.4.0
- Stack: Node.js (server), JavaScript + PowerShell/WinForms (client), plain HTML/CSS/JS (console)
- License: Apache License 2.0 (see `LICENSE`); third-party notices in `THIRD_PARTY_NOTICES.md`
