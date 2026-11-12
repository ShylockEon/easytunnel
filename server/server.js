// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CharlotteDe

'use strict';
/* ============================================================
 * EasyTunnel 服务端  ——  放在有公网 IP 的那台服务器上
 * 零依赖，Node.js >= 18，运行： node server.js
 *
 * 端口用途：
 *   ADMIN_PORT  (默认 9000) : Web 管理页面 + 管理 API；同时接受 HTTPS（按首字节分流）
 *   TUNNEL_PORT (默认 9001) : 内网客户端连入的控制端口
 *   其它由网页配置的 publicPort : 对外提供服务的公网端口
 *
 * HTTPS 路径映射：访问 https://<公网IP>:ADMIN_PORT/<路径>/ 按前缀转发到内网服务；
 *   证书放在 certs/cert.pem、certs/key.pem（自签名即可，首次访问需浏览器确认）。
 *
 * 可选环境变量： ADMIN_PORT / TUNNEL_PORT / ADMIN_PASSWORD
 * 首次启动会自动生成 config.json（管理密码 + 客户端令牌，并打印到控制台）
 * ============================================================ */

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = __dirname;
const CFG_FILE = path.join(DIR, 'config.json');
const ADMIN_HTML = path.join(DIR, 'admin.html');
const VERSION = '2.4.0';
const CLIENT_IDLE_MS = 30000;   // 认证后 30 秒没有任何帧（含 5 秒一次的 ping）即判定隧道离线
const DOWNLOADS_DIR = path.join(DIR, 'downloads');
const CLIENT_ZIP = path.join(DOWNLOADS_DIR, 'client.zip');
const CERTS_DIR = path.join(DIR, 'certs');
const CERT_FILE = path.join(CERTS_DIR, 'cert.pem');
const KEY_FILE = path.join(CERTS_DIR, 'key.pem');

/* ------------------------- 配置 ------------------------- */
function loadCfg() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch (_) { /* 首次运行 */ }
  c.adminPort = Number(process.env.ADMIN_PORT || c.adminPort || 9000);
  c.tunnelPort = Number(process.env.TUNNEL_PORT || c.tunnelPort || 9001);
  c.adminPassword = process.env.ADMIN_PASSWORD || c.adminPassword || crypto.randomBytes(6).toString('hex');
  c.token = c.token || crypto.randomBytes(16).toString('hex');
  c.mappings = Array.isArray(c.mappings) ? c.mappings : [];
  c.pathMappings = Array.isArray(c.pathMappings) ? c.pathMappings : [];
  // 多客户端：每个客户端一个稳定 id + 独立令牌；旧配置没有 clients 时自动迁移为单个默认客户端
  const rawClients = Array.isArray(c.clients) ? c.clients : [];
  const seen = new Set();
  c.clients = rawClients
    .map(x => ({
      id: String((x && x.id) || '').slice(0, 32),
      name: String((x && x.name) || '').slice(0, 40),
      token: String((x && x.token) || '')
    }))
    .filter(x => x.token);
  for (const cl of c.clients) {
    if (!cl.id || seen.has(cl.id)) cl.id = 'c' + crypto.randomBytes(3).toString('hex');
    seen.add(cl.id);
    if (!cl.name) cl.name = '客户端 ' + cl.id;
  }
  if (!c.clients.length) {
    c.clients.push({
      id: 'c0', name: '默认客户端',
      token: c.token || crypto.randomBytes(16).toString('hex')
    });
  }
  c.token = c.clients[0].token;   // 兼容旧字段与旧版客户端
  c.httpsEnabled = c.httpsEnabled !== false;
  c.publicHost = typeof c.publicHost === 'string' ? c.publicHost : '';  // 客户端连接用的公网 IP / 域名，在管理页配置
  return c;
}
const cfg = loadCfg();
function saveCfg() {
  fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}
saveCfg();

function log(msg, tag) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log('[' + t + '] ' + (tag || '--') + ' ' + msg);
}

/* ---------------------- 帧协议 ----------------------
 * | type(1) | channelId(4) | length(4) | payload(length) |
 * type = 1 控制帧(JSON/UTF-8)，type = 2 数据帧(原始字节)
 * --------------------------------------------------- */
function frameHeader(type, ch, len) {
  const h = Buffer.allocUnsafe(9);
  h[0] = type;
  h.writeUInt32BE(ch >>> 0, 1);
  h.writeUInt32BE(len >>> 0, 5);
  return h;
}
function frame(type, ch, body) {
  body = body || Buffer.alloc(0);
  return Buffer.concat([frameHeader(type, ch, body.length), body]);
}
function ctrl(ch, obj) {
  return frame(1, ch, Buffer.from(JSON.stringify(obj), 'utf8'));
}

/* 数据帧写：帧头与负载分两次 write，再用 cork/uncork 合成一次发送。
 * 相比 frame() 的 Buffer.concat，省掉每块数据的一次全量拷贝 —— 大流量下
 * 能明显降低内存带宽与 GC 压力（这是转发热路径，每次公网读都会走）。 */
function writeFrame(sock, type, ch, payload) {
  if (!sock || sock.destroyed || !sock.writable) return false;
  const h = frameHeader(type, ch, payload.length);
  let ok = true;
  try {
    sock.cork();
    ok = sock.write(h);
    if (payload.length) ok = sock.write(payload) && ok;
  } catch (_) {
    return false;
  } finally {
    try { sock.uncork(); } catch (_) { /* ignore */ }
  }
  return ok;
}

/* 解码器：按分片队列解析，整帧落在同一 chunk 时零拷贝；
 * 跨 chunk 时只做一次必要拷贝。旧实现每个 chunk 都 Buffer.concat 一次，
 * 高吞吐 / 小帧密集（chunked 响应）时是 O(n²) 的重复拷贝。 */
function decoder(onFrame) {
  const parts = [];
  let total = 0;

  function header() {
    const first = parts[0];
    if (first.length >= 9) return first;
    const h = Buffer.allocUnsafe(9);
    let copied = 0;
    for (let i = 0; i < parts.length && copied < 9; i++) {
      const p = parts[i];
      const n = Math.min(9 - copied, p.length);
      p.copy(h, copied, 0, n);
      copied += n;
    }
    return h;
  }

  function take(n) {
    if (n <= 0) return Buffer.alloc(0);
    const first = parts[0];
    if (first.length > n) {
      parts[0] = first.subarray(n);
      total -= n;
      return first.subarray(0, n);          // 零拷贝
    }
    if (first.length === n) {
      parts.shift();
      total -= n;
      return first;
    }
    const out = Buffer.allocUnsafe(n);       // 跨片：只拷贝一次
    let copied = 0;
    while (copied < n) {
      const p = parts[0];
      const need = n - copied;
      if (p.length <= need) {
        p.copy(out, copied);
        copied += p.length;
        parts.shift();
      } else {
        p.copy(out, copied, 0, need);
        parts[0] = p.subarray(need);
        copied = n;
      }
    }
    total -= n;
    return out;
  }

  return function (chunk) {
    if (!chunk.length) return;
    parts.push(chunk);
    total += chunk.length;
    while (total >= 9) {
      const h = header();
      const len = h.readUInt32BE(5);
      if (len > 8 * 1024 * 1024) throw new Error('帧过大，已断开');
      if (total < 9 + len) break;
      const type = h[0];
      const ch = h.readUInt32BE(1);
      take(9);
      onFrame(type, ch, take(len));
    }
  };
}

/* ---------------------- 运行时状态 ---------------------- */
const S = {
  clients: new Map(),       // clientId -> { id, sock, name, ip, authed, since, lastRecv }
  channels: new Map(),      // ch -> { pub, ready, pending, pendingBytes, timer, ps }
  listeners: new Map(),     // publicPort -> net.Server
  listenerError: {},        // publicPort -> 错误信息
  seq: 0,
  startedAt: Date.now(),
  totalConn: 0,
  bytesIn: 0,
  bytesOut: 0,
  rateIn: 0,                // 最近一次 2 秒采样的全局速率（字节/秒）
  rateOut: 0,
  history: { in: new Array(60).fill(0), out: new Array(60).fill(0) },
  mapStats: new Map(),      // publicPort -> 逐映射统计（见 portStats）
  pathStats: new Map(),     // pathMapping.id -> 逐路径统计
  pathFwd: new Map()        // pathMapping.id -> { srv, port, host, lport }
};

/* 逐映射统计：热路径只做对象属性自增，避免 Map 查找。
 * bytesIn  = 公网发往内网方向的 payload 字节（不含 9 字节帧头）
 * bytesOut = 内网返回公网方向的 payload 字节
 * total    = 该端口累计建立的公网连接数（含随后被拒绝的） */
function portStats(port) {
  let s = S.mapStats.get(port);
  if (!s) {
    s = {
      total: 0, bytesIn: 0, bytesOut: 0,
      rateIn: 0, rateOut: 0, lastAt: 0,
      _sampleIn: 0, _sampleOut: 0
    };
    S.mapStats.set(port, s);
  }
  return s;
}

/* 路径映射统计（与端口映射同一套字段，按映射 id 区分） */
function pathStats(id) {
  let s = S.pathStats.get(id);
  if (!s) {
    s = {
      total: 0, bytesIn: 0, bytesOut: 0,
      rateIn: 0, rateOut: 0, lastAt: 0,
      _sampleIn: 0, _sampleOut: 0
    };
    S.pathStats.set(id, s);
  }
  return s;
}

function onlineClients() {
  const out = [];
  for (const c of S.clients.values()) if (c.authed && c.sock && !c.sock.destroyed) out.push(c);
  return out;
}
function primaryClient() { return onlineClients()[0] || null; }

/* 解析映射目标客户端：指定了 clientId 就必须在线；未指定则落到任一在线客户端 */
function resolveConnFor(target) {
  const id = target && target.clientId;
  if (id) {
    const c = S.clients.get(id);
    return (c && c.authed && c.sock && !c.sock.destroyed) ? c : null;
  }
  return primaryClient();
}

function isClientOnline(id) {
  if (!id) return onlineClients().length > 0;   // 自动：任一在线即可
  const c = S.clients.get(id);
  return !!(c && c.authed && c.sock && !c.sock.destroyed);
}

function writeConn(conn, buf) {
  if (!conn || !conn.authed || !conn.sock || conn.sock.destroyed) return false;
  const ok = conn.sock.write(buf);
  if (!ok) pauseAllPublic();     // 控制连接背压：暂停所有公网来源
  return ok;
}
/* 转发数据帧（零拷贝写），与 writeConn 保持同样的背压语义 */
function writeConnData(conn, ch, payload) {
  if (!conn || !conn.authed || !conn.sock || conn.sock.destroyed) return false;
  const ok = writeFrame(conn.sock, 2, ch, payload);
  if (!ok) pauseAllPublic();
  return ok;
}
function sendCtrlTo(conn, ch, obj) { return writeConn(conn, ctrl(ch, obj)); }
/* 关闭某个客户端的全部通道（顶替/掉线时用） */
function closeChannelsOf(conn) {
  for (const [ch, c] of [...S.channels]) if (c.conn === conn) closeChannel(ch, false);
}
function pauseAllPublic() {
  for (const c of S.channels.values()) if (c.ready && !c.pub.destroyed) c.pub.pause();
}
function resumeAllPublic() {
  for (const c of S.channels.values()) if (c.ready && !c.pub.destroyed) c.pub.resume();
}

function closeChannel(ch, notifyClient) {
  const c = S.channels.get(ch);
  if (!c) return;
  S.channels.delete(ch);
  if (c.timer) clearTimeout(c.timer);
  if (!c.pub.destroyed) c.pub.destroy();
  if (notifyClient && c.conn) sendCtrlTo(c.conn, ch, { t: 'close' });
}
// 映射变更时断开该端口上的存量连接，保证「改完立即生效」
function killChannelsOnPort(port) {
  for (const [ch, c] of [...S.channels]) if (c.port === port) closeChannel(ch, true);
}

function findMapping(port) {
  return cfg.mappings.find(m => m.enabled && Number(m.publicPort) === port);
}

/* ---------------------- 速率采样（每秒一次，保留 60 秒） ---------------------- */
let lastSampleAt = Date.now();
let lastSampleIn = 0;
let lastSampleOut = 0;
setInterval(() => {
  const now = Date.now();
  const dt = Math.max(0.5, (now - lastSampleAt) / 1000);
  const dIn = S.bytesIn - lastSampleIn;
  const dOut = S.bytesOut - lastSampleOut;
  lastSampleAt = now;
  lastSampleIn = S.bytesIn;
  lastSampleOut = S.bytesOut;

  S.rateIn = Math.max(0, Math.round(dIn / dt));
  S.rateOut = Math.max(0, Math.round(dOut / dt));
  S.history.in.push(S.rateIn);
  S.history.out.push(S.rateOut);
  if (S.history.in.length > 60) S.history.in.shift();
  if (S.history.out.length > 60) S.history.out.shift();

  for (const st of S.mapStats.values()) {
    st.rateIn = Math.max(0, Math.round((st.bytesIn - st._sampleIn) / dt));
    st.rateOut = Math.max(0, Math.round((st.bytesOut - st._sampleOut) / dt));
    st._sampleIn = st.bytesIn;
    st._sampleOut = st.bytesOut;
  }
  for (const st of S.pathStats.values()) {
    st.rateIn = Math.max(0, Math.round((st.bytesIn - st._sampleIn) / dt));
    st.rateOut = Math.max(0, Math.round((st.bytesOut - st._sampleOut) / dt));
    st._sampleIn = st.bytesIn;
    st._sampleOut = st.bytesOut;
  }
}, 1000).unref();

/* ---------------------- 公网端口监听 ---------------------- */
function applyMappings() {
  const want = new Set();
  for (const m of cfg.mappings) if (m.enabled) want.add(Number(m.publicPort));

  for (const [port, srv] of [...S.listeners]) {
    if (!want.has(port)) {
      S.listeners.delete(port);
      delete S.listenerError[port];
      killChannelsOnPort(port);
      try { srv.close(function () {}); } catch (_) { /* ignore */ }
      log('停止监听 ' + port);
    }
  }

  for (const port of want) {
    if (S.listeners.has(port)) continue;
    const srv = net.createServer(pub => onPublicConnection(pub, port));
    srv.on('error', e => {
      S.listenerError[port] = e.code === 'EADDRINUSE' ? '端口已被占用' : (e.code || e.message);
      S.listeners.delete(port);
      log('端口 ' + port + ' 监听失败：' + S.listenerError[port], '!!');
    });
    srv.listen(port, '0.0.0.0', () => {
      delete S.listenerError[port];
      log('监听公网端口 ' + port);
    });
    S.listeners.set(port, srv);
  }
}

/* 把一条公网/本地 TCP 连接挂到客户端通道上。
 * target: { port, pathId, localHost, localPort, name, stats } */
function attachTunnel(pub, target, label) {
  const conn = resolveConnFor(target);
  if (!conn) { pub.destroy(); return false; }   // 目标客户端离线：直接放弃这条公网连接
  target.stats.total++;
  target.stats.lastAt = Date.now();

  const ch = ++S.seq;
  const c = {
    conn, pub, port: target.port || null, pathId: target.pathId || null,
    ready: false, pending: [], pendingBytes: 0, timer: null, ps: target.stats
  };
  S.channels.set(ch, c);
  pub.pause();                                   // 等客户端把内网服务连上

  c.timer = setTimeout(() => {
    if (S.channels.get(ch) === c && !c.ready) {
      log('通道 #' + ch + ' 连接内网超时', '!!');
      closeChannel(ch, true);
    }
  }, 10000);

  pub.on('data', d => {
    S.bytesIn += d.length;
    const cur = S.channels.get(ch);
    if (!cur) return;
    cur.ps.bytesIn += d.length;
    if (!cur.ready) {
      cur.pendingBytes += d.length;
      if (cur.pendingBytes > 1024 * 1024) { closeChannel(ch, true); return; }
      cur.pending.push(Buffer.from(d));   // 暂存路径显式拷贝，避免切片持有整块 socket 缓冲
      return;
    }
    writeConnData(cur.conn, ch, d);
  });
  const bye = () => closeChannel(ch, true);
  pub.on('close', bye);
  pub.on('error', bye);

  sendCtrlTo(conn, ch, { t: 'open', host: target.localHost, port: Number(target.localPort), name: target.name || '' });
  log('新连接 #' + ch + '  ' + label + ' -> ' + target.localHost + ':' + target.localPort);
  return true;
}

function onPublicConnection(pub, port) {
  S.totalConn++;
  const m = findMapping(port);
  if (!m) { pub.destroy(); return; }
  attachTunnel(pub, {
    clientId: m.clientId || '',
    port: port,
    localHost: m.localHost,
    localPort: m.localPort,
    name: m.name,
    stats: portStats(port)
  }, '公网 ' + port);
}

/* ---------------------- HTTPS 路径映射 ----------------------
 * HTTPS 与 HTTP 共用管理端口（AdminPort）：用首字节分流，0x16 是 TLS ClientHello。
 * 每个路径映射在 127.0.0.1 起一个本地转发器，转发器再通过客户端通道连到内网服务。
 * 这样可以直接复用 Node 的 http/https 客户端处理 HTTP/1.1、chunked、WebSocket 升级。 */
let adminInternalPort = 0;
let httpsServer = null;
let httpsInternalPort = 0;
let httpsError = '';
let httpsCertInfo = { subject: '', validTo: '' };

function loadTls() {
  httpsServer = null;
  httpsInternalPort = 0;
  httpsError = '';
  httpsCertInfo = { subject: '', validTo: '' };
  if (!cfg.httpsEnabled) { httpsError = 'HTTPS 已在配置中关闭'; return; }
  try {
    const cert = fs.readFileSync(CERT_FILE, 'utf8');
    const key = fs.readFileSync(KEY_FILE, 'utf8');
    httpsServer = https.createServer({ cert, key }, onHttpsRequest);
    httpsServer.on('upgrade', onHttpsUpgrade);
    try {
      const x = new crypto.X509Certificate(cert);
      httpsCertInfo.subject = String(x.subject || '').replace(/\n/g, ' ').trim();
      httpsCertInfo.validTo = String(x.validTo || '');
    } catch (_) { /* 只展示基础状态 */ }
    httpsError = '';
    log('HTTPS 证书已加载：' + (httpsCertInfo.subject || '自签名证书'), 'OK');
  } catch (e) {
    httpsError = '未找到可用证书：请把 cert.pem / key.pem 放到 certs/ 目录';
    log(httpsError, '!!');
  }
}

function startPathForwarder(pm) {
  const srv = net.createServer(sock => {
    attachTunnel(sock, {
      clientId: pm.clientId || '',
      pathId: pm.id,
      localHost: pm.localHost,
      localPort: pm.localPort,
      name: pm.name,
      stats: pathStats(pm.id)
    }, 'HTTPS ' + pm.path);
  });
  srv.on('error', e => {
    log('路径映射 ' + pm.path + ' 本地转发失败：' + (e.code || e.message), '!!');
  });
  srv.listen(0, '127.0.0.1', () => {
    S.pathFwd.set(pm.id, {
      srv: srv,
      port: srv.address().port,
      host: pm.localHost,
      lport: Number(pm.localPort)
    });
    log('路径映射就绪 ' + pm.path + ' -> ' + pm.localHost + ':' + pm.localPort);
  });
}

function stopPathForwarder(id, notify) {
  const f = S.pathFwd.get(id);
  if (!f) return;
  S.pathFwd.delete(id);
  for (const [ch, c] of [...S.channels]) {
    if (c.pathId === id) closeChannel(ch, notify);
  }
  try { f.srv.close(function () {}); } catch (_) { /* ignore */ }
}

function applyPathMappings() {
  const want = new Map();
  for (const pm of cfg.pathMappings) if (pm.enabled) want.set(pm.id, pm);

  for (const [id, f] of [...S.pathFwd]) {
    const pm = want.get(id);
    if (!pm) { stopPathForwarder(id, true); continue; }
    if (f.host !== pm.localHost || f.lport !== Number(pm.localPort)) {
      stopPathForwarder(id, true);
    }
  }
  for (const pm of want.values()) {
    if (!S.pathFwd.has(pm.id)) startPathForwarder(pm);
  }
}

function matchPathMapping(urlPath) {
  const u = String(urlPath || '/');
  let best = null;
  let bestLen = -1;
  for (const pm of cfg.pathMappings) {
    if (!pm.enabled) continue;
    const prefix = String(pm.path || '').replace(/\/+$/, '');
    if (!prefix || prefix === '/') continue;
    if (u === prefix || u.startsWith(prefix + '/')) {
      if (prefix.length > bestLen) { best = pm; bestLen = prefix.length; }
    }
  }
  return best;
}

function buildTargetPath(pm, rawUrl) {
  let u = String(rawUrl || '/');
  let q = '';
  const qi = u.indexOf('?');
  if (qi >= 0) { q = u.slice(qi); u = u.slice(0, qi); }
  const prefix = String(pm.path || '').replace(/\/+$/, '');
  if (pm.stripPrefix !== false && prefix && u.startsWith(prefix)) {
    u = u.slice(prefix.length) || '/';
    if (u.charAt(0) !== '/') u = '/' + u;
  }
  return u + q;
}

function proxyToAdmin(req, res) {
  if (!adminInternalPort) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('管理页尚未就绪');
    return;
  }
  const up = http.request({
    host: '127.0.0.1',
    port: adminInternalPort,
    method: req.method,
    path: req.url,
    headers: req.headers
  }, r => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('管理页暂不可用');
  });
  req.pipe(up);
}

function onHttpsRequest(req, res) {
  const urlPath = String(req.url || '/').split('?')[0];
  // 管理页 / API / 下载 / 证书走原管理服务，避免被路径映射抢占
  if (urlPath === '/' || urlPath === '/index.html' || urlPath.startsWith('/api/') ||
      urlPath.startsWith('/download/') || urlPath === '/favicon.ico') {
    proxyToAdmin(req, res);
    return;
  }
  const pm = matchPathMapping(urlPath);
  if (!pm) { proxyToAdmin(req, res); return; }

  const fwd = S.pathFwd.get(pm.id);
  if (!fwd) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('路径映射尚未就绪：' + pm.path);
    return;
  }

  const headers = Object.assign({}, req.headers);
  headers['x-forwarded-proto'] = 'https';
  headers['x-forwarded-host'] = req.headers.host || '';
  headers['x-forwarded-for'] = (req.socket && req.socket.remoteAddress) || '';
  const prefix = String(pm.path || '').replace(/\/+$/, '');
  if (pm.stripPrefix !== false) headers['x-forwarded-prefix'] = prefix;
  delete headers['connection'];

  const mod = pm.scheme === 'https' ? https : http;
  const targetPath = buildTargetPath(pm, req.url);
  const up = mod.request({
    host: '127.0.0.1',
    port: fwd.port,
    method: req.method,
    path: targetPath,
    headers: headers,
    rejectUnauthorized: pm.verifyTls === true,
    servername: pm.localHost
  }, upRes => {
    const outHeaders = Object.assign({}, upRes.headers);
    if (pm.stripPrefix !== false && prefix) {
      if (outHeaders.location && outHeaders.location.charAt(0) === '/' &&
          outHeaders.location !== prefix && !outHeaders.location.startsWith(prefix + '/')) {
        outHeaders.location = prefix + outHeaders.location;
      }
      if (outHeaders['set-cookie']) {
        outHeaders['set-cookie'] = outHeaders['set-cookie'].map(c =>
          c.replace(/;\s*Path=\/(?=;|$)/i, '; Path=' + prefix + '/'));
      }
    }
    res.writeHead(upRes.statusCode || 502, outHeaders);
    upRes.pipe(res);
  });
  up.setTimeout(60000, () => up.destroy(new Error('上游超时')));
  up.on('error', err => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('上游连接失败：' + (err.code || err.message));
    } else {
      try { res.destroy(); } catch (_) { /* ignore */ }
    }
  });
  req.pipe(up);
}

function onHttpsUpgrade(req, socket, head) {
  const urlPath = String(req.url || '/').split('?')[0];
  const pm = matchPathMapping(urlPath);
  if (!pm) { socket.destroy(); return; }
  const fwd = S.pathFwd.get(pm.id);
  if (!fwd) { socket.destroy(); return; }

  const targetPath = buildTargetPath(pm, req.url);
  const up = net.connect(fwd.port, '127.0.0.1', () => {
    const lines = [req.method + ' ' + targetPath + ' HTTP/1.1'];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1]);
    }
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    socket.pipe(up);
    up.pipe(socket);
  });
  up.on('error', () => { try { socket.destroy(); } catch (_) { /* ignore */ } });
  socket.on('error', () => { try { up.destroy(); } catch (_) { /* ignore */ } });
}

/* ---------------------- 内网客户端连接 ---------------------- */
function onClientFrame(conn, type, ch, payload) {
  if (type === 1) {
    let msg;
    try { msg = JSON.parse(payload.toString('utf8')); } catch (_) { return; }

    if (msg.t === 'auth') {
      // 每客户端一个独立令牌；命中哪条就归属哪个客户端
      const entry = cfg.clients.find(cl => safeEqual(msg.token, cl.token));
      if (!entry) {
        try { conn.sock.write(ctrl(0, { t: 'err', msg: '令牌错误' })); } catch (_) { /* ignore */ }
        setTimeout(() => conn.sock.destroy(), 150);
        log('客户端令牌校验失败，已拒绝 (' + conn.ip + ')', '!!');
        return;
      }
      clearTimeout(conn.timer);
      conn.authed = true;
      conn.id = entry.id;
      conn.name = entry.name;
      conn.reportedName = String(msg.name || '').slice(0, 40);
      conn.since = Date.now();
      conn.lastRecv = Date.now();
      // 同一客户端重连/顶替：只清掉它自己的旧连接与旧通道，不影响其它客户端
      const old = S.clients.get(entry.id);
      if (old && old !== conn) {
        try { old.sock.destroy(); } catch (_) { /* ignore */ }
        closeChannelsOf(old);
      }
      S.clients.set(entry.id, conn);
      conn.sock.write(ctrl(0, { t: 'auth_ok', cid: entry.id, name: conn.name }));
      log('客户端已上线：' + conn.name + ' [' + entry.id + '] (' + conn.ip + ')', 'OK');
      return;
    }
    if (!conn.authed || S.clients.get(conn.id) !== conn) return;

    switch (msg.t) {
      case 'ready': {
        const c = S.channels.get(ch);
        if (!c || c.conn !== conn || c.ready) return;
        clearTimeout(c.timer); c.timer = null;
        c.ready = true;
        let blocked = false;
        for (const d of c.pending) if (!writeConnData(conn, ch, d)) blocked = true;
        c.pending = [];
        if (!blocked) c.pub.resume();           // 否则等控制连接 drain 统一恢复
        break;
      }
      case 'close':
        closeChannel(ch, false);
        break;
      case 'pause': {
        const c = S.channels.get(ch);
        if (c && c.conn === conn && !c.pub.destroyed) c.pub.pause();
        break;
      }
      case 'resume': {
        const c = S.channels.get(ch);
        if (c && c.conn === conn && c.ready && !c.pub.destroyed) c.pub.resume();
        break;
      }
      case 'ping':
        sendCtrlTo(conn, 0, { t: 'pong' });
        break;
    }
    return;
  }

  if (type === 2) {
    if (!conn.authed || S.clients.get(conn.id) !== conn) return;
    const c = S.channels.get(ch);
    if (!c || c.conn !== conn || !c.ready || c.pub.destroyed) return;
    S.bytesOut += payload.length;
    c.ps.bytesOut += payload.length;
    if (!c.pub.write(payload)) {
      sendCtrlTo(conn, ch, { t: 'pause' });     // 让客户端暂停读内网服务
      c.pub.once('drain', () => {
        if (S.channels.get(ch) === c) sendCtrlTo(conn, ch, { t: 'resume' });
      });
    }
  }
}


/* 隧道离线判定：客户端每 5 秒发 ping，认证后 30 秒收不到任何帧说明连接已半开
 *（断网、休眠、路由掉线都不会发 FIN），此时主动断开并清理，避免管理页一直显示在线、
 *  公网端口持续接住连接却没有响应。 */
setInterval(() => {
  for (const c of S.clients.values()) {
    if (!c.authed || !c.sock || c.sock.destroyed) continue;
    const idle = Date.now() - (c.lastRecv || c.since || Date.now());
    if (idle > CLIENT_IDLE_MS) {
      log('客户端心跳超时（' + Math.round(idle / 1000) + ' 秒无数据）：' + c.name + ' [' + c.id + ']，判定离线', '!!');
      try { c.sock.destroy(); } catch (_) { /* close 事件里统一清理 */ }
    }
  }
}, 5000).unref();

const controlServer = net.createServer(sock => {
  const conn = { sock, ip: sock.remoteAddress || '?', id: '', name: '', reportedName: '', authed: false, since: 0, timer: null, lastRecv: Date.now() };

  // 不在 TCP 建立瞬间顶替在线客户端（见 auth 成功分支）；
  // 未认证连接 8 秒后自行超时退出，不污染已认证的客户端表。
  conn.timer = setTimeout(() => {
    if (!conn.authed) { log('客户端认证超时，断开', '!!'); sock.destroy(); }
  }, 8000);

  const feed = decoder((type, ch, payload) => {
    try { onClientFrame(conn, type, ch, payload); }
    catch (e) { log('协议错误：' + e.message, '!!'); sock.destroy(); }
  });
  sock.on('data', chunk => {
    conn.lastRecv = Date.now();
    try { feed(chunk); } catch (e) { log('连接异常：' + e.message, '!!'); sock.destroy(); }
  });
  sock.on('drain', resumeAllPublic);
  sock.on('error', e => log('控制连接错误：' + e.message, '!!'));
  sock.on('close', () => {
    clearTimeout(conn.timer);
    if (conn.authed && S.clients.get(conn.id) === conn) {
      S.clients.delete(conn.id);
      closeChannelsOf(conn);
      log('客户端已离线：' + conn.name + ' [' + conn.id + ']');
    }
  });
  log('收到客户端连接：' + conn.ip);
});

/* ---------------------- 管理 API ---------------------- */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', d => {
      b += d;
      if (b.length > 65536) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}
/* 恒定时间比较：避免按字符提前返回带来的时序侧信道（密码 / 令牌） */
function safeEqual(a, b) {
  const x = Buffer.from(String(a == null ? '' : a), 'utf8');
  const y = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/* 登录失败限速：同一 IP 连续错 5 次锁 60 秒，挡住公网暴力破解管理密码 */
const loginFails = new Map();   // ip -> { n, until }
function loginBlocked(ip) {
  const e = loginFails.get(ip);
  return !!(e && e.until && Date.now() < e.until);
}
function noteLoginFail(ip) {
  let e = loginFails.get(ip);
  if (!e) { e = { n: 0, until: 0 }; loginFails.set(ip, e); }
  if (e.until && Date.now() >= e.until) { e.n = 0; e.until = 0; }
  e.n++;
  if (e.n >= 5) {
    e.n = 0;
    e.until = Date.now() + 60000;
    log('管理密码连续错误 5 次，已锁定 ' + ip + ' 60 秒', '!!');
  }
}
function noteLoginOk(ip) { loginFails.delete(ip); }
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of loginFails) if (!e.until || now - e.until > 300000) loginFails.delete(ip);
}, 60000).unref();

function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
    'Cache-Control': 'no-store'
  });
  res.end(s);
}
let tunnelError = '';
let downloadToken = '';
let downloadTokenExp = 0;

function clientZipReady() {
  try { return fs.statSync(CLIENT_ZIP).isFile(); } catch (_) { return false; }
}

function buildState() {
  const activeByPort = {};
  const activeByPath = {};
  for (const c of S.channels.values()) {
    if (c.pathId) activeByPath[c.pathId] = (activeByPath[c.pathId] || 0) + 1;
    else activeByPort[c.port] = (activeByPort[c.port] || 0) + 1;
  }
  return {
    ok: true,
    token: cfg.token,
    adminPort: cfg.adminPort,
    tunnelPort: cfg.tunnelPort,
    publicHost: cfg.publicHost,
    tunnelError: tunnelError,
    client: (function () {
      const p = primaryClient();
      return p
        ? { online: true, name: p.name, ip: p.ip, since: p.since,
            lastSeen: p.lastRecv || 0,
            idleSec: Math.max(0, Math.round((Date.now() - (p.lastRecv || Date.now())) / 1000)) }
        : { online: false };
    })(),
    clients: cfg.clients.map(cl => {
      const c = S.clients.get(cl.id);
      const on = !!(c && c.authed && c.sock && !c.sock.destroyed);
      let chs = 0;
      for (const ch of S.channels.values()) if (ch.conn && ch.conn.id === cl.id) chs++;
      const maps = cfg.mappings.filter(m => m.clientId === cl.id).length +
        cfg.pathMappings.filter(pm => pm.clientId === cl.id).length;
      return {
        id: cl.id, name: cl.name, token: cl.token,
        online: on, ip: on ? c.ip : '', since: on ? c.since : 0,
        lastSeen: on ? (c.lastRecv || 0) : 0,
        idleSec: on ? Math.max(0, Math.round((Date.now() - (c.lastRecv || Date.now())) / 1000)) : -1,
        mappings: maps, channels: chs
      };
    }),
    clientDownload: clientZipReady(),
    https: {
      enabled: !!httpsServer,
      configured: cfg.httpsEnabled !== false,
      error: httpsError,
      subject: httpsCertInfo.subject,
      validTo: httpsCertInfo.validTo,
      port: cfg.adminPort
    },
    mappings: cfg.mappings.map(m => {
      const port = Number(m.publicPort);
      const st = S.mapStats.get(port) || { total: 0, bytesIn: 0, bytesOut: 0, rateIn: 0, rateOut: 0 };
      return {
        id: m.id,
        name: m.name,
        publicPort: m.publicPort,
        localHost: m.localHost,
        localPort: m.localPort,
        enabled: m.enabled,
        clientId: m.clientId || '',
        clientName: (cfg.clients.find(cl => cl.id === m.clientId) || {}).name || '',
        status: !m.enabled ? 'off'
          : S.listenerError[m.publicPort] ? 'error'
            : !isClientOnline(m.clientId) ? 'wait'             // 目标客户端离线：端口在监听但转不出去
              : S.listeners.has(port) ? 'on' : 'starting',
        error: S.listenerError[m.publicPort] || '',
        stats: {
          active: activeByPort[port] || 0,
          total: st.total,
          bytesIn: st.bytesIn,
          bytesOut: st.bytesOut,
          rateIn: st.rateIn,
          rateOut: st.rateOut
        }
      };
    }),
    pathMappings: cfg.pathMappings.map(pm => {
      const st = S.pathStats.get(pm.id) || { total: 0, bytesIn: 0, bytesOut: 0, rateIn: 0, rateOut: 0 };
      return {
        id: pm.id,
        name: pm.name,
        path: pm.path,
        localHost: pm.localHost,
        localPort: pm.localPort,
        scheme: pm.scheme || 'http',
        stripPrefix: pm.stripPrefix !== false,
        verifyTls: pm.verifyTls === true,
        enabled: pm.enabled,
        clientId: pm.clientId || '',
        clientName: (cfg.clients.find(cl => cl.id === pm.clientId) || {}).name || '',
        status: !pm.enabled ? 'off'
          : !isClientOnline(pm.clientId) ? 'wait'
            : S.pathFwd.has(pm.id) ? 'on' : 'starting',
        stats: {
          active: activeByPath[pm.id] || 0,
          total: st.total,
          bytesIn: st.bytesIn,
          bytesOut: st.bytesOut,
          rateIn: st.rateIn,
          rateOut: st.rateOut
        }
      };
    }),
    history: { in: S.history.in.slice(), out: S.history.out.slice() },
    stats: {
      totalConn: S.totalConn,
      active: S.channels.size,
      bytesIn: S.bytesIn,
      bytesOut: S.bytesOut,
      rateIn: S.rateIn,
      rateOut: S.rateOut,
      uptime: Math.floor((Date.now() - S.startedAt) / 1000),
      version: VERSION
    }
  };
}
function normalizeMapping(b) {
  const o = {
    name: String(b.name || '').trim().slice(0, 40) || ('映射-' + b.publicPort),
    publicPort: Number(b.publicPort),
    localHost: String(b.localHost || '127.0.0.1').trim(),
    localPort: Number(b.localPort),
    clientId: String(b.clientId || '').trim().slice(0, 32),
    enabled: b.enabled !== false
  };
  if (o.clientId && !cfg.clients.some(cl => cl.id === o.clientId)) throw new Error('目标客户端不存在');
  if (!Number.isInteger(o.publicPort) || o.publicPort < 1 || o.publicPort > 65535) throw new Error('公网端口需为 1~65535');
  if (!Number.isInteger(o.localPort) || o.localPort < 1 || o.localPort > 65535) throw new Error('内网端口需为 1~65535');
  if (o.publicPort === cfg.adminPort || o.publicPort === cfg.tunnelPort) throw new Error('公网端口不能与管理端口 / 隧道端口相同');
  if (!o.localHost) throw new Error('请填写内网地址');
  return o;
}

function normalizePathMapping(b) {
  let p = String(b.path || '').trim();
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/+$/, '') || '/';
  const o = {
    name: String(b.name || '').trim().slice(0, 40) || ('路径-' + p),
    path: p,
    localHost: String(b.localHost || '127.0.0.1').trim(),
    localPort: Number(b.localPort),
    scheme: b.scheme === 'https' ? 'https' : 'http',
    stripPrefix: b.stripPrefix !== false,
    verifyTls: b.verifyTls === true,
    clientId: String(b.clientId || '').trim().slice(0, 32),
    enabled: b.enabled !== false
  };
  if (o.clientId && !cfg.clients.some(cl => cl.id === o.clientId)) throw new Error('目标客户端不存在');
  if (o.path === '/') throw new Error('路径不能是根路径 /');
  if (o.path.length > 60) throw new Error('路径前缀最多 60 个字符');
  if (!/^\/[A-Za-z0-9_\-.~\/]*$/.test(o.path)) throw new Error('路径只能包含字母、数字、- _ . ~ /');
  if (o.path === '/api' || o.path.startsWith('/api/') ||
      o.path === '/download' || o.path.startsWith('/download/') ||
      o.path === '/favicon.ico') {
    throw new Error('该路径为系统保留路径，请换一个前缀');
  }
  if (!Number.isInteger(o.localPort) || o.localPort < 1 || o.localPort > 65535) throw new Error('内网端口需为 1~65535');
  if (!o.localHost) throw new Error('请填写内网地址');
  return o;
}

// 管理页修改隧道端口后，热切换到新端口（旧客户端会断开并按新配置重连）
function rebindTunnel(newPort) {
  for (const c of S.clients.values()) { try { c.sock.destroy(); } catch (_) { /* ignore */ } }
  for (const ch of [...S.channels.keys()]) closeChannel(ch, false);
  tunnelError = '';
  const listen = () => controlServer.listen(newPort, '0.0.0.0', () => {
    tunnelError = '';
    log('隧道端口已切换到 ' + newPort, 'OK');
  });
  try { controlServer.close(listen); } catch (_) { listen(); }
}

const adminServer = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const method = req.method.toUpperCase();

  try {
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      fs.readFile(ADMIN_HTML, (e, d) => {
        if (e) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('admin.html 缺失：请把它和 server.js 放在同一目录');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(d);
      });
      return;
    }
    if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }

    if (pathname === '/api/verify' && method === 'POST') {
      const ip = req.socket.remoteAddress || '?';
      if (loginBlocked(ip)) {
        json(res, 429, { ok: false, error: '尝试过于频繁，请 1 分钟后再试' });
        return;
      }
      const b = await readBody(req);
      const ok = safeEqual(b.key, cfg.adminPassword);
      // 登录成功签发 12 小时下载令牌，管理页下载客户端时用，避免把管理密码写进 URL
      if (ok) {
        noteLoginOk(ip);
        downloadToken = crypto.randomBytes(16).toString('hex');
        downloadTokenExp = Date.now() + 12 * 3600 * 1000;
      } else {
        noteLoginFail(ip);
      }
      json(res, 200, { ok: ok, downloadToken: ok ? downloadToken : '' });
      return;
    }

    // 客户端整包下载（需要登录后的下载令牌，或用 x-admin-key 直连）
    if (pathname === '/download/client.zip' && method === 'GET') {
      const t = new URL(req.url, 'http://localhost').searchParams.get('t') || '';
      const authed = safeEqual(req.headers['x-admin-key'], cfg.adminPassword) ||
        (t && safeEqual(t, downloadToken) && Date.now() < downloadTokenExp);
      if (!authed) {
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('下载链接已失效，请刷新管理页后重新点击下载');
        return;
      }
      fs.stat(CLIENT_ZIP, (err, st) => {
        if (err || !st.isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end('服务端未放置客户端包：请把 easytunnel-client.zip 放到 downloads/client.zip');
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': st.size,
          'Content-Disposition': 'attachment; filename="easytunnel-client.zip"',
          'Cache-Control': 'no-store'
        });
        const stream = fs.createReadStream(CLIENT_ZIP);
        stream.on('error', () => { try { res.destroy(); } catch (_) { /* ignore */ } });
        stream.pipe(res);
      });
      return;
    }

    // HTTPS 自签名证书（公开，可下载安装）
    if (pathname === '/download/cert.pem' && method === 'GET') {
      fs.readFile(CERT_FILE, (err, data) => {
        if (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('服务端未放置 certs/cert.pem');
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/x-pem-file',
          'Content-Length': data.length,
          'Content-Disposition': 'attachment; filename="easytunnel-cert.pem"',
          'Cache-Control': 'no-store'
        });
        res.end(data);
      });
      return;
    }

    if (!pathname.startsWith('/api/')) { json(res, 404, { error: 'not found' }); return; }
    if (!safeEqual(req.headers['x-admin-key'], cfg.adminPassword)) {
      json(res, 401, { error: '管理密码错误' });
      return;
    }

    if (pathname === '/api/state' && method === 'GET') {
      json(res, 200, buildState());
      return;
    }
    // 服务端 IP / 端口统一在管理页配置；保存后下发的客户端配置会同步更新
    if (pathname === '/api/settings' && method === 'POST') {
      const b = await readBody(req);
      const host = String(b.publicHost || '').trim().slice(0, 120)
        .replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
      const port = Number(b.tunnelPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('隧道端口需为 1~65535');
      if (port === cfg.adminPort) throw new Error('隧道端口不能与管理端口相同');
      if (cfg.mappings.some(m => Number(m.publicPort) === port)) throw new Error('隧道端口与某条映射的公网端口冲突');
      const oldPort = cfg.tunnelPort;
      cfg.publicHost = host;
      cfg.tunnelPort = port;
      saveCfg();
      if (oldPort !== port) rebindTunnel(port);
      log('服务端设置已更新：地址=' + (host || '自动') + '  隧道端口=' + port, 'OK');
      json(res, 200, buildState());
      return;
    }
    // 供管理页「下载客户端配置」使用，内容即客户端所需的全部参数
    if (pathname === '/api/client-config' && method === 'GET') {
      const h = cfg.publicHost || '127.0.0.1';
      const cid = new URL(req.url, 'http://localhost').searchParams.get('cid') || '';
      const cl = cid ? cfg.clients.find(x => x.id === cid) : cfg.clients[0];
      if (!cl) { json(res, 404, { error: '客户端不存在' }); return; }
      json(res, 200, {
        server: h + ':' + cfg.tunnelPort, token: cl.token,
        name: cl.name, clientId: cl.id, adminPort: cfg.adminPort
      });
      return;
    }

    /* ---------- 客户端管理 ---------- */
    if (pathname === '/api/clients' && method === 'POST') {
      const b = await readBody(req);
      const name = String(b.name || '').trim().slice(0, 40) || '客户端';
      const cl = {
        id: 'c' + crypto.randomBytes(3).toString('hex'),
        name: name,
        token: crypto.randomBytes(16).toString('hex')
      };
      cfg.clients.push(cl);
      saveCfg();
      log('新增客户端：' + cl.name + ' [' + cl.id + ']', 'OK');
      json(res, 200, buildState());
      return;
    }
    const cmatch = pathname.match(/^\/api\/clients\/([A-Za-z0-9]+)(\/token)?$/);
    if (cmatch) {
      const cl = cfg.clients.find(x => x.id === cmatch[1]);
      if (!cl) { json(res, 404, { error: '客户端不存在' }); return; }
      if (cmatch[2] === '/token' && method === 'POST') {
        cl.token = crypto.randomBytes(16).toString('hex');
        if (cfg.clients[0] === cl) cfg.token = cl.token;
        saveCfg();
        const c = S.clients.get(cl.id);
        if (c) { try { c.sock.destroy(); } catch (_) { /* ignore */ } }
        log('客户端令牌已重置：' + cl.name + ' [' + cl.id + ']', 'OK');
        json(res, 200, buildState());
        return;
      }
      if (method === 'PUT') {
        const b = await readBody(req);
        const name = String(b.name || '').trim().slice(0, 40);
        if (!name) throw new Error('名称不能为空');
        cl.name = name;
        const c = S.clients.get(cl.id);
        if (c) c.name = name;
        saveCfg();
        json(res, 200, buildState());
        return;
      }
      if (method === 'DELETE') {
        const used = cfg.mappings.some(m => m.clientId === cl.id) ||
          cfg.pathMappings.some(pm => pm.clientId === cl.id);
        if (used) throw new Error('该客户端还绑定了映射，请先把映射改成其它客户端或“自动”');
        cfg.clients = cfg.clients.filter(x => x !== cl);
        if (!cfg.clients.length) {
          cfg.clients.push({ id: 'c0', name: '默认客户端', token: crypto.randomBytes(16).toString('hex') });
        }
        cfg.token = cfg.clients[0].token;
        saveCfg();
        const c = S.clients.get(cl.id);
        if (c) { try { c.sock.destroy(); } catch (_) { /* ignore */ } }
        log('已删除客户端：' + cl.name + ' [' + cl.id + ']', 'OK');
        json(res, 200, buildState());
        return;
      }
    }
    if (pathname === '/api/mappings' && method === 'POST') {
      const b = await readBody(req);
      const o = normalizeMapping(b);
      if (cfg.mappings.some(m => Number(m.publicPort) === o.publicPort)) throw new Error('公网端口 ' + o.publicPort + ' 已被其它映射占用');
      o.id = crypto.randomBytes(6).toString('hex');
      cfg.mappings.push(o);
      killChannelsOnPort(o.publicPort);
      saveCfg(); applyMappings();
      json(res, 200, buildState());
      return;
    }
    const match = pathname.match(/^\/api\/mappings\/([a-f0-9]+)$/);
    if (match) {
      const idx = cfg.mappings.findIndex(m => m.id === match[1]);
      if (idx < 0) { json(res, 404, { error: '映射不存在' }); return; }
      if (method === 'PUT') {
        const b = await readBody(req);
        const o = normalizeMapping({ ...cfg.mappings[idx], ...b });
        if (cfg.mappings.some((m, i) => i !== idx && Number(m.publicPort) === o.publicPort)) throw new Error('公网端口 ' + o.publicPort + ' 已被其它映射占用');
        o.id = cfg.mappings[idx].id;
        const oldPort = Number(cfg.mappings[idx].publicPort);
        cfg.mappings[idx] = o;
        killChannelsOnPort(o.publicPort);
        if (oldPort !== o.publicPort) {
          killChannelsOnPort(oldPort);
          S.mapStats.delete(oldPort);
        }
        saveCfg(); applyMappings();
        json(res, 200, buildState());
        return;
      }
      if (method === 'DELETE') {
        const gone = cfg.mappings.splice(idx, 1)[0];
        killChannelsOnPort(Number(gone.publicPort));
        S.mapStats.delete(Number(gone.publicPort));
        saveCfg(); applyMappings();
        json(res, 200, buildState());
        return;
      }
    }
    if (pathname === '/api/path-mappings' && method === 'POST') {
      const b = await readBody(req);
      const o = normalizePathMapping(b);
      if (cfg.pathMappings.some(m => m.path === o.path)) throw new Error('路径 ' + o.path + ' 已被其它映射占用');
      o.id = crypto.randomBytes(6).toString('hex');
      cfg.pathMappings.push(o);
      saveCfg(); applyPathMappings();
      json(res, 200, buildState());
      return;
    }
    const pmatch = pathname.match(/^\/api\/path-mappings\/([a-f0-9]+)$/);
    if (pmatch) {
      const idx = cfg.pathMappings.findIndex(m => m.id === pmatch[1]);
      if (idx < 0) { json(res, 404, { error: '路径映射不存在' }); return; }
      if (method === 'PUT') {
        const b = await readBody(req);
        const o = normalizePathMapping({ ...cfg.pathMappings[idx], ...b });
        if (cfg.pathMappings.some((m, i) => i !== idx && m.path === o.path)) throw new Error('路径 ' + o.path + ' 已被其它映射占用');
        o.id = cfg.pathMappings[idx].id;
        cfg.pathMappings[idx] = o;
        saveCfg(); applyPathMappings();
        json(res, 200, buildState());
        return;
      }
      if (method === 'DELETE') {
        const gone = cfg.pathMappings.splice(idx, 1)[0];
        stopPathForwarder(gone.id, true);
        S.pathStats.delete(gone.id);
        saveCfg(); applyPathMappings();
        json(res, 200, buildState());
        return;
      }
    }
    if (pathname === '/api/token' && method === 'POST') {
      const cl = cfg.clients[0];
      cl.token = crypto.randomBytes(16).toString('hex');
      cfg.token = cl.token;
      saveCfg();
      const c = S.clients.get(cl.id);
      if (c) { try { c.sock.destroy(); } catch (_) { /* ignore */ } }
      log('客户端令牌已重置：' + cl.name, 'OK');
      json(res, 200, buildState());
      return;
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 400, { error: e.message || String(e) });
  }
});

/* ---------------------- 启动 ---------------------- */
applyMappings();
loadTls();
applyPathMappings();

function startFront() {
  const front = net.createServer(sock => {
    sock.setTimeout(15000, () => sock.destroy());
    sock.once('data', chunk => {
      sock.setTimeout(0);
      const isTls = chunk.length > 0 && chunk[0] === 0x16;
      if (isTls && (!httpsServer || !httpsInternalPort)) { sock.destroy(); return; }
      const port = isTls ? httpsInternalPort : adminInternalPort;
      if (!port) { sock.destroy(); return; }
      const up = net.connect(port, '127.0.0.1', () => {
        up.write(chunk);
        sock.pipe(up);
        up.pipe(sock);
      });
      up.on('error', () => { try { sock.destroy(); } catch (_) { /* ignore */ } });
      sock.on('error', () => { try { up.destroy(); } catch (_) { /* ignore */ } });
    });
    sock.on('error', () => { /* ignore */ });
  });
  front.on('error', e => { console.error('管理端口启动失败：' + e.message); process.exit(1); });
  front.listen(cfg.adminPort, '0.0.0.0', () => {
    log('管理页面已启动 http://0.0.0.0:' + cfg.adminPort +
        (httpsServer ? '（HTTPS 共用同一端口）' : ''), 'OK');
    console.log('');
    console.log('  ============================================================');
    console.log('   EasyTunnel 已就绪  v' + VERSION);
    console.log('   管理页面 : http://<公网IP>:' + cfg.adminPort);
    if (httpsServer) {
      console.log('   HTTPS    : https://<公网IP>:' + cfg.adminPort + '/<路径>/');
      console.log('   HTTPS 证书: certs/cert.pem（自签名，首次访问需在浏览器确认）');
    } else {
      console.log('   HTTPS    : 未启用（' + (httpsError || '缺少证书') + '）');
    }
    console.log('   管理密码 : ' + cfg.adminPassword);
    console.log('   客户端 (' + cfg.clients.length + ' 个):');
    for (const cl of cfg.clients) {
      console.log('     - ' + cl.name + ' [' + cl.id + ']  令牌: ' + cl.token);
    }
    console.log('   客户端地址: 在管理页「客户端」卡片下载各自的 client.json，放到 exe 同目录');
    console.log('  ============================================================');
    console.log('   服务器防火墙 / 安全组需放行：' + cfg.adminPort + '、' + cfg.tunnelPort);
    console.log('   以及网页里配置的每一个「公网端口」');
    console.log('');
  });
}

controlServer.on('error', e => {
  tunnelError = e.code || e.message;
  log('隧道端口监听失败：' + tunnelError + '（请到管理页「服务端设置」换端口）', '!!');
});
controlServer.listen(cfg.tunnelPort, '0.0.0.0', () => { tunnelError = ''; log('隧道端口已启动 ' + cfg.tunnelPort, 'OK'); });

adminServer.listen(0, '127.0.0.1', () => {
  adminInternalPort = adminServer.address().port;
  if (httpsServer) {
    let started = false;
    httpsServer.on('error', e => {
      if (started) return;
      httpsError = 'HTTPS 启动失败：' + (e.code || e.message);
      log(httpsError, '!!');
      httpsServer = null;
      httpsInternalPort = 0;
      started = true;
      startFront();
    });
    httpsServer.listen(0, '127.0.0.1', () => {
      httpsInternalPort = httpsServer.address().port;
      started = true;
      startFront();
    });
  } else {
    startFront();
  }
});
