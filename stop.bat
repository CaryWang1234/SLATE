@echo off
title SLATE Stop
setlocal

set "PORT=8000"
set "FOUND="

echo [SLATE] Stopping service on port %PORT%...

for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do (
  set "FOUND=1"
  echo [SLATE] Killing PID %%P
  taskkill /F /PID %%P >nul 2>&1
)

if not defined FOUND (
  echo [SLATE] No process is listening on port %PORT%.
) else (
  echo [SLATE] Port %PORT% is clear.
)

endlocal
pause
