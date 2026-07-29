SLATE（砚）—— 项目开发规格书

---

角色设定

你是一名极致务实的全栈工程师，擅长原生Web技术（HTML/CSS/JS）和Python轻量级后端（FastAPI）。你的代码风格干净、简洁、中文注释精炼，绝不引入任何多余的依赖或花哨的动画。

---

项目名称与定位

· 项目名：SLATE（砚）
· 定位：本地AI协作调度台。将用户的零碎灵感、手动修改意图、本地代码上下文，整合为适配不同大模型（DeepSeek / Kimi / Doubao / Gemini / ChatGPT 等）的精简提示词。
· 核心原则：本应用只做提示词工程、上下文管理、项目灵感建议，不涉及完整的项目开发。所有代码执行由外部 Coding Agent / Working Agent 完成。

---

绝对红线（务必遵守）

1. 禁止使用 npm / Node.js：前端必须用原生 HTML + CSS + JS（零构建工具，零包管理）。
2. 禁止集成代码编辑器：绝对不要引入 Monaco Editor、Ace、CodeMirror 等任何编辑器组件。代码展示仅限于 <pre><code> 配合 Highlight.js 实现只读高亮。
3. 禁止蓝紫渐变 / 圆角大礼包：UI必须是纯黑白灰色系（#FFFFFF、#000000、#DDDDDD、#F8F8F8），直角边框（可带极少圆角，≤4px），无阴影、无渐变、无毛玻璃。
4. 字体规范：中文字体使用微软雅黑系列，代码字体使用 Consolas / JetBrains Mono（通过系统回退实现，不引入额外字体文件）。

---

技术栈

层级 技术选型 备注
前端 原生 HTML + CSS + JavaScript（ES6+） 零构建工具
后端 Python 3.13+ + FastAPI + Uvicorn 轻量异步服务
依赖 fastapi, uvicorn, httpx, python-multipart 见 requirements.txt
语法高亮 Highlight.js（CDN 引入，atom-one-dark 主题） 只读高亮，无交互
图表渲染 Mermaid.js（CDN 引入） 用于白板逻辑链可视化

---

功能需求详解

1. 对话模型配置

· 模型预设分类：分为四类——
  · 国外：ChatGPT（GPT-4o / o1）、Claude（3.5 Sonnet / 3.7 Sonnet）、Gemini（1.5 Pro / 2.0 Flash）
  · 国内：DeepSeek（R1 / V3）、Kimi（Moonshot）、Doubao（豆包）、Qwen（通义千问）、GLM（智谱）
  · 自定义：用户可手动填写任意兼容 OpenAI API 格式的模型名称和 Base URL
  · 本地：Ollama / LM Studio 本地部署模型
· 前置要求：项目初始化时，你必须查询当前（2026年7月）可调取 API 的主流模型列表，剔除已停用或过时的模型（如 GPT-3.5-Turbo 旧版本），确保预设列表的时效性和准确性。
· 启用逻辑：用户填入有效的 API Key 后，该模型自动进入 “使用列表”，可在对话聊天框旁的快捷下拉菜单中一键切换。

---

2. 聊天逻辑链

2.1 基础聊天

· 交互形式：标准聊天气泡输入框（底部固定），用户输入后 LLM 返回流式或非流式答复。
· 上下文管理：
  · 记录完整对话历史（含用户消息、LLM 回复、Skill 调用结果）。
  · 明确的上下文长度限制（可配置，默认 64k tokens），超出阈值后自动触发上下文压缩（摘要式压缩，保留关键决策和最新 2 轮完整对话）。
  · 压缩过程在后台静默执行，不打断用户当前交互。

2.2 技能（Skill）系统

· LLM 可通过 SLATE 调用以下内置技能：
  · 终端运行：执行 Shell 命令（受限沙箱，仅允许指定目录）
  · 读取文件：读取指定路径文件内容（前 N 行或全文）
  · 简单 HTML 框架编写：生成符合 SLATE 纯黑白风格的 HTML 骨架
  · CSS 调色：基于用户描述生成纯黑白灰色系样式
  · 文档编写：生成 Markdown 格式的技术文档或需求说明
· 用户自定义 Skill：
  · 用户可自行添加 Skill，必须提供完整的 Skill.md（功能说明）和 .skill 文件（可执行脚本/配置）。
  · SLATE 提供 Skill 模板解析器，按规范加载并暴露给 LLM 调用。

2.3 创新功能一：白板式逻辑链

· LLM 会将单个灵感 / 功能 / 想法整理为一张卡片，贴在 “黑板”（独立面板/视图）上。
· 卡片之间用箭头/连线标识功能依赖、数据流向或决策顺序。
· 实现方式：使用 Mermaid.js 渲染 flowchart / mindmap 图表，LLM 生成对应 Markdown 代码块，前端自动渲染为可视化白板。
· 用户可拖拽卡片位置（使用原生 HTML5 Drag & Drop，不引入外部库）。

2.4 创新功能二：AI 团队

· 多模型协作：多个模型（或同一模型的不同人格设定）以团队形式协作讨论。
· 交互方式：
  · 每个“团队成员”以简短的输出（1-3 句话）发表观点。
  · 系统自动进行决策汇总：标注共识点、分歧点，并给出明确决策建议。
  · 用户可作为“产品经理”参与决策，投票或直接指定方向。
· Token 节约原则：
  · 团队讨论时，仅使用轻量级模型（如 DeepSeek-V3 / Gemini Flash）进行初步讨论。
  · 仅当需要最终决策或代码生成时，才调用重型模型（如 Claude 3.7 / GPT-4o）。
  · 每次讨论后自动生成讨论摘要（≤500 tokens），替代完整历史喂给下一轮。

2.5 创新功能三：多模态通感

· 输入支持：docx、csv、markdown、html、图片（JPG/PNG）、pdf 等。
· 处理方式：所有多模态文件由后端 Python 统一处理（解析、提取文本、缩略图生成等），前端仅负责上传和展示。
· Token 优化：文件处理期间，LLM 不进行任何操作，不产生任何 API 调用，杜绝 token 浪费。
· 输出支持：Markdown 渲染、HTML 预览、CSV 表格展示、图片缩略图等。

---

3. 核心：提示词生成

· 定位：SLATE 不进行完整的项目开发，而是生成高质量提示词，交给用户的外部 Coding Agent / Working Agent（如 Claude Code、Codex、Cursor 等）执行。
· 输出要求：
  · 提示词明确、简洁、可执行，包含必要的上下文（项目宪法、相关文件路径、约束条件）。
  · 支持用户审查与修改：生成后展示在专门区域，用户可编辑后确认，再复制/导出。
· 输出格式示例：
  ```
  [项目宪法摘要]
  [相关文件上下文（仅路径 + 关键片段）]
  [任务描述：具体要做什么]
  [约束条件：禁止修改哪些文件，必须遵守哪些规则]
  [交付物要求：代码块/文档/配置]
  ```

---

目录结构

```
slate/
├── start.bat                     # Windows 一键启动脚本
├── start.sh                      # Linux / macOS 一键启动脚本
├── favicon.svg                   # 纯黑白三栏线框图标
├── backend/
│   ├── main.py                   # FastAPI 入口：挂载静态目录，注册路由
│   ├── requirements.txt          # 依赖清单
│   ├── routers/
│   │   ├── proxy.py              # 代理路由：转发 LLM API 请求（支持多模型切换）
│   │   ├── constitution.py       # 宪法路由：读写 data/constitution.json
│   │   ├── skills.py             # 技能路由：统一挂载 Skill 调用入口
│   │   └── chat.py               # 聊天路由：对话历史管理，上下文压缩
│   └── skills/                   # 技能实现目录
│       ├── __init__.py
│       ├── file_tree.py          # 技能：扫描目录树（仅第一层）
│       ├── file_peek.py          # 技能：读取文件前 N 行（≤50行）
│       ├── terminal.py           # 技能：受限终端执行
│       └── html_render.py        # 技能：生成纯黑白 HTML 骨架
├── frontend/
│   ├── index.html                # 入口页面：三栏布局（对话/黑板/工厂）
│   ├── css/
│   │   └── style.css             # 纯黑白全局样式（含响应式）
│   └── js/
│       ├── app.js                # 主控：初始化、事件绑定、路由切换
│       ├── store.js              # 全局状态：当前模型、对话历史、上下文池、黑板卡片
│       ├── components/
│       │   ├── chat.js           # 聊天组件：气泡渲染、流式输出、模型切换
│       │   ├── whiteboard.js     # 白板组件：Mermaid 渲染、卡片拖拽
│       │   ├── skill_panel.js    # 技能面板：内置技能列表 + 自定义 Skill 上传
│       │   └── prompt_factory.js # 提示词工厂：生成、预览、编辑、导出
│       └── services/
│           ├── api.js            # API 调用封装（fetch 统一拦截）
│           └── adapter.js        # 模型适配器：System Prompt 模板 + 参数映射
└── data/
    ├── constitution.json         # 项目宪法（默认：禁止外键，API 统一格式）
    ├── chat_history.db           # SQLite 对话历史（可选，轻量持久化）
    └── skills/                   # 用户自定义 Skill 存放目录
        └── .gitkeep
```

---

启动脚本

start.bat（Windows）

```bat
@echo off
pip install -r backend/requirements.txt
uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000
pause
```

start.sh（Linux / macOS）

```bash
#!/bin/bash
pip install -r backend/requirements.txt
uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000
```

---

输出要求

请严格按照上述目录结构，依次输出每个文件的完整代码。不要输出额外的解释性文字（注释除外）。所有前端 API 请求地址统一指向 http://127.0.0.1:8000/api/...，确保前后端联调无缝衔接。