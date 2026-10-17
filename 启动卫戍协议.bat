@echo off
cd /d "%~dp0"

REM --- Locate node/npm (avoid hardcoding the Chinese path) ---
set "NODE_EXE="
set "NPM_CMD="
where node >nul 2>nul
if not errorlevel 1 (
    set "NODE_EXE=node"
    set "NPM_CMD=npm"
    goto :HAVENODE
)
if exist "C:/Program Files/nodejs/node.exe" (
    set "NODE_EXE=C:/Program Files\nodejs\node.exe"
    set "NPM_CMD=C:/Program Files\nodejs\npm.cmd"
    goto :HAVENODE
)
for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
    if exist "%%d\node.exe" (
        set "NODE_EXE=%%d\node.exe"
        set "NPM_CMD=%%d\npm.cmd"
        goto :HAVENODE
    )
)
echo [ERROR] Node.js not found. Install Node.js >=22 from https://nodejs.org then retry.
pause
exit /b 1

:HAVENODE
echo [INFO] Using node: %NODE_EXE%

REM --- First run: install deps + browser libs into public/vendor ---
if not exist "public\vendor" (
    echo [INFO] First run: installing dependencies and browser libraries, this may take a few minutes...
    if "%NPM_CMD%"=="npm" (
        call npm install
    ) else (
        call "%NPM_CMD%" install
    )
    if errorlevel 1 (
        echo [ERROR] npm install failed. Check the output above.
        pause
        exit /b 1
    )
) else (
    echo [INFO] Dependencies already present, skipping install.
)

REM --- Start server in background, log to server.log ---
echo [INFO] Starting Stronghold Protocol server...
start "" /b "%NODE_EXE%" server/index.js > server.log 2>&1

REM --- Wait until port 3000 is listening, then open browser ---
set "READY=0"
for /l %%i in (1,1,60) do (
    netstat -ano 2>nul | findstr ":3000" >nul 2>&1
    if not errorlevel 1 (
        set "READY=1"
        goto :OPEN
    )
    timeout /t 1 /nobreak >nul
)

:OPEN
if "%READY%"=="1" (
    echo [INFO] Server is up. Opening http://localhost:3000
    start "" http://localhost:3000
    echo [INFO] Close this window to stop the server.
) else (
    echo [ERROR] Server did not start within 60s. Check server.log for details.
)
pause
