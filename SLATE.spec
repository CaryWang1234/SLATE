# -*- mode: python ; coding: utf-8 -*-

datas = [
    ('frontend', 'frontend'),
    ('backend/skills', 'backend/skills'),
    ('backend/workflows', 'backend/workflows'),
]

hiddenimports = [
    'backend.main',
    'backend.routers.chat',
    'backend.routers.constitution',
    'backend.routers.experts',
    'backend.routers.files',
    'backend.routers.knowledge',
    'backend.routers.projects',
    'backend.routers.proxy',
    'backend.routers.settings',
    'backend.routers.skills',
    'backend.routers.workflows',
    'backend.skills.css_color',
    'backend.skills.doc_write',
    'backend.skills.file_create',
    'backend.skills.file_edit',
    'backend.skills.file_peek',
    'backend.skills.file_tree',
    'backend.skills.html_render',
    'backend.skills.json_tool',
    'backend.skills.regex_test',
    'backend.skills.repo_stats',
    'backend.skills.text_summarize',
    'backend.skills.todo_scan',
    'backend.skills.terminal',
    'webview.platforms.edgechromium',
    'uvicorn.lifespan.on',
    'uvicorn.protocols.http.auto',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.loops.auto',
]

excludes = [
    'PyQt5',
    'PyQt6',
    'PySide2',
    'PySide6',
    'kivy',
    'gi',
    'gtk',
    'tkinter',
]

a = Analysis(
    ['desktop.py'],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='SLATE',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['app.ico'],
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='SLATE',
)
