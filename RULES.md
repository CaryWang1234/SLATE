# SLATE（砚）开发规则（RULES）

> 本文档面向 AI Agent 与人类贡献者，是本项目**当前真实状态**的开发约定。
> 与 `QODER.md`（早期产品规格书）冲突时，以本文件与代码现状为准。

---

## 1. 项目定位

- **SLATE（砚）**：本地 AI 协作调度台。FastAPI 后端 + 原生 JS 前端 + PyWebView 桌面壳。
- 核心能力：多模型对话、AI 团队讨论与工作流、白板逻辑链、提示词工厂、MCP 工具 / SKILL.md 技能、知识库（knowledge）、定时任务、Harness 自主执行。
- 本地优先：所有数据存本地（SQLite / JSON），API Key 只保存在前端 localStorage 与本地 `desktop_state.json`，不经任何第三方服务器。

## 2. 绝对红线

1. **禁止 npm / Node.js / 任何构建工具**：前端必须是原生 HTML + CSS + JavaScript（ES Modules，零构建、零打包、零包管理）。
2. **禁止新增依赖**：后端依赖以 `requirements.txt` 为准（fastapi / uvicorn / httpx / python-multipart 等），确需新依赖必须先与用户确认。
3. **禁止代码编辑器组件**：不引入 Monaco / Ace / CodeMirror 等；代码展示只用 `<pre><code>` + Highlight.js（CDN）。
4. **禁止破坏 UI 基调**：黑白灰双主题 + 金色点缀（见 §8），不得引入蓝紫渐变、毛玻璃、大圆角。
5. **改动不要同步到其它项目**：所有开发仅在 SLATE 仓库进行。

## 3. 技术栈（固定）

| 层级 | 选型 | 说明 |
|---|---|---|
| 前端 | 原生 HTML + CSS + JS（ES Modules） | 零构建；CDN 引入 Highlight.js、Mermaid.js |
| 后端 | Python 3.13+ / FastAPI / Uvicorn | 异步轻量服务，入口 `backend/main.py` |
| 存储 | SQLite（chat_history.db / knowledge.db）+ JSON | 全部位于 data 目录 |
| 桌面 | PyWebView（EdgeChromium）+ PyInstaller | 入口 `desktop.py`，规格 `SLATE.spec` |
| 安装包 | Inno Setup | `SLATE_InnoSetup.iss` + `build_installer.bat` |

## 4. 目录结构（当前）

```
SLATE/
├── backend/
│   ├── main.py                # FastAPI 入口：注册全部路由、挂载 frontend 静态目录
│   ├── routers/               # 路由层（proxy/constitution/skills/chat/files/projects/
│   │                          #   settings/knowledge/scheduler/workflows 共 10 个）
│   ├── skills/                # MCP 内置工具实现（每个文件一个 execute(**params)）
│   └── workflows/             # 工作流 JSON 定义（DAG）
├── frontend/
│   ├── index.html             # 单页入口
│   ├── css/style.css          # 全局样式（双主题 CSS 变量）
│   └── js/
│       ├── app.js             # 主控：初始化、设置页、事件绑定
│       ├── store.js           # 全局 state + 持久化（localStorage + 后端共享双通道）
│       ├── components/        # chat/team/memory/whiteboard/skill_panel/schedule/…
│       └── services/          # api/tools/adapter/markdown/workflow/project
├── data/                      # 源码运行时的数据目录（勿提交用户数据）
├── docs/                      # 官网静态站（GitHub Pages，main 分支 /docs）
├── installer/                 # 各版本安装包
├── desktop.py                 # 桌面端入口（PyWebView + 内嵌 uvicorn）
├── SLATE.spec                 # PyInstaller 打包规格
└── start.bat / start.sh       # 源码一键启动（uvicorn 127.0.0.1:8000）
```

## 5. 后端规范

### 5.1 API 约定
- 所有接口统一返回 `{ "code": 0, "data": …, "message": "ok" }`；`code !== 0` 表示业务错误，`message` 必须是人话。
- 前端所有请求经 `frontend/js/services/api.js` 封装（带 180s 超时保护），禁止在组件里裸写 fetch（流式除外，用 `streamChat`）。

### 5.2 新增路由三步走
1. `backend/routers/<name>.py` 中定义 `router = APIRouter(prefix="/<name>", tags=[…])`；
2. `backend/main.py` 导入并 `app.include_router(xxx.router, prefix="/api")`；
3. **`SLATE.spec` 的 `hiddenimports` 追加 `backend.routers.<name>`**（漏掉则安装版 404）。

### 5.3 新增数据文件目录
- 需要随包分发的静态资源目录（如 `backend/workflows/`）必须加入 `SLATE.spec` 的 `datas`。
- 运行时**可写**数据一律放 data 目录：`Path(os.environ.get("SLATE_DATA_DIR", 项目根/data))`，不要写死源码路径。

### 5.4 数据库
- SQLite 表结构变更用迁移模式：`PRAGMA table_info` 检测 + `ALTER TABLE ADD COLUMN`，不删库重建。
- 连接需设 `timeout=10.0`、`PRAGMA busy_timeout`，避免并发写锁冲突。

### 5.5 共享设置状态（重要教训）
- `PUT /api/settings/state` 必须是**合并式写入**（先读已有 `desktop_state.json`，只覆盖本次提交的白名单字段），禁止整体覆盖写，否则漏传字段会被永久抹掉。
- 新增设置项的完整链路（三处缺一不可）：
  1. `store.js`：state 加字段 + 纳入持久化白名单；
  2. `app.js`：控件绑定 `change` 事件**即时** `savePersistent()`（不能只靠"保存"按钮）；
  3. `settings.py`：字段加入白名单集合。

## 6. 前端规范

### 6.1 版本号机制（强制）
- 所有 `<script>` / `<link>` / `import` 必须带 `?v=YYYYMMDD-N` 缓存戳。
- 每次修改前端文件后**统一 bump**：当日递增 `-N`（如 `20260808-8 → 20260808-9`），替换必须覆盖 `frontend/` 下全部 html/js/css，并校验无旧版本号残留。
- 用 PowerShell 脚本批量替换时，文件必须写成 **UTF-8 无 BOM**（BOM 会导致 JS 加载失败）。

### 6.2 代码组织
- 组件放 `js/components/`，可复用服务放 `js/services/`；全局状态只存在于 `store.js`，通过 `subscribe(key, fn)` 订阅变更。
- 渲染 DOM 优先 `createElement` + `textContent`（防注入）；用户内容禁止直接拼进 `innerHTML`。
- Markdown 渲染统一走 `services/markdown.js`。

### 6.3 LLM 调用
- 统一经 `/api/proxy/chat`（支持流式与非流式 `stream:false`），API Key 由前端从 `getModelKey(modelId)` 取；后端不保存、不代管 Key。
- 流式必须用 `api.js` 的 `streamChat`（内置 idle 看门狗 + 零内容重试），不要自写 SSE 解析。

## 7. 扩展点规范

### 7.1 新增 MCP 内置工具（四处注册，缺一不可）
1. `backend/skills/<name>.py`：实现 `def execute(**params) -> dict|str`；
2. `backend/routers/skills.py`：`BUILTIN_SKILLS` 字典注册名称与描述；
3. `frontend/js/components/skill_panel.js`：`SKILL_PARAM_DEFS` 添加手动执行的参数表单；
4. `frontend/js/services/tools.js`：`skill_run` 工具的 description 补充该工具（模型可见）。

### 7.2 新增工作流
- 在 `backend/workflows/` 放 JSON：必含 `id / name / description / nodes / edges`。
- 节点字段：`id / name / role（团队成员角色）/ model / skill / prompt / inputs / output_key`（可选 `max_tokens` / `temperature`）。
- 输入映射约定：`$input` = 运行时用户输入，`$node_id` = 上游节点输出，其余为字面量；提示词模板用 `{{变量名}}`。
- DAG 合法性（环、未知引用）由 `GET /api/workflows` 自动校验，非法工作流前端会标 ⚠ 且禁止运行。

### 7.3 知识库写入
- 任何自动产物入库都复用 `POST /api/knowledge/docs`（后端 `upsert_document`），带上 `source / kind / metadata`，**禁止另建重复存储**。

## 8. UI 规范

- 双主题（`data-theme` 切换）：浅色白底黑字，深色 `#0A0A0A` 底奶油字；主强调色金色（`--gold`）。
- 颜色一律用 CSS 变量（`--bg / --text / --border / --bg-alt / --gold` 等）；唯一例外：危险/错误色 `#c44`。
- 直角或 ≤4px 圆角（`--radius`），无阴影、无渐变、无毛玻璃；字体走系统回退，不引字体文件。
- 新增样式追加到 `style.css` 对应功能区块后，命名沿用现有前缀（`team-* / wf-* / chat-* / settings-*` 等）。

## 9. 桌面版与发布

- **安装版路径**：`C:\<user>\AppData\Local\Programs\SLATE`；其数据目录为 `…\SLATE\data`（`desktop.py` 设 `SLATE_DATA_DIR`），与源码 `data/` 相互独立。
- **纯前端改动**：`robocopy frontend "…\SLATE\_internal\frontend" /MIR` 即时生效。
- **任何后端 Python / 资源目录改动**：必须重新执行 `build_desktop.bat` 打包才生效；安装包另走 `build_installer.bat`。
- `docs/` 是官网（GitHub Pages，main 分支），推送后自动更新。

## 10. 提交前自检清单

1. Python：`python -m py_compile <改动文件>`；路由级改动用 `fastapi.testclient.TestClient` 冒烟。
2. JavaScript：`node --check <改动文件>`。
3. 前端版本号已统一 bump，且全仓库 grep 无旧版本号残留。
4. 涉及后端时，`SLATE.spec` 的 `hiddenimports` / `datas` 已同步。
5. 涉及新设置项时，确认 change 即时保存 + 后端白名单 + 合并式写入语义未被破坏。
6. 不要提交 `data/` 下的用户数据、`desktop_backend.log`、`.tmp-*` 临时目录。

## 11. 代码风格

- 注释用中文，精炼说明"为什么"而非复述代码；与周围代码的密度、命名保持一致。
- 函数保持短小单一职责；错误必须给用户可读的中文信息（`⚠ / ✗` 前缀沿用现有惯例）。
- 不做投机性抽象：能用现有链路（proxy / skills / knowledge）就不新建平行机制。
