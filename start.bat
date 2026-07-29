@echo off
chcp 65001 >nul
title SLATE
echo [SLATE] Starting backend...
pip install -r backend/requirements.txt -q
uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000
pause
