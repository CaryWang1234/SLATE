# SLATE 多项目 / 多任务管理 设计草案 v0.1（未实施）

需求原话：「现在SLATE的项目需要手动打开/关闭/切换，与现在市面上的Agent的多项目、多任务管理相差甚远，帮我设计一个方案」

本文件只做设计：概念协议 + 现状映射表 + 逐文件改造清单 + 分期验收。**不含任何代码改动**。落地前 §0 的五条要先拍板。

---

## 0. 五条待拍板

| # | 决定 | 推荐值 | 为什么这是分水岭 |
|---|---|---|---|
| D1 | "多项目"要做到哪一层 | **三层分开**：① 项目注册表（在册/最近/固定，一眼切换）② 每个项目的任务可见（会话归组 + 在跑/需操作）③ 多会话真并行。①② 无并发风险，③ 才动循环 | ①② 是纯整理，③ 要改 `isGenerating` 全局单例与切会话即 abort 的语义 |
| D2 | 并行任务同项目时怎么防互相覆盖 | **默认同项目串行（1 并发）、跨项目并行（≤2）**；要同项目并行就开 worktree 模式（P3） | 不做隔离就并行 = 两个 run 同时 `file_edit` 同一文件，坏了还查不出是谁干的 |
| D3 | 切换会话是否还中断生成 | **不再中断**：run 离开视野继续跑，结局落到任务中心；`停止` 仍是显式按钮 | 这条改了用户已经熟悉的"切走就停"，必须在设置里给回退开关（`backgroundRuns`，默认开） |
| D4 | 会话归属项目的记法 | 新增 `project_id`（路径派生的稳定 id），旧的 `project`（名称字符串）列保留只做展示并一次性回填 | 现在按**名称**归组：两个同名项目、改名、移动目录，都会把历史搅成一团（`chat.js:3846` 传 `state.project?.name`） |
| D5 | 模型能不能自己开任务/切项目 | 先只给只读 `projects_list`（我在哪些项目上有活、各自最近状态）。派工（"在 X 项目上起一个任务"）等 P3 的 worktree 到位后再放开，且必过审批 | 让模型跨项目写盘，风险从"改错文件"升级成"改错仓库" |

---

## 1. 需求逐句 → 契约

| 用户表述 | 展开成的契约 |
|---|---|
| "需要手动打开" | 项目是**在册**的：`data/projects.json` 存注册表，任何一次开过的项目都留在册，重开不用重新找路径；开项目=把它设为"正在看的那一个"，不需要"打开对话框 → 输路径 → 确定"这条仪式 |
| "关闭" | 关闭 ≠ 丢失：关闭后它的会话、看板、后台任务、宪法、在跑的 run 都还在，随时回来接着看；"从最近里移除"与"删数据"是两件事，UI 上不许合并成一个按钮 |
| "切换" | 一次点击切换，且**回到上次离开时的现场**：该项目的上一条会话、滚动位置、输入框草稿、看板、终端 cwd。切换不许静默停掉另一个项目的在跑任务 |
| "多项目管理" | 侧栏两级：项目 → 该项目的会话/任务；跨项目有一张"任务中心"（需要操作 / 在跑 / 完成未看），点一行跳回对应项目+会话 |
| "多任务管理" | 一个任务 = 一场会话的一次运行（run），有明确生命周期：排队 → 进行中 → 需要操作 / 出错 / 已完成未查看 → 已查看。状态是**事件算出来的**，不是散落各处手工翻转的 |
| "与市面上相差甚远" | 对齐三件市面共识：项目是持久编排层（不是当前目录指针）、任务按项目归组且能在别处看全局、并行要么隔离要么串行，不赌运气（对照见 §2.2） |

---

## 2. 现状映射表

### 2.1 后端与持久层（今天"单活动项目"这件事具体长在哪）

| 事实 | 位置 | 影响 |
|---|---|---|
| 项目状态是一个模块级单例，注释自己写着"内存态，重启丢失" | `backend/routers/projects.py:29` `_current_project` | `/open` 直接覆盖、`/close` 置 None（L244/L268），没有任何"列表 / 并存 / 按项目寻址"能力 |
| 除 open/close/root/workspace 外，全部路由隐含读那个单例 | `projects.py` `/browse:377` `/git/graph:591` `/find:755` `/apply-edit:825` `/create-file:866` `/append-file:909` `/understand/scan:1009` | 去单例要一处一处给它们加可选 `project` 参数，不能只改 open |
| 项目配置住在**仓库里**：`<项目>/.slate/config.json` 的 `kind/folders/root/constitution/understanding` | `projects.py:102-122` `_project_info()` | 身份与规则该跟着代码走（现状正确），SLATE 私有状态不该写进用户仓库 |
| 会话表有 `project TEXT DEFAULT ''`，存的是**项目名**，无索引、无过滤参数 | `backend/routers/chat.py:54,62-63,129`；唯一写入点 `POST /chat/conversations:254-266` ← `frontend/js/components/chat.js:3842-3847` | 分组只在前端做（`task_list.js:141`）；改名/同名/移动目录就错乱；会话多了以后全量返回 |
| 前端把"上次项目路径"当唯一记忆点 | `store.js:224` `lastProjectPath = workspace_dir \|\| path`，`app.js:2007-2014` 启动重放 | 只有 1 格记忆；没有最近列表（`project_bar.js:139-166` 打开弹窗时只预填这一条） |
| 关闭项目只 `setProject(null)`，不停生成、不动会话、不刷列表 | `project_bar.js:200-207` | "关闭"语义现在是"我看不见了"，正是要升级的地方 |
| 后台任务记 `work_dir` 但不记项目/会话 | `backend/skills/bg_task.py:91-94,352`，事件由前端领回后注入"当时的当前会话" | 切了项目之后回来的事件会进错场次 |
| 定时任务完全没有项目维度：字段里没有 work_dir/project，产生的会话 `project=''` | `backend/routers/scheduler.py:444-464`，`create_conversation` 于 L358 不传 project | 事件模式已经在读 `watch_paths`/`git_repo`（L134/L230），离项目只差一个 id |
| 作用域现状：宪法=全局 `data/constitution.json` + 项目 `.slate/config.json.constitution`（**在前端合并** `store.js:1032-1035` `effectiveConstitution()`）；actions / 知识库 / 记忆 / MCP / 模型设置 = 全全局 | `routers/constitution.py:16-17`、`routers/actions.py:40`、`routers/knowledge.py:33-44`、`mcp_client.py:26` | "分项目"已有先例与合并口径（`effectiveX()`），扩到别处是照抄，不是新发明 |
| 服务端唯一自己读项目的技能 | `backend/skills/code_search.py:109-119`（未打开项目直接报错） | 它必须先参数化，否则并行时它只看得到 active |

### 2.2 前端与并发闸门（决定 D1 的③有多贵）

| 事实 | 位置 |
|---|---|
| 全局同一时刻只允许一场生成，且状态是 chat.js 的模块级单例 | `chat.js:40` `isGenerating`、`L41` `activeGenerationController`、`L42` `activeGenerationConvId`（注释原文：切换/新建会话时中断旧生成，防止串写）、`L43` `inputQueue` |
| **切换会话即掐断在跑的循环**；新建会话同样 | `chat.js:4808`、`L5483`；另有 `L1961`、`L4222`、`L5303` |
| 排队而非并行：生成中发的新消息进 `inputQueue`，结束后串行消费 | `chat.js:3777-3785`、`L4113` |
| 会话四态纯函数已就位（进行中/需要操作/出错/已完成未查看），"进行中"取实时 `activeConvId` 且**绝不落库** | `frontend/js/services/task_list.js:75-86`、`STATUS_MARKS:20-26` |
| 按项目分组已存在，但只在 Codex 侧栏；classic 两处列表都是扁平 | `task_list.js:141` `groupConversationsByProject` ← `app.js:1510`；classic `chat.js:4521` |
| Codex 项目组头没有任何操作（不能就地新建/重命名/移除/静音） | `app.js:1533-1561` |
| 真并行的只有后端 bg_task（进程级，前端轮询快照 + ack），移动端另有自己独立的 `isGenerating` | `services/bg_tasks.js`、`chat.js:5509-5524`、`m-chat.js:652` |
| 内核已抽出来了：agent 循环在 `services/agent_loop.js`，桌面/手机共用 | `agent_loop.js` + `agent_common.js` |

> 好消息：循环已经是 kernel 化的，"多 run" 是把 `isGenerating` 这一层壳拆掉，不是重写引擎。

### 2.3 市面共识对照（设计借的三条，其余不抄）

| 别家在怎么做 | 关键事实 | SLATE 对应位置 |
|---|---|---|
| 项目=持久编排层：跨会话保留上下文与工程指令，一个界面里发起并监视多个并发执行环境，AI 当"定目标→派工→收结果→拼合"的导演 | Anthropic 把这套叫 Claude Code Projects（2026-09 beta） | §3 注册表 + §5.4 任务中心 + §3.6 每项目现场恢复 |
| 并行任务的隔离=物理隔离：**一个任务 = 一个 worktree = 一个隔离目录 + 专属分支**，收工后人工挑选/合并，失效就 `worktree remove` + `branch -D`；审查用行内 diff 批注回灌模型 | Orca 与多篇单机 worktree 工作台的共同形状；已知坑：交互式 TTY 需要 PTY 层 | §6（P3），并明确复用现有 `terminal`/`git_tool`/Code Review 的 diff 面 |
| 完成/需要人时把信号送到别处（手机伴侣通知），人不必盯着 | Orca 的 companion app | SLATE 已有局域网移动端 + `notifyTaskComplete`，缺的是"这条事件属于哪个项目哪场会话"（§3.4） |

---

## 3. 概念与数据协议

### 3.1 三个词，各管一件事（先把语言钉住）

| 词 | 定义 | 唯一性 | 生命周期 |
|---|---|---|---|
| **项目 Project** | 一个在册的代码目录或工作区宿主（`kind: folder \| workspace`） | `project_id` 稳定 | 加入册 → 活跃/闲置 → 归档（不删数据）/ 移除（只从册上摘） |
| **会话 Conversation** | 一场对话，创建时就固定在某个项目上 | `conversation_id` | 已有语义不动 |
| **运行 Run** | 某人发一条消息后，某场会话里跑起来的一次 agent 循环（含 `bg_task` / 定时任务产生的运行） | `run_id`（`convId` 派生） | queued → running → needs_you / failed / done → seen |

**只有一个是"正在看的那一个"**：`active_project_id`。刻意保留这条——上一轮做工作区时定下的"任何时刻只有一个当前根"的口径不被推翻，文件工具、`code_search`、Git 树、终端 `work_dir`、范围校验全都沿用单根语义，不发明第二套路径口径。变化在于：**当前根之外还有 N 个项目在册、M 个 run 在跑**。

### 3.2 `project_id`：路径派生 + 别名，而不是随机 UUID

```
real      = 解析宿主目录（工作区取 workspace_dir，普通项目取 path）后的绝对路径，去掉尾部分隔符
project_id = "p_" + sha1(real.replace("\\", "/").lower())[:10]
```

- 为什么路径派生：重开同一个文件夹必须落回同一个身份，不需要查表；查表失败的兜底才可怕。
- 代价是**目录一搬 id 就变** → 注册表带 `aliases: [旧 id]`，`/open` 时按路径命中新 id 就把旧 id 记进 aliases，历史会话按 `project_id` 反查时两个都认（`chat.py` 的 `GET /chat/conversations` 支持 `?project_id=` 内部展开别名）。
- 禁止用项目名当身份（今天的做法），名只用于显示，重名在册表里靠路径尾段区分显示。

### 3.3 `data/projects.json`（服务端状态，不进 `desktop_state.json`）

```jsonc
{
  "version": 1,
  "active": "p_3f2a91c0dd",
  "projects": [{
    "id": "p_3f2a91c0dd",
    "path": "C:/Users/caryw/Desktop/codes/SLATE",   // 工作区＝宿主目录
    "name": "SLATE",
    "kind": "folder",
    "added_at": 1777..., "last_opened_at": 1777...,
    "pinned": true, "archived": false,
    "aliases": ["p_旧id"],
    "prefs": {                        // SLATE 私有、可跨设备同步的那一份
      "last_conversation_id": "conv-...",
      "draft": "",                    // 输入框草稿（截断存 2KB）
      "scroll": 0.62,                 // 相对位置，窗口尺寸变了也不错位
      "board_id": "default",
      "muted": false,                 // 静音=不提醒，不等于停任务
      "model_id": "",                 // 进这个项目时的默认档；空=跟全局
      "constitution_scope": "inherit" // inherit | project（沿用 effectiveConstitution 口径）
    }
  }]
}
```

- 写盘：与 `scheduled_tasks.json` 同法（临时文件 + `os.replace`），一次一处写，读不到/坏掉按"只有 active 那一项"降级，绝不因为注册表坏了就打不开项目。
- `prefs` 走 `settings.py` 的 allowlist 同步到共享状态（`projectsPrefs`，按 id 键；本机才有的东西——比如"这个 run 是不是我正在看的"——继续留在 localStorage，沿用"未读是本机概念"那条注释的口径，`store.js:409`）。

### 3.4 事件要有出处（`needs_you` 的第一前提）

今天 bg_task 的事件是"注入当时的当前会话"。加两个必填维度：

```jsonc
{ "event_id": "...", "kind": "run_needs_you | run_finished | run_failed | bg_task_finished",
  "project_id": "p_...", "conversation_id": "conv-...", "run_id": "...",
  "at": 1777..., "summary": "要审批：rm -rf dist/", "ack": false }
```

`taskStatusOf()`（`task_list.js:75`）改成读这份事件表 + `runs`，而不是散落的 `state.taskFlags`；`flag.at` 早于 `updated_at` 即作废的那条规则保留（它防的就是陈旧标志）。**取走即清、池子封顶**照抄 bg_events 已有的两条不变量。

### 3.5 runs（前端，新增 `services/run_registry.js`）

```js
// 唯一真源：Map<run_id, {run_id, conv_id, project_id, controller, phase, started_at, last_event_at}>
startRun({convId, projectId}) -> run   // 拿到 controller，登记进表
isGenerating(convId?)                  // 不传=任一场在跑；传=这场是否在跑（兼容旧调用点）
abortRun(runId)                        // 显式，唯一的停止口
canStart({projectId}) -> {ok, reason}  // 两条上限：跨项目 maxParallelRuns、同项目 maxConcurrentRunsPerProject
```

默认：`maxParallelRuns = 2`、`maxConcurrentRunsPerProject = 1`（D2）。超限时**不拒绝**，进队列并在界面上写明"排队中·等 SLATE 的那场跑完"——静默吞掉请求是最坏的一种"贴心"。

### 3.6 每项目现场恢复

切项目 = 一次性还原四件事：`last_conversation_id` 的会话、`draft`、`scroll`、`board_id` 的看板；缺任何一项就跳过那一项，不报错。终端 cwd 不需要还原（`terminal.py` 已按 `session_id` 各存一份 cwd），但 `session_id` 要带上 `project_id` 前缀，否则切项目会串台。

---

## 4. 后端契约

### 4.1 路由（全部新增可选 `?project=`，缺省＝active，保证旧前端一行不改也不崩）

| 方法 路径 | 语义 | 备注 |
|---|---|---|
| `GET /api/projects/registry` | 列在册项目（含 active、每项目 `running/needs_you/unseen` 计数） | 任务中心与侧栏都读它，一次请求，不 N+1 |
| `POST /api/projects/active` `{project_id}` | 设为正在看的那一个 | 只改 `active` + `last_opened_at`；**不碰任何在跑的 run** |
| `POST /api/projects/open` `{path}` | 开路径：命中注册表→等价于设为 active；未在册→入册再 active | 把现有 `/open` 的"覆盖单例"降级成"入册+置 active" |
| `POST /api/projects/close` | 从视野里收起（写 `last_*` 后清 active），数据全留 | 现有"×"按钮接这条，语义与现在几乎一致 |
| `POST /api/projects/archive` `{project_id, archived}` | 归档：折叠出主列表，进"已归档"抽屉 | |
| `DELETE /api/projects/registry/{id}` | 从册上移除（`?forget=true` 才连带删 `data/projects/<id>/`，二次确认） | 移除 ≠ 删数据，UI 不许合并 |
| `PATCH /api/projects/registry/{id}` | `pinned/prefs/aliases` | `path` 不可改（要改路径请重新 open） |

`/browse /find /apply-edit /git/graph /create-file /append-file /understand/scan /review/diff` 一律接受 `project` 参数并交给 `_resolve_project()`；`_current_project` 那个模块变量改为只由 `_resolve_project()` 内部读 `projects.json` 的 active，**代码里不许再出现第二处直接引用**（守卫钉这条）。

### 4.2 会话与用量

- `conversations` 加列 `project_id TEXT DEFAULT ''` + 索引 `CREATE INDEX idx_conv_project ON conversations(project_id, updated_at DESC)`；一次性回填：`UPDATE conversations SET project_id = ? WHERE project = ?`（按注册表 name 反查，查不到的留空并在 UI 显示「未归类」——比猜一个项目诚实）。
- `GET /chat/conversations?project_id=&limit=`：给了就按项目（含别名）过滤，没给维持全量。
- `daily_usage(day, tokens)` 后面加 `by_project` 视图（`conversations.project_id` join 即可）：热力图/左栏徽标暂时不动，先让"这个项目这个月烧了多少 token"能答出来——这是多项目之后必然被问的第一个问题。

### 4.3 任务也要有出处

- `bg_task` 的 `BgTask` 记 `project_id`（由 `work_dir` 反查注册表得到，或由调用方显式传）；事件按 §3.4 带出处。
- `scheduled_tasks.json` 每条加 `project_id`；事件模式的 `watch_paths`/`git_repo` 在它缺省时从项目根展开；`create_conversation` 传 `project_id`（今天 L358 什么都不传，导致定时任务的会话无家可归）。

---

## 5. 前端契约

### 5.1 项目切换器（`project_bar.js` 改造，不是新增第二根栏）

- 现在那颗项目名按钮变成**可点开的切换器**：固定项 / 最近 8 项 / 「其他…（打开路径、新建工作区）」，每项右侧显示在跑小点与"需要操作 N"。
- 打开弹窗 `#project-open-modal` 保留，但顶部先给"在册项目"这一段（今天它只预填 `state._lastProjectPath`，`project_bar.js:139-166`）。
- 键盘：`Ctrl+Alt+P` 呼出切换器，`Ctrl+Alt+]` / `[` 在固定项之间轮换。绑定沿用 `app.js` 既有的快捷键注册处，不新开一套监听。
- 「×」从"关闭项目"改成"收起"，归档/移除进切换器项的右键菜单，文案明确区分"从最近移除"和"删除 SLATE 私有数据"。

### 5.2 侧栏两级（两壳同一份渲染）

- Codex：组头 `app.js:1533` 补操作（新建任务 / 静音 / 固定 / 收起 / 从最近移除），组内仍按现有排序偏好。
- classic：`chat.js:4521` 的扁平列表接同一个 `groupConversationsByProject(...)`（`task_list.js:141`），行内已有项目 chip（`chat.js:4552`）但列表本身不分组，顶栏加「按项目 / 按时间」二选一分段控件——今天分组只存在于 Codex，两壳行为不一致这件事顺手抹平。
- 分组函数继续做纯函数：输入 `convs + ctx{activeProjectId, registry, runs, flags}`，输出树；徽标/排序不许在渲染层现算（这条是上一轮四态徽章已经踩过的地方）。

### 5.3 「需要操作」进顶栏

顶栏一颗铃铛：`needs_you` 计数（跨项目）。点开是 §5.4 的收件箱视图，一行 = 一个 run，含项目名、会话名、等什么（审批原文 / 报错首行 / 完成待看）、两个按钮（去处理 / 就地停止）。**铃铛不弹窗，避免与高危审批弹窗抢焦点**：审批本身仍在原会话里，铃铛只负责带你过去。

### 5.4 任务中心（新页签，与「任务」「会话」并列）

三段：在跑（含排队）、需要操作、完成未看；再一个"最近 24 小时"抽屉。行内可：跳回项目+会话、停止、静音。数据源就是 `GET /api/projects/registry` 的计数 + `runs` + 事件表，**不新增一份后端表**——少一个移动件。

### 5.5 store 新增/改动

| 字段 | 落盘档 | 说明 |
|---|---|---|
| `projects`（注册表快照）、`activeProjectId` | 共享（`projectsPrefs`）+ 本机快照 | 单一真源在后端 `projects.json`，前端只读缓存 |
| `runs` | **不落盘**（照"进行中绝不落库"那条既有规则） | 页面刷新后 run 没了，但 `bg_task` 的进程还在，靠后端事件重新点亮"需要操作" |
| `maxParallelRuns`、`maxConcurrentRunsPerProject`、`backgroundRuns` | 共享 | 三个新设置项，都放「设置 → 多任务与项目」新区块 |

`state.project` 保留为"active 那一项的展开"，让今天所有读 `state.project.path` 的调用点不必一次性改完（渐进迁移，不制造 500 处 diff）。

---

## 6. worktree 隔离（P3，同项目并行的前提）

```
data/projects/<project_id>/worktrees/<branch_slug>/   ← git worktree add -b slate/<task_slug>
```

- 开任务时选"就地 / 隔离"。隔离＝该 run 的全部文件与终端根切到它的 worktree；`project_id` 不变（同一项目的不同现场）。
- 收工：复用 Code Review 那套 diff 呈现（`review.js` + `/review/diff`）→ 人工"合回"＝在 worktree 里 `git merge`/`apply`，SLATE 不代做提交合并之外的判断。
- 清理：`git worktree remove` + `git branch -D`，只允许对 SLATE 自己建的那批路径执行；守卫钉死"目标路径必须以 `data/projects/` 开头"。
- 明确边界：非 git 目录不许开隔离（直接拒绝并说明）；依赖没装（`node_modules`/`.venv`）时第一项提醒用户"新现场是干净的，需要先装依赖"，不自动装（那是不可逆的磁盘动作，按既有的"不可逆操作交给用户"规矩）；端口冲突不自动改端口，只提示。
- 交互式 TTY 在 worktree 里跑要 PTY，现有 `terminal.py` 是一次性 shell 调用，不承诺支持 `vim`/TUI 类程序——写进面板的说明里，别让用户踩了才发现。

---

## 7. 逐文件改造清单（P0+P1 为主）

| 文件 | 动什么 |
|---|---|
| `backend/routers/projects.py` | 注册表读写 + `_resolve_project(project=None)`；`/active /registry /archive` 新路由；把 8 个隐含读单例的路由改为可带 `project` |
| `backend/routers/settings.py` | allowlist 加 `projectsPrefs`；`desktop_state.json` 里不放注册表（它在 `projects.json`） |
| `backend/routers/chat.py` | `project_id` 列 + 索引 + 回填 + `GET /chat/conversations?project_id`；`create_conversation` 收 `project_id` |
| `backend/skills/bg_task.py` / `routers/bg_tasks.py` | `BgTask.project_id`；事件加出处与 `conversation_id` |
| `backend/routers/scheduler.py` | 任务字段加 `project_id`，`watch_paths` 缺省按项目根，会话带上出处 |
| `backend/skills/code_search.py` | `L109-119` 的单例读法改成参数 + `_resolve_project` 回落 |
| `frontend/js/store.js` | `projects/activeProjectId/runs` + 三个新设置项；`state.project` 语义不变 |
| 新建 `frontend/js/services/run_registry.js` | §3.5 全部 |
| `frontend/js/components/chat.js` | `isGenerating` 调用点改 `run_registry`（重点 L40/L43/L3777-3785/L4113/L4808/L5483）；**删掉"切会话即 abort"**，按 `backgroundRuns` 开关走旧行为 |
| `frontend/js/components/project_bar.js` | 切换器 + 收起语义 + 现场恢复 |
| `frontend/js/app.js` | Codex 组头操作；顶栏铃铛；任务中心页签；设置区块接线 |
| `frontend/js/services/task_list.js` | `taskStatusOf` 改读 runs+事件；`groupConversationsByProject` 输入多一个 registry（拿不到 id 时回落名称，兼容旧数据） |
| `frontend/index.html` / `css/style.css` / `services/i18n_dict.js` | 新页签与区块 DOM、样式、双语词条（中文原文为键） |
| `frontend/js/services/tools.js` | `project_info` 返回里加在册概览；新只读工具 `projects_list`；提示词里写"跨项目文件操作要显式给 project" |
| `frontend/js/mobile/*` | 移动端项目选择器（只列在册，切换=设为 active），不引入并行 |
| 新建 `scripts/check_multi_project.mjs`、`.qoder/walk_multi_project.py`、`.qoder/mutate_multi_project.py` | 见 §9 |
| `docs/*`、`README*.md`、`GUIDE.md`、`ACTIONS-DESIGN.md` 同族的根级 `PROJECT-TASKS-DESIGN.md` | 文案与计数同步（守卫会重算源码行数） |

---

## 8. 明确不做

- 不做多根并铺的文件树（上一轮定过：一个当前根）。
- 不做云同步 / 多人共享项目（本地优先）。
- 不自动 `git commit`、不自动合并、不自动装依赖、不自动改端口——凡不可逆的磁盘/版本动作，只提醒、由人执行。
- 不让模型跨项目写盘（P3 之前连读别的都要显式路径 + 审批）。
- 不把 `runs` 落库：进行中的东西落库就会在下次启动变成一个撒谎的"进行中"。
- 不新增数据库表承载任务中心（注册表 + 事件表 + runs 三样够了）。

---

## 9. 分期与验收

| 期 | 内容 | 可观测判据（走查/守卫） |
|---|---|---|
| **P0** 在册与切换 | `projects.json` + 注册表路由 + 顶栏切换器 + 现场恢复 + 会话 `project_id`（含回填与别名）+ classic 侧栏按项目分组 | ①打开 A→打开 B→切回 A，上一条会话/草稿/看板还原；②两个同名项目分组不串；③改名后历史仍在；④守卫钉"除 `_resolve_project` 外无人读单例" |
| **P1** 出处与收件箱 | 事件带 project/conversation/run；顶栏铃铛 + 任务中心；定时任务与 bg_task 挂上项目；`?project_id` 过滤；按项目 token 视图 | ①在 A 跑长任务→切到 B→A 的事件进 A 的那场会话而不是当前会话；②任务中心一行点得到、停得了；③`GET /chat/conversations?project_id=` 只回该项目 |
| **P2** 跨项目并行 | `run_registry` + 两条上限 + 「排队中」可见 + `backgroundRuns` 开关 + 同项目默认串行 | ①A、B 各跑一场，两条进度互不干扰、token 各记各的；②同项目第二个任务显示排队而不是被吞；③关掉 `backgroundRuns` 后行为与今天逐字一致（回归判据）；④变异：把"切会话不再 abort"下毒回 abort，走查必须咬 |
| **P3** 同项目隔离 | worktree 开/查/合/清 + 派工入口（此时才考虑让模型起任务） | ①两个任务改同一文件互不见面（哨兵文件核对）；②清理只动 `data/projects/` 下 SLATE 自建路径（下毒改前缀必须被拒）；③非 git 目录开隔离被明确拒绝 |
| **P4** 作用域收敛 | actions / 知识库 / MCP 的"全局 + 项目覆盖"，照 `effectiveConstitution()` 口径 | 项目覆盖存在时注入的是覆盖版；删覆盖后回落全局；两处 UI 都写明现在改的是哪一份（与分项目宪法同一套文案） |

每期收口都走同一套：新守卫 + 真浏览器走查 + 变异取证（串行跑，不许两个 harness 并行），然后 `?v=` 全量 bump、docs/README/GUIDE 计数同步、`check_docs_site.mjs` 实测比对。**打包与提交另等你发话。**

落地状态（2026-09-25）：

- **P0 已完成**：注册表 + 顶栏切换器 + 现场恢复 + `project_id` 分组。证据 `scripts/check_multi_project.mjs`、`.qoder/walk_multi_project.py`。
- **P1 已完成**：事件出处 + 铃铛 + 任务中心 + 按项目 token 视图。证据同上（X1..X5 判据）。
- **P2 已完成**：`services/run_registry.js`（生成权登记表）+ 每场一份消息数组（`store.threads`）+ 按 run 的项目视野（`services/project_scope.js`、`/projects/registry/{id}/info`）+ 「排队中」可见 + `backgroundRuns` 开关与两条上限（设置页「多任务与项目」）。证据 `scripts/check_parallel_runs.mjs`（44 项）、`.qoder/walk_parallel_runs.py`（31 项真跑）、`.qoder/mutate_parallel_runs.py`（9/9 咬住）。四档可观测判据逐条对上：①两场并行、线程/落库/用量各归各的（J1）；②同项目第二发进队列且被自动接上（J3）；③关掉开关后切走即中断（J5）；④把"切会话不再 abort"下毒回 abort，走查 J1 咬住。
  - 取证补记（P3 沿用）：把流式落点 `threadHostOf()` 下毒成"永远画到屏幕上"，只在**排队那一场于后台自动开跑**的那一刻看得见（走查 J4）——两条流都在自己前台起手时 `msgEl` 早已挂好，那是等价变异，证不出东西。
- **P3 / P4 待做**：同项目 worktree 隔离与合并审查；actions / 知识库 / MCP 的分项目覆盖。

---

## 10. 迁移与兼容

- 老数据零丢失：`project`（名称）列保留，`project_id` 一次性回填，回填不上的显示「未归类」并可手工归到某个在册项目。
- 第一次启动带注册表的版本：把 `lastProjectPath` 自动入册并置 active（用户不会感到"项目不见了"）。
- 移动端与桌面共享注册表（走 `settings` 的共享档），但 `active` 是本机视野——两台设备各看各的项目才叫多设备，不是一条状态线牵着走。
- 现有 26 个守卫里凡钉住 `state.project.path` / `_current_project` 语义的，逐条复核后放宽到新口径，别静默改判据。
