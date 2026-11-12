'use strict';
/* ============================================================
 * EasyTunnel 客户端  ——  放在内网那台机器上
 * 零依赖，Node.js >= 18；打包成 exe 后双击会打开图形窗口，不是黑窗口
 *
 * 双击 exe（不带参数）：弹出图形界面，地址和令牌已预填，可「从剪贴板导入」配置；
 *   点「最小化」收起到系统托盘后台运行（保留托盘图标）；点「退出」或关窗口则彻底结束进程。
 * 服务端 Web 管理页「服务端设置」也可下载 client.json 放到同目录作为初始配置。
 *
 * 配置优先级：命令行参数 > 环境变量(ET_SERVER/ET_TOKEN/ET_NAME) > 同目录 client.json
 *   静默模式（不弹窗口，用于开机自启）：
 *     EasyTunnelClient.exe --no-gui
 *     EasyTunnelClient.exe --server 1.2.3.4:9001 --token xxxxxx
 *
 * 日志 client.log / 状态 client.status 都在同目录；映射规则全部由服务端网页下发。
 * 断线自动重连，管理页改动隧道端口或令牌后本端会自动跟随。
 * ============================================================ */

const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const spawnProc = require('child_process').spawn;

// GUI 版 exe 没有控制台，防止 stdout/stderr 写入失败抛未捕获异常
try { process.stdout.on('error', () => {}); process.stderr.on('error', () => {}); } catch (_) { /* ignore */ }

function parseArgs(argv) {
  const alias = { s: 'server', t: 'token', n: 'name' };
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('-')) continue;
    let k, v;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) { k = a.slice(2, eq); v = a.slice(eq + 1); }
      else {
        k = a.slice(2);
        v = argv[i + 1];
        if (v === undefined || v.startsWith('-')) v = 'true'; else i++;
      }
    } else {
      k = alias[a.slice(1)] || a.slice(1);
      v = argv[i + 1];
      if (v === undefined || v.startsWith('-')) v = 'true'; else i++;
    }
    out[k] = v;
  }
  return out;
}

/* ---------------------- 连接参数 ---------------------- */
// SEA 打包成 exe 后脚本内嵌在 exe 内，配置文件与日志都放在 exe 同目录
function isSea() {
  try { return require('node:sea').isSea(); } catch (_) { return false; }
}
function appDir() { return isSea() ? path.dirname(process.execPath) : __dirname; }
function configFile() { return path.join(appDir(), 'client.json'); }
const LOG_FILE = path.join(appDir(), 'client.log');
const STATUS_FILE = path.join(appDir(), 'client.status');
const GUI_READY_FILE = path.join(appDir(), 'client.gui');
// 日志 > 1MB 时轮转为 client.log.1，避免无限增长；失败则退化为清空
try {
  if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) {
    try { fs.renameSync(LOG_FILE, LOG_FILE + '.1'); }
    catch (_) { fs.writeFileSync(LOG_FILE, '', 'utf8'); }
  }
} catch (_) { /* ignore */ }

// 只有「打包成 exe + 双击（不带任何参数）」才弹图形窗口；
// 命令行带参数、--no-gui、源码脚本运行都保持静默，方便开机自启和服务化。
const RAW_ARGS = process.argv.slice(2);
const GUI_MODE = process.platform === 'win32'
  && (isSea() || process.env.ET_FORCE_GUI === '1') && RAW_ARGS.length === 0;

// 打包时把默认服务端地址/令牌作为 SEA asset 固化进 exe，单独一个 exe 也能直接连
function builtinConfig() {
  try {
    const sea = require('node:sea');
    if (!sea.isSea()) return {};
    const a = sea.getAsset('default.json');
    if (!a) return {};
    const txt = typeof a === 'string' ? a : Buffer.from(a).toString('utf8');
    return JSON.parse(txt.replace(/^\uFEFF/, ''));
  } catch (_) { return {}; }
}
function readConfigSync() {
  const A = parseArgs(RAW_ARGS);
  const builtin = builtinConfig();
  let file = {};
  try {
    let text = fs.readFileSync(configFile(), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // 兼容记事本/PowerShell 写入的 BOM
    file = JSON.parse(text);
  } catch (_) { /* 没有配置文件 */ }
  const server = A.server || process.env.ET_SERVER || file.server || builtin.server || '';
  const token = A.token || process.env.ET_TOKEN || file.token || builtin.token || '';
  const name = A.name || process.env.ET_NAME || file.name || builtin.name || os.hostname();
  const ap = Number(A['admin-port'] || process.env.ET_ADMIN_PORT || file.adminPort || builtin.adminPort || 9000);
  const clientId = file.clientId || builtin.clientId || '';
  if (!server || !token) return null;
  return {
    server: server,
    token: token,
    name: name,
    clientId: clientId,
    adminPort: (Number.isInteger(ap) && ap >= 1 && ap <= 65535) ? ap : 9000
  };
}
async function resolveSettings() {
  const s = readConfigSync();
  if (!s) throw new Error('未找到客户端配置：请在窗口中填写，或从服务端管理页下载 client.json 放到本程序同目录');
  return s;
}

let SERVER, TOKEN, NAME, CLIENT_ID, HOST, PORT, ADMIN_PORT;

// GUI 版 exe 没有控制台，日志落盘；同时兼容源码脚本 / 控制台运行。
// 日志改为内存队列 + 异步批量落盘，避免每转发一次连接就同步写盘造成卡顿。
const logQueue = [];
let logTimer = null;
function flushLog() {
  if (!logQueue.length) return;
  const buf = logQueue.splice(0, logQueue.length).join('');
  try { fs.appendFile(LOG_FILE, buf, () => {}); } catch (_) { /* ignore */ }
}
function log(msg, tag) {
  const line = '[' + new Date().toTimeString().slice(0, 8) + '] ' + (tag || '--') + ' ' + msg;
  try { console.log(line); } catch (_) { /* GUI 模式下 stdout 不可用 */ }
  logQueue.push(line + '\n');
  if (logQueue.length >= 200) { flushLog(); return; }
  if (!logTimer) {
    logTimer = setTimeout(() => { logTimer = null; flushLog(); }, 300);
    if (logTimer.unref) logTimer.unref();
  }
}
function flushLogSync() {
  if (!logQueue.length) return;
  try { fs.appendFileSync(LOG_FILE, logQueue.splice(0, logQueue.length).join(''), 'utf8'); } catch (_) { /* ignore */ }
}
process.on('exit', flushLogSync);

/* ---------------------- 状态快照（供客户端窗口读取） ----------------------
 * client.status 改为 JSON：窗口每秒读取一次，写临时文件再 rename，避免读到半截。
 * 只在 GUI 窗口存在时窗口才会读，但静默模式也持续写，方便排查。 */
let txBytes = 0;              // 本次会话发往服务端的 payload 字节
let rxBytes = 0;              // 本次会话从服务端收到的 payload 字节
let connectedAt = 0;          // 认证成功时间
let latency = 0;              // 最近 RTT（毫秒，EMA 平滑）
let pingAt = 0;               // 最近一次 ping 发出时间
const series = { in: new Array(60).fill(0), out: new Array(60).fill(0) };
let lastSample = { t: Date.now(), in: 0, out: 0 };
const statusInfo = { state: 'starting', text: '正在启动…', server: '' };
let lastStatusWrite = 0;

function sampleRates() {
  const now = Date.now();
  const dt = Math.max(0.2, (now - lastSample.t) / 1000);
  const dIn = Math.max(0, rxBytes - lastSample.in);
  const dOut = Math.max(0, txBytes - lastSample.out);
  lastSample = { t: now, in: rxBytes, out: txBytes };
  series.in.push(Math.round(dIn / dt));
  series.out.push(Math.round(dOut / dt));
  if (series.in.length > 60) series.in.shift();
  if (series.out.length > 60) series.out.shift();
}

function buildStatus() {
  let ch = 0;
  try { ch = locals.size; } catch (_) { /* ignore */ }
  return {
    v: 2,
    state: statusInfo.state,
    text: statusInfo.text,
    server: statusInfo.server,
    latency: latency,
    uptimeSec: connectedAt ? Math.floor((Date.now() - connectedAt) / 1000) : 0,
    inBytes: rxBytes,
    outBytes: txBytes,
    channels: ch,
    series: { in: series.in.slice(), out: series.out.slice() },
    ts: Date.now()
  };
}

function writeStatus(force) {
  const now = Date.now();
  if (!force && now - lastStatusWrite < 900) return;
  lastStatusWrite = now;
  const text = JSON.stringify(buildStatus());
  const tmp = STATUS_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, STATUS_FILE);
  } catch (e) {
    try { fs.writeFileSync(STATUS_FILE, text, 'utf8'); } catch (_) { /* ignore */ }
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
}

function setStatus(text, state) {
  statusInfo.text = text;
  if (state) statusInfo.state = state;
  writeStatus(true);
}

const sampleTimer = setInterval(() => {
  sampleRates();
  writeStatus(false);
}, 1000);
if (sampleTimer.unref) sampleTimer.unref();
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ---------------------- 图形界面（WinForms，无黑窗口，暗色主题与管理端一致） ----------------------
 * 用系统自带 PowerShell 承载一个真正的 Windows 窗口：自定义暗色渐变标题栏 + 圆角按钮 +
 * 暗色输入框 + 状态指示灯；可填服务端 IP/端口/令牌、实时显示连接状态、最小化到托盘。
 * 纯 GDI 自绘，不引入任何外部图片/字体/控件库，保持轻量；脚本内嵌，不产生额外文件。 */
/* GUI 脚本：源码模式读同目录 gui.ps1；打包后从 SEA 内置 asset 读取。
 * 拆成独立文件便于维护和语法校验，最终仍然只有一个 exe。 */
function readGuiScript() {
  try {
    const sea = require('node:sea');
    if (sea.isSea && sea.isSea()) {
      const a = sea.getAsset('gui.ps1');
      if (a) return typeof a === 'string' ? a : Buffer.from(a).toString('utf8');
    }
  } catch (_) { /* ignore */ }
  try {
    return fs.readFileSync(path.join(__dirname, 'gui.ps1'), 'utf8').replace(/^\uFEFF/, '');
  } catch (_) { return ''; }
}
const PS_SCRIPT = readGuiScript();

let tempIconPath = '';
let tempLogoPath = '';
process.on('exit', () => {
  try { if (tempIconPath) fs.unlinkSync(tempIconPath); } catch (_) { /* ignore */ }
  try { if (tempLogoPath) fs.unlinkSync(tempLogoPath); } catch (_) { /* ignore */ }
});

// 图标：源码模式用 source/icon/ 下的文件；打包后用 SEA 内置 asset 释放到临时目录。
// 窗口 / 托盘用 PNG 生成 HICON，避免 System.Drawing 对 PNG 压缩 ICO 帧的兼容问题。
function assetFile(name, fileName) {
  const candidates = [
    path.join(appDir(), fileName),
    path.join(__dirname, 'icon', fileName)
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
  }
  try {
    const sea = require('node:sea');
    if (sea.isSea && sea.isSea()) {
      const a = sea.getAsset(name);
      if (a) {
        const dst = path.join(os.tmpdir(), 'et-' + fileName.replace(/[^\w.-]/g, '_') + '-' + process.pid);
        fs.writeFileSync(dst, Buffer.from(a));
        if (name === 'icon.ico') tempIconPath = dst; else tempLogoPath = dst;
        return dst;
      }
    }
  } catch (_) { /* 没有内置图标时使用系统默认图标 */ }
  return '';
}
function iconFile() { return assetFile('icon.ico', 'icon.ico'); }
function logoFile() { return assetFile('icon-128.png', 'icon-128.png'); }

function startGui() {
  if (!PS_SCRIPT) {
    log('缺少 gui.ps1，无法显示图形窗口（不影响连接）', '!!');
    return false;
  }
  try {
    const ps = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // 注意：这里不能用 detached。Windows 上 detached 会让 PowerShell 直接退出，
    // WinForms 窗体就永远出不来；保持父子关系 + windowsHide 即可无黑窗口。
    // GUI 脚本较长，超过 Windows 命令行长度上限(32767)，改用临时 .ps1 文件经 -File 启动。
    const effective = readConfigSync() || {};
    try { fs.unlinkSync(GUI_READY_FILE); } catch (_) { /* ignore */ }
    let guiFile;
    try {
      guiFile = path.join(os.tmpdir(), 'et-gui-' + process.pid + '-' + Date.now() + '.ps1');
      fs.writeFileSync(guiFile, '﻿' + PS_SCRIPT, 'utf8');   // BOM+UTF8，避免中文被 ANSI 编码破坏
      if (process.env.ET_DUMP_PS === '1') {
        try { fs.copyFileSync(guiFile, path.join(appDir(), 'client.gui.ps1')); } catch (_) { /* ignore */ }
      }
    } catch (e) {
      log('图形界面脚本写出失败（不影响连接）：' + e.message, '!!');
      return false;
    }
    const child = spawnProc(ps,
      ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', guiFile],
      {
        // 用 pipe 捕获 PowerShell 输出，窗口起不来时日志能直接说明原因
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        env: { ...process.env,
          ET_CFG_PATH: configFile(),
          ET_STATUS_PATH: STATUS_FILE,
          ET_GUI_READY: GUI_READY_FILE,
          ET_CLIENT_PID: String(process.pid),
          ET_ICON_PATH: iconFile(),
          ET_LOGO_PATH: logoFile(),
          ET_ADMIN_PORT: String((effective && effective.adminPort) || 9000),
          ET_DEFAULT_SERVER: effective.server || '',
          ET_DEFAULT_TOKEN: effective.token || '' }
      });
    child.stdout.on('data', d => log('[GUI] ' + d.toString().trim()));
    child.stderr.on('data', d => {
      const t = d.toString().trim();
      // PowerShell 会把进度信息以 CLIXML 写到 stderr，不是真正的错误
      if (!t || t.startsWith('#< CLIXML') || t.startsWith('<Objs') || t.startsWith('<Obj ')) return;
      log('[GUI-ERR] ' + t, '!!');
    });
    child.on('exit', code => {
      try { if (guiFile) fs.unlinkSync(guiFile); } catch (_) { /* ignore */ }
      log('图形窗口进程退出 code=' + code, '!!');
      // 窗口曾经正常显示过 → 说明是用户点「退出」或关了窗口，客户端一并结束，不留后台。
      // 若窗口从未显示（PowerShell 被策略禁用），则保持静默连接，不影响使用。
      if (fs.existsSync(GUI_READY_FILE)) {
        log('窗口已关闭，客户端退出（不保留后台）', 'OK');
        try { fs.unlinkSync(GUI_READY_FILE); } catch (_) { /* ignore */ }
        process.exit(0);
      }
    });
    child.on('error', e => log('图形界面启动失败（不影响连接）：' + e.message, '!!'));
    log('图形配置窗口已启动');
    // PowerShell 冷启动（首次准备模块）可能要几十秒，超时给足，避免误报
    setTimeout(() => {
      if (!fs.existsSync(GUI_READY_FILE)) {
        log('图形窗口尚未显示（首次启动 PowerShell 可能较慢）；' +
            '配置已内置，客户端会正常连接，也可用 --no-gui 静默运行', '!!');
      }
    }, 30000);
    return true;
  } catch (e) {
    log('图形界面启动失败（不影响连接）：' + e.message, '!!');
    return false;
  }
}

async function waitForConfig(timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await sleep(500);
    const s = readConfigSync();
    if (s) return s;
  }
  throw new Error('等待配置超时：请在窗口中填写服务端地址和令牌');
}
function applyConfig(s) {
  SERVER = s.server; TOKEN = s.token; NAME = s.name; CLIENT_ID = s.clientId || '';
  statusInfo.server = SERVER;
  ADMIN_PORT = Number(s.adminPort) || 9000;
  const cut = SERVER.lastIndexOf(':');
  HOST = cut > 0 ? SERVER.slice(0, cut) : SERVER;
  PORT = cut > 0 ? Number(SERVER.slice(cut + 1)) : 9001;
  if (!HOST || !Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('服务端地址格式不对，应形如 1.2.3.4:9001');
}
// 窗口里改了地址/令牌后自动重连，不用重启客户端
function watchConfig() {
  let last = 0;
  try { last = fs.statSync(configFile()).mtimeMs; } catch (_) { /* none */ }
  setInterval(() => {
    let m = 0;
    try { m = fs.statSync(configFile()).mtimeMs; } catch (_) { return; }
    if (m === last) return;
    const appeared = last === 0;          // 之前没有 client.json，刚被粘贴/导入
    last = m;
    const s = readConfigSync();
    if (s && (appeared || s.server !== SERVER || s.token !== TOKEN)) {
      log('检测到配置更新，重新连接 ' + s.server, 'OK');
      applyConfig(s);
      retry = 0;
      setStatus('配置已更新，正在重新连接…', 'connecting');
      if (sock && !sock.destroyed) sock.destroy();
    }
  }, 1500);
}

/* ---------------------- 帧协议（与服务端一致） ---------------------- */
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
/* 解码器：分片队列解析，整帧在同一 chunk 内时零拷贝；跨 chunk 只拷贝一次。
 * 旧实现每个 chunk 都 Buffer.concat，高吞吐时是 O(n²) 重复拷贝。 */
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
      return first.subarray(0, n);
    }
    if (first.length === n) {
      parts.shift();
      total -= n;
      return first;
    }
    const out = Buffer.allocUnsafe(n);
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
      if (len > 8 * 1024 * 1024) throw new Error('帧过大');
      if (total < 9 + len) break;
      const type = h[0];
      const ch = h.readUInt32BE(1);
      take(9);
      onFrame(type, ch, take(len));
    }
  };
}

/* ---------------------- 连接主体 ---------------------- */
let sock = null;
let locals = new Map();      // ch -> { sock, ready }
let retry = 0;
let beat = null;
let lastPong = 0;   // 最近一次收到服务端 pong 的时间戳（心跳超时自愈用）

function pauseAllLocals() {
  for (const r of locals.values()) if (r.ready && r.sock && !r.sock.destroyed) r.sock.pause();
}
function resumeAllLocals() {
  for (const r of locals.values()) if (r.ready && r.sock && !r.sock.destroyed) r.sock.resume();
}
let drainGuard = null;
function writeServer(buf) {
  if (!sock || sock.destroyed) return false;
  const ok = sock.write(buf);
  if (!ok) {
    pauseAllLocals();
    // 兜底：drain 事件偶发丢失时会永久暂停所有内网 socket，大响应会停在半截。
    // 轮询到控制连接写缓冲排空即恢复。
    if (!drainGuard) {
      drainGuard = setInterval(() => {
        if (!sock || sock.destroyed || sock.writableLength === 0) {
          clearInterval(drainGuard); drainGuard = null;
          resumeAllLocals();
        }
      }, 100);
    }
  }
  return ok;
}
/* 数据帧零拷贝写：帧头 + 负载两次 write，用 cork 合并成一次发送 */
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
function writeServerData(ch, payload) {
  const s = sock;
  if (!s || s.destroyed) return false;
  const ok = writeFrame(s, 2, ch, payload);
  if (!ok) pauseAllLocals();
  return ok;
}
function sendCtrl(ch, obj) { return writeServer(frame(1, ch, Buffer.from(JSON.stringify(obj), 'utf8'))); }

function dropLocal(ch, rec, notify) {
  if (locals.get(ch) !== rec) return;
  locals.delete(ch);
  if (rec.idleTimer) { clearTimeout(rec.idleTimer); rec.idleTimer = null; }
  if (rec.pauseGuard) { clearTimeout(rec.pauseGuard); rec.pauseGuard = null; }
  if (rec.sock && !rec.sock.destroyed) rec.sock.destroy();
  if (notify) sendCtrl(ch, { t: 'close' });
}

/* 把一条内网 TCP 连接挂到通道 ch 上。
 *
 * 关键：内网 upstream 关闭 != 公网连接关闭。
 * 服务端 closeChannel() 用的是 pub.destroy()，一旦收到客户端的 close 帧就会硬销毁
 * 公网 socket，内核发送队列里还没 ACK 的响应尾部会被 RST 丢弃 —— 这就是大文件
 * （vue.min.js 434871 字节）在公网被稳定截断的根因。
 * 因此 upstream 关闭时只做「软关闭」：保留通道与公网连接，由浏览器按 Content-Length
 * 读完后自己关闭 pub，服务端再通过 close 帧反向通知我们清理。
 * 浏览器若在 keep-alive 连接上继续发请求，则在同一个通道上重连 upstream 即可。
 */
function attachLocal(ch, rec, msg, isReopen) {
  const local = net.connect({ host: msg.host, port: Number(msg.port) });
  rec.sock = local;
  rec.ready = false;
  rec.closing = false;
  rec.pending = rec.pending || [];
  clearTimeout(rec.idleTimer); rec.idleTimer = null;

  local.setNoDelay(true);
  local.on('connect', () => {
    if (locals.get(ch) !== rec || rec.sock !== local) return;
    rec.ready = true;
    if (!isReopen) {
      sendCtrl(ch, { t: 'ready' });
      log('转发 #' + ch + '  ->  ' + msg.host + ':' + msg.port + (msg.name ? '  (' + msg.name + ')' : ''));
    }
    // 重建 upstream 时服务端通道早已 ready，不能重复发 ready 帧
    if (rec.pending && rec.pending.length) {
      for (const b of rec.pending) local.write(b);   // 逐块写，避免再拼一个大 Buffer
      rec.pending = [];
      rec.pendingBytes = 0;
    }
  });
  local.on('data', d => {
    if (locals.get(ch) === rec && rec.sock === local) {
      txBytes += d.length;
      writeServerData(ch, d);
    }
  });
  local.on('error', e => {
    if (rec.sock !== local) return;
    log('内网服务 ' + msg.host + ':' + msg.port + ' 连接失败：' + (e.code || e.message), '!!');
    dropLocal(ch, rec, true);
  });
  local.on('close', () => {
    if (locals.get(ch) !== rec || rec.sock !== local) return;
    rec.ready = false;
    rec.closing = true;
    rec.sock = null;
    clearTimeout(rec.idleTimer);
    // 兜底回收：公网连接长期空闲、浏览器也没关闭时，60 秒后主动清理通道
    rec.idleTimer = setTimeout(() => {
      if (locals.get(ch) === rec) dropLocal(ch, rec, true);
    }, 60000);
  });
}

function openLocal(ch, msg) {
  const rec = {
    sock: null, ready: false, closing: false, pending: [], pendingBytes: 0,
    idleTimer: null, pauseGuard: null,
    host: msg.host, port: Number(msg.port)
  };
  locals.set(ch, rec);
  attachLocal(ch, rec, msg, false);
}

function reopenLocal(ch, rec) {
  attachLocal(ch, rec, { host: rec.host, port: rec.port }, true);
}

function handleCtrl(ch, payload) {
  let msg;
  try { msg = JSON.parse(payload.toString('utf8')); } catch (_) { return; }

  if (ch === 0) {
    if (msg.t === 'auth_ok') {
      retry = 0;
      connectedAt = Date.now();
      txBytes = 0; rxBytes = 0;
      for (let i = 0; i < 60; i++) { series.in[i] = 0; series.out[i] = 0; }
      lastSample = { t: Date.now(), in: 0, out: 0 };
      pingAt = 0; latency = 0;
      log('已连接服务端 ' + HOST + ':' + PORT + (msg.name ? '（' + msg.name + '）' : '') + '，等待映射请求', 'OK');
      setStatus('已连接 · ' + HOST + ':' + PORT + ' · 映射在管理页配置', 'online');
      return;
    }
    if (msg.t === 'err') {
      log('服务端拒绝：' + msg.msg + '（请检查 --token）', '!!');
      setStatus('被服务端拒绝：' + msg.msg + '（令牌可能不对）', 'error');
      return;
    }
    if (msg.t === 'pong') {
      lastPong = Date.now();
      if (pingAt) {
        const rtt = Date.now() - pingAt;
        pingAt = 0;
        latency = latency ? Math.round(latency * 0.65 + rtt * 0.35) : rtt;
      }
      return;
    }
    return;
  }

  const rec = locals.get(ch);
  switch (msg.t) {
    case 'open':
      openLocal(ch, msg);
      break;
    case 'close':
      if (rec) dropLocal(ch, rec, false);
      break;
    case 'pause':
      if (rec && rec.sock && !rec.sock.destroyed) {
        rec.sock.pause();
        // 服务端 pub 的 drain 竞态可能漏发 resume，兜底自动恢复，避免响应永久卡住
        clearTimeout(rec.pauseGuard);
        rec.pauseGuard = setTimeout(() => {
          rec.pauseGuard = null;
          if (locals.get(ch) === rec && rec.sock && !rec.sock.destroyed) rec.sock.resume();
        }, 1500);
      }
      break;
    case 'resume':
      if (rec && rec.pauseGuard) { clearTimeout(rec.pauseGuard); rec.pauseGuard = null; }
      if (rec && rec.ready && rec.sock && !rec.sock.destroyed) rec.sock.resume();
      break;
  }
}

function handleData(ch, payload) {
  rxBytes += payload.length;
  const rec = locals.get(ch);
  if (!rec) return;
  if (!rec.ready || rec.closing) {
    // upstream 尚未连上或已软关闭：公网连接仍然有效，先暂存请求数据
    if (rec.closing) reopenLocal(ch, rec);   // keep-alive 复用 → 同一通道重连内网服务
    // 与服务端一致做 1MB 上限保护：内网服务迟迟连不上时避免无限吃内存
    rec.pendingBytes = (rec.pendingBytes || 0) + payload.length;
    if (rec.pendingBytes > 1024 * 1024) {
      log('通道 #' + ch + ' 缓存超过 1MB（内网服务响应异常），主动断开', '!!');
      dropLocal(ch, rec, true);
      return;
    }
    rec.pending.push(Buffer.from(payload));   // 暂存路径显式拷贝，避免切片持有整块 socket 缓冲
    return;
  }
  if (!rec.sock || rec.sock.destroyed) return;
  if (!rec.sock.write(payload)) {
    sendCtrl(ch, { t: 'pause' });              // 让服务端暂停读公网连接
    rec.sock.once('drain', () => {
      if (locals.get(ch) === rec && sock && !sock.destroyed) sendCtrl(ch, { t: 'resume' });
    });
  }
}

function connect() {
  log('正在连接服务端 ' + HOST + ':' + PORT + ' ...');
  setStatus('正在连接 ' + HOST + ':' + PORT + ' …', 'connecting');
  const s = net.connect({ host: HOST, port: PORT });
  sock = s;
  s.setNoDelay(true);
  s.setKeepAlive(true, 15000);   // TCP 层保活：防止 NAT/防火墙回收空闲会话

  const feed = decoder((type, ch, payload) => {
    if (!sock || sock !== s) return;
    if (type === 1) handleCtrl(ch, payload);
    else if (type === 2) handleData(ch, payload);
  });

  s.on('connect', () => {
    s.write(frame(1, 0, Buffer.from(JSON.stringify({ t: 'auth', token: TOKEN, name: NAME, clientId: CLIENT_ID }), 'utf8')));
    lastPong = Date.now();
    clearInterval(beat);
    beat = setInterval(() => {
      if (sock !== s || s.destroyed) return;
      if (Date.now() - lastPong > 40000) {
        // 40 秒没收到服务端任何 pong → 连接大概率已半开，主动断开触发快速重连
        log('心跳超时（40 秒未收到服务端回应），主动重连', '!!');
        try { s.destroy(); } catch (_) { /* ignore */ }
        return;
      }
      pingAt = Date.now();
      sendCtrl(0, { t: 'ping' });
    }, 5000);
  });
  s.on('data', chunk => {
    try { feed(chunk); } catch (e) { log('协议错误：' + e.message, '!!'); s.destroy(); }
  });
  s.on('drain', resumeAllLocals);
  s.on('error', e => {
    log('连接失败：' + (e.code || e.message), '!!');
    setStatus('连接失败：' + (e.code || e.message) + '，将自动重试', 'error');
  });
  s.on('close', () => {
    clearInterval(beat);
    if (sock !== s) return;
    sock = null;
    for (const [ch, rec] of [...locals]) dropLocal(ch, rec, false);
    locals.clear();
    retry++;
    // 服务端 9001 暴露在公网，任何未认证的 TCP 探测都会顶替已认证客户端
    // （见 _deploy/easytunnel-server-patch/server.js 的修复说明）。这类断连不需要
    // 退避，200ms 内重连可把中断压到最短；只有连续连接失败才逐步退避。
    const wait = retry <= 2 ? 200 : Math.min(1000 * (retry - 1), 10000);
    log('连接断开，' + (wait / 1000) + ' 秒后自动重连 ...');
    setStatus('连接断开，' + (wait / 1000) + ' 秒后自动重连…', 'connecting');
    setTimeout(connect, wait);
  });
}

process.on('SIGINT', () => { log('已退出'); process.exit(0); });

async function boot() {
  if (GUI_MODE) startGui();
  setStatus('正在启动…', 'starting');

  let s = readConfigSync();
  if (!s) {
    if (GUI_MODE) {
      setStatus('未配置：请在窗口中填写服务端地址和令牌，点「保存并连接」', 'idle');
      log('等待图形窗口填写配置 …');
      s = await waitForConfig(5 * 60 * 1000);
    } else {
      throw new Error('未找到客户端配置：请从服务端管理页下载 client.json 放到本程序同目录，或用 --server / --token 参数启动');
    }
  }
  applyConfig(s);
  log('EasyTunnel 客户端启动  本机名称: ' + NAME, 'OK');
  log('服务端: ' + HOST + ':' + PORT + '  日志: ' + LOG_FILE);
  connect();
  if (GUI_MODE) watchConfig();
}

boot().catch(e => {
  log('启动失败：' + e.message, '!!');
  setStatus('启动失败：' + e.message, 'error');
  try { console.error('启动失败：' + e.message); } catch (_) { /* ignore */ }
  flushLogSync();
  process.exit(1);
});
