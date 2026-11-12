@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Building EasyTunnelClient.exe ...
echo.

set "NODE_EXE=node"
set "NODE_MAJOR=0"
for /f %%v in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 20 (
  if exist "D:\node-v24.18.0-win-x64\node.exe" (
    set "NODE_EXE=D:\node-v24.18.0-win-x64\node.exe"
    set "NODE_MAJOR=24"
  )
)
if %NODE_MAJOR% LSS 20 (
  echo [ERROR] 需要 Node.js 20 或更高版本（当前 node 版本过低）。
  echo         可安装 Node 22/24 后重试，或用 ET_NODE 指定 node.exe 路径。
  echo.
  pause
  exit /b 1
)
if defined ET_NODE set "NODE_EXE=%ET_NODE%"

"%NODE_EXE%" build-exe.js
if errorlevel 1 (
  echo.
  echo [FAILED] See the error above.
) else (
  echo.
  echo [OK] EasyTunnelClient.exe is ready in this folder.
)
echo.
pause
