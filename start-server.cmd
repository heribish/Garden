@echo off
title garden
cd /d "%~dp0"
echo Starting server in: %cd%
node src/server.js
if errorlevel 1 pause
pause
