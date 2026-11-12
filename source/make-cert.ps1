# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CharlotteDe

param(
  [string]$HostName = '',
  [string]$OutDir = "$PSScriptRoot\certs",
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
if (-not $HostName) { $HostName = Read-Host '请输入公网 IP 或域名（例如 1.2.3.4 或 tunnel.example.com）' }
if (-not $HostName) { throw '必须提供公网 IP 或域名' }
if (-not (Get-Command openssl -ErrorAction SilentlyContinue)) {
  throw '未找到 openssl。Windows 可安装 Git for Windows（自带 openssl）后重试。'
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$cert = Join-Path $OutDir 'cert.pem'
$key = Join-Path $OutDir 'key.pem'
if ((Test-Path $cert) -and (Test-Path $key) -and -not $Force) {
  Write-Output "证书已存在：$cert / $key（加 -Force 覆盖）"
  exit 0
}
$san = if ($HostName -match '^\d{1,3}(\.\d{1,3}){3}$') {
  "IP:$HostName,IP:127.0.0.1,DNS:localhost"
} else {
  "DNS:$HostName,DNS:localhost,IP:127.0.0.1"
}
& openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 `
  -keyout $key -out $cert -subj "/CN=$HostName" -addext "subjectAltName=$san"
if ($LASTEXITCODE -ne 0) { throw 'openssl 生成证书失败' }
Write-Output "已生成：$cert"
Write-Output "已生成：$key"
Write-Output '把 certs 目录放到 server.js 同目录，重启服务端即可启用 HTTPS 路径映射。'
