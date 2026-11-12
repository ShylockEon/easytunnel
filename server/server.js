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
  client: null,             // { sock, name, ip, authed, since, timer }
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

function writeClient(buf) {
  const c = S.client;
  if (!c || !c.authed || c.sock.destroyed) return false;
  const ok = c.sock.write(buf);
  if (!ok) pauseAllPublic();     // 控制连接背压：暂停所有公网来源
  return ok;
}
/* 转发数据帧（零拷贝写），与 writeClient 保持同样的背压语义 */
function writeClientData(ch, payload) {
  const c = S.client;
  if (!c || !c.authed || c.sock.destroyed) return false;
  const ok = writeFrame(c.sock, 2, ch, payload);
  if (!ok) pauseAllPublic();
  return ok;
}
function sendCtrl(ch, obj) { return writeClient(ctrl(ch, obj)); }
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
  if (notifyClient) sendCtrl(ch, { t: 'close' });
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
  if (!S.client || !S.client.authed) { pub.destroy(); return false; }
  target.stats.total++;
  target.stats.lastAt = Date.now();

  const ch = ++S.seq;
  const c = {
    pub, port: target.port || null, pathId: target.pathId || null,
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
    writeClientData(ch, d);
  });
  const bye = () => closeChannel(ch, true);
  pub.on('close', bye);
  pub.on('error', bye);

  sendCtrl(ch, { t: 'open', host: target.localHost, port: Number(target.localPort), name: target.name || '' });
  log('新连接 #' + ch + '  ' + label + ' -> ' + target.localHost + ':' + target.localPort);
  return true;
}

function onPublicConnection(pub, port) {
  S.totalConn++;
  const m = findMapping(port);
  if (!m) { pub.destroy(); return; }
  attachTunnel(pub, {
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
      if (!safeEqual(msg.token, cfg.token)) {
        try { conn.sock.write(ctrl(0, { t: 'err', msg: '令牌错误' })); } catch (_) { /* ignore */ }
        setTimeout(() => conn.sock.destroy(), 150);
        log('客户端令牌校验失败，已拒绝 (' + conn.ip + ')', '!!');
        return;
      }
      clearTimeout(conn.timer);
      conn.authed = true;
      conn.name = String(msg.name || 'unnamed').slice(0, 40);
      conn.since = Date.now();
      // 只有通过令牌校验的连接才顶替旧客户端并清理旧通道。
      // 9001 暴露在公网，端口扫描 / 健康检查 / 任意裸 TCP 连接都会触发；
      // 若在 TCP 建立瞬间就顶替，会把已认证客户端踢下线约 1 秒（表现为反复断线重连）。
      if (S.client && S.client !== conn) {
        try { S.client.sock.destroy(); } catch (_) { /* ignore */ }
      }
      for (const ch of [...S.channels.keys()]) closeChannel(ch, false);
      S.client = conn;
      conn.sock.write(ctrl(0, { t: 'auth_ok' }));
      log('客户端已上线：' + conn.name + ' (' + conn.ip + ')', 'OK');
      return;
    }
    if (!conn.authed || S.client !== conn) return;

    switch (msg.t) {
      case 'ready': {
        const c = S.channels.get(ch);
        if (!c || c.ready) return;
        clearTimeout(c.timer); c.timer = null;
        c.ready = true;
        let blocked = false;
        for (const d of c.pending) if (!writeClientData(ch, d)) blocked = true;
        c.pending = [];
        if (!blocked) c.pub.resume();           // 否则等控制连接 drain 统一恢复
        break;
      }
      case 'close':
        closeChannel(ch, false);
        break;
      case 'pause': {
        const c = S.channels.get(ch);
        if (c && !c.pub.destroyed) c.pub.pause();
        break;
      }
      case 'resume': {
        const c = S.channels.get(ch);
        if (c && c.ready && !c.pub.destroyed) c.pub.resume();
        break;
      }
      case 'ping':
        sendCtrl(0, { t: 'pong' });
        break;
    }
    return;
  }

  if (type === 2) {
    if (!conn.authed || S.client !== conn) return;
    const c = S.channels.get(ch);
    if (!c || !c.ready || c.pub.destroyed) return;
    S.bytesOut += payload.length;
    c.ps.bytesOut += payload.length;
    if (!c.pub.write(payload)) {
      sendCtrl(ch, { t: 'pause' });             // 让客户端暂停读内网服务
      c.pub.once('drain', () => {
        if (S.channels.get(ch) === c) sendCtrl(ch, { t: 'resume' });
      });
    }
  }
}

const controlServer = net.createServer(sock => {
  const conn = { sock, ip: sock.remoteAddress || '?', name: '', authed: false, since: 0, timer: null };

  // 不在 TCP 建立瞬间顶替在线客户端（见 auth 成功分支）；
  // 未认证连接 8 秒后自行超时退出，不污染 S.client。
  conn.timer = setTimeout(() => {
    if (!conn.authed) { log('客户端认证超时，断开', '!!'); sock.destroy(); }
  }, 8000);

  const feed = decoder((type, ch, payload) => {
    try { onClientFrame(conn, type, ch, payload); }
    catch (e) { log('协议错误：' + e.message, '!!'); sock.destroy(); }
  });
  sock.on('data', chunk => {
    try { feed(chunk); } catch (e) { log('连接异常：' + e.message, '!!'); sock.destroy(); }
  });
  sock.on('drain', resumeAllPublic);
  sock.on('error', e => log('控制连接错误：' + e.message, '!!'));
  sock.on('close', () => {
    clearTimeout(conn.timer);
    if (S.client === conn) {
      S.client = null;
      for (const ch of [...S.channels.keys()]) closeChannel(ch, false);
      log('客户端已离线：' + conn.name);
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
    client: S.client && S.client.authed
      ? { online: true, name: S.client.name, ip: S.client.ip, since: S.client.since }
      : { online: false },
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
        status: !m.enabled ? 'off'
          : S.listenerError[m.publicPort] ? 'error'
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
        status: !pm.enabled ? 'off' : S.pathFwd.has(pm.id) ? 'on' : 'starting',
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
    enabled: b.enabled !== false
  };
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
    enabled: b.enabled !== false
  };
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
  if (S.client) { try { S.client.sock.destroy(); } catch (_) { /* ignore */ } }
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
      json(res, 200, { server: h + ':' + cfg.tunnelPort, token: cfg.token, name: '', adminPort: cfg.adminPort });
      return;
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
      cfg.token = crypto.randomBytes(16).toString('hex');
      saveCfg();
      if (S.client) { try { S.client.sock.destroy(); } catch (_) { /* ignore */ } }
      log('客户端令牌已重置，旧客户端已断开', 'OK');
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
    console.log('   客户端令牌: ' + cfg.token);
    console.log('   客户端地址: 在管理页「服务端设置」填公网 IP / 端口，下载 client.json 放到 exe 同目录');
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
