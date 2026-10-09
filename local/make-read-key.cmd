@echo off
title Novig Explorer - make a read-only key
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js isn't installed. Install it with:
  echo     winget install OpenJS.NodeJS.LTS
  echo.
  pause
  exit /b 1
)
node make-read-key.mjs
pause
