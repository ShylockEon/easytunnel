// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CharlotteDe

'use strict';
/* ============================================================
 * 一键把 client.js 打包成 Windows 单文件 EasyTunnelClient.exe
 * 用 Node 官方 SEA（Single Executable Application），无需安装第三方运行时。
 * 运行： node build-exe.js    或双击 build-exe.bat
 * 需要 Node >= 20 且能访问 npm（首次会自动取 postject 注入工具）。
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = __dirname;
const OUT = path.join(DIR, 'EasyTunnelClient.exe');
const BLOB = path.join(DIR, 'sea-prep.blob');
const WANT_CONSOLE = process.env.ET_CONSOLE === '1';   // 排错时可生成带控制台的调试版
// 子进程（npx / postject / rcedit）优先使用当前 Node 24，而不是 PATH 里的旧 Node
const CHILD_ENV = Object.assign({}, process.env, {
  PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '')
});

function run(cmd, args, shell) {
  console.log('> ' + cmd + ' ' + args.join(' '));
  execFileSync(cmd, args, { stdio: 'inherit', cwd: DIR, shell: !!shell, env: CHILD_ENV });
}

// 只做「局部字节原地修改」：不整块重写 83MB，避免 Windows 实时扫描短暂锁文件
function syncPause(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (_) { const end = Date.now() + ms; while (Date.now() < end) { /* busy wait */ } }
}
function withRetry(fn, label) {
  let last;
  for (let i = 0; i < 10; i++) {
    try { return fn(); } catch (e) { last = e; syncPause(250); }
  }
  throw new Error(label + ' 失败（文件可能被占用）：' + (last && last.message));
}
function readHead(file, size) {
  return withRetry(() => {
    const fd = fs.openSync(file, 'r');
    try { const b = Buffer.alloc(size); fs.readSync(fd, b, 0, size, 0); return b; }
    finally { fs.closeSync(fd); }
  }, '读取 PE 头');
}
function patch(file, offset, bytes) {
  withRetry(() => {
    const fd = fs.openSync(file, 'r+');
    try { fs.writeSync(fd, bytes, 0, bytes.length, offset); }
    finally { fs.closeSync(fd); }
  }, '写入 PE 头');
}

// 复制出来的 node.exe 带有 Authenticode 签名，注入后会失效并干扰 PE 解析，
// 等价于官方建议的 `signtool remove /s`，这里把安全目录清零，无需 Windows SDK。
function stripSignature(file) {
  const h = readHead(file, 1024);
  const pe = h.readUInt32LE(0x3c);
  const opt = pe + 24;
  const magic = h.readUInt16LE(opt);
  const sec = opt + (magic === 0x20b ? 112 : 96) + 4 * 8;   // Data Directory[4] = Security
  if (h.readUInt32LE(sec) || h.readUInt32LE(sec + 4)) {
    patch(file, sec, Buffer.alloc(8));
    console.log('已清除失效的数字签名目录');
  }
}

// PE Optional Header 里的 Subsystem：3=控制台(CUI)，2=图形(GUI)。
// 改成 GUI 后双击不会弹黑色控制台窗口；客户端会打开一个 WinForms 图形窗口
// 用于填服务端地址/令牌和看连接状态，日志写 client.log。
function setGuiSubsystem(file) {
  const h = readHead(file, 1024);
  const sub = h.readUInt32LE(0x3c) + 24 + 68;
  const old = h.readUInt16LE(sub);
  if (old === 2) { console.log('已是 GUI 子系统'); return; }
  if (old !== 3) throw new Error('未识别的 PE Subsystem: ' + old);
  const two = Buffer.alloc(2); two.writeUInt16LE(2, 0);
  patch(file, sub, two);
  console.log('已切换为 GUI 子系统：双击不再弹黑窗口');
}

function localNpx() {
  const p = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'npx.cmd' : 'npx');
  return fs.existsSync(p) ? p : 'npx';
}

// 写入 exe 图标与版本信息。必须在 postject 注入 SEA blob 之前执行：
// rcedit 会重建 PE 资源树并改写头部，注入后再调用可能破坏 blob / 哨兵。
function setExeIcon(file) {
  const ico = path.join(DIR, 'icon', 'icon.ico');
  if (!fs.existsSync(ico)) {
    console.log('未找到 icon/icon.ico，跳过 exe 图标（窗口/托盘图标不受影响）');
    return;
  }
  const bin = path.join(DIR, 'tools', process.arch === 'x64' ? 'rcedit-x64.exe' : 'rcedit.exe');
  if (!fs.existsSync(bin)) {
    console.log('未找到 tools/rcedit.exe，跳过 exe 图标（窗口/托盘图标不受影响）');
    return;
  }
  console.log('写入 exe 图标与版本信息 ...');
  const args = [file,
    '--set-icon', ico,
    '--set-file-version', '2.2.0',
    '--set-product-version', '2.2.0',
    '--set-version-string', 'FileDescription', 'EasyTunnel 客户端',
    '--set-version-string', 'ProductName', 'EasyTunnel',
    '--set-version-string', 'CompanyName', 'EasyTunnel'];
  try {
    run(bin, args, false);
    console.log('exe 图标写入完成');
  } catch (e) {
    console.log('设置 exe 图标失败（不影响运行）：' + (e && e.message));
  }
}

console.log('Node: ' + process.version + '  (' + process.execPath + ')');
if (process.platform !== 'win32') {
  console.error('提示：当前不是 Windows，复制的是本机 node 可执行文件，产物不是 Windows exe。');
}

// 1. 生成 SEA blob
console.log('\n[1/4] 生成 SEA 快照 ...');
run(process.execPath, ['--experimental-sea-config', 'sea-config.json'], false);
if (!fs.existsSync(BLOB)) throw new Error('sea-prep.blob 未生成，请确认 Node >= 20');

// 2. 复制 node 可执行文件作为 exe 载体
console.log('\n[2/4] 复制 node 可执行文件 ...');
try { fs.unlinkSync(OUT); } catch (e) {
  if (e.code !== 'ENOENT') throw new Error('旧的 EasyTunnelClient.exe 还在运行或被占用，请先关闭它再打包');
}
fs.copyFileSync(process.execPath, OUT);
stripSignature(OUT);
if (!WANT_CONSOLE) setGuiSubsystem(OUT);
else console.log('ET_CONSOLE=1：保留控制台窗口（调试用）');
setExeIcon(OUT);

// 不同构建的 fuse 常量可能不同，直接从二进制里探测，避免硬编码
const raw = fs.readFileSync(OUT);
const fmatch = raw.toString('latin1').match(/NODE_SEA_FUSE_[0-9a-f]{32}/);
if (!fmatch) throw new Error('这个 node.exe 不含 SEA fuse，请改用官方 Node 22 Windows 版打包');
const fuse = fmatch[0];
console.log('检测到 SEA fuse: ' + fuse);

// 3. 注入 blob
console.log('\n[3/4] 注入客户端代码 ...');
const args = [OUT, 'NODE_SEA_BLOB', BLOB, '--sentinel-fuse', fuse];
try {
  run('postject', args, true);
} catch (_) {
  console.log('本地没有 postject，改用 npx 自动获取（需要联网，首次约十几秒）...');
  run(localNpx(), ['--yes', 'postject', ...args], true);
}

// 4. 移除已失效的数字签名（有 signtool 才做，没有不影响运行）
console.log('\n[4/4] 收尾 ...');
try { run('signtool', ['remove', '/s', OUT], true); }
catch (_) { console.log('未找到 signtool，跳过移除签名（不影响运行，仅 SmartScreen 可能提示）'); }
try { fs.unlinkSync(BLOB); } catch (_) { /* ignore */ }

console.log('\n完成：' + OUT);
console.log('大小：' + (fs.statSync(OUT).size / 1048576).toFixed(1) + ' MB');
console.log('\n用法：');
console.log('  双击 exe：服务端地址和令牌已内置，直接连接；窗口里可随时修改');
console.log('  也可从管理页下载 client.json 放到 exe 同目录，窗口会自动带入');
console.log('  静默模式（开机自启）：EasyTunnelClient.exe --no-gui');
console.log('  命令行：EasyTunnelClient.exe --server IP:9001 --token 令牌');
if (!WANT_CONSOLE) console.log('  要看控制台排错：ET_CONSOLE=1 node build-exe.js 重新生成');
