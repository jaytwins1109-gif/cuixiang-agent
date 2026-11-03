@echo off
chcp 65001 >nul
title 脆香零食 - 设置开机自启
cd /d "%~dp0"

echo ============================================
echo   设置开机自启
echo   以后登录 Windows 会自动启动开发服务
echo   地址：http://localhost:3000
echo ============================================
echo.

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LNK=%STARTUP%\cuixiang-dev-server.lnk"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%LNK%'); $s.TargetPath = '%~dp0silent-start.vbs'; $s.WorkingDirectory = '%~dp0'; $s.Save()"

if exist "%LNK%" (
  echo [完成] 已写入启动项：
  echo        %LNK%
  echo.
  echo 重启电脑后服务会自动跑起来，IDE 内置预览随时可打开。
) else (
  echo [失败] 没写进去，可以右键"以管理员身份运行"再试。
)

echo.
echo 不想开机自启了？双击 取消开机自启.bat 即可撤销。
echo.
pause
