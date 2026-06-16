@echo off
title garden (dev, auto-reload)
cd /d "%~dp0"
echo Starting dev server: http://127.0.0.1:3780
node --watch src/server.js
if errorlevel 1 pause
