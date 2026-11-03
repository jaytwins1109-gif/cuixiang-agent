@echo off
chcp 65001 >nul
title 脆香零食 - 取消开机自启
cd /d "%~dp0"

set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\cuixiang-dev-server.lnk"

if exist "%LNK%" (
  del "%LNK%"
  echo [完成] 已取消开机自启，启动项已删除。
) else (
  echo 本来就没有设置开机自启，无需操作。
)

echo.
echo 现在想启动服务，双击 启动.bat。
echo.
pause
