@echo off
title Novig Explorer (live)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js isn't installed. Install it with:
  echo     winget install OpenJS.NodeJS.LTS
  echo   then close this window and double-click start.cmd again.
  echo.
  pause
  exit /b 1
)
if not exist config.json (
  copy /y config.example.json config.json >nul
  echo.
  echo   Created config.json. Fill in your key ID and key file path, save it,
  echo   then double-click start.cmd again.
  echo.
  start notepad config.json
  pause
  exit /b 0
)
start "" http://localhost:8787
node server.mjs
pause
