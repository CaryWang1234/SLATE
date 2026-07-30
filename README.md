# SLATE（砚）

> 本地 AI 协作调度台 · 将灵感转化为结构化方案

SLATE 是一个轻量级本地 AI 协作工具，专注于**提示词工程、上下文管理和项目灵感整理**。它不直接进行代码开发，而是生成高质量 Prompt，供外部 Coding Agent（Claude Code、Codex、Cursor 等）执行。

---

## 核心功能

### 🗣️ 多模型对话

- 支持国内外主流 LLM：ChatGPT、Claude、Gemini、DeepSeek、Kimi、Doubao、Qwen、GLM 等
- 支持自定义模型（兼容 OpenAI API 格式）和本地模型（Ollama / LM Studio）
- 侧边栏一键切换模型，管理 API Key
- 自动上下文管理（可配置 token 阈值，超限自动压缩）

### 🧠 白板式逻辑链

- 将灵感/功能/想法整理为卡片，贴在可视化黑板上
- 用箭头连线标识依赖关系、数据流向或决策顺序
- 基于 Mermaid.js 渲染 flowchart / mindmap
- 原生拖拽调整卡片位置

### 👥 AI 团队协作

- 多模型/多角色以团队形式协作讨论
- 轻量模型（DeepSeek-V3 / Gemini Flash）用于讨论，重型模型（Claude 3.7 / GPT-4o）用于最终决策
- 自动生成讨论摘要（≤500 tokens），节约 token
- 用户可作为产品经理参与投票决策

### 📦 多模态输入

- 支持 docx、csv、markdown、html、图片、pdf 等文件
- 后端 Python 统一解析提取，前端仅负责上传展示
- 文件处理期间零 API 调用，杜绝 token 浪费

### 🏭 提示词工厂

- 将上下文、项目宪法、约束条件整合为高质量 Prompt
- 支持用户审查、编辑、导出
- 输出格式清晰：宪法摘要 → 上下文片段 → 任务描述 → 约束 → 交付要求

### 🛠️ 技能系统

内置技能：
- 终端运行（受限沙箱）
- 文件读取
- HTML 骨架生成
- CSS 调色
- 文档编写

支持用户自定义 Skill（.md + .skill 文件）

---

## 技术栈

| 层级 | 技术选型 |
|------|---------|
| 前端 | 原生 HTML + CSS + JavaScript（ES6+） |
| 后端 | Python 3.13+ + FastAPI + Uvicorn |
| 依赖 | fastapi, uvicorn, httpx, python-multipart |
| 语法高亮 | Highlight.js（CDN） |
| 图表渲染 | Mermaid.js（CDN） |

**零构建工具，零 npm 依赖。**

---

## 目录结构

```
SLATE/
├── start.bat                     # Windows 一键启动
├── start.sh                      # Linux/macOS 一键启动
├── favicon.svg                   # 纯黑白三栏线框图标
├── LICENSE                       # 许可证
├── QODER.md                      # 项目开发规格书
├── backend/
│   ├── main.py                   # FastAPI 入口
│   ├── requirements.txt          # 依赖清单
│   ├── routers/
│   │   ├── proxy.py              # LLM API 代理路由
│   │   ├── constitution.py       # 宪法读写路由
│   │   ├── skills.py             # 技能调用路由
│   │   └── chat.py               # 对话历史管理路由
│   └── skills/                   # 技能实现
│       ├── __init__.py
│       ├── file_tree.py
│       ├── file_peek.py
│       ├── terminal.py
│       └── html_render.py
├── frontend/
│   ├── index.html                # 三栏布局入口
│   ├── css/
│   │   └── style.css             # 纯黑白全局样式
│   └── js/
│       ├── app.js                # 主控初始化
│       ├── store.js              # 全局状态管理
│       ├── components/
│       │   ├── chat.js           # 聊天组件
│       │   ├── whiteboard.js     # 白板组件
│       │   ├── skill_panel.js    # 技能面板
│       │   └── prompt_factory.js # 提示词工厂
│       └── services/
│           ├── api.js            # API 封装
│           └── adapter.js        # 模型适配器
└── data/
    ├── constitution.json         # 项目宪法
    ├── chat_history.db           # 对话历史（SQLite）
    └── skills/                   # 用户自定义 Skill
```

---

## 快速开始

### 前置要求

- Python 3.13+
- 各 LLM 的 API Key（按需配置）

### 启动

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

---

## 设计原则

- **纯黑白灰色系**：无蓝紫渐变、无圆角大礼包、无阴影毛玻璃
- **原生技术**：零 npm/Node.js，零构建工具，零外部编辑器组件
- **本地优先**：所有处理在本地完成，API Key 仅用于 LLM 调用
- **Token 节约**：智能压缩、分级调用、静默处理

---

## License

本项目采用 [LICENSE](LICENSE) 中指定的许可证。

---

*SLATE（砚）—— 研磨灵感，落笔成章。*