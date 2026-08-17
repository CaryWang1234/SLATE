<div align="center">

<img src="frontend/icon.png" width="96" alt="SLATE" />

# SLATE（砚）

**本地 AI 协作调度台 · 将灵感转化为结构化方案**

*Local AI collaboration studio — turn sparks of ideas into structured plans.*

[![License: MIT](https://img.shields.io/badge/License-MIT-1a1a1a.svg)](LICENSE)
[![Website](https://img.shields.io/badge/Website-carywang1234.github.io%2FSLATE-1a1a1a.svg)](https://carywang1234.github.io/SLATE/docs/zh/index.html)
[![Guide](https://img.shields.io/badge/%E6%95%99%E7%A8%8B-%E4%BD%BF%E7%94%A8%E6%8C%87%E5%8D%97-d4a24e.svg)](https://carywang1234.github.io/SLATE/docs/guide.html)
[![Python](https://img.shields.io/badge/Python-3.13%2B-1a1a1a.svg)](https://www.python.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows-1a1a1a.svg)]()
[![Build](https://img.shields.io/badge/Build-Zero%20npm%20%2F%20Zero%20Bundler-1a1a1a.svg)]()

**中文** · [English](README.md)

</div>

---

SLATE 是一个**轻量级本地 AI 协作工具**，专注于提示词工程、上下文管理与项目灵感整理。

它内置多模型对话、工具调用、Harness 自主执行、磨墨模式、AI 团队辩论与白板式逻辑链，既能直接驱动内置工具完成任务，也能生成高质量 Prompt 交给外部 Coding Agent（Claude Code、Codex、Cursor 等）执行。

**零 npm 依赖，零构建工具，原生技术栈，本地优先。**

---

## ✨ 亮点一览

- 🗣️ **多模型统一接入** —— 国内外主流 LLM + 自定义 OpenAI 兼容端点 + 本地模型（Ollama / LM Studio）
- ⚡ **Harness 自主执行** —— 六阶段闭环自主推进，默认 50 轮不断线，大任务自动建 TODOLIST 统筹批量销账；停止不退出，仅手动停止 / 轮数用完 / 清单了结才结束
- 🖌️ **磨墨模式** —— `/grind` 一句粗糙想法，AI 三段式追问研磨成结构化任务书，一键送入 Harness
- 🗂️ **对话与数据管理** —— 历史全文搜索、会话导出 / 改名 / 批量管理、消息编辑删除，一键备份恢复全部数据，存储用量可视可清理
- 🛠️ **26 个内置工具** —— 文件读写编辑追加、终端沙箱、PPT / Word 文档生成、SVG 图表与二维码、Python API 文档提取、便携网页打包、联网搜索与网页抓取、工具工厂自生产工具、截图转代码、浏览器与桌面自动化等
- 🔌 **外部 MCP Server** —— 连接外部 MCP Server（SSE 传输协议）扩展工具能力，远程工具与内置工具统一展示，AI 模型可无缝调用
- 🧩 **自定义 Skill 系统** —— `SKILL.md` 即插即用，聊天中 `@` 提及即注入上下文
- 🎓 **专家包（Expert Pack）** —— 人格 + 规则 + 知识 + 技能五件套，zip 导入导出，对话 / 团队 / @提及三路注入
- 📖 **Better Project Understanding** —— 简略 / 平衡 / 详细三档扫描项目，自动生成导览·百科与规则手册
- 🔍 **Code Review** —— 读取 git diff（未暂存 / 已暂存 / 提交范围），AI 从代码质量、安全性、性能、可维护性四维度输出结构化审查报告，支持行级评论
- 🔔 **任务完成通知** —— Harness / 团队 / 工作流大任务结束时播放提示音 + 发送系统通知，两个开关均可在设置中独立切换
- 📡 **局域网遥控** —— 应用启动即在 8001 端口开放局域网访问，手机 / 平板浏览器扫码即用同一界面；设置页与顶栏 📡 按钮醒目展示访问网址与二维码
- 🛡️ **高危命令审批** —— 写死规则前后端双层拦截，批准前由模型解释命令目的，灾难级命令无条件禁止
- 👥 **AI 团队多轮辩论** —— 多角色提案 / 反驳 / 决策，轻重模型分工节约 token，另有 DAG 工作流流水线，**8 种内置工作流模板**（标准开发、代码审查、文档生成、数据分析、研究报告、产品需求、Bug 排查、并行研究）；辩论中途可一键停止，已完成发言保留；**9 种内置团队预设**（代码审查、产品头脑风暴、红蓝对抗等）+ 自定义配置；工作流支持导入/导出/删除
- ⏰ **定时对话任务** —— 到点自动执行预设提示词，结果归档为独立会话
- 🧠 **白板式逻辑链** —— 卡片 + 连线整理思路，Mermaid 渲染 flowchart / mindmap；工具执行自动记录为带状态颜色的步骤卡片，箭头串联形成逻辑链
- 💾 **长期记忆 & 知识库** —— 自动沉淀对话要点，跨会话召回；支持 AI 驱动的记忆**覆盖**（修正过时信息）与**删除**（清理废弃记忆）；**✨ 灵光** —— 对话结束时自动捕获技术洞察，归档为知识文档供后续 RAG 注入
- 🗜️ **上下文智能压缩** —— 超阈值自动摘要，输出截断四层防线自动续写补全，四层超时防线防卡死
- 🏭 **提示词工厂** —— 宪法 + 上下文 + 约束一键整合为可交付 Prompt
- 🎤 **语音输入** —— 点击麦克风按钮即可口述消息，基于 Web Speech API，自动识别中英文，实时转写预览
- 📚 **Markdown 文库** —— 集成于记忆弹窗的 Obsidian 风格知识库：文件夹 + 笔记管理、Markdown 实时编辑与预览、`[[wiki-link]]` 双向链接、全文搜索 + 标签系统
- 🌍 **多语言界面** —— 安装时选择简体中文或 English，界面与提示文字全程本地化

---

## 🧩 功能全景

### 多模型对话

- 预设模型：GPT / Claude / Gemini、DeepSeek / Kimi / Qwen / GLM / Doubao / MiniMax / ERNIE 等
- 支持自定义模型（任意 OpenAI 兼容 API）与本地模型
- 侧边栏一键切换，API Key 本地加密存储
- 流式输出、代码块一键复制、智能滚动跟随、重新生成最后回复

### Harness 自主执行

- 开启后模型按"目标 → 计划 → 执行 → 验证 → 汇报 → 追溯"六阶段闭环自主推进
- 大任务自动建立 TODOLIST（消息区右侧栏实时展示），统筹全局批量推进，每完成一项或一批立即同步进度，未全部了结不得宣称完成
- 工具调用轮数默认 50 轮；仅三种情况退出——手动停止 / 轮数用完 / 清单全部了结，模型侧失败、零输出、重复调用均自动恢复推进不中断
- 每轮工具结果标注当前轮次（第 x/N 轮），模型感知剩余轮数预算自主把握节奏；停止仅中断当轮，Harness 保持开启待命
- 输出截断四层防线：6 轮断点锚点续写 + 截断守卫 + `file_append` 分段补齐 + 提示词预防，超长文件一定写完整

### 磨墨模式

- 输入 `/grind 想法` 或点击侧边栏 🖌 按钮，把粗糙想法研磨成结构化任务书（墨稿）
- AI 按「接墨 → 磨墨 → 收墨」三段式追问（上限 10 轮），侧边栏墨迹面板实时标记 ✔ 已定 / ✘ 未知与完成进度
- 墨稿含目标 / 受众 / 交付物 / 验收标准 / 边界 / 建议路径 / 遗留问题，附三键：送入 Harness 执行 / 投到白板推演 / 存为模板复用
- 磨墨会话按会话持久化，刷新与切换会话自动恢复

### 工具 & Skill 系统

内置工具（`backend/skills/`）：

| 工具 | 说明 |
|------|------|
| `file_tree` / `file_peek` | 项目目录浏览 / 文件读取 |
| `file_create` / `file_edit` | 文件创建 / 差异预览式编辑 |
| `terminal` | 受限沙箱命令执行 |
| `html_render` / `css_color` | HTML 骨架生成 / CSS 调色 |
| `doc_write` / `text_summarize` | Markdown 文档编写 / 文本摘要 |
| `ppt_create` / `word_create` | .pptx 演示文稿 / .docx Word 文档生成 |
| `json_tool` / `regex_test` | JSON 处理 / 正则测试 |
| `repo_stats` / `todo_scan` | 仓库统计 / TODO 扫描 |
| `web_search` / `web_fetch` | 联网搜索（免 Key）/ 网页内容获取 |
| `chart_create` / `qrcode_create` | SVG 图表生成（柱状/条形/折线/饼图）/ 二维码生成，产出内联预览 |
| `python_api_extract` / `html_bundle` | Python 库公共 API 文档提取（JSON/Markdown）/ 网页 css/js 内联单文件打包 |
| `code_scan` / `mcp_factory` | 代码安全扫描 / 工具自生产（让 SLATE 自生产适配自身的工具） |
| `browser_automation` / `computer_use` | 浏览器自动化（Playwright 控制 Chromium）/ 桌面自动化（鼠标键盘控制） |
| `screenshot_to_code` | 截图转代码——AI 视觉分析截图内容，生成 HTML/CSS 还原视觉效果 |

自定义 Skill：上传或导入 `SKILL.md` 即可扩展新能力；聊天输入框 `@` 提及工具、Skill 或专家包，发送时自动注入对应上下文。

外部 MCP Server：设置页 → MCP Server 区块添加外部 MCP Server（SSE 传输协议），自动发现远程工具并与内置工具统一展示，AI 模型可通过 `skill_run` 调用。

### 专家包（Expert Pack）

- 五件套结构：`persona.md`（人格）+ `rules.md`（规则）+ `knowledge/`（知识文件）+ `skills/`（技能文档）+ `data.json`
- zip 导入导出，可分享、可分发；内置样例包「创意写作导师」
- 三路注入：对话输入区下拉（全程生效）、团队成员卡（按角色配置）、聊天 `@` 提及（单条消息注入人格 + 规则 + 知识文件内容）

### Better Project Understanding

- 三档扫描预算：简略 / 平衡 / 详细，按优先级精读 README、依赖清单与核心文件
- 自动生成两份文档：导览·百科（项目全貌与模块解读）、规则手册（有证据的开发规则）
- 结果持久化到项目 `.slate/config.json`，重开即查

### Code Review

- 支持三种 diff 模式：未暂存变更、已暂存变更、提交范围（from..to）
- AI 从四个维度审查：代码质量、安全性、性能、可维护性
- 结构化报告包含总体评价、各维度分析、行级评论
- 行级评论带严重程度标签（严重 / 重要 / 建议 / 信息），可点击文件:行号定位
- 三种结果视图：完整报告（Markdown）、行级评论列表、四维度卡片

### 定时 / 事件任务

- 支持单次 / 每日定点 / 固定间隔三种调度方式
- **事件驱动触发**：文件变更监听 / Git push 检测 / Webhook 接收——事件发生时自动执行任务
- 后端 asyncio 调度器到点直调模型，结果归档到 `[定时]` 或 `[事件]` 前缀会话
- 前端可视化管理：增删、启停、立即运行、执行状态回显

### 对话与数据管理

- 历史侧栏全文内容搜索，命中即显上下文摘录，点击直达对应会话
- 会话重命名、导出为 Markdown、批量管理删除；消息支持单条编辑 / 删除
- 一键备份：全部数据（对话 / 记忆 / 素材 / 设置）导出为 JSON，导入即恢复
- 存储空间管理：用量分项明细、数据库压缩、清空对话、WebView 缓存清理
- 首次启动新手引导，快速认识三栏工作台
- 启动自动检查更新，发现 GitHub Releases 新版本即提示升级

### AI 团队协作

- 多模型 / 多角色多轮辩论：提案 → 支持 / 反对 / 反驳 → 决策
- 轻量模型负责讨论、重型模型负责最终决策
- 自动生成讨论摘要（≤500 tokens），用户可介入投票
- **中断机制**：辩论中途可一键停止，已完成发言保留，不丢失已有成果
- **黑板集成**：辩论步骤自动记录到黑板，形成可视化逻辑链（动作类型 + 发言摘要）
- **团队工作流 DAG**：需求 → 拆解 → 编码 → 审查 → 总结流水线自动推进，上下游产出逐层传递，节点状态实时可见，产物自动归档知识库；**并行执行**无依赖节点同时运行，**停止按钮**中途可中断

### 白板式逻辑链

- 灵感 / 功能 / 想法卡片化，拖拽布局、箭头连线标识依赖与数据流
- Mermaid.js 渲染 flowchart / mindmap
- **自动记录**：工具执行自动创建步骤卡片，带工具图标、描述、状态颜色（黄色=执行中、绿色=完成、红色=错误）
- **思考过程显示**：模型推理/思考过程实时显示在可折叠面板中，思考完成后自动折叠

### 更多

- 📦 **多模态输入**：docx / csv / markdown / html / 图片等，后端解析零 token 浪费
- 💾 **长期记忆**：自动提炼对话要点，跨会话持久化
- 📚 **知识库**：本地知识片段检索与注入
- 🛡️ **终端安全**：高危命令写死规则判定，前端审批弹窗 + 后端独立拦截双层防御，灾难级命令（`rm -rf /`、`format` 等）无条件禁止
- 🔒 **全面沙箱防护**：路径穿越拦截（敏感系统目录黑名单）、凭据文件访问禁止、输出截断（5 万字符）、文件大小限制（5MB）、请求体上限（20MB）、上传文件名消毒、ReDoS 超时保护、环境变量清理 —— 全部对用户透明，零摩擦
- 🗜️ **上下文压缩**：token 超阈值自动摘要，支持手动压缩
- 🏭 **提示词工厂**：宪法摘要 → 上下文片段 → 任务描述 → 约束 → 交付要求
- 🎨 **双主题 UI**：亮 / 暗色一键切换

---

## 🚀 快速开始

### 方式一：Windows 安装包（推荐）

1. 前往 [Releases](https://github.com/CaryWang1234/SLATE/releases) 下载 `SLATE-Setup-x.x.x.exe`
2. 安装时选择界面语言（简体中文 / English），安装完成后开箱即用
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
├── README.md / README-zh.md    # 项目说明（English / 中文）
├── GUIDE.md                    # 双语使用教程（源文件）
├── QODER.md                    # 项目开发规格书
├── backend/
│   ├── main.py                 # FastAPI 入口（静态服务 + 路由注册 + 调度器启动）
│   ├── routers/
│   │   ├── proxy.py            # LLM API 代理（多厂商流式转发 + 分段超时）
│   │   ├── chat.py             # 对话历史 / 上下文压缩
│   │   ├── scheduler.py        # 定时任务调度器
│   │   ├── knowledge.py        # 知识库检索
│   │   ├── projects.py         # 项目管理 / Better Project Understanding 扫描 / Code Review
│   │   ├── experts.py          # 专家包增删改查 / zip 导入导出
│   │   ├── skills.py           # 技能调用
│   │   ├── mcp.py              # 标准 MCP 协议端点（JSON-RPC 2.0）
│   │   ├── mcp_servers.py      # 外部 MCP Server 管理（增删查 + 代理调用）
│   │   ├── settings.py         # 设置 / 跨设备同步 / 存储空间管理
│   │   ├── constitution.py     # 项目宪法
│   │   ├── grind.py            # 磨墨模式会话状态机
│   │   ├── i18n.py             # 界面语言配置（安装时选择，运行时只读）
│   │   ├── update.py           # 启动更新检查（GitHub Releases）
│   │   ├── workflows.py        # 团队工作流 DAG 定义
│   │   ├── vault.py            # Markdown 文库（Obsidian 风格知识库）
│   │   └── files.py            # 多模态文件解析
│   └── skills/                 # 26 个内置工具实现（含高危命令双层拦截）
├── backend/mcp_client.py       # MCP 客户端管理器（SSE 传输协议）
├── frontend/
│   ├── index.html              # 三栏布局入口（对话 / 黑板 / 工厂+能力）
│   ├── css/style.css           # 全局样式（双主题）
│   └── js/
│       ├── app.js              # 主控初始化
│       ├── store.js            # 全局状态管理
│       ├── components/         # 聊天 / 白板 / 团队 / 技能 / 记忆 / 定时等
│       └── services/           # api / adapter / tools / markdown / i18n / grind
├── docs/                       # 官网 Landing Page（GitHub Pages）
│   ├── index.html              # 英文版
│   ├── zh/index.html           # 中文版
│   └── guide.html              # 双语文档（卷轴式教程）
├── installer/                  # 安装包产物
└── data/                       # 运行数据（SQLite / 宪法 / 定时任务 / 自定义 Skill / 专家包 / 磨墨会话）
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
