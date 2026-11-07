"""通用插件适配层：支持 SKILL.md 开放标准，兼容 Codex CLI / Claude Code 等生态。

支持来源：
1. SKILL.md 开放标准（Codex CLI、Claude Code、Cursor、Gemini CLI 等通用）
2. Codex CLI 插件（.codex-plugin/plugin.json 清单）
3. 标准安装路径自动发现（~/.codex/skills/、~/.claude/skills/ 等）
4. GitHub 仓库在线拉取
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.parse
import zipfile
from pathlib import Path
from typing import Any

# SKILL.md 开放标准文件名
SKILL_MD_NAMES = {"SKILL.md", "skill.md", "Skill.md"}

# 标准技能安装路径（按优先级）
STANDARD_SKILL_DIRS = [
    Path.home() / ".codex" / "skills",
    Path.home() / ".claude" / "skills",
    Path.home() / ".cursor" / "skills",
    Path.home() / ".gemini" / "skills",
    Path.home() / ".agents" / "skills",
]

# Codex 插件清单文件名
CODEX_PLUGIN_MANIFEST = ".codex-plugin/plugin.json"


def _parse_skill_md_frontmatter(content: str) -> dict[str, str]:
    """解析 SKILL.md 开头的 YAML frontmatter，提取 name/description。

    只在文件开头解析一次（首行 --- 到下一个 ---），正文中的 Markdown
    水平线 --- 不得重新进入 frontmatter 模式，否则正文 `xxx: yyy` 行会
    覆盖 name/description。
    """
    meta: dict[str, str] = {}
    if not content.startswith("---"):
        return meta
    lines = content.split("\n")
    for i, line in enumerate(lines[1:], 1):
        if line.strip() == "---":
            break
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or ":" not in stripped:
            continue
        key, _, value = stripped.partition(":")
        meta[key.strip().lower()] = value.strip()
    return meta


def _find_skill_md(directory: Path) -> Path | None:
    """在目录中查找 SKILL.md 文件（大小写不敏感）。"""
    for name in SKILL_MD_NAMES:
        candidate = directory / name
        if candidate.is_file():
            return candidate
    return None


def discover_local_skills() -> list[dict[str, Any]]:
    """扫描标准安装路径，发现已安装的 SKILL.md 技能。"""
    discovered: list[dict[str, Any]] = []
    seen_names: set[str] = set()

    for base_dir in STANDARD_SKILL_DIRS:
        if not base_dir.is_dir():
            continue
        for skill_dir in base_dir.iterdir():
            if not skill_dir.is_dir():
                continue
            skill_md = _find_skill_md(skill_dir)
            if not skill_md:
                continue
            try:
                content = skill_md.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            meta = _parse_skill_md_frontmatter(content)
            name = meta.get("name", skill_dir.name)
            if name in seen_names:
                continue
            seen_names.add(name)
            discovered.append({
                "name": name,
                "description": meta.get("description", name),
                "source": str(base_dir),
                "path": str(skill_dir),
                "format": "skill.md",
            })
    return discovered


def discover_codex_plugins() -> list[dict[str, Any]]:
    """扫描 Codex 插件目录，发现 .codex-plugin/plugin.json 清单。"""
    discovered: list[dict[str, Any]] = []
    codex_dir = Path.home() / ".codex" / "plugins"
    if not codex_dir.is_dir():
        return discovered

    for plugin_dir in codex_dir.iterdir():
        if not plugin_dir.is_dir():
            continue
        manifest = plugin_dir / CODEX_PLUGIN_MANIFEST
        if not manifest.is_file():
            continue
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        discovered.append({
            "name": data.get("name", plugin_dir.name),
            "description": data.get("description", ""),
            "source": "codex-plugin",
            "path": str(plugin_dir),
            "format": "codex-plugin",
            "manifest": data,
        })
    return discovered


def import_from_path(src_path: str, dest_dir: Path, name: str = "") -> dict[str, Any]:
    """从本地路径导入技能（支持 SKILL.md 目录或 Codex 插件目录）。

    返回: {"name": str, "format": str, "files": int, "path": str}
    """
    src = Path(os.path.expanduser(src_path.strip()))
    if not src.exists():
        return {"error": f"路径不存在: {src_path}"}

    # 检测格式
    skill_md = _find_skill_md(src) if src.is_dir() else None
    codex_manifest = (src / CODEX_PLUGIN_MANIFEST) if src.is_dir() else None

    if not skill_md and not codex_manifest:
        return {"error": "未找到 SKILL.md 或 .codex-plugin/plugin.json"}

    # 确定技能名
    if skill_md:
        meta = _parse_skill_md_frontmatter(skill_md.read_text(encoding="utf-8", errors="ignore"))
        skill_name = name or meta.get("name", src.name)
        fmt = "skill.md"
    else:
        try:
            manifest_data = json.loads(codex_manifest.read_text(encoding="utf-8"))
            skill_name = name or manifest_data.get("name", src.name)
        except (OSError, json.JSONDecodeError):
            skill_name = name or src.name
        fmt = "codex-plugin"

    # 清理技能名
    skill_name = re.sub(r"[^\w\u4e00-\u9fff.-]", "-", skill_name.strip()).strip(".")[:64]
    if not skill_name:
        return {"error": "无效的技能名称"}

    # 复制到目标目录
    dest = dest_dir / skill_name
    dest_dir.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(src.resolve(), dest)

    file_count = sum(1 for _ in dest.rglob("*") if _.is_file())
    return {
        "name": skill_name,
        "format": fmt,
        "files": file_count,
        "path": str(dest),
    }


def import_from_github(repo_url: str, dest_dir: Path, subpath: str = "") -> dict[str, Any]:
    """从 GitHub 仓库导入技能。

    支持格式：
    - https://github.com/user/repo
    - https://github.com/user/repo/tree/main/path/to/skill
    - user/repo
    - user/repo/path/to/skill
    """
    # 解析仓库 URL
    repo_url = repo_url.strip().rstrip("/")
    if not repo_url.startswith(("http://", "https://")):
        repo_url = f"https://github.com/{repo_url}"

    # 提取 user/repo 和可选子路径
    match = re.match(r"https://github\.com/([^/]+)/([^/]+?)(?:/tree/[^/]+/(.+))?$", repo_url)
    if not match:
        return {"error": f"无法解析 GitHub 仓库地址: {repo_url}"}

    user, repo, sub_path = match.groups()
    sub_path = subpath or sub_path or ""

    # 下载仓库（使用 GitHub archive URL）
    archive_url = f"https://github.com/{user}/{repo}/archive/refs/heads/main.zip"
    # 也尝试 master 分支
    archive_url_master = f"https://github.com/{user}/{repo}/archive/refs/heads/master.zip"

    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = Path(tmp_dir)
        archive_path = tmp_path / "repo.zip"

        # 尝试下载
        downloaded = False
        for url in (archive_url, archive_url_master):
            try:
                import urllib.request
                urllib.request.urlretrieve(url, str(archive_path))
                downloaded = True
                break
            except Exception:
                continue

        if not downloaded:
            return {"error": "无法下载仓库，请检查仓库地址或网络连接"}

        # 解压
        extract_dir = tmp_path / "extracted"
        with zipfile.ZipFile(str(archive_path), "r") as zf:
            zf.extractall(str(extract_dir))

        # 查找技能目录
        # GitHub archive 解压后通常在 {repo}-main/ 或 {repo}-master/ 下
        extracted_items = list(extract_dir.iterdir())
        if len(extracted_items) == 1 and extracted_items[0].is_dir():
            root = extracted_items[0]
        else:
            root = extract_dir

        # 定位技能目录
        if sub_path:
            skill_dir = root / sub_path
        else:
            # 查找包含 SKILL.md 的目录
            skill_dir = None
            for md_file in root.rglob("SKILL.md"):
                skill_dir = md_file.parent
                break
            if not skill_dir:
                for md_file in root.rglob("skill.md"):
                    skill_dir = md_file.parent
                    break

        if not skill_dir or not skill_dir.is_dir():
            return {"error": "仓库中未找到 SKILL.md 文件"}

        # 导入
        skill_md = _find_skill_md(skill_dir)
        if skill_md:
            meta = _parse_skill_md_frontmatter(skill_md.read_text(encoding="utf-8", errors="ignore"))
            skill_name = meta.get("name", skill_dir.name)
        else:
            skill_name = skill_dir.name

        skill_name = re.sub(r"[^\w\u4e00-\u9fff.-]", "-", skill_name.strip()).strip(".")[:64]
        dest = dest_dir / skill_name
        dest_dir.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(skill_dir, dest)

        file_count = sum(1 for _ in dest.rglob("*") if _.is_file())
        return {
            "name": skill_name,
            "format": "skill.md",
            "files": file_count,
            "path": str(dest),
            "source": f"{user}/{repo}",
        }


def list_available_sources() -> dict[str, Any]:
    """列出所有可用的技能来源。"""
    return {
        "local_skills": discover_local_skills(),
        "codex_plugins": discover_codex_plugins(),
        "standard_dirs": [str(d) for d in STANDARD_SKILL_DIRS if d.is_dir()],
    }


# ── .agents 直读（不复制） ─────────────────────────────
#
# 跨工具 Agent Skills 标准落在 .agents/skills/：工作区一份、家目录一份。
# 与「发现插件」那条复制导入的路不同，这里是活读——别家工具装了/更新了，
# 下一次请求就看得见；同名时工作区盖过家目录（标准规定的优先级）。

def _agents_skill_dirs(workspace_dir: Path | None) -> list[tuple[Path, str]]:
    dirs: list[tuple[Path, str]] = []
    if workspace_dir:
        dirs.append((workspace_dir / ".agents" / "skills", "workspace"))
    dirs.append((Path.home() / ".agents" / "skills", "home"))
    return dirs


def _scan_agents_dir(base_dir: Path, source: str) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    if not base_dir.is_dir():
        return found
    for skill_dir in sorted(base_dir.iterdir()):
        if not skill_dir.is_dir():
            continue
        skill_md = _find_skill_md(skill_dir)
        if not skill_md:
            continue
        try:
            content = skill_md.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        meta = _parse_skill_md_frontmatter(content)
        found.append({
            "name": skill_dir.name,
            "description": meta.get("description", skill_dir.name),
            "source": source,
            "path": str(skill_dir),
        })
    return found


def list_external_skills(workspace_dir: Path | None = None) -> list[dict[str, Any]]:
    """直读工作区与家目录的 .agents/skills；同名工作区优先，各来源内部按目录名去重。"""
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for base_dir, source in _agents_skill_dirs(workspace_dir):
        for entry in _scan_agents_dir(base_dir, source):
            if entry["name"] in seen:
                continue
            seen.add(entry["name"])
            result.append(entry)
    return result


def resolve_external_skill(name: str, workspace_dir: Path | None = None) -> Path | None:
    """按名字找回 .agents 里的技能目录（工作区优先）；名字先消毒防穿越。"""
    clean = re.sub(r"[^\w\u4e00-\u9fff.-]", "-", str(name).strip()).strip(".")[:64]
    if not clean or clean != str(name).strip():
        return None
    for base_dir, _source in _agents_skill_dirs(workspace_dir):
        candidate = base_dir / clean
        if candidate.is_dir() and _find_skill_md(candidate):
            return candidate
    return None


# ── npm 包导入（tarball 直取，不跑 lifecycle 脚本） ─────

NPM_REGISTRY = "https://registry.npmjs.org"
_NPM_NAME_RE = re.compile(r"^(?:@[a-z0-9-~][a-z0-9-._~]*/)?[a-z0-9-~][a-z0-9-._~]*$")
_NPM_MAX_BYTES = 20 * 1024 * 1024


def _safe_extract_tar(archive: Path, dest: Path) -> None:
    """解 tar.gz 时逐条验落点：绝对路径、.. 穿越、符号链接一律拒收。"""
    dest_resolved = dest.resolve()
    with tarfile.open(archive, "r:gz") as tf:
        for member in tf.getmembers():
            target = (dest / member.name).resolve()
            if dest_resolved != target and dest_resolved not in target.parents:
                raise ValueError(f"压缩包含越界路径: {member.name}")
            if member.issym() or member.islnk():
                raise ValueError(f"压缩包含链接条目: {member.name}")
        tf.extractall(dest, filter="data")


def import_from_npm(package: str, dest_dir: Path, name: str = "") -> dict[str, Any]:
    """从 npm registry 取包的 tarball，找到 SKILL.md 后复制导入。

    只下载与解包，绝不执行 npm install / lifecycle 脚本——postinstall 是
    技能包供应链里最常见的投毒点，技能本体又只是 Markdown，没必要跑代码。
    """
    import urllib.request

    pkg = str(package).strip()
    if pkg.startswith("npm:"):
        pkg = pkg[4:].strip()
    if not _NPM_NAME_RE.match(pkg) or len(pkg) > 214:
        return {"error": f"不是合法的 npm 包名: {package}"}

    try:
        meta_url = f"{NPM_REGISTRY}/{urllib.parse.quote(pkg, safe='@/')}"
        with urllib.request.urlopen(meta_url, timeout=20) as resp:
            meta = json.loads(resp.read().decode("utf-8"))
        latest = (meta.get("dist-tags") or {}).get("latest", "")
        version_meta = (meta.get("versions") or {}).get(latest) or {}
        tarball = (version_meta.get("dist") or {}).get("tarball", "")
        if not tarball.startswith("https://"):
            return {"error": f"包 {pkg} 没有可下载的 tarball"}
    except Exception as e:
        return {"error": f"查询 npm registry 失败: {str(e)[:160]}"}

    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = Path(tmp_dir)
        archive_path = tmp_path / "package.tgz"
        try:
            req = urllib.request.Request(tarball, headers={"User-Agent": "SLATE-skill-import"})
            with urllib.request.urlopen(req, timeout=60) as resp, open(archive_path, "wb") as out:
                total = 0
                while chunk := resp.read(65536):
                    total += len(chunk)
                    if total > _NPM_MAX_BYTES:
                        return {"error": "包体积超过 20MB，拒绝导入"}
                    out.write(chunk)
        except Exception as e:
            return {"error": f"下载 tarball 失败: {str(e)[:160]}"}

        extract_dir = tmp_path / "extracted"
        extract_dir.mkdir()
        try:
            _safe_extract_tar(archive_path, extract_dir)
        except (ValueError, tarfile.TarError, OSError) as e:
            return {"error": f"解包被拒: {str(e)[:160]}"}

        # npm tarball 惯例是 package/ 一层；SKILL.md 可能在根、skills/<name>/ 或更深
        skill_md = None
        for candidate in sorted(extract_dir.rglob("*")):
            if candidate.is_file() and candidate.name in SKILL_MD_NAMES:
                skill_md = candidate
                break
        if not skill_md:
            return {"error": f"包 {pkg} 里没有找到 SKILL.md，它可能不是一个技能包"}
        skill_dir = skill_md.parent
        meta_fm = _parse_skill_md_frontmatter(skill_md.read_text(encoding="utf-8", errors="ignore"))
        skill_name = name or meta_fm.get("name") or (skill_dir.name if skill_dir.name != "package" else pkg.split("/")[-1])
        skill_name = re.sub(r"[^\w\u4e00-\u9fff.-]", "-", skill_name.strip()).strip(".")[:64]
        if not skill_name:
            return {"error": "无效的技能名称"}

        dest = dest_dir / skill_name
        dest_dir.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(skill_dir, dest)
        file_count = sum(1 for _ in dest.rglob("*") if _.is_file())
        return {
            "name": skill_name,
            "format": "skill.md",
            "files": file_count,
            "path": str(dest),
            "source": f"npm:{pkg}@{latest}",
        }
