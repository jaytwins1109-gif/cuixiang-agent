@echo off
chcp 65001 >nul
title 脆香零食 - 本地服务
cd /d "%~dp0"

echo ============================================
echo   脆香零食 · 启动中
echo   启动后浏览器会自动打开 http://localhost:3000
echo   关闭本窗口即停止服务
echo ============================================
echo.

rem ── 1. 找 Node.exe：先用系统 PATH，找不到就用机器上已存在的那份 ──
set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"

if not defined NODE_EXE (
  if exist "C:\Users\Administrator\AppData\Roaming\secoresdk\360se6\Application\components\Node\node.exe" (
    set "NODE_EXE=C:\Users\Administrator\AppData\Roaming\secoresdk\360se6\Application\components\Node\node.exe"
  )
)

if not defined NODE_EXE (
  echo [错误] 没找到 Node.js，请先安装 Node.js 18 或更高版本。
  echo        下载地址：https://nodejs.org/zh-cn
  pause
  exit /b 1
)

rem 把 node 所在目录加进 PATH，保证 npm 也能用
for %%I in ("%NODE_EXE%") do set "NODE_DIR=%%~dpI"
set "PATH=%NODE_DIR%;%PATH%"

echo [1/3] 使用 Node：
node -v
echo.

rem ── 2. 依赖没装过就先装 ──
if not exist "node_modules" (
  echo [2/3] 首次运行，正在安装依赖（约 1-2 分钟）...
  call npm install
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
) else (
  echo [2/3] 依赖已就绪，跳过安装。
)
echo.

rem ── 3. 起服务 + 自动开浏览器 ──
echo [3/3] 启动开发服务器...
start "" cmd /c "timeout /t 8 /nobreak >nul & start "" http://localhost:3000"
node node_modules\next\dist\bin\next dev -p 3000

echo.
echo 服务已停止。
pause
