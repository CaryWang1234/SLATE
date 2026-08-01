@echo off
title Build SLATE Desktop

set PYTHON_EXE=C:\Users\caryw\AppData\Local\Programs\Python\Python314\python.exe

echo [SLATE] Building desktop package...
"%PYTHON_EXE%" -m PyInstaller --noconfirm --clean SLATE.spec

if not exist "dist\SLATE\data\skills" mkdir "dist\SLATE\data\skills"
if exist "data\constitution.json" copy /Y "data\constitution.json" "dist\SLATE\data\constitution.json" >nul
if exist "data\skills\.gitkeep" copy /Y "data\skills\.gitkeep" "dist\SLATE\data\skills\.gitkeep" >nul

echo [SLATE] Done: dist\SLATE\SLATE.exe
pause
