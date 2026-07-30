@echo off
title SLATE

:: Kill process on port 8000 (pure ASCII, no encoding issues)
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R "127.0.0.1:8000.*LISTENING"') do taskkill /F /PID %%P >nul 2>&1

chcp 65001 >nul
echo [SLATE] Starting backend...
python -m pip install -r backend/requirements.txt -q
python -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000
pause
