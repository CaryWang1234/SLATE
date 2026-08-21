@echo off
title Build SLATE Installer

set ISCC=ISCC.exe
set ISCC_FOUND=0
where ISCC.exe >nul 2>&1
if %errorlevel% equ 0 (
  set ISCC_FOUND=1
) else (
  if exist "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" (
    set "ISCC=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
    set ISCC_FOUND=1
  )
  if exist "C:\Program Files\Inno Setup 6\ISCC.exe" (
    set "ISCC=C:\Program Files\Inno Setup 6\ISCC.exe"
    set ISCC_FOUND=1
  )
  if exist "C:\Program Files (x86)\Inno Setup 7\ISCC.exe" (
    set "ISCC=C:\Program Files (x86)\Inno Setup 7\ISCC.exe"
    set ISCC_FOUND=1
  )
  if exist "C:\Program Files\Inno Setup 7\ISCC.exe" (
    set "ISCC=C:\Program Files\Inno Setup 7\ISCC.exe"
    set ISCC_FOUND=1
  )
)

if "%ISCC_FOUND%" neq "1" (
  echo [SLATE] Inno Setup compiler was not found.
  echo [SLATE] Install Inno Setup 6/7 or add ISCC.exe to PATH.
  pause
  exit /b 1
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

echo [SLATE] Done: installer\SLATE-Setup-0.3.2.exe
pause
