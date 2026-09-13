@echo off
cd /d "c:\Users\david\tz-shop-mvp"
start "Garden" /MIN cmd /c "npm run dev"
timeout /t 3 /nobreak >nul
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app=http://127.0.0.1:3780/shop --new-window
