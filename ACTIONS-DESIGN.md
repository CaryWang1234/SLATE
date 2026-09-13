# SLATE Actions 设计草案 v0.2（P0 已落地）

需求原话：添加 "Actions"，用户可自定义/让模型配置 Actions，每个 Actions 都是一个 .yml 文件，里面记录着干某件事的必要流程，模型可直接进行调用/读取信息。

本文件前半是设计：协议草案 + 现状映射表 + 逐文件改造清单。**§10 记录 P0 实际落地结果与草案的偏差**——设计段落保留原话不改写，以偏差条目为准。

---

## 0. 三条待拍板（D1 已定，D2/D3 按推荐值实施）

| # | 决定 | 状态 | 影响面 |
|---|---|---|---|
| D1 | Actions 与既有 `data/skills/*/SKILL.md` 自定义技能的关系 | **已定 2026-09-13：并存 + 单向转换**（SKILL.md 原样保留，只读导入；提供 SKILL.md → Action 转换，不动旧轨） | 文件布局、面板结构、迁移代码量 |
| D2 | Action 是不是执行引擎 | **按推荐实施：不是**。Action 是"给模型读的流程说明书"，确定性编排继续用 `backend/workflows/*.json` | 是否新增运行时（最大复杂度分水岭） |
| D3 | YAML 怎么解析 | **按推荐实施：后端单一解析器 + 受限子集 SAY-1**，不把 PyYAML 加进 `backend/requirements.txt`，前端永不解析 YAML | 打包体积、hiddenimports、双端口径漂移 |


---

## 1. 需求逐句 → 契约

| 用户表述 | 展开成的契约 |
|---|---|
| "用户可自定义" | 面板可新建/编辑/删除；磁盘上就是一个可读可改的 `.yml`（用户用记事本改也认） |
| "让模型配置" | 暴露 `actions_write` 工具给 Agent；写入必须过 riskguard 高危审批（与 `file_edit` 同级） |
| "每个 Actions 都是一个 .yml 文件" | `data/actions/<id>.yml`，一文件一 Action，文件名即 id，不建子目录 |
| "记录着干某件事的必要流程" | 结构化的 `steps[]`，每步可带 `detail`（正文）与 `check`（完成判据），不是自由长文 |
| "模型可直接进行调用" | 系统提示里给**一行式目录**（名字 + 一句话），不注入正文 |
| "读取信息" | `actions_read` 按 id 拉归一化 JSON；`actions_list` 按 tag 过滤 |

---

## 2. 现状映射表：仓库里已有 5 个近亲

| 机制 | 存储 | 格式 | 谁能写 | 怎么到达模型 | 是否执行 |
|---|---|---|---|---|---|
| 内置工具 `BUILTIN_SKILLS` | `backend/routers/skills.py:38-73`（35 条 name→中文描述）+ `backend/skills/*.py` | Python `execute()` | 只有开发者 | `skill_run` 工具 | **是** |
| 自定义技能 | `data/skills/<name>/SKILL.md`（`skills.py:35,76-94`） | md + YAML frontmatter（手搓行扫描 `skills.py:88-92`、`plugin_adapter.py:38-57`） | 上传/导入，**没有编辑器**（`skill_panel.js:462-497`） | `skill_search`→`skill_run` 回原文；`@mention` 直插 user 消息（`chat.js:780-791`，无上限） | 否，只回文本（`skills.py:155-159`） |
| 工具选择速查 `TOOL_USE_RECIPES` | `frontend/js/services/tools.js:1038-1054` | 硬编码 `["场景","路由"]` 15 组 | 只有开发者 | 系统提示内联（`tools.js:1577-1584` 区） | 否 |
| 工作流 | `backend/workflows/*.json`（8 个） | nodes DAG（`{id,name,role,skill,prompt,inputs,output_key}`） | 导入/导出（`routers/workflows.py:163-198`），用户不可编辑内置 | 独立执行引擎，不是 Agent 工具 | **是** |
| 宪法/专家/记忆/知识库 | `data/constitution.json`、`data/experts/`、`chat_history.db`、`knowledge.db` | json / md / sqlite | UI 可编辑 | 系统提示注入，多数**无上限**（宪法 `adapter.js:152-157` 逐条 +=，无截断） | 否 |

结论：**"流程说明书"这件事今天已经能做一半**（SKILL.md 就是说明书，`skill_run` 就是读取），缺的正好是用户点名要的三点——① YAML 结构化（有 steps 而不是散文）② 可视化编辑 ③ 模型能自己写。所以 Actions 应该被设计成 **SKILL.md 的结构化同胞**，而不是第三条平行轨道。

外部兼容资产不能丢：`SKILL.md` 是 Codex CLI / Claude Code / Cursor 的开放标准（`skills.py:3` 注释、`plugin_adapter.py`），删掉它就删掉了"一键导入别人家的技能包"。

---

## 3. 文件格式（协议草案）

### 3.1 落盘

```
data/actions/<id>.yml          一文件一 Action，UTF-8，LF，无 BOM
data/actions/.history/<id>.<ts>.yml   写前自动留底，每 id 保留最近 5 版
```

`<id>` 约束：`^[a-z0-9][a-z0-9_-]{0,47}$`（小写、无空格、无路径分隔符）。消毒直接复用 `skills.py:431 _sanitize_skill_name` 的思路：**先消毒再拼路径**，且解析后必须 `resolve()` 回 `DATA_DIR/actions/` 内，否则拒绝（这是本项目已有的目录穿越教训）。

### 3.2 受限 YAML 子集（SAY-1）

仓库现状：`backend/requirements.txt` **没有 pyyaml**，且 `routers/vault.py:34-58` 明确写着"不依赖 PyYAML"、手写解析。再加第三个手搓解析器有风险，所以把支持面**定死成可枚举的 5 条**，其余一律报错并给行号：

1. 顶层只允许 `key: value`，缩进固定 2 空格，最大嵌套 2 层；
2. value 允许：裸 scalar / 单双引号 scalar / 块数组（`- ` 开头，元素是 scalar 或一层 `key: value`）/ 字面块标量 `|`；
3. 允许 `#` 整行注释；**禁止**行尾注释（`a: b # c` 里的 `# c` 属于值）；
4. 禁止：锚点 `&` / alias `*` / 多文档 `---` / 流式 `{}` `[]` / 折叠 `>` / 显式类型 `!!`；
5. scalar 一律按字符串处理，`required: true` 里的 `true` 只认字面 `true|false`，不做 YAML 1.1 的 `yes/no/on/off` 布尔陷阱（这条就是他们踩过的"竖线码位变体"类坑的同类）。

理由：SAY-1 足以表达流程，实现约 120 行，可被守卫脚本用 fixture 锁死；用户手写、模型生成、后端解析三方对同一子集收敛。

### 3.3 字段表

| 字段 | 必填 | 上限 | 语义 |
|---|---|---|---|
| `name` | 是 | 40 字 | UI 显示名，中文可 |
| `description` | 是 | 120 字 | **进系统提示目录的唯一文案**，写不好等于没这个 Action |
| `when` | 否 | 200 字 | 触发线索（"用户要求 X 时"），只进 `actions_list`，不进目录 |
| `inputs[]` | 否 | 8 项 | `{key,label,type,required,options?}`，type ∈ text/number/textarea/select；面板渲染表单、模型按此传参 |
| `steps[]` | 是 | 24 步 | `{title,tool?,detail?,check?}` |
| `steps[].tool` | 否 | — | 建议调用的工具名；**不存在的名字不报错、只降级为提示文本**（避免注册表变更让旧 Action 全线失效） |
| `steps[].check` | 否 | 200 字 | 完成判据，模型自检用 |
| `output` | 否 | — | `{format,destination,path}`，destination ∈ message/file/board |
| `tags[]` | 否 | 8 项 | 分组与过滤 |
| `author` | 否 | — | user/model，**仅信息用途，不是安全边界**（见 §6） |
| `version` | 否 | — | 用户自己的记账位 |

体积上限：单文件 64 KB，超出拒绝写入并在错误里报实际字节数。

### 3.4 示例

```yaml
name: 生成发布说明
description: 从 git log 归纳中英双语 Release Notes 并落到 CHANGELOG
when: 用户说"发版/写 release notes/出更新日志"时
inputs:
  - key: tag
    label: 目标版本号
    type: text
    required: true
  - key: audience
    label: 读者
    type: select
    options:
      - 终端用户
      - 开发者
steps:
  - title: 取变更清单
    tool: git_tool
    detail: |
      git log <上个 tag>..HEAD --oneline --no-merges
    check: 每条 commit 都能被归入某个分类，没有落单
  - title: 归类
    detail: |
      按 feature / fix / perf / breaking 四类归并；
      breaking 必须置顶并写迁移提示。
    check: 四类以外的条目为 0
  - title: 双语输出
    tool: file_create
    check: 中文在前、英文在后，小节标题一一对应
output:
  format: markdown
  destination: file
  path: CHANGELOG.md
tags:
  - release
  - docs
author: user
```

---

## 4. 后端契约

新文件 `backend/routers/actions.py`，前缀 `/actions`（挂载同 `main.py:79` 那批，`prefix="/api"`）。响应统一沿用仓库信封 `{code, data, message}`，`code: -1` + 中文 message，**不抛 500**（同 `diagnostics.py` 的口径）。

| 路由 | 入参 | 出参 `data` |
|---|---|---|
| `GET /api/actions` | — | `{actions:[{id,name,description,tags,stepCount,author}]}` |
| `GET /api/actions/{id}` | — | `{id,name,description,when,inputs[],steps[],output,tags,raw,path}` |
| `PUT /api/actions/{id}` | `{content}` 原文 | `{id,warnings[]}`（解析+校验+原子写） |
| `DELETE /api/actions/{id}` | — | `{removed}` |
| `POST /api/actions/validate` | `{content}` | `{ok,errors:[{line,reason}]}`（面板实时校验，不落盘） |
| `POST /api/actions/from-skill` | `{skill}` | `{id,content}`（SKILL.md 有序列表 → steps，**只生成不写入**） |

实现约束：写盘只用 `backend.data_io.atomic_write_text`（`routers/typing.py` 已在用）；读取上限沿用 `READ_LIMIT_CHARS` 风格常量；解析器放 `backend/slate_yaml.py` 单独成模块，好被守卫脚本直接 import 测。

---

## 5. 前端契约

### 5.1 三个工具（`frontend/js/services/tools.js`，TOOLS 25 → 28；P0 只上前两个，实际 27 键，见 §10）

按 `tools.js:44` 的形状加三个 key：`name / description / params{type,description,required} / async execute(params, callCtx)`，返回 `{success, output}`（`tools.js:1491-1539`）。

| 工具 | 参数 | 行为 |
|---|---|---|
| `actions_list` | `tag?` | GET 目录，输出编号清单（照 `skill_search` `tools.js:308-346` 的样式） |
| `actions_read` | `action` 必填 | GET 详情 → 渲染成"标题 / 步骤 / 判据 / 输出要求"的分段文本 |
| `actions_write` | `action`, `content` 必填 | PUT；**先过 riskguard 审批**再发请求（同 `skill_run` `tools.js:374` 的门） |

三个都要进 `buildOpenAITools`（`tools.js:1725-1744`，自动遍历）与 `CORE_AGENT_TOOLS`（`tools.js:1067`）的取舍判断。

### 5.2 目录注入：位置与预算（两个已知坑）

- **预算**：一行一条，`- <name>：<description>`，最多 20 条、每条 description 截到 60 字，超出补一句"另有 N 个 Action 未列出，用 actions_list 查看"。约 1.4k 字符 ≈ 470 token。不注入正文。
- **位置**：必须插在 `adapter.js:171` 的 `getToolsSystemPrompt(...)` **之前**。因为 `context_meter.js:22-26` 的 tools 桶是靠长度**反推**的，追加在它之后的内容会被误记成"工具目录"。
- **对话态**（`withTools === false`，`adapter.js:166-169`）不注入目录——那一条链路本来就没有工具，注入了只会诱导模型伪造 ◈◈◈（`adapter.js:145` 的注释就是为此写的）。
- **纪律句**：目录抬头必须写"与用户当前要求不符时不要套用 Action"。项目刚修过一次"提示词自相矛盾"（`27939f9`），这类"照本宣科"是同源风险。

### 5.3 面板与状态

- `frontend/js/store.js`：加 `actions: []` + `setActions()`（照 `boardCards`/`setBoardStrokes` 的写法，`store.js:627-647`），并加进 `serializeForBackend` 之外的**不持久化**类——磁盘已是真源，不要双写 localStorage。
- `frontend/js/components/skill_panel.js`：`renderSkillList`（`:252-284`）现在是三段（内置/自定义/远程），加第四段 "Actions"；每项点开进**可编辑** modal（现有 `openSkillViewer :375-393` 是只读的，这是 Actions 真正新增的 UI 能力），保存前调 `POST /api/actions/validate`，错误按行号定位到编辑框。
- `@mention`：接进 `chat.js` 已有的 `openMentionPicker`，提及 Action 时插入 `actions_read` 的输出，**并且必须加截断上限**（现在 SKILL.md 提及是 `chat.js:780-791` 无上限直灌，别再复制这个缺陷）。
- `frontend/index.html` + `frontend/js/services/i18n_dict.js`：新区块文案双语；若沿用"实验性标记"样式（`api_test`/`typing_game` 那批新区块就是这么标的），首版建议打上。
- 缓存串：本轮改动后要 bump `?v=20260913-001` → 新值，全量 295 处 + `scripts/`，随后跑 `check_frontend_integrity`（需要 ripgrep 在 PATH）。

---

## 6. 安全与风控（"让模型配置"是这里唯一的高危面）

1. **写入即改写指令面**：模型能写 Action，就能把一条错误流程固化成以后每次都读的说明书。所以 `actions_write` 必须走 riskguard 审批弹窗（用户明示确认），并在面板上把 `author: model` 显式标出来 + 提供"查看与 SKILL.md 同级的原文"。
2. **目录穿越**：id 先 `_sanitize` 再拼路径，写前 `resolve()` 校验仍在 `data/actions/` 内；`path` 类字段（`output.path`）**只当字符串读，后端不打开它**。
3. **留底**：`atomic_write_text` 之前把旧内容进 `.history/`，每 id 5 版，给用户"我反悔了"的出口。
4. **禁写内容**：Action 文本里出现明文 Key 时（照 `code_scan` 的密钥正则口径）`validate` 返回 warning；`raw`/`path` 不进日志（同 `error_sink` 只存 origin+pathname 的处理）。
5. **不新增执行权限**：Action 不携带可执行代码，`steps[].tool` 只是建议名；真要执行仍然走 `skill_run`/`file_edit`，从而继续受既有高危命令双层拦截（`backend/skills/terminal.py`、`sandbox.py`）。这是 D2 的直接收益。
6. **体积/数量**：单文件 64 KB、steps ≤ 24、inputs ≤ 8、目录注入 ≤ 20 条，全部写进 `scripts/check_actions_contract.mjs` 的可断言常量。

---

## 7. 逐文件改造清单

| 文件 | 动作 | 内容 |
|---|---|---|
| `backend/slate_yaml.py` | 新增 | SAY-1 解析器 + `ActionSpec` 校验，返回结构化错误（行号+原因） |
| `backend/routers/actions.py` | 新增 | §4 六条路由 |
| `backend/main.py` | 改 | import + `include_router(actions.router, prefix="/api")`（紧跟 `:79` 那批） |
| `backend/routers/skills.py` | 改 | `GET /api/skills` 的 `data` 增 `actions` 段，或在 `from-skill` 里单向读；**不改现有执行分支** |
| `frontend/js/services/tools.js` | 改 | +3 工具、目录注入文本块、`CORE_AGENT_TOOLS` 判断、`TOOL_USE_RECIPES` 加一条"有对应 Action 时先 actions_read" |
| `frontend/js/services/adapter.js` | 改 | `buildSystemContent` 在 `:171` 之前拼 `[可用 Actions]` |
| `frontend/js/store.js` | 改 | `actions` state + `setActions` |
| `frontend/js/components/skill_panel.js` | 改 | Actions 段 + 可编辑器 + validate 前置 + `.history` 回滚入口 |
| `frontend/js/components/chat.js` | 改 | `@mention` Action；提及插入带上限 |
| `frontend/index.html` / `css/style.css` / `services/i18n_dict.js` | 改 | 区块、样式、双语词条 |
| `scripts/check_actions_contract.mjs` | 新增 | 子集 fixture（含 5 条禁止构造）、上限常量、路由注册、目录注入位置、前端不再引入 YAML 解析器 |
| `README.md` / `README-zh.md` / `GUIDE.md` / `docs/guide.html` | 改 | ~~工具计数 25→28~~ **不改动数字**（两套口径，见 §10 第 2 条），只新增 Actions 说明段落与能力总清单条目 |
| `SLATE.spec` / `SLATE_macos.spec` / `SLATE_InnoSetup.iss` | 待评 | 见下 |

打包注意点：`SLATE.spec:21-23` 已把 `backend/routers`、`backend/skills`、`backend/workflows` 整体作为 datas 收进去，新增 `actions.py` 与 `slate_yaml.py` 属于 `backend/` 根包——**需要确认 `backend/*.py` 是否被 Analysis 自动扫到**（`main.py` 直接 import 就会进依赖图，正常无需 hiddenimports）。这与上一轮 `diagnostics.py` 的判断同构。因为坚持 D3 不加 PyYAML，也避开了 `trafilatura hiddenimports` 那类前科。

---

## 8. 分期与验收

- **P0（最小可用，只读）**：`slate_yaml.py` + `GET /api/actions`、`GET /{id}` + `actions_list`/`actions_read` + 系统提示一行式目录 + 面板只读列表与手写 `.yml` 生效。用户拿记事本就能建 Action，模型能读能照做。**P0 不含写入、不含编辑器**。
- **P1**：面板可编辑 + `validate` + `PUT/DELETE` + `actions_write`（riskguard 审批）+ `.history` 回滚 + `@mention`。
- **P2**：`from-skill` 转换、inputs 表单驱动"运行"按钮（把 steps 渲染成待办清单打勾，仍由模型执行）、Action 使用次数统计（接 `agent_ledger.js`）。

验收必须包含（沿用项目既有验证配方）：

1. 静态：`check_mojibake`、`check_frontend_integrity`（rg 在 PATH）、`check_actions_contract`，以及全套 9 个既有守卫不回归；
2. 端到端：隔离 `SLATE_DATA_DIR` + Python Playwright 驱动系统 Edge + `page.route("**/api/proxy/chat")` 假 SSE，跑通"手写 `.yml` → reload → 目录出现 → Agent 发一句触发语 → `actions_read` 被调用 → 步骤文本进上下文"；
3. 边界用例：SAY-1 禁止构造逐个报错带行号；id 传 `../evil` 被拒；40 KB 步骤正文不炸栈（本轮刚修的 `Math.min(...)` 教训：任何目录统计一律逐元素扫描）；对话态不出现 Action 目录、也不伪造调用块。

---

## 9. 明确不做

- 不做确定性 DAG/并行编排（`backend/workflows/` 已有，两套编排必然漂移）。
- 不做云端同步/多设备 Action 合并（`.yml` 进 git 由用户自己管）。
- 不让 Action 携带可执行脚本、模板变量求值或沙箱运行时。
- 不引入 PyYAML / js-yaml。
- 不做移动端（`frontend/m.html` 一贯不在范围内）。

---

## 10. P0 落地记录（2026-09-13）

已交付（只读链路）：

| 部位 | 落地内容 |
|---|---|
| `backend/slate_yaml.py` | SAY-1 解析器 + `validate_action` / `load_action`，`SayError` 带行号 |
| `backend/routers/actions.py` | `GET /api/actions`、`GET /api/actions/{id}`、`POST /api/actions/validate` 三条只读路由；`_clean_id` 先消毒再拼路径，`_action_path` 要求 `resolve()` 后仍在 `data/actions/` 内，单文件 64 KB 上限 |
| `frontend/js/services/tools.js` | `actions_list` / `actions_read` 两个工具 + `TOOL_USE_RECIPES` 的"先读再动手"一条 |
| `frontend/js/services/adapter.js` | `getActionsSystemPrompt()` 紧贴在 `getToolsSystemPrompt()` **之前**注入（与 §5.2 的位置要求一致），对话态整段跳过 |
| `frontend/js/store.js` | `actions: []` + `setActions()`，不入 `serializeForBackend`（磁盘是真源） |
| `frontend/js/components/skill_panel.js` | 设置页第四段 Actions：只读列表 + 计数 + 坏文件原因 + 点条目弹窗看 yml 原文与路径，无执行按钮 |
| `scripts/check_slate_yaml.py`、`scripts/check_actions_contract.mjs` | 两个新守卫：子集禁止构造逐个断言；工具注册、上限常量、路由注册、注入位置、前端不引入 YAML 解析器 |

与草案的偏差（以下五条以本节为准）：

1. **工具数不是 28**。§5.1 写"三个工具、TOOLS 25 → 28"，P0 按 §8 的分期只上 `actions_list` / `actions_read`，`actions_write` 连同 riskguard 审批留在 P1。`tools.js` 的 `TOOLS` 现为 **27 键**。
2. **文档里的"34 个内置工具"与前端 27 键是两套口径，都对**。34 == `backend/routers/skills.py::BUILTIN_SKILLS` 的长度（已实测），指可被调用的内置技能；前端 `TOOLS` 是模型可见的工具 key 数。§7 那句"README/GUIDE/docs 工具计数 25→28"**不执行**——那样改只会把两个口径重新搅浑。本轮只在这几处补 Actions 说明段落。
3. **坏文件的原因带行号**。草案只要求 broken 列表"可见"，实现里 `_load_all` 与详情路由都改用 `str(exc)`（`SayError.__str__` 渲染「第 N 行：原因」，`line == 0` 时自动去掉前缀），所以记事本改坏一个 yml，面板和模型拿到的都是「第 4 行：不允许使用 Tab 缩进」这类可定位的话。
4. **`validate` 提前到 P0**（原计划 P1）。它不落盘、纯试校验，是"改坏 yml 时看得懂报错"的前置能力，跟着只读链路一起上没引入新的写入面。
5. **守卫从 9 个长到 14 个**。§8 验收里的"9 个既有守卫"是写草案时的数量，现在的回归基线是 14 个全绿。

P0 验收结果：隔离 `SLATE_DATA_DIR`（23 份合法 + 2 份坏文件夹具）+ 真 Edge 会话 + `page.route` 假 SSE 的走查 **47 项全过**，覆盖"面板计数 → 行号原因 → 弹窗原文与路径 → 两个工具真跑 → 提示词恰好 20 条且长描述截到 60 字 → 对话态整段不注入 → 主链路回归 + 全程零 `js_errors`"；只读边界在 HTTP 层机器验证（`POST/PUT/PATCH/DELETE` × 两个地址共 8 次全部 404/405，目录字节不变）；14 个守卫全绿；缓存串 bump 至 `20260913-003`。

未落地，等明确指令：P1（写入 + 审批 + 编辑器 + `.history` + `@mention`）、P2（SKILL.md → Action 转换、inputs 驱动的待办清单、使用次数统计）。

（本节以上一条已被 §11 取代：P1 已落地。）

---

## 11. P1 落地记录（2026-09-13）

已交付（写入链路 + 审批 + 编辑器 + 回滚 + 提及）：

| 部位 | 落地内容 |
|---|---|
| `backend/routers/actions.py` | 新增 `PUT /api/actions/{id}`、`DELETE /api/actions/{id}`、`GET /{id}/history`、`GET /{id}/history/{ts}`、`POST /{id}/history/restore`，加 P0 三条共 **8 条路由**。`_write_action` 是 PUT 与回滚**共用**的唯一落盘点：体积 → SAY-1 → 留底 → `atomic_write_text`。`_backup` + `_prune_history` 维护 `data/actions/.history/<id>.<ts>.yml`，`HISTORY_KEEP = 5` |
| `frontend/js/services/tools.js` | 第三个工具 `actions_write`（`TOOLS` 现为 **28 键**，进 `CORE_AGENT_TOOLS`，**不进** `FILE_RAW_TOOLS`）。闸门次序：id 白名单 → `POST /actions/validate` → `author: model` → 审批弹窗 → `PUT` → `refreshActionSnapshot()` → 回执尾句「Action 只是流程约定，本次任务仍要按步骤实际执行并完成验证。」 |
| `frontend/js/components/skill_panel.js` | `#action-modal` 编辑器（＋ 新建先 `dlgPrompt` 问 id）+ 抬头 SAY-1 书写纪律 + 实时校验（`setTimeout` 节流 + `actionDraftSeq` 竞态守卫，慢响应不得盖掉新内容）+ 删除（`dlgConfirm` 二次确认）+ 历史清单/查看原文/回滚；`refreshActions` 导出 |
| `frontend/js/components/chat.js` | `@` 候选加 `kind: "action"`，点选插入 `@id `；提及注入上限 `ACTION_MENTION_LIMIT = 6000`（`chat.js:773`），超限截断并指回 `actions_read id=<id>` |
| `frontend/index.html` / `css/style.css` / `services/i18n_dict.js` | 编辑器与历史区块的骨架、样式、双语词条 |
| `scripts/check_actions_contract.mjs` | **改写**（不是加第 15 个守卫）：从只读契约升级为「写入三道闸 / SAY-1 单点解析 / 目录注入预算 / @mention 上限」。顺序类断言一律限定在函数体切片内——整文件 `[\s\S]*` 会跨函数凑出一次假成功，删掉 `_write_action` 的校验都不红 |
| `scripts/check_frontend_integrity.mjs` | 缓存串一致性检查扩到 `scripts/*.mjs` 的 `?v=` pin，见本节末段 |

与草案的偏差（以下以本节为准）：

1. **审批弹窗不是无条件的**。§6.1 写"`actions_write` 必须走 riskguard 审批弹窗"，实现照的是项目既有的权限模式语义：`state.permissionMode` 为 `auto`/`full` 时不弹，只有「询问」档弹（`okText: 允许写入` / `cancelText: 拒绝`）。理由：同一张工具表上的写入工具本来就是这套档位口径，Action 单独强制弹窗会让全自动档多出一个关不掉的对话框。
2. **`author: model` 从"面板标注"升级成硬前置**：校验通过后、弹窗之前，草稿没写 `author: model` 就直接拒写并回一句解释。这样面板的「模型代写」徽标不会是装饰——模型写的必然带得起来。
3. **`.history` 时间戳是定宽本地时间** `%Y%m%dT%H%M%S`，同秒碰撞补 `-N`。定宽使字典序 = 时间序，清单排序不必解析日期。
4. **回滚必须再过一次 SAY-1**：`restore` 走同一个 `_write_action`，所以手工改坏的留底版本回 `code -1` 且磁盘一字节不动（宁可让用户去改文件，也不把坏内容盖回可用位）。
5. **留底失败不废写入**：`_backup` 内读取与写入分两段 `except OSError`，只 `logger.warning` 并回空串，响应里 `backedUp: ""` 如实说明"这次没留成底"。用户点了保存就该落盘，留底是附加保险而不是前置条件。
6. **`actions_write` 不进 `FILE_RAW_TOOLS`**（那张表只有 `file_create`/`file_append`，语义是"结果按原文透传不折叠"）。
7. **「未写 id：以文件名（<id>.yml）作为 id」这条 warning 只在 `/actions/validate` 出现**。`spec_id = action_id or raw["id"]`，而 `PUT` 带 `action_id`，故只有草稿态会报。直接后果：面板新建态的提示条是黄的，保存一次才转绿。这不是缺陷（它说的正是"文件名即身份"），走查按"黄 → 补 `id:` 后转绿"两态各断一次。
8. **`TOOLS` 27 → 28 键，文档里的"34 个内置工具"照旧不动**（§10 第 2 条的两套口径）。
9. **§10 末尾"POST/PUT/PATCH/DELETE 全部 404/405"这条在 P1 后不再成立**，走查改断言更窄的不变量：集合级 `POST /actions`、`PATCH /actions/{id}`、`DELETE /actions`、以及漏掉 `history` 段的 `restore` 仍然不存在，且这些请求一个字节都不落盘——写入面只认"按 id 打"。

**本轮修掉的一类假红**（不是 Actions 的 bug，但会反复咬人）：`scripts/*.mjs` import 前端模块时也带着 `?v=` 串，而 **Node 按含 query 的完整 URL 决定模块实例**。仓库里这些 pin 长期落后（HEAD 中是 `20260912-002`、`20260913-001`），串一落后守卫与应用就各拿一份 `store.js`：`check_agent_loop.mjs` 往自己那份 `state` 写 `currentConversationId`，kernel 读的是另一份（`null`），第 1 个用例就报"会话已切换"——看起来像骨架语义被改坏，其实是同一模块被加载了两次。已把 10 处 pin 统一到 `20260913-004`，并让 `check_frontend_integrity` 的缓存串检查把 `scripts/*.mjs` 一起扫进去：以后 bump 少改一处，会在这条守卫上直接报出文件名，而不是伪装成别处的语义断言失败。浏览器侧的同类断言（"页面模块 URL 与走查版本串一致"）P0 就有，这次补的是 Node 侧。

P1 验收结果：隔离 `SLATE_DATA_DIR`（23 份合法 + 2 份坏文件夹具）+ 真 Edge 会话 + `page.route` 假 SSE 的走查 **共 128 项、失败 0**。HTTP 层覆盖"坏内容上不了盘 / 覆盖与删除必先留底 / 连续覆盖只留 5 版 / 误删凭留底整份捞回 / 编码穿越读不到目录外文件且不 500"；界面层覆盖"书写纪律抬头 → Tab 缩进报第 4 行并拒绝保存 → 保存后转绿并回显留底号 → 历史查看与回滚真的换回磁盘 → 删除二次确认 → `actions_write` 缺 author 与坏 YAML 不弹窗直接退回 → 弹窗内点「拒绝」确实不写盘、点「允许写入」才创建并标出「模型代写」→ `auto`/`full` 两档不弹窗 → `@` 提及命中与 6 000 字截断 → 主链路回归 + 全程零 `js_errors`"。首轮跑出两条真红并已修（① 非法 ts 实际由路由层先挡下返回 404，不是我们的信封；② "改绿"那条按上面第 7 条重写）。契约守卫的顺序不变量做过现场变异验证：把 `_write_action` 里的 `load_action(` 改名，守卫精确报「顺序必须是 体积→校验→留底→原子写」，改回后转绿。14 个守卫全绿；缓存串 `20260913-004`。

未落地，等明确指令：P2（SKILL.md → Action 单向转换、`inputs` 驱动的待办清单、Action 使用次数统计）。
