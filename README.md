<div align="center">

<img src="frontend/icon.png" width="96" alt="SLATE" />

# SLATE（砚）

**本地 AI 协作调度台 · 将灵感转化为结构化方案**

*Local AI collaboration studio — turn sparks of ideas into structured plans.*

[![License: MIT](https://img.shields.io/badge/License-MIT-1a1a1a.svg)](LICENSE)
[![Website](https://img.shields.io/badge/Website-carywang1234.github.io%2FSLATE-1a1a1a.svg)](https://carywang1234.github.io/SLATE/docs/index.html)
[![Python](https://img.shields.io/badge/Python-3.13%2B-1a1a1a.svg)](https://www.python.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows-1a1a1a.svg)]()
[![Build](https://img.shields.io/badge/Build-Zero%20npm%20%2F%20Zero%20Bundler-1a1a1a.svg)]()

</div>

---

SLATE 是一个**轻量级本地 AI 协作工具**，专注于提示词工程、上下文管理与项目灵感整理。

它内置多模型对话、MCP 工具调用、Harness 自主执行、AI 团队辩论与白板式逻辑链，既能直接驱动内置工具完成任务，也能生成高质量 Prompt 交给外部 Coding Agent（Claude Code、Codex、Cursor 等）执行。

**零 npm 依赖，零构建工具，原生技术栈，本地优先。**

---

## ✨ 亮点一览

- 🗣️ **多模型统一接入** —— 国内外主流 LLM + 自定义 OpenAI 兼容端点 + 本地模型（Ollama / LM Studio）
- ⚡ **Harness 自主执行** —— 模型自主规划、多轮调用工具直至任务完成，带进度显示可随时停止
- 🛠️ **13 个内置 MCP 工具** —— 文件读写编辑、终端沙箱、仓库统计、正则测试、文本摘要等
- 🧩 **自定义 Skill 系统** —— `SKILL.md` 即插即用，聊天中 `@` 提及即注入上下文
- 👥 **AI 团队多轮辩论** —— 多角色提案 / 反驳 / 决策，轻重模型分工节约 token
- ⏰ **定时对话任务** —— 到点自动执行预设提示词，结果归档为独立会话
- 🧠 **白板式逻辑链** —— 卡片 + 连线整理思路，Mermaid 渲染 flowchart / mindmap
- 💾 **长期记忆 & 知识库** —— 自动沉淀对话要点，跨会话召回
- 🗜️ **上下文智能压缩** —— 超阈值自动摘要，输出截断自动续写，四层超时防线防卡死
- 🏭 **提示词工厂** —— 宪法 + 上下文 + 约束一键整合为可交付 Prompt

---

## 🧩 功能全景

### 多模型对话

- 预设模型：GPT / Claude / Gemini、DeepSeek / Kimi / Qwen / GLM / Doubao / MiniMax / ERNIE 等
- 支持自定义模型（任意 OpenAI 兼容 API）与本地模型
- 侧边栏一键切换，API Key 本地加密存储
- 流式输出、代码块一键复制、智能滚动跟随、重新生成最后回复

### Harness 自主执行

- 开启后模型按"拆解 → 执行 → 验证 → 报告"自主推进
- 工具调用轮数提升至 10–50 轮，金色进度条实时显示
- 输出截断自动续写（最多 3 轮拼回原文），流式四层超时防线杜绝卡死

### MCP 工具 & Skill 系统

内置工具（`backend/skills/`）：

| 工具 | 说明 |
|------|------|
| `file_tree` / `file_peek` | 项目目录浏览 / 文件读取 |
| `file_create` / `file_edit` | 文件创建 / 差异预览式编辑 |
| `terminal` | 受限沙箱命令执行 |
| `html_render` / `css_color` | HTML 骨架生成 / CSS 调色 |
| `doc_write` / `text_summarize` | 文档编写 / 文本摘要 |
| `json_tool` / `regex_test` | JSON 处理 / 正则测试 |
| `repo_stats` / `todo_scan` | 仓库统计 / TODO 扫描 |

自定义 Skill：上传或导入 `SKILL.md` 即可扩展新能力；聊天输入框 `@` 提及 MCP 工具或 Skill，发送时自动注入对应上下文。

### 定时任务

- 支持单次 / 每日定点 / 固定间隔三种调度方式
- 后端 asyncio 调度器到点直调模型，结果归档到 `[定时]` 前缀会话
- 前端可视化管理：增删、启停、立即运行、执行状态回显

### AI 团队协作

- 多模型 / 多角色多轮辩论：提案 → 支持 / 反对 / 反驳 → 决策
- 轻量模型负责讨论、重型模型负责最终决策
- 自动生成讨论摘要（≤500 tokens），用户可介入投票

### 白板式逻辑链

- 灵感 / 功能 / 想法卡片化，拖拽布局、箭头连线标识依赖与数据流
- Mermaid.js 渲染 flowchart / mindmap

### 更多

- 📦 **多模态输入**：docx / csv / markdown / html / 图片等，后端解析零 token 浪费
- 💾 **长期记忆**：自动提炼对话要点，跨会话持久化
- 📚 **知识库**：本地知识片段检索与注入
- 🗜️ **上下文压缩**：token 超阈值自动摘要，支持手动压缩
- 🏭 **提示词工厂**：宪法摘要 → 上下文片段 → 任务描述 → 约束 → 交付要求
- 🎨 **双主题 UI**：亮 / 暗色一键切换

---

## 🚀 快速开始

### 方式一：Windows 安装包（推荐）

1. 前往 [Releases](https://github.com/CaryWang1234/SLATE/releases) 下载 `SLATE-Setup-x.x.x.exe`
2. 安装并启动，开箱即用
3. 在设置中配置所需模型的 API Key

### 方式二：从源码运行

**前置要求：** Python 3.13+

```bash
git clone https://github.com/CaryWang1234/SLATE.git
cd SLATE
pip install -r requirements.txt
```

**Windows：**

```bash
start.bat
```

**Linux / macOS：**

```bash
chmod +x start.sh
./start.sh
```

启动后访问 `http://127.0.0.1:8000`

### 自行打包桌面版

```bash
build_desktop.bat      # PyInstaller 打包为单文件桌面应用
build_installer.bat    # Inno Setup 编译 Windows 安装包（需预装 ISCC）
```

---

## 🛠️ 技术栈

| 层级 | 选型 |
|------|------|
| 前端 | 原生 HTML + CSS + JavaScript（ES Modules，零构建） |
| 后端 | Python 3.13+ · FastAPI · Uvicorn · httpx |
| 存储 | SQLite（对话历史）· JSON（状态 / 定时任务 / 宪法） |
| 渲染 | Highlight.js · Mermaid.js（CDN） |
| 桌面 | webview2 壳 + PyInstaller 打包 + Inno Setup 安装器 |

---

## 📁 目录结构

```
SLATE/
├── desktop.py                  # 桌面端入口（webview 壳，PyInstaller 打包目标）
├── start.bat / start.sh        # 源码一键启动（Windows / Unix）
├── build_desktop.bat           # PyInstaller 打包脚本
├── SLATE.spec                  # PyInstaller 配置
├── SLATE_InnoSetup.iss         # Inno Setup 安装包脚本
├── QODER.md                    # 项目开发规格书
├── backend/
│   ├── main.py                 # FastAPI 入口（静态服务 + 路由注册 + 调度器启动）
│   ├── routers/
│   │   ├── proxy.py            # LLM API 代理（多厂商流式转发 + 分段超时）
│   │   ├── chat.py             # 对话历史 / 上下文压缩
│   │   ├── scheduler.py        # 定时任务调度器
│   │   ├── knowledge.py        # 知识库检索
│   │   ├── projects.py         # 项目管理
│   │   ├── skills.py           # 技能调用
│   │   ├── settings.py         # 设置与跨设备同步
│   │   ├── constitution.py     # 项目宪法
│   │   └── files.py            # 多模态文件解析
│   └── skills/                 # 13 个内置 MCP 工具实现
├── frontend/
│   ├── index.html              # 三栏布局入口（对话 / 黑板 / 工厂+能力）
│   ├── css/style.css           # 全局样式（双主题）
│   └── js/
│       ├── app.js              # 主控初始化
│       ├── store.js            # 全局状态管理
│       ├── components/         # 聊天 / 白板 / 团队 / 技能 / 记忆 / 定时等
│       └── services/           # api / adapter / tools / markdown / project
├── installer/                  # 安装包产物
└── data/                       # 运行数据（SQLite / 宪法 / 定时任务 / 自定义 Skill）
```

---

## 🧭 设计原则

- **纯黑白灰基底**：无蓝紫渐变、无圆角大礼包、无阴影毛玻璃
- **原生技术**：零 npm / Node.js，零构建工具，前端即文件、改完即生效
- **本地优先**：所有数据存本地，API Key 仅用于 LLM 调用
- **Token 节约**：智能压缩、分级调用、静默处理
- **永不卡死**：idle 看门狗 + 零内容自动重试 + 请求超时 + UI 兜底四层防线

---

## 🤝 参与贡献

欢迎提交 Issue 与 Pull Request：

1. Fork 本仓库并创建特性分支：`git checkout -b feat/your-feature`
2. 提交前请保持现有代码风格（原生 JS、无新构建依赖）
3. 提交 PR 并描述改动动机与测试方式

---

## 📄 License

本项目基于 [MIT License](LICENSE) 开源。

---

<div align="center">

*SLATE（砚）—— 研磨灵感，落笔成章。*

</div>
