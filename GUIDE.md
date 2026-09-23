# SLATE（砚）使用教程 · User Guide

> [中文](#中文) | [English](#english)

---

<a id="中文"></a>
## 📜 中文教程

### 目录

1. [SLATE 是什么？](#1-slate-是什么)
2. [安装与启动](#2-安装与启动)
3. [多模型对话](#3-多模型对话)
4. [Agent Autopilot](#4-agent-autopilot)
5. [Harness 自主执行](#5-harness-自主执行)
6. [磨墨模式](#6-磨墨模式)
7. [团队模式](#7-团队模式)
8. [白板逻辑链](#8-白板逻辑链)
9. [MCP 工具箱](#9-mcp-工具箱)
10. [专家包](#10-专家包)
11. [工作流模板](#11-工作流模板)
12. [知识库与灵光](#12-知识库与灵光)
13. [Code Review](#13-code-review)
14. [语音输入](#14-语音输入)
15. [截图转代码](#15-截图转代码)
16. [定时任务](#16-定时任务)
17. [设置与个性化](#17-设置与个性化)

---

### 1. SLATE 是什么？

SLATE（砚）是一款**本地优先**的 AI 协作调度台。它把主流大模型、34 个内置工具、团队辩论、DAG 工作流、白板式逻辑链整合在一个轻量界面里——零 npm、零构建、开箱即用。

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

1. 点击顶栏的 **设置** 页签
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

**左侧「任务」列表：**
- 排序可切换：最近更新 / 按项目 / 按状态 / 创建时间 / 按用量；偏好跨设备同步，经典布局与 Codex 历史栏共用同一份
- 每条会话按当下处境给出独立标志：**需要操作**（上一场被停止或还有下一步）、**出错**、**进行中**（呼吸动画，只在这一场真的在生成时出现）、**已完成未查看**（点进会话即清除）
- 标志记的是"上一场怎么结束的"：若在别处（如手机遥控）继续过这条会话，旧标志自动作废

**消息区右侧「任务清单」栏：**
- 大任务跑起来时逐条展示进度；点顶栏「任务清单」按钮（Codex 布局在输入框上方那行）即可整栏收起，把宽度还给消息区，再点一下展开
- 收起是记在你这台机器上的偏好：刷新、重启都保持折叠，清单继续往下跑也不会擅自把栏撑回来
- 折叠期间按钮悬停会报 `{done}/{total}`，进度不至于彻底隐身；这场没有清单时按钮置灰

**快捷键：**
- `Enter` 发送消息
- `Shift + Enter` 换行
- `Ctrl + N` 新建对话

---

### 4. Agent Autopilot

Autopilot 是默认的“少打继续”执行层。只要你的消息明显是在要求 SLATE 查看项目、修改文件、运行命令、排查 bug、提交代码或生成文件，它会自动进入多轮 Agent Loop。

**你怎么用：**
- 直接说“修复 xxx”“排查项目 bug”“优化工具调用”“跑一下测试并修掉报错”
- 不需要手动开启 Harness，也不需要反复发送“继续”
- 普通任务最多自动推进 24 轮；全面扫描、项目级、多文件任务最多 40 轮
- 轮数是止损线不是预算：交付并逐项验证通过后，模型调用 `exit_autopilot` 收口，循环随即结束
- 轮数用完不等于干完：默认开启的 **Continue Autopilot** 在末轮不松手。上一轮还在执行工具时，把上限往后推 8 轮（最多推 3 次），让它把手上的活做完；上一轮空手停笔时，把清单剩余项念回给它，催它继续推进或明确写【任务完成】。不想要这个行为，去「设置 → 自动推进」取消勾选

**它会自动做：**
1. 读取相关目录、文件、配置或 Git 状态
2. 调用 `file_edit` / `terminal` / `git_tool` / `code_scan` 等工具推进
3. 把工具结果隐藏回灌给模型，让它继续下一步
4. 修改后重新读取、运行检查、测试或构建
5. 没有工具记录却口头说“完成”时，系统会要求它先验证
6. 跑到轮数上限而任务还没干完时，按 Continue Autopilot 追加轮数并接着推进（可在「设置 → 自动推进」关掉）

**砚流 · 落笔即所见：** 模型正在逐个 token 写工具参数时，SLATE 会按本地工具 schema 解析这份还没写完的参数，实时演成一行预览——哪些字段已经闭合、哪个字段正在写。它只做预览，**半成品参数永不触发执行**；几十 KB 的正文类字段一律折叠成行数与字数，不刷屏。

**停止是真取消：** 点击停止会同时关闭模型流与工具调用的流式通道，后端随即终止对应的子进程与在跑任务，不再是“界面停了、活还在干”。被取消的调用会以独立状态记进本地事件账，与正常完成区分开。

**什么时候还用 Harness：** 需要更强约束、明确 TODOLIST、长任务 80 轮闭环时，点击输入框左侧 **＋** 菜单里的「目标模式」开关；验证全部通过后模型调用 `exit_target_mode` 收口，目标模式开关随之关闭。

---

### 5. Harness 自主执行

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
- 最多 80 轮自主调用，验证通过后由模型调 `exit_target_mode` 显式收口
- 中途可暂停（仅中断当轮，不丢失进度）
- 自动建立 TODOLIST 统筹大任务（消息区右栏实时展示；顶栏「任务清单」按钮可随时折叠/展开，折叠后按钮上仍报 `{done}/{total}` 进度）
- 异常自动恢复推进

---

### 6. 磨墨模式

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

### 7. 团队模式

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

**讨论记录：** 每次发言除了写进本机历史，还会落进后端（团队会话 + 名册 + 每人一次事件账本 run），
黑板 · 工作流视图的星图读的就是这份；落库失败时历史仍在，列表里标「仅本机记录」。

---

### 8. 白板逻辑链

可视化的卡片 + 连线系统，用于梳理思路、推演方案。

**操作：**
- 点击「黑板」标签进入
- AI 可自动创建卡片（分析结果、方案对比等）
- 手动拖拽卡片、建立连线
- 顶栏可切换 Git / 流程 / 看板 / 纲要等显示模式；主黑板就是默认自由画布
- Git 树会识别当前项目的 Git 要素：HEAD、branch、remote branch、commit、tag、remote、worktree、stash、暂存 / 修改 / 未跟踪、未推送提交；节点和视野都可拖动
- 支持 4 种 AI 白板工具：
  - `card_create` 创建卡片
  - `card_edit` 编辑卡片
  - `arrow_create` 建立连线
  - `board_summarize` 总结全局

**第 5 档「工作流」：把"怎么跑"和"跑得怎么样"放进同一屏**
- 控制条：停止 / 继续跑完 / 自动推进（目标模式）/ 回复方式 / 思考强度。
  这些控件不另存一份状态，写的就是聊天框顶部那套共用的状态，两处永远一致
- 流程卡片墙：`data/actions/*.yml` 里每份流程说明书一张卡，卡面写清共几步、几项输入、
  谁写的、产出落到哪；「跑这条」以 @提及 发进当前对话，「看步骤」就地展开步骤清单（懒加载）
- 置顶与「只看置顶」存在本机 `slate_board_wf_prefs`，只影响这一屏的排布
- 当前运行：直接从事件账本投影——哪一步在跑、跑了多久、成没成；
  活数据只改自己那截 DOM 的文本，运行中每秒一跳不会把整块看板抖散
- 团队星图：按角色摆出这场对话最近一次团队讨论，谁回应了谁、谁动过哪些工具、
  谁派生了子代理，全部取自后端真实记录；没有团队记录时这里会直说，不画装饰性的图

---

### 9. MCP 工具箱

SLATE 内置 34 个 MCP 工具，模型在对话中自主决定何时使用。

**使用方式：**
- 直接描述需求（如"帮我搜索 xxx"）
- 或 `@工具名` 显式调用

**工具分类：**

| 类别 | 工具 |
|------|------|
| 文件操作 | `file_tree` `file_peek` `file_create` `file_edit` `file_append` |
| 终端 | `terminal`（沙箱执行，高危命令需审批） |
| 检索与代码 | `code_search` `code_scan` `doc_scan` `repo_stats` `todo_scan` `python_api_extract` |
| 文档生成 | `doc_write` `ppt_create` `word_create` `html_render` `html_bundle` |
| 办公与 PDF | `excel_tool` `pdf_tool` |
| 数据处理 | `json_tool` `regex_test` `text_summarize` `chart_create` `qrcode_create` |
| 网络 | `web_search` `web_fetch` |
| 系统与环境 | `system_info` `git_tool` `css_color` |
| 自动化 | `browser_automation` `computer_use` `screenshot_to_code` |
| AI 生成 | `image_gen` `video_gen`（需在设置中配置模型与 API Key） |
| 扩展 | `mcp_factory`（动态注册外部 MCP 工具） |

**特殊字符与编码：**
- `file_peek` / `file_edit` 自动识别 UTF-8、UTF-8 BOM、GB18030、GBK、UTF-16 等常见文本编码
- 中文、emoji、全角符号会原样保留；如果旧编码无法表达新字符，工具会安全升级写入编码而不是丢字符
- Windows 下 `terminal` 会隐藏 PowerShell 子窗口，并对 Python / Node / Git / npm / rg 等原生命令做 Unicode-safe 输出捕获
- Windows 下 `terminal` 一条命令一个 PowerShell 进程：多行块（`foreach` / `if`）直接执行，`&&` / `||` 在 PowerShell 5.1 上自动翻成 `if ($?)` 嵌套，语法错误带非零退出码原样返回；会话保持 `cd` 与 `$env:`（PowerShell 变量不跨命令），裸 `python` / `node` 这类交互式 REPL 拿不到输入会立刻退出

**Actions 流程说明书：**

上面的工具是「手」，Action 是「步骤约定」——把某件重复任务的必要流程写成一份 yml，模型按它推进，而不是每次重新猜。

- 位置：`data/actions/<id>.yml`，一个文件一份流程，文件名（去掉 `.yml`）就是它的 id
- 字段：`name`、`description`、`when`（什么时候该套用）、`inputs`（要问用户拿什么）、`steps`（每步 `title` + 可选 `tool` / `detail` / `check`）、`output`、`tags`
- 智能体态下模型自动看到 Action 目录（最多 20 条，超出只报数量并指向 `actions_list`），确认要用时调 `actions_read` 读完整流程，再按步骤实际执行；对话态没有工具，整段目录都不注入
- 读到流程不等于做过流程：步骤里标了建议工具的，仍要真调工具完成，模型不会因为「读过 yml」就声称已经执行
- 写坏的 yml 不会凭空消失：设置 →「工具 / 技能」里会连同「第 N 行：原因」一起列出，工具返回里也会告诉模型哪些暂时不可用
- 格式用的是极简 YAML 子集（2 空格缩进、块数组、`|` 字面量块），Tab 缩进、锚点、多文档等一律拒收；单文件上限 64 KB
- 面板可编辑：设置 →「工具 / 技能」→ Actions，点「＋ 新建 Action」或点已有条目进编辑器；边写边校验，报错按「第 N 行：原因」显示，校验没过就保存不了
- 每次覆盖或删除都会先把原文留底到 `data/actions/.history/`（每份最多 5 版），编辑器里的「历史版本」可查看任意一版或直接回滚
- 模型也能写：`actions_write` 工具要求它先在 yml 里声明 `author: model`（面板据此打上「模型代写」徽标），且「询问」权限模式下会弹窗给你审批；切到「自动 / 越权」则不弹窗——写坏可以回滚，但格式校验永远会拦住不合格的内容
- 聊天框输入 `@<id>` 可把整份流程注入这条消息（注入有 6000 字上限，超出部分提示模型用 `actions_read` 读全）

---

### 10. 专家包

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

### 11. 工作流模板

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

### 12. 知识库与灵光

**知识库：** 长期存储项目知识，对话时自动注入相关上下文。

- 设置 → 记忆与画 → 知识库标签
- 手动添加笔记、项目背景、资料摘录
- 支持 Markdown 格式

**灵光（Spark）：** 对话结束时自动捕获有价值的技术洞察。

- 对话结束 → 系统检测是否有可归档的洞察
- 确认后自动存入知识库
- 无需手动操作

---

### 13. Code Review

对 Git 仓库的变更进行 AI 四维度结构化审查。

**使用：**
- 设置 → Code Review
- 选择仓库路径
- AI 读取 `git diff` → 分析代码质量/安全性/性能/可维护性
- 输出行级评论 + 汇总报告

---

### 14. 语音输入

浏览器端语音转文字，免打字输入。

**使用：**
- 点击输入框旁的 🎤 按钮
- 说出你的想法，实时转写到输入框
- 再次点击停止
- 支持中英文自动检测

**注意：** 需浏览器支持 Web Speech API（Chrome / Edge 已支持）

---

### 15. 截图转代码

将截图还原为 HTML/CSS 代码。

**使用：**
- 在对话中描述「把这个截图转成代码」
- 或 `@screenshot_to_code` 指定图片路径
- AI 视觉模型分析图片 → 生成对应 HTML/CSS

**支持格式：** PNG / JPG / JPEG / GIF / WebP / BMP / SVG（≤10MB）

---

### 16. 定时任务

让 AI 定时或按事件自动执行任务。

**使用：**
- 点击顶栏 ⏰ 按钮
- 新建任务 → 设置名称、触发条件（定时/事件）、执行内容
- 支持 Cron 表达式

**触发类型：**
- 定时：每隔 N 分钟/小时/天
- 事件：文件变更、对话结束等

---

### 17. 设置与个性化

**主要设置项：**

| 设置 | 说明 |
|------|------|
| 模型管理 | 添加/删除 API Key，配置自定义端点，可选启用 Responses API |
| 推理强度 | 点输入框左侧胶囊开滑杆弹窗，按模型能力给出可选档位（自动/关/低/中/高），每档下方小字标注对应墨色（随墨/清墨/淡墨/浓墨/焦墨）；上游不认的档位不会出现，拖动松手才落盘 |
| 上下文预算 | 模型行上的滑杆（自动/100K/200K/400K/600K/800K/1M），同时决定自动压缩阈值与用量条分母 |
| 输出控制 | 最大 Token 数、流式输出开关 |
| 自动推进 | Autopilot / 短回复审阅 / 长回复停顿审阅 / Continue Autopilot（末轮续跑） |
| 安全模式 | 高危命令审批策略 |
| 局域网遥控 | 查看访问地址与二维码，设置局域网访问密码 |
| 主题 | 深色/浅色切换 |
| 语言 | 中文/English |
| 上下文压缩 | 自动/手动压缩历史对话 |

---

<a id="english"></a>
## 📜 English Guide

### Table of Contents

1. [What is SLATE?](#1-what-is-slate)
2. [Installation & Quick Start](#2-installation--quick-start)
3. [Multi-Model Chat](#3-multi-model-chat)
4. [Agent Autopilot](#4-agent-autopilot-1)
5. [Harness Autonomous Execution](#5-harness-autonomous-execution)
6. [Grind Mode](#6-grind-mode)
7. [Team Mode](#7-team-mode)
8. [Whiteboard Logic Chain](#8-whiteboard-logic-chain)
9. [MCP Toolbox](#9-mcp-toolbox)
10. [Expert Packs](#10-expert-packs)
11. [Workflow Templates](#11-workflow-templates)
12. [Knowledge Base & Sparks](#12-knowledge-base--sparks)
13. [Code Review](#13-code-review)
14. [Voice Input](#14-voice-input)
15. [Screenshot to Code](#15-screenshot-to-code)
16. [Scheduled Tasks](#16-scheduled-tasks)
17. [Settings & Customization](#17-settings--customization)

---

### 1. What is SLATE?

SLATE is a **local-first** AI collaboration studio. It integrates mainstream LLMs, 34 built-in tools, team debates, DAG workflows, whiteboard logic chains — all in a lightweight interface. Zero npm, zero build, ready to use.

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

1. Click the **Settings** tab in the top bar
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

**Task list on the left:**
- Sort is yours to pick: recent / by project / by status / created / by usage. The preference syncs across devices, and the classic sidebar and the Codex history rail share the same one
- Each conversation carries a mark matching where it stands: **needs action** (you stopped it, or a next step remains), **error** (request failed / stream cut), **running** (breathing animation, only while this run is actually generating), **done but unread** (cleared the moment you open it)
- The mark records how the last run ended: if the conversation was continued elsewhere (e.g. phone remote), the stale mark retires itself

**Task list rail on the right:**
- Large tasks stream their checklist into the rail beside the messages; the "Task list" button on the chat header (the quick-action row above the input in the Codex layout) folds the whole rail and hands the width back, one more click unfolds it
- Folding is a preference stored on this machine: it survives reload and restart, and a list still making progress will not force the rail back open
- While folded the button tooltip keeps reporting `{done}/{total}`, so progress does not vanish entirely; with no checklist in this conversation the button greys out

**Shortcuts:**
- `Enter` to send
- `Shift + Enter` for newline
- `Ctrl + N` for new conversation

---

### 4. Agent Autopilot

Autopilot is the default "do not make me type continue" execution layer. When your message clearly asks SLATE to inspect a project, edit files, run commands, debug, commit, or generate files, it automatically enters a multi-round Agent Loop.

**How to use it:**
- Say things like "fix xxx", "scan the project for bugs", "optimize tool calling", or "run tests and fix failures"
- You do not need to enable Harness manually, and you do not need to keep sending "continue"
- Ordinary tasks can auto-advance up to 24 rounds; broad project-wide or multi-file tasks can auto-advance up to 40 rounds
- The round budget is a stop-loss, not a target: once every deliverable is verified the model calls `exit_autopilot` to close the loop
- Out of rounds is not the same as done: **Continue Autopilot** (on by default) refuses to let go at the last round. If that round was still executing tools, the ceiling moves back by 8 rounds (at most 3 top-ups) so the work in flight can finish; if the model stopped without doing anything, the open TODOLIST items are read back to it and it is told to keep going or write 【任务完成】 explicitly. Don't want it? Uncheck it under Settings → Auto-Advance

**What it does automatically:**
1. Reads relevant directories, files, config, or Git state
2. Calls tools such as `file_edit`, `terminal`, `git_tool`, or `code_scan`
3. Feeds tool results back into the model invisibly so it can continue
4. Re-reads files or runs checks/tests/builds after changes
5. If the model claims completion without tool evidence, SLATE asks it to verify or actually act first
6. When the round budget runs out while work is still open, Continue Autopilot tops up the rounds and keeps going (toggle it off under Settings → Auto-Advance)

**InkStream — arguments as they are written:** while the model streams a tool call token by token, SLATE parses the half-formed arguments against the local tool schema and shows a live one-line preview of which fields are already closed and which one is still being written. It is preview only — **incomplete arguments never reach execution**; multi-KB text fields fold into line and character counts instead of flooding the screen.

**Stop really cancels:** pressing Stop closes both the model stream and the tool-call stream, so the backend terminates the matching subprocess or running task instead of "UI stopped, work still going". Cancelled calls are recorded in the local event ledger under their own status, kept apart from successful ones.

**When to use Harness:** use the **Target Mode** toggle in the **＋** menu (left of the chat input) when you want the stronger six-phase mode, explicit TODOLIST enforcement, and an 80-round long-task loop; after verification passes the model closes it with `exit_target_mode`, which also switches Target Mode off.

---

### 5. Harness Autonomous Execution

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
- Up to 80 autonomous rounds, closed by the model calling `exit_target_mode` once verification passes
- Pause anytime (only interrupts current round, no progress loss)
- Auto-creates TODOLIST for large tasks (shown live in the right rail; the "Task list" button on the chat header folds or unfolds it anytime, and keeps reporting `{done}/{total}` while folded)
- Auto-recovery from exceptions

---

### 6. Grind Mode

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

### 7. Team Mode

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

**Discussion record:** every turn is stored besides the local history — a team session, its roster,
and one event-ledger run per member — which is exactly what the Whiteboard → Workflow star map reads.
If the write fails, the local history stays and that session is labelled "Local only".

---

### 8. Whiteboard Logic Chain

Visual cards + connections system for reasoning and planning.

**Operations:**
- Click "Whiteboard" tab to enter
- AI auto-creates cards (analysis results, comparisons)
- Drag cards, create connections manually
- Switch display modes from the whiteboard header: Git, Flow, Kanban, Outline and Workflow. The main whiteboard is the default freeform canvas.
- Git Tree recognizes the opened project's Git elements: HEAD, branches, remote branches, commits, tags, remotes, worktrees, stash, staged/changed/untracked counts, and unpushed commits. Nodes and the canvas viewport are draggable.
- 4 AI whiteboard tools:
  - `card_create` — Create cards
  - `card_edit` — Edit cards
  - `arrow_create` — Create connections
  - `board_summarize` — Summarize the board

**The 5th mode, "Workflow": how to run it and how it's going, on one screen**
- Run bar: stop / resume / autopilot (goal mode) / response mode / reasoning effort.
  These controls don't keep a second copy of the state — they write the very state the chat
  header uses, so the two can never disagree.
- Flow wall: every playbook in `data/actions/*.yml` becomes a card stating its step count,
  inputs, author and where the output lands. "Run this" sends it into the current chat as an
  @mention; "Steps" expands the step list in place (fetched lazily).
- Pinning and "Pinned only" live in `slate_board_wf_prefs` on this machine and only reorder this view.
- Current run: projected straight from the event ledger — which step is live, how long it has taken,
  whether it succeeded. The live layer only patches text in its own subtree, so a per-second tick
  never re-renders the board underneath it.
- Team star map: the most recent team discussion of this conversation, laid out by role, showing who
  replied to whom, which tools each member used and which sub-agents they spawned — all from real
  backend records. With no team record it says so instead of drawing a decorative graph.

---

### 9. MCP Toolbox

SLATE includes 34 built-in MCP tools. The model decides when to use them during conversations.

**Usage:**
- Describe your need naturally (e.g., "search for xxx")
- Or explicitly call `@tool_name`

**Tool Categories:**

| Category | Tools |
|----------|-------|
| File Ops | `file_tree` `file_peek` `file_create` `file_edit` `file_append` |
| Terminal | `terminal` (sandbox execution, high-risk commands need approval) |
| Search & Code | `code_search` `code_scan` `doc_scan` `repo_stats` `todo_scan` `python_api_extract` |
| Doc Gen | `doc_write` `ppt_create` `word_create` `html_render` `html_bundle` |
| Office & PDF | `excel_tool` `pdf_tool` |
| Data | `json_tool` `regex_test` `text_summarize` `chart_create` `qrcode_create` |
| Web | `web_search` `web_fetch` |
| System & Environment | `system_info` `git_tool` `css_color` |
| Automation | `browser_automation` `computer_use` `screenshot_to_code` |
| AI Generation | `image_gen` `video_gen` (model and API key configured in Settings) |
| Extension | `mcp_factory` (dynamically register external MCP tools) |

**Unicode and encoding:**
- `file_peek` / `file_edit` auto-detect UTF-8, UTF-8 BOM, GB18030, GBK, UTF-16, and other common text encodings
- Chinese, emoji, and full-width symbols are preserved as-is; if a legacy encoding cannot represent a new character, the tool safely upgrades the write encoding instead of losing text
- On Windows, `terminal` hides PowerShell windows and captures Unicode-safe output for native commands such as Python / Node / Git / npm / rg
- On Windows `terminal` runs one PowerShell process per command: multi-line blocks (`foreach` / `if`) execute directly, `&&` / `||` are rewritten into `if ($?)` nesting on PowerShell 5.1, and a syntax error comes back verbatim with a failing exit code. The session keeps `cd` and `$env:` (PowerShell variables do not cross commands), and interactive REPLs such as bare `python` / `node` exit at once instead of holding the task open

**Action Playbooks:**

The tools above are the hands; an Action is the agreed sequence — write the required flow for a recurring task into one yml file so the model follows it instead of re-guessing every time.

- Location: `data/actions/<id>.yml`, one flow per file; the filename (minus `.yml`) is its id
- Fields: `name`, `description`, `when` (when it applies), `inputs` (what to ask the user for), `steps` (each with `title` plus optional `tool` / `detail` / `check`), `output`, `tags`
- In Agent mode the model sees the Action catalog automatically (capped at 20 entries; the remainder is reported as a count pointing to `actions_list`), reads a full flow with `actions_read` before committing to it, then executes the steps. Chat mode has no tools, so the catalog is not injected at all
- Reading a flow is not the same as running it: steps that name a suggested tool still require the actual call, and the model never claims completion just because it read the yml
- A broken file does not silently disappear: Settings → "Tools / Skills" lists it together with "line N: reason", and tool results tell the model which Actions are currently unavailable
- The format is a minimal YAML subset (2-space indent, block arrays, `|` literal blocks); tabs, anchors and multi-document files are rejected. 64 KB per file
- Editable in the panel: Settings → "Tools / Skills" → Actions, then "+ New Action" or click an entry to open the editor. Validation runs as you type and reports "line N: reason"; a failing draft cannot be saved
- Every overwrite or delete first copies the previous text to `data/actions/.history/` (up to 5 versions per Action). The editor's "History" button lets you view any version or roll back to it
- The model can write too: the `actions_write` tool requires it to declare `author: model` inside the yml (the panel badges such files "Model-written"), and in "Ask" permission mode a confirmation dialog shows the exact content first. "Auto" / "Full access" skip the dialog — a bad write is reversible via history, but the format gate never lets an invalid file through
- Typing `@<id>` in the chat box injects the whole flow into that message, capped at 6000 characters; anything longer is trimmed with a note telling the model to read the rest with `actions_read`

---

### 10. Expert Packs

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

### 11. Workflow Templates

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

### 12. Knowledge Base & Sparks

**Knowledge Base:** Long-term project knowledge storage, auto-injected into conversations.

- Settings → Memory & Canvas → Knowledge tab
- Manually add notes, project background, reference material
- Supports Markdown

**Sparks:** Auto-captures valuable technical insights when conversations end.

- After conversation → System detects archivable insights
- Confirms and stores to knowledge base
- No manual operation needed

---

### 13. Code Review

AI-powered four-dimensional structured review of Git repository changes.

**Usage:**
- Settings → Code Review
- Select repository path
- AI reads `git diff` → Analyzes quality/security/performance/maintainability
- Outputs line-level comments + summary report

---

### 14. Voice Input

Browser-based speech-to-text for hands-free input.

**Usage:**
- Click 🎤 button next to the input box
- Speak your idea, real-time transcription appears in input
- Click again to stop
- Auto-detects Chinese and English

**Note:** Requires Web Speech API support (Chrome / Edge supported)

---

### 15. Screenshot to Code

Convert screenshots to HTML/CSS code.

**Usage:**
- Describe "convert this screenshot to code" in chat
- Or `@screenshot_to_code` with image path
- AI vision model analyzes image → Generates corresponding HTML/CSS

**Supported formats:** PNG / JPG / JPEG / GIF / WebP / BMP / SVG (≤10MB)

---

### 16. Scheduled Tasks

Let AI automatically execute tasks on schedule or by events.

**Usage:**
- Click ⏰ button in top bar
- New Task → Set name, trigger (schedule/event), execution content
- Supports Cron expressions

**Trigger Types:**
- Schedule: Every N minutes/hours/days
- Event: File changes, conversation end, etc.

---

### 17. Settings & Customization

**Main Settings:**

| Setting | Description |
|---------|-------------|
| Model Management | Add/remove API keys, configure custom endpoints, optionally enable Responses API |
| Reasoning Effort | Click the pill left of the input to open a slider; levels follow the model's capability (auto/off/low/medium/high), each tick annotated with its ink shade in small type (free/clear/light/rich/charred); unsupported levels never appear, and the value is persisted only when you let go |
| Context Budget | Per-model slider (auto/100K/200K/400K/600K/800K/1M) driving both the auto-compress threshold and the usage bar |
| Output Control | Max tokens, streaming toggle |
| Auto-Advance | Autopilot / short-reply review / long-stall review / Continue Autopilot |
| Safety Mode | High-risk command approval policy |
| LAN Remote | View LAN URL / QR code, configure remote access password |
| Theme | Dark/Light toggle |
| Language | Chinese / English |
| Context Compression | Auto/manual compression of history |

---

<p align="center">
  <strong>SLATE（砚）</strong>—— 将灵感转化为结构化方案<br>
  <strong>SLATE</strong> — Turn inspiration into structured action
</p>
