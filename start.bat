@echo off
title MCSLite Minecraft Server Panel
cd /d "%~dp0"

if not exist server.js (
  echo [ERROR] server.js not found in this folder.
  echo Please run this file from the MCSLite folder:
  echo   C:\Users\Qireal\Desktop\MCSLite
  pause
  exit /b 1
)

echo ========================================
echo   MCSLite Minecraft Server Panel
echo   Web:  http://127.0.0.1:8333
echo   Ctrl+C to stop the panel
echo ========================================
node server.js
pause
