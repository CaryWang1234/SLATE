#!/bin/bash
# ─────────────────────────────────────────────────────────────
# SLATE macOS 构建与打包脚本
# 用法：bash build_macos.sh [version]
#   version: 可选，如 "0.3.6"，默认从 desktop.py 读取
# ─────────────────────────────────────────────────────────────

set -euo pipefail

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ── 版本检测 ────────────────────────────────────────────────
VERSION="${1:-}"
if [ -z "$VERSION" ]; then
    # 尝试从 Inno Setup 脚本提取版本号
    if [ -f "SLATE_InnoSetup.iss" ]; then
        VERSION=$(grep '#define MyAppVersion' SLATE_InnoSetup.iss | sed 's/.*"\(.*\)".*/\1/')
    fi
fi
if [ -z "$VERSION" ]; then
    log_error "无法确定版本号，请手动传入: bash build_macos.sh 0.3.6"
fi

BUILD_TIMESTAMP=$(date +"%Y%m%d%H%M")
APP_NAME="SLATE 砚"
BUNDLE_NAME="${APP_NAME}.app"
DMG_FILENAME="SLATE-Setup-${VERSION}.dmg"

log_info "版本: ${VERSION}"
log_info "构建时间戳: ${BUILD_TIMESTAMP}"
log_info "应用名称: ${APP_NAME}"

# ── 环境检查 ────────────────────────────────────────────────
check_command() {
    if ! command -v "$1" &> /dev/null; then
        log_error "缺少必要命令: $1，请先安装 (brew install $2)"
    fi
}

check_command python3 "python@3"
check_command pip3 "python-pip"
check_command pyinstaller "pyinstaller"
check_command hdiutil ""  # macOS 自带
check_command create-dmg "create-dmg" || log_warn "create-dmg 未安装，将使用基础 dmg 创建方式 (brew install create-dmg)"

# ── 清理旧构建 ──────────────────────────────────────────────
log_info "清理旧构建..."
rm -rf dist build
mkdir -p dist

# ── 安装依赖 ───────────────────────────────────────────────
log_info "安装 Python 依赖..."
pip3 install -r requirements.txt --quiet

# ── PyInstaller 构建 ────────────────────────────────────────
log_info "PyInstaller 构建中..."
pyinstaller SLATE_macos.spec --clean --noconfirm

if [ ! -d "dist/${BUNDLE_NAME}" ]; then
    log_error "PyInstaller 构建失败，未找到 .app 包"
fi

log_info "PyInstaller 构建完成"

# ─ 复制前端资源到 .app 内部 ────────────────────────────────
log_info "复制前端资源..."
RESOURCES_DIR="dist/${BUNDLE_NAME}/Contents/Resources"
mkdir -p "${RESOURCES_DIR}/frontend"
cp -r frontend/* "${RESOURCES_DIR}/frontend/" 2>/dev/null || true

# 复制图标
if [ -f "app.icns" ]; then
    cp app.icns "${RESOURCES_DIR}/app.icns"
else
    log_warn "未找到 app.icns，将使用默认图标"
fi

# 复制许可证
if [ -f "LICENSE" ]; then
    cp LICENSE "${RESOURCES_DIR}/LICENSE"
fi

# ── 验证 .app 结构 ──────────────────────────────────────────
log_info "验证 .app 包结构..."
if [ ! -d "dist/${BUNDLE_NAME}/Contents/MacOS" ]; then
    log_error ".app 包结构不完整"
fi

# ── 签名（可选，需要开发者证书）──────────────────────────────
# 如果有 Apple Developer ID，取消下面注释并替换证书名称
# log_info "代码签名..."
# codesign --force --deep --sign "Developer ID Application: Your Name (TEAM_ID)" \
#     "dist/${BUNDLE_NAME}"

# ── 创建 DMG 安装包 ─────────────────────────────────────────
log_info "创建 DMG 安装包..."

DMG_TEMP="dist/slate-dmg-temp"
rm -rf "${DMG_TEMP}"
mkdir -p "${DMG_TEMP}"

# 复制 .app 到临时目录
cp -R "dist/${BUNDLE_NAME}" "${DMG_TEMP}/"

# 创建 Applications 文件夹快捷方式（符号链接）
ln -s /Applications "${DMG_TEMP}/Applications"

if command -v create-dmg &> /dev/null; then
    # 使用 create-dmg 创建美观的 DMG
    log_info "使用 create-dmg 创建安装包..."
    create-dmg \
        --volname "SLATE 砚 ${VERSION}" \
        --volicon "dist/${BUNDLE_NAME}/Contents/Resources/app.icns" \
        --window-pos 200 120 \
        --window-size 600 400 \
        --icon-size 100 \
        --icon "SLATE.app" 175 190 \
        --hide-extension "SLATE.app" \
        --app-drop-link 425 190 \
        --background "dist/dmg-background.png" \
        "dist/${DMG_FILENAME}" \
        "${DMG_TEMP}"
else
    # 基础 DMG 创建方式
    log_info "使用 hdiutil 创建基础安装包..."
    hdiutil create \
        -volname "SLATE 砚 ${VERSION}" \
        -srcfolder "${DMG_TEMP}" \
        -ov \
        -format UDZO \
        "dist/${DMG_FILENAME}"
fi

# 清理临时目录
rm -rf "${DMG_TEMP}"

# ── 生成校验和 ──────────────────────────────────────────────
log_info "生成 SHA256 校验和..."
cd dist
shasum -a 256 "${DMG_FILENAME}" > "${DMG_FILENAME}.sha256"
cd ../..

# ── 完成 ────────────────────────────────────────────────────
log_info "=========================================="
log_info "macOS 安装包构建完成！"
log_info "=========================================="
log_info "位置: dist/${DMG_FILENAME}"
log_info "校验和: dist/${DMG_FILENAME}.sha256"
log_info ""
log_info "安装说明："
log_info "1. 双击打开 ${DMG_FILENAME}"
log_info "2. 将 SLATE.app 拖入 Applications 文件夹"
log_info "3. 首次运行可能需要右键点击 → 打开（绕过 Gatekeeper）"
log_info ""
log_info "如需代码签名，请在脚本中配置 Apple Developer ID"
log_info "=========================================="
