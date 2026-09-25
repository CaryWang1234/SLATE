@echo off
title Build SLATE Desktop

set PYTHON_EXE=C:\Users\caryw\AppData\Local\Programs\Python\Python314\python.exe

echo [SLATE] Building desktop package...
"%PYTHON_EXE%" -m PyInstaller --noconfirm --clean SLATE.spec

if not exist "dist\SLATE\data\skills" mkdir "dist\SLATE\data\skills"
if exist "data\constitution.json" copy /Y "data\constitution.json" "dist\SLATE\data\constitution.json" >nul
if exist "data\skills\.gitkeep" copy /Y "data\skills\.gitkeep" "dist\SLATE\data\skills\.gitkeep" >nul
rem NOTE: keep this file ASCII-only. cmd.exe parses .bat in the OEM code page, so a
rem non-ASCII line with LF endings makes it swallow the next newline and run the
rem following command as garbage. Bundled SKILL.md skills and expert packs are
rem shipped as whole dirs; the installer uses onlyifdoesntexist so user edits stay.
if exist "data\skills" xcopy "data\skills" "dist\SLATE\data\skills\" /E /I /Y /Q >nul
if exist "data\experts" xcopy "data\experts" "dist\SLATE\data\experts\" /E /I /Y /Q >nul

echo [SLATE] Done: dist\SLATE\SLATE.exe
pause
