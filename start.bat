@echo off
title SLATE

:: 自动清理占用 8000 端口的残留进程
powershell -Command "Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1

chcp 65001 >nul
echo [SLATE] Starting backend...
python -m pip install -r backend/requirements.txt -q
python -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000
pause
