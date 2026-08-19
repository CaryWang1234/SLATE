# SLATE（砚）使用教程 · User Guide

> [中文](#中文) | [English](#english)

---

<a id="中文"></a>
## 📜 中文教程

### 目录

1. [SLATE 是什么？](#1-slate-是什么)
2. [安装与启动](#2-安装与启动)
3. [多模型对话](#3-多模型对话)
4. [Harness 自主执行](#4-harness-自主执行)
5. [磨墨模式](#5-磨墨模式)
6. [团队模式](#6-团队模式)
7. [白板逻辑链](#7-白板逻辑链)
8. [MCP 工具箱](#8-mcp-工具箱)
9. [专家包](#9-专家包)
10. [工作流模板](#10-工作流模板)
11. [知识库与灵光](#11-知识库与灵光)
12. [Code Review](#12-code-review)
13. [语音输入](#13-语音输入)
14. [截图转代码](#14-截图转代码)
15. [定时任务](#15-定时任务)
16. [设置与个性化](#16-设置与个性化)

---

### 1. SLATE 是什么？

SLATE（砚）是一款**本地优先**的 AI 协作调度台。它把主流大模型、30 个内置工具、团队辩论、DAG 工作流、白板式逻辑链整合在一个轻量界面里——零 npm、零构建、开箱即用。

核心理念：**让灵感直达行动，中间不隔工具摩擦。**

---

### 2. 安装与启动

#### 方式一：安装包（推荐）

前往 [GitHub Releases](https://github.com/CaryWang1234/SLATE/releases) 下载 `SLATE-Setup-x.x.x.exe`，双击安装即可。

#### 方式二：源码运行

```bash
git clone https://github.com/CaryWang1234/SLATE.git
cd SLATE
pip install -r requirements.txt
python desktop.py
```

源码启动后访问 `http://127.0.0.1:8000`。

#### 首次配置

1. 点击左下角 **设置** ⚙
2. 在「模型」栏添加你的 API Key（支持 OpenAI / Claude / Gemini / DeepSeek / 自定义端点）
3. 选择默认模型，即可开始对话

---

### 3. 多模型对话

SLATE 支持同时接入多个模型，在对话界面顶部下拉框随时切换。

**操作要点：**
- 点击模型下拉框 → 添加/切换模型
- 不同对话可使用不同模型
- 支持本地模型（Ollama / LM Studio 的 OpenAI 兼容端点）
- 每条回复显示模型名称与 Token 用量

**快捷键：**
- `Enter` 发送消息
- `Shift + Enter` 换行
- `Ctrl + N` 新建对话

---

### 4. Harness 自主执行

Harness 是 SLATE 的「自动驾驶」模式——你只需说清目标，模型自主规划、调用工具、多轮执行直至完成。

**启动方式：**
- 点击顶栏 🚀 按钮
- 或在消息中提及「用 Harness 执行」

**六阶段流程：**
1. **目标理解** → 解析你的需求
2. **计划制定** → 拆解为可执行步骤
3. **工具执行** → 自主调用文件/终端/搜索等工具
4. **验证检查** → 确认每步结果
5. **汇报总结** → 输出执行报告
6. **追溯归档** → 记录到 TODOLIST

**特性：**
- 最多 50 轮自主调用
- 中途可暂停（仅中断当轮，不丢失进度）
- 自动建立 TODOLIST 统筹大任务
- 异常自动恢复推进

---

### 5. 磨墨模式

把粗糙想法研磨成结构化任务书（墨稿）的交互式引导。

**启动方式：**
- 输入 `/grind 你的想法`
- 或点击 🖌 按钮
- **新增**：输入抽象任务（如"制作一个网站"）时自动建议切换

**三段式流程：**

| 阶段 | 说明 |
|------|------|
| 接墨 | AI 复述你的想法，列出 3-5 个待澄清缺口，只问第一个 |
| 磨墨 | 逐轮追问，一次一问，选择题优先（最多 10 轮） |
| 收墨 | 输出结构化 JSON 墨稿，含目标/交付物/验收标准 |

**收墨触发：** 输入「收墨」「够了」「就这样」或达到轮数上限

**墨稿三键：**
- 送入 Harness → 直接执行
- 投到白板 → 可视化推演
- 存为模板 → 复用

---

### 6. 团队模式

多个 AI 角色围绕你的问题进行多轮辩论，最终输出共识结论。

**启动方式：** 点击顶栏「团队」标签

**流程：**
1. 选择团队成员（预设 9 种角色组合，或自定义）
2. 输入问题
3. 各成员按角色依次发表观点（3 轮辩论）
4. 输出共识总结

**自定义团队：**
- 设置 → 团队管理 → 添加/编辑/删除成员
- 每个成员可指定模型、角色、人设

---

### 7. 白板逻辑链

可视化的卡片 + 连线系统，用于梳理思路、推演方案。

**操作：**
- 点击「黑板」标签进入
- AI 可自动创建卡片（分析结果、方案对比等）
- 手动拖拽卡片、建立连线
- 支持 4 种 AI 白板工具：
  - `card_create` 创建卡片
  - `card_edit` 编辑卡片
  - `arrow_create` 建立连线
  - `board_summarize` 总结全局

---

### 8. MCP 工具箱

SLATE 内置 30 个 MCP 工具，模型在对话中自主决定何时使用。

**使用方式：**
- 直接描述需求（如"帮我搜索 xxx"）
- 或 `@工具名` 显式调用

**工具分类：**

| 类别 | 工具 |
|------|------|
| 文件操作 | `file_tree` `file_peek` `file_create` `file_edit` `file_append` |
| 终端 | `terminal`（沙箱执行，高危命令需审批） |
| 文档生成 | `doc_write` `ppt_create` `word_create` `html_render` `html_bundle` |
| 数据处理 | `json_tool` `regex_test` `text_summarize` `chart_create` `qrcode_create` |
| 网络 | `web_search` `web_fetch` |
| 代码 | `code_scan` `repo_stats` `todo_scan` `python_api_extract` |
| 自动化 | `browser_automation` `computer_use` `screenshot_to_code` |
| 扩展 | `mcp_factory`（动态注册外部 MCP 工具） |
| 样式 | `css_color` |

---

### 9. 专家包

预制的角色知识包，让 AI 以特定专家身份回答。

**使用：**
- 对话界面左侧「专家」下拉框选择
- 内置样例：创意写作导师

**导入/导出：**
- 设置 → 专家包管理 → 导入 `.zip` / 导出为 `.zip`
- 专家包结构：`persona.md`（人设）+ `rules.md`（规则）+ `knowledge/`（知识）+ `skills/`（技能）

**创建自定义专家：**
1. 新建文件夹，按上述结构放入文件
2. 打包为 `.zip` 导入
3. 或直接通过 UI 创建

---

### 10. 工作流模板

预定义的 DAG 工作流，多节点并行执行复杂任务。

**内置 8 个模板：**

| 模板 | 用途 |
|------|------|
| 默认开发流程 | 通用开发任务 |
| 并行研究流程 | 多维度并行调研 |
| Bug 排查流程 | 日志/代码/环境并行分析 |
| 代码审查流程 | 质量/安全/性能并行审查 |
| 数据分析流程 | 趋势/异常/统计并行分析 |
| 文档生成流程 | 大纲→正文→摘要→整合 |
| 产品需求流程 | 想法→用户故事→功能→PRD |
| 研究报告流程 | 课题→调研→方案→报告 |

**管理：**
- 团队面板 → 工作流 → 导入/导出/删除自定义模板

---

### 11. 知识库与灵光

**知识库：** 长期存储项目知识，对话时自动注入相关上下文。

- 设置 → 记忆与画 → 知识库标签
- 手动添加笔记、项目背景、资料摘录
- 支持 Markdown 格式

**灵光（Spark）：** 对话结束时自动捕获有价值的技术洞察。

- 对话结束 → 系统检测是否有可归档的洞察
- 确认后自动存入知识库
- 无需手动操作

---

### 12. Code Review

对 Git 仓库的变更进行 AI 四维度结构化审查。

**使用：**
- 设置 → Code Review
- 选择仓库路径
- AI 读取 `git diff` → 分析代码质量/安全性/性能/可维护性
- 输出行级评论 + 汇总报告

---

### 13. 语音输入

浏览器端语音转文字，免打字输入。

**使用：**
- 点击输入框旁的 🎤 按钮
- 说出你的想法，实时转写到输入框
- 再次点击停止
- 支持中英文自动检测

**注意：** 需浏览器支持 Web Speech API（Chrome / Edge 已支持）

---

### 14. 截图转代码

将截图还原为 HTML/CSS 代码。

**使用：**
- 在对话中描述「把这个截图转成代码」
- 或 `@screenshot_to_code` 指定图片路径
- AI 视觉模型分析图片 → 生成对应 HTML/CSS

**支持格式：** PNG / JPG / JPEG / GIF / WebP / BMP / SVG（≤10MB）

---

### 15. 定时任务

让 AI 定时或按事件自动执行任务。

**使用：**
- 点击顶栏 ⏰ 按钮
- 新建任务 → 设置名称、触发条件（定时/事件）、执行内容
- 支持 Cron 表达式

**触发类型：**
- 定时：每隔 N 分钟/小时/天
- 事件：文件变更、对话结束等

---

### 16. 设置与个性化

**主要设置项：**

| 设置 | 说明 |
|------|------|
| 模型管理 | 添加/删除 API Key，配置自定义端点 |
| 输出控制 | 最大 Token 数、流式输出开关 |
| 安全模式 | 高危命令审批策略 |
| 主题 | 深色/浅色切换 |
| 语言 | 中文/English |
| 上下文压缩 | 自动/手动压缩历史对话 |
| 短回复审阅 | 模型回复后自动检查是否需要推进 |

---

<a id="english"></a>
## 📜 English Guide

### Table of Contents

1. [What is SLATE?](#1-what-is-slate)
2. [Installation & Quick Start](#2-installation--quick-start)
3. [Multi-Model Chat](#3-multi-model-chat)
4. [Harness Autonomous Execution](#4-harness-autonomous-execution)
5. [Grind Mode](#5-grind-mode)
6. [Team Mode](#6-team-mode)
7. [Whiteboard Logic Chain](#7-whiteboard-logic-chain)
8. [MCP Toolbox](#8-mcp-toolbox)
9. [Expert Packs](#9-expert-packs)
10. [Workflow Templates](#10-workflow-templates)
11. [Knowledge Base & Sparks](#11-knowledge-base--sparks)
12. [Code Review](#12-code-review)
13. [Voice Input](#13-voice-input)
14. [Screenshot to Code](#14-screenshot-to-code)
15. [Scheduled Tasks](#15-scheduled-tasks)
16. [Settings & Customization](#16-settings--customization)

---

### 1. What is SLATE?

SLATE is a **local-first** AI collaboration studio. It integrates mainstream LLMs, 30 built-in tools, team debates, DAG workflows, whiteboard logic chains — all in a lightweight interface. Zero npm, zero build, ready to use.

Core philosophy: **Let ideas go straight to action, without tool friction in between.**

---

### 2. Installation & Quick Start

#### Option A: Installer (Recommended)

Download `SLATE-Setup-x.x.x.exe` from [GitHub Releases](https://github.com/CaryWang1234/SLATE/releases) and run the installer.

#### Option B: From Source

```bash
git clone https://github.com/CaryWang1234/SLATE.git
cd SLATE
pip install -r requirements.txt
python desktop.py
```

After starting from source, visit `http://127.0.0.1:8000`.

#### First-Time Setup

1. Click **Settings** ⚙ (bottom-left)
2. Add your API Key in the Models section (OpenAI / Claude / Gemini / DeepSeek / custom endpoints)
3. Select a default model and start chatting

---

### 3. Multi-Model Chat

SLATE supports multiple models simultaneously — switch anytime from the top dropdown.

**Key Points:**
- Click the model dropdown → Add/switch models
- Different conversations can use different models
- Supports local models (Ollama / LM Studio via OpenAI-compatible endpoints)
- Each reply shows model name and token usage

**Shortcuts:**
- `Enter` to send
- `Shift + Enter` for newline
- `Ctrl + N` for new conversation

---

### 4. Harness Autonomous Execution

Harness is SLATE's "autopilot" — state your goal, and the model autonomously plans, calls tools, and executes in multiple rounds until done.

**Launch:**
- Click 🚀 button in the top bar
- Or mention "use Harness" in your message

**Six-Phase Flow:**
1. **Goal Understanding** → Parse your requirements
2. **Plan Creation** → Break into executable steps
3. **Tool Execution** → Autonomously call files/terminal/search tools
4. **Verification** → Confirm each step's result
5. **Report** → Output execution summary
6. **Trace** → Log to TODOLIST

**Features:**
- Up to 50 autonomous rounds
- Pause anytime (only interrupts current round, no progress loss)
- Auto-creates TODOLIST for large tasks
- Auto-recovery from exceptions

---

### 5. Grind Mode

Interactive refinement: turn rough ideas into structured task briefs.

**Launch:**
- Type `/grind your idea`
- Or click 🖌 button
- **New:** Auto-suggests when detecting abstract tasks (e.g., "make a website")

**Three-Phase Flow:**

| Phase | Description |
|-------|-------------|
| Receive | AI restates your idea, lists 3-5 gaps, asks only the first |
| Grind | Round-by-round questions, one at a time, prefers A/B choices (up to 10 rounds) |
| Collect | Outputs structured JSON brief with goals/deliverables/acceptance criteria |

**Trigger Collect:** Type "收墨" / "够了" / "就这样" or reach round limit

**Three Actions on Draft:**
- Send to Harness → Execute directly
- Push to Whiteboard → Visual reasoning
- Save as Template → Reuse later

---

### 6. Team Mode

Multiple AI roles debate your question across rounds, producing a consensus conclusion.

**Launch:** Click "Team" tab in the top bar

**Flow:**
1. Select team members (9 presets or custom)
2. Enter your question
3. Members speak in role order (3 debate rounds)
4. Consensus summary output

**Custom Teams:**
- Settings → Team Management → Add/Edit/Delete members
- Each member can specify model, role, and persona

---

### 7. Whiteboard Logic Chain

Visual cards + connections system for reasoning and planning.

**Operations:**
- Click "Whiteboard" tab to enter
- AI auto-creates cards (analysis results, comparisons)
- Drag cards, create connections manually
- 4 AI whiteboard tools:
  - `card_create` — Create cards
  - `card_edit` — Edit cards
  - `arrow_create` — Create connections
  - `board_summarize` — Summarize the board

---

### 8. MCP Toolbox

SLATE includes 30 built-in MCP tools. The model decides when to use them during conversations.

**Usage:**
- Describe your need naturally (e.g., "search for xxx")
- Or explicitly call `@tool_name`

**Tool Categories:**

| Category | Tools |
|----------|-------|
| File Ops | `file_tree` `file_peek` `file_create` `file_edit` `file_append` |
| Terminal | `terminal` (sandbox execution, high-risk commands need approval) |
| Doc Gen | `doc_write` `ppt_create` `word_create` `html_render` `html_bundle` |
| Data | `json_tool` `regex_test` `text_summarize` `chart_create` `qrcode_create` |
| Web | `web_search` `web_fetch` |
| Code | `code_scan` `repo_stats` `todo_scan` `python_api_extract` |
| Automation | `browser_automation` `computer_use` `screenshot_to_code` |
| Extension | `mcp_factory` (dynamically register external MCP tools) |
| Style | `css_color` |

---

### 9. Expert Packs

Pre-built role knowledge packages that let AI answer as a specific expert.

**Usage:**
- Select from the "Expert" dropdown on the left side of chat
- Built-in sample: Creative Writing Mentor

**Import/Export:**
- Settings → Expert Pack Management → Import `.zip` / Export as `.zip`
- Pack structure: `persona.md` + `rules.md` + `knowledge/` + `skills/`

**Create Custom Expert:**
1. Create a folder with the above structure
2. Zip and import
3. Or create directly via UI

---

### 10. Workflow Templates

Pre-defined DAG workflows for complex multi-node parallel execution.

**8 Built-in Templates:**

| Template | Purpose |
|----------|---------|
| Default Dev Flow | General development tasks |
| Parallel Research | Multi-dimensional parallel research |
| Bug Investigation | Parallel log/code/env analysis |
| Code Review | Parallel quality/security/performance review |
| Data Analysis | Parallel trend/anomaly/stats analysis |
| Doc Generation | Outline → Content → Summary → Integration |
| Product Requirements | Idea → User stories → Features → PRD |
| Research Report | Topic → Research → Comparison → Report |

**Management:**
- Team Panel → Workflows → Import/Export/Delete custom templates

---

### 11. Knowledge Base & Sparks

**Knowledge Base:** Long-term project knowledge storage, auto-injected into conversations.

- Settings → Memory & Canvas → Knowledge tab
- Manually add notes, project background, reference material
- Supports Markdown

**Sparks:** Auto-captures valuable technical insights when conversations end.

- After conversation → System detects archivable insights
- Confirms and stores to knowledge base
- No manual operation needed

---

### 12. Code Review

AI-powered four-dimensional structured review of Git repository changes.

**Usage:**
- Settings → Code Review
- Select repository path
- AI reads `git diff` → Analyzes quality/security/performance/maintainability
- Outputs line-level comments + summary report

---

### 13. Voice Input

Browser-based speech-to-text for hands-free input.

**Usage:**
- Click 🎤 button next to the input box
- Speak your idea, real-time transcription appears in input
- Click again to stop
- Auto-detects Chinese and English

**Note:** Requires Web Speech API support (Chrome / Edge supported)

---

### 14. Screenshot to Code

Convert screenshots to HTML/CSS code.

**Usage:**
- Describe "convert this screenshot to code" in chat
- Or `@screenshot_to_code` with image path
- AI vision model analyzes image → Generates corresponding HTML/CSS

**Supported formats:** PNG / JPG / JPEG / GIF / WebP / BMP / SVG (≤10MB)

---

### 15. Scheduled Tasks

Let AI automatically execute tasks on schedule or by events.

**Usage:**
- Click ⏰ button in top bar
- New Task → Set name, trigger (schedule/event), execution content
- Supports Cron expressions

**Trigger Types:**
- Schedule: Every N minutes/hours/days
- Event: File changes, conversation end, etc.

---

### 16. Settings & Customization

**Main Settings:**

| Setting | Description |
|---------|-------------|
| Model Management | Add/remove API keys, configure custom endpoints |
| Output Control | Max tokens, streaming toggle |
| Safety Mode | High-risk command approval policy |
| Theme | Dark/Light toggle |
| Language | Chinese / English |
| Context Compression | Auto/manual compression of history |
| Short Reply Review | Auto-check if model reply needs follow-up |

---

<p align="center">
  <strong>SLATE（砚）</strong>—— 将灵感转化为结构化方案<br>
  <strong>SLATE</strong> — Turn inspiration into structured action
</p>
