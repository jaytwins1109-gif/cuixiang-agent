@echo off
cd /d "%~dp0"

rem locate node.exe: PATH first, then the bundled copy on this machine
set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"

if not defined NODE_EXE (
  if exist "C:\Users\Administrator\AppData\Roaming\secoresdk\360se6\Application\components\Node\node.exe" (
    set "NODE_EXE=C:\Users\Administrator\AppData\Roaming\secoresdk\360se6\Application\components\Node\node.exe"
  )
)

if not defined NODE_EXE exit /b 1

for %%I in ("%NODE_EXE%") do set "NODE_DIR=%%~dpI"
set "PATH=%NODE_DIR%;%PATH%"

if not exist "node_modules" call npm install

rem silent mode (used by auto-start): overwrite log, no browser popup
"%NODE_EXE%" node_modules\next\dist\bin\next dev -p 3000 > dev.log 2>&1
