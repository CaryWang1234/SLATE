# -*- mode: python ; coding: utf-8 -*-
"""
SLATE macOS PyInstaller 构建配置
用法：pyinstaller SLATE_macos.spec
"""

import os
import sys
from pathlib import Path

# ── 基础路径 ────────────────────────────────────────────────
BASE_DIR = Path(SPECPATH).resolve()
FRONTEND_DIR = BASE_DIR / "frontend"
BACKEND_DIR = BASE_DIR / "backend"

# ── 应用信息 ────────────────────────────────────────────────
app_name = "SLATE 砚"
app_version = "0.3.6"  # 从 SLATE_InnoSetup.iss 同步

# ── 收集前端文件 ────────────────────────────────────────────
def collect_frontend():
    """递归收集 frontend 目录下所有文件"""
    datas = []
    if FRONTEND_DIR.exists():
        for root, dirs, files in os.walk(FRONTEND_DIR):
            rel_dir = Path(root).relative_to(BASE_DIR)
            for f in files:
                src = str(Path(root) / f)
                dst = str(rel_dir / f)
                datas.append((src, dst))
    return datas

# ── 收集后端技能文件 ─────────────────────────────────────────
def collect_skills():
    """收集 backend/skills 目录下的 Python 文件"""
    datas = []
    skills_dir = BACKEND_DIR / "skills"
    if skills_dir.exists():
        for f in skills_dir.glob("*.py"):
            datas.append((str(f), f"backend/skills"))
    return datas

# ─ 数据文件列表 ────────────────────────────────────────────
datas = collect_frontend() + collect_skills()

# 添加其他必要的数据文件
extra_datas = [
    ("LICENSE", "."),
    ("README.md", "."),
]
datas.extend(extra_datas)

# ── 隐藏导入（PyInstaller 自动检测可能遗漏的模块）────────────
hiddenimports = [
    # FastAPI & Uvicorn
    "fastapi",
    "uvicorn",
    "uvicorn.main",
    "uvicorn.config",
    "uvicorn.lifespan",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.ws",
    # HTTPX
    "httpx",
    "httpcore",
    # Database
    "aiosqlite",
    "sqlite3",
    # File handling
    "aiofiles",
    "aiofiles.os",
    # Document processing
    "pptx",
    "docx",
    "openpyxl",
    "pdfplumber",
    # Web scraping
    "ddgs",
    "playwright",
    "playwright.sync_api",
    # Desktop
    "webview",
    "webview.guilib",
    "pythonnet",
    # Utilities
    "qrcode",
    "PIL",
    "PIL.Image",
    "pyautogui",
    "pyperclip",
    "pygetwindow",
    # JSON/Config
    "json",
    "configparser",
]

# ── 二进制文件排除（macOS 不需要 Windows DLL）────────────────
binaries = []

# ── 排除项 ──────────────────────────────────────────────────
excludes = [
    "tkinter",
    "matplotlib",
    "numpy",
    "scipy",
    "pandas",
    "pytest",
    "setuptools",
    "distutils",
    # Windows 专属
    "win32api",
    "win32con",
    "winreg",
    "_winapi",
    "msvcrt",
]

# ── PyInstaller 主配置 ──────────────────────────────────────
a = Analysis(
    ["desktop.py"],
    pathex=[str(BASE_DIR)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=None,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=None)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="SLATE",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,  # macOS GUI 应用不显示控制台
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,  # auto-detect
    codesign_identity=None,
    entitlements_file=None,
    icon="app.icns" if Path("app.icns").exists() else None,
)

# macOS .app Bundle 配置（直接 BUNDLE，无需 COLLECT）
app = BUNDLE(
    exe,
    name=f"{app_name}.app",
    icon="app.icns" if Path("app.icns").exists() else None,
    bundle_identifier="com.slate.desktop",
    version=app_version,
    info_plist={
        "CFBundleName": app_name,
        "CFBundleDisplayName": app_name,
        "CFBundleVersion": app_version,
        "CFBundleShortVersionString": app_version,
        "CFBundleIdentifier": "com.slate.desktop",
        "NSHighResolutionCapable": True,
        "LSMinimumSystemVersion": "10.15.0",
        "NSRequiresAquaSystemAppearance": False,
    },
)
