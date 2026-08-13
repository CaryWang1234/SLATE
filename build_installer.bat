@echo off
title Build SLATE Installer

set ISCC=ISCC.exe
where ISCC.exe >nul 2>&1
if %errorlevel% neq 0 (
  if exist "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" set ISCC=C:\Program Files (x86)\Inno Setup 6\ISCC.exe
  if exist "C:\Program Files\Inno Setup 6\ISCC.exe" set ISCC=C:\Program Files\Inno Setup 6\ISCC.exe
  if exist "C:\Program Files (x86)\Inno Setup 7\ISCC.exe" set ISCC=C:\Program Files (x86)\Inno Setup 7\ISCC.exe
  if exist "C:\Program Files\Inno Setup 7\ISCC.exe" set ISCC=C:\Program Files\Inno Setup 7\ISCC.exe
)

if not exist "dist\SLATE\SLATE.exe" (
  echo [SLATE] dist\SLATE\SLATE.exe not found.
  echo [SLATE] Run build_desktop.bat first.
  pause
  exit /b 1
)

echo [SLATE] Building installer...
"%ISCC%" "SLATE_InnoSetup.iss"
if %errorlevel% neq 0 (
  echo [SLATE] Inno Setup compiler failed or was not found.
  echo [SLATE] Install Inno Setup 6 or open SLATE_InnoSetup.iss manually.
  pause
  exit /b 1
)

echo [SLATE] Done: installer\SLATE-Setup-{version}.exe
pause
