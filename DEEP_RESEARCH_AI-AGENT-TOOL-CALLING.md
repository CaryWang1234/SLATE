# 2026 年 AI Agent 工具流式调用调研 & SLATE「砚流 InkStream」设计方案

> 交付性质：**设计文档，不含任何代码实施**。生成日期 2026-09-06。
> 方法：deep 档多代理检索（4 路并行 + 1 路缺口补充 + 1 路引用抽查 + 1 路本地代码扫描），61 条来源，关键断言逐条回源核验。
> 置信标注：`[高]` 一手规范或多源交叉证实；`[中]` 一手但抽取不完整／两源；`[低]` 单一来源或片段级（`[snippet]`）来源。

---

## 0. TL;DR（先读这段）

1. **模型 API 层已经收敛**：工具调用参数以「有序字符串增量」下发、客户端拼接，三家（OpenAI Responses / Anthropic / Gemini）皆然，差别只在并行调用的解复用方式和「这次调用完成」与「这一轮完成」能否被区分 `[高]`。
2. **MCP 在 2026-07-28 做了一次方向反转**：从「有状态多路复用连接」转向「无状态请求/响应」——移除 session 与 `Mcp-Session-Id`、移除 `GET` 长连接流、**移除 `Last-Event-ID` 断线重放**，把长任务降级为扩展（Tasks Extension），并把 HTTP 上的取消语义定义为「关闭 SSE 响应流本身」。但**每请求 SSE 仍然合法**，`notifications/progress` 仍在 `[高]`。
3. **产品层的事实语法是「默认折叠 + 逐级展开」**，而**并行性是被挪出对话流解决的**（独立会话 / agent view 状态表 / 分屏 / worktree），不是在流内变可读 `[高]`。
4. **三层独立证据共同指向同一个缺陷——调用级可核验性**：没人流式渲染半成品参数、没人给单行工具标它自己的耗时与成本、没人把 trace 行链回它声称的证据、子代理中间过程按设计不可见 `[高]`。
5. **SLATE 的结构性事实与市面相反：agent 循环在前端，后端只是无状态执行器。** 因此市面协议要解决的「服务端→UI 传输」对 SLATE 不是问题；SLATE 的真实缺口是**执行期无进度、取消传不到执行器、参数增量到手即弃、事件不落盘不可回放、白板与卡片互为命令式副作用**。
6. **方案主线三条**：落笔即所见（schema-aware 容错参数渲染）、一次调用一条流且**关流即取消**（与 MCP 2026 语义天然同构、零新依赖）、墨迹账（事件日志为唯一事实源，聊天与白板都是它的投影）。

---

## 1. 方法论与已知局限

**检索结构**：四个并行子代理分别负责模型 API 层、MCP 协议层、产品交互层、编排框架/事件协议层；一个子代理扫描 SLATE 本地代码得到第八章的现状地图；MCP 传输语义因官方页面超时另起缺口代理，改用 `raw.githubusercontent.com` 拉取规范源文件（`docs/specification/2026-07-28/**.mdx`）取得逐字规范文本；最后由验证代理对 13 条片段级断言回源抽查。

**已更正的两处易错归属**（写作时务必不要写反）：
- 「fine-grained tool streaming」和 `defer_loading` / Tool Search 是 **Anthropic** 的机制，不是 OpenAI 的；OpenAI 侧对应的是 Responses API 的事件化模型与 `parallel_tool_calls` / `strict` `[高]`。
- MCP 会话移除归 **SEP-2567**；**SEP-2575** 是「让 MCP 无状态化」的总纲（同时废弃 `initialize` / `notifications/initialized`，新增 `server/discover` 与 `subscriptions/listen`，移除重放）。

**局限**：
- 中文公开资料在此主题上信噪比极低。本会话两次定向检索国内侧（Manus / Kimi / 通义 / 扣子）与一篇《Agent 推理链可视化》，返回几乎全是内容农场，且头条页面被 JS 反爬拦截取不到正文。因此**产品交互层证据全部来自英文一手厂商文档 + HN 一手评论**，国内产品做法仅作为无法引用的情绪信号，不进入结论。
- 四条断言未能回源核实，正文中显式标注 `[未核实]`：LangGraph 人机中断页（官方 URL 404）、Claude Code 权限规则缓存的具体生命周期、Claude Code 六种权限模式名称、OpenTelemetry `gen_ai.*` 属性名。
- 验证代理用尽配额，AG-UI 与 A2A 的**完整事件/状态清单**只做了差异核对，不是穷举。

---

## 2. 第 1 部分：市面调研

### 2.1 模型 API 层：参数增量的三家共识与三处分歧

**共识原语**：一次工具调用 = `开始` → N × `参数片段` → `结束` → 与调用 id 复用的 `结果`，全程靠一个 id 关联。

- **OpenAI Responses API** 是事件化最彻底的一家：`response.output_item.added` → `response.function_call_arguments.delta` × N → `response.function_call_arguments.done` → `response.output_item.done`，事件携带 `output_index`，flag 为 `parallel_tool_calls` 与 `strict` [3]。`sequence_number` 与 `response.completed` 见于社区教程与 Azure 镜像 [10][11]，一手指南页未直接呈现，标 `[中]`。与之对照，**旧 Chat Completions 只有** `choices[].delta.tool_calls[i].function.arguments` 靠 `index` 区分，并把「调用完成」塌缩进「轮次结束」的 `finish_reason:"tool_calls"` [3][10] `[中]`。
- **Anthropic** 用索引块：`content_block_start` → `content_block_delta`（`delta.type = "input_json_delta"`，字段 `partial_json`）→ `content_block_stop`，轮次由 `message_delta.stop_reason:"tool_use"` 收尾 [1] `[高]`。
- **Gemini** 是三家中「参数增量」表达最弱的一家：调用以 `functionCall` part 出现，`args` 常常在 part 内一次到位，增量参数下发是**选择性开关而非默认形态** [5][6] `[中]`。这解释了一个实务现象：同一套前端在 Gemini 上往往只能流式化「周边文本」，流式化不了 JSON 本身。

**「更快」与「更安全」是两个方向**。严格 schema（OpenAI `strict:true`、Anthropic 服务端校验）让每个流出的片段都是**合法 JSON 前缀**；而 Anthropic 的 **fine-grained tool streaming**（`eager_input_streaming: true`，且**现已 GA，`fine-grained-tool-streaming-2025-05-14` 转为遗留 header**）刻意**取消服务端缓冲与 JSON 校验**以压低首字延迟，官方文档原文承认「你可能收到部分或无效的 JSON」，代价明写为客户端必须自行累积与容错 [1] `[高]`。开源底座侧，XGrammar 通过把 token 划分上下文无关/相关集合并维护持久栈，在解码期保证输出始终是语法合法前缀（vLLM/SGLang 的 `guided_json`、llama.cpp 的 GBNF 皆属此路）[4] `[高]`。

**裸拼接在生产里确实会坏**，证据集中在 serving 层：SGLang 的 streaming `tool_calls` 双重 unicode 转义 issue [8]、vLLM 的 GLM 流式解析间歇失败 [7]、LiteLLM 代理在 Responses 上游时「静默丢掉 tool_calls」[9]（三条均 `[低]`/片段级，但方向一致且互不隶属）`[中]`。更结构性的问题是**两种 OpenAI 形态不可无损互转**——`delta.tool_calls[index]` 与 `function_call_arguments.delta[output_index]` 之间的适配器会在流中丢事件 [9] `[低]`。

**规模与中断**。多工具上下文已由模型侧原语接管：Anthropic Tool Search Tool 用 `defer_loading: true` 把工具排除在首屏 prompt 外，模型调用 `tool_search_tool_regex_20251119` / `tool_search_tool_bm25_20251119` 返回 `tool_reference` 块按需展开真实 schema，上限 10,000 个延迟工具，官方称 token 降低「超过 85%」[2] `[高]`；Azure 亦把 tool search 做成 Responses API 的一等能力 [30] `[低]`。中断侧存在不对称：OpenAI 有 `background: true` + 重连 `POST /v1/responses/{id}/stream`，即**服务端持久化的运行可以重新接上并拿到部分结果** [11] `[中]`；Anthropic/Gemini 只有 AbortController 级别的「放弃即丢失」`[中]`。

> **对 SLATE 的直接含义**：SLATE 后端 `/api/proxy/chat` 已经把上游各家形态**归一化成 OpenAI Chat-Completions chunk**（`delta.content` / `delta.reasoning` / `delta.tool_calls[]`）再下发，并且 Responses/Anthropic/Google 三条流各自做了转换。所以「调用完成 vs 轮次完成」的区分在 SLATE 的归一化层**被抹平了**——这是后文要还回去的东西。

### 2.2 MCP 协议层：能给的可观测，明确不给的流式输出

**2026-07-28 修订是本次调研最重要的单条发现**。逐字规范要点 [12]-[21] `[高]`：

| 机制 | 状态 | 精确语义 |
|---|---|---|
| `params._meta.progressToken` → `notifications/progress` | 存活且未变 | `progress`(float，**必须严格递增**)、`total`(可选)、`message`(可选)；**频率完全由服务端决定，规范不定上下界**；请求完成必须停止；只能引用活跃 token |
| `notifications/cancelled` | **降级** | 在 Streamable HTTP 上，**关闭 SSE 响应流本身就是取消信号**，不再期望 `notifications/cancelled`；该方法退为 stdio-only |
| 每请求 SSE | **保留** | `POST` 响应 **MUST** 是 `application/json` 或 `text/event-stream` 之一，客户端 **MUST** 两者都支持；服务端可在最终响应前发 `notifications/progress` / `notifications/message`，但**不得在该流上发独立 JSON-RPC 请求**（这是对 2025-03-26→2025-11-25 的行为变更） |
| `GET` 长连接流 | **移除** | 本修订服务端收到 GET/DELETE **应回 405** |
| `subscriptions/listen` | 新增 | 替代隐式订阅，**其响应本身是一条长驻 SSE 流**，但**只承载变更通知**（`toolsListChanged` / `promptsListChanged` / `resourcesListChanged` / `resourceSubscriptions`），首帧必须是 `notifications/subscriptions/acknowledged`，每条带 `_meta["io.modelcontextprotocol/subscriptionId"]` |
| `Last-Event-ID` 重放 | **移除** | 「**Resumable SSE streams via `Last-Event-ID` are not supported**」；断线即丢失在途请求，客户端 **MUST** 以**新 request id 重发**；listen 流断线后需重发 `subscriptions/listen`，服务端不保留订阅态 |
| session / `Mcp-Session-Id` | 移除 | SEP-2567；收到即忽略 |
| `initialize` / `notifications/initialized` | 移除 | 改为每请求在 `params._meta` 内携带 `protocolVersion` / `clientInfo` / `clientCapabilities`，并以 HTTP 头 `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` 冗余，不匹配回 400 + `-32020 HeaderMismatch` |
| 结构化结果 | 已有 | `outputSchema` + 结果内 `structuredContent` + `isError`（后者表示「工具执行出错」而非协议错，结构化输出仍会送达） |
| Elicitation | **改为 MRTR 内嵌** | 不再是服务端主动请求：`resultType:"input_required"` 的 `InputRequiredResult` 携带 `inputRequests` map，值 **MUST** 是 `ElicitRequest` / `CreateMessageRequest` / `ListRootsRequest` 之一；`requestState` 是不透明字符串、客户端 **MUST** 原样回显；响应 **只有 `accept` / `decline` / `cancel` 三个 action，不存在 `defer`**；`mode` 为 `form`（默认）或 `url`；`requestedSchema` **限于扁平对象 + 原始属性**（string/number/integer/boolean，enum 单选、array+enum 多选，禁嵌套对象） |
| Tasks | **出核心、入扩展** | `io.modelcontextprotocol/tasks`（SEP-2663）：方法只有 `tasks/get` / `tasks/update` / `tasks/cancel`（**无 `tasks/list`，阻塞式 `tasks/result` 被轮询取代**）；`Task` 字段 `taskId` / `status` / `statusMessage` / `createdAt` / `lastUpdatedAt` / `ttlMs` / `pollIntervalMs`；状态 **5 值** `working` / `input_required` / `completed` / `failed` / `cancelled`（无 `expired`；`completed` 涵盖 `isError:true`，`failed` 留给 JSON-RPC 错误）；能力经 `extensions` 协商；`taskId` 被明确定位为**断连/重启后的恢复句柄** |
| Roots / Sampling / Logging | **废弃** | SEP-2577 |

**结论句**：MCP 给了完整的通知词汇（进度、取消、反问、变更），却**断然拒绝承担「工具输出的增量流」和「可恢复性」**。进度是带可选文案的**标量计数器**，不是结果分块；长任务的 2026 年官方答案是**可轮询的任务句柄**，而且它被放在扩展而非核心里，意味着客户端不能假设服务端支持 `[高]`。生态侧的不平衡也已被证实：一个广泛使用的编码代理至今把「完整 MCP **客户端**能力」挂在 open feature request 上 [29] `[低]`——即服务端发 `notifications/progress` 而客户端从未声明能力或直接丢弃，是静默无操作。规范版本节奏约每年两版且含破坏性变更（2024-11-05 → 2025-03-26 → 2025-06-18 → 2025-11-25 → 2026-07-28）[27] `[中]`，任何硬编码版本号的对接都是债。

一个值得单独记下的**反向信号**：同为 JSON-RPC 血统、但站在 UI/编辑器一侧的 ACP（Zed）正在通过 RFD **新增** WebSocket / streamable-HTTP 传输，方向与 MCP 移除 GET 流恰好相反 [31] `[低]`。这说明「一条连接、多路交织、可恢复」在 2026 年仍是**未决的标准化问题**，不是已解题。

### 2.3 产品交互层：折叠阶梯是通用语法，并行被搬出了对话流

**呈现语法**（Claude Code 文档逐字核实 [34][37] `[高]`）：每个工具调用默认收成一行摘要（`Read(src/file.ts)`、`Called slack 3 times`），`Ctrl+O` 才展开带时间戳与模型的完整 transcript；输出预算是为**模型上下文**而非人眼预算的——命令输出**边跑边写进一个工作文件**，内联上限约 30,000 字符，超过则改为「文件路径 + 开头短预览」由模型自行再读，超 5GB 直接杀进程；超时交接语原文：`Command did not complete within its 120s timeout and was moved to the background`；`Ctrl+B` 把 bash / agent 转后台；`/tasks` 列出后台项并可查看/附加/停止。**关键的一条按设计不透明：Agent 工具下「父看不到子代理的中间工具调用与输出，只看最终结果」** [37]。

渲染层也遇到了真问题：Claude Code 为此专门做了 alternate-screen 全屏渲染模式，动因原文是「当 Claude 工作时你的终端滚动位置跳到顶部，或屏幕随工具输出流入而闪烁」，并保证内存占用与对话长度无关 `[高]` —— **工具输出洪泛在 2026 年已经是需要渲染器级方案的性能问题，而不只是审美问题**。

**并行性：不在流内解决**。Claude Code 的 agent view 把并行会话摆在 transcript **之外**的一张状态表里，分组为 `Needs input / Working / Completed`，配「Peek 看最近输出或在等什么问题（而非完整 transcript）→ Enter/→ attach 接管终端 → ← detach」的下钻阶梯，底部脚注用一个约每 10 秒刷新的计数徽章提示「2 agents 在等你」[39] `[高]`。团队模式下超过 3 个空闲 teammate 才折叠成 `2 idle agents` 一行，而**工作中/失败的永远保留独立行**；显示形态二选一：进程内面板或 tmux/iTerm2 分屏 `[高]`。Cursor 侧同向：subagent 跑在隔离 VM、自托管机器把工具执行留在本地 [42][43] `[中]`。

**人在环：分层 + 缓存 + 疲劳已被官方承认**。审批选项的作用域是分级且持久的（Bash 按「仓库+命令」永久、WebFetch 按「仓库+域名」永久，文件修改类 `[未核实：仅一次会话内]`）[35]；拒绝时填的注释会**作为拒绝理由回传给模型并让它继续干活**；`/permissions` 可在运行中打开，改动**从下一次工具调用起生效** `[未核实]`。更重要的是 Anthropic 已把「审批疲劳」当作设计缺陷处理：`auto` 模式引入**第二个模型（classifier）替你审查动作**，官方动机就写着「reducing prompt fatigue」[36] `[未核实具体模式名]`。Steering 边界也已趋同：Cursor 明确「消息在 agent 的下一次工具调用处投递，而不是切断在飞的动作」以保存在途工作 [42] `[高]`。

**反方证据（这批最有用）**：批评已从「信息太少」转向「信息在错误的节律下不可读」。HN 上一手开发者自述：「**长程运行里你开始无脑点 Approve，不再读 diff**」，并因此长出一个事后观察的细分市场（IAXT 记录 agent 在你的 Mac 上做了什么以便**事后读**、grith 在 syscall 层评估、LaneKeep 本地决策日志 + 预算上限、Raindrop/ai-sdk devtools 看 trace 写 eval）[48] `[中]`（一手评论，但为个人陈述）。同时存在明确反方：「我不想整天坐在那里**看着 agent** 改来改去」。中文侧唯一成体系的实证是贾思玉的七模式框架，它把「过程」阶段判为最坏阶段，三条缺陷正好对上：**多模块缺乏清晰对应关系**、**过程透明度不足（黑盒）**、**用户介入不灵活（一般不允许中途暂停，只能等全部跑完再重跑）**；并给出可移植规则——渐进式展示而非一次呈现、高亮正在执行重要操作的模块、**允许用户调整过程展示的详细程度**、提供明显暂停按钮、**允许中止并保存已完成内容**、只在真实决策点自动暂停 [49] `[中]`。

### 2.4 编排框架与事件协议层：词汇已收敛，空隙已定位

**收敛形态**：一条 SSE 承载的**扁平有序 JSON 事件日志**，五件套——运行/步骤生命周期信封、`start / content(delta) / end` 三元组、按 id 索引的参数增量、复用同一调用 id 的独立 `result` 事件、共享态的 `snapshot` + JSON-Patch `delta` `[高]`。

**AG-UI 是目前最接近「赢家」的超集词汇**，可直接当线格式模板 [51]。核实后的完整度值得重抄一遍（比常见引述更宽）：除 `RUN_STARTED/FINISHED/ERROR`、`STEP_STARTED/FINISHED`、`TEXT_MESSAGE_START/CONTENT/END`、`TOOL_CALL_START/ARGS/END/RESULT`、`STATE_SNAPSHOT`、`STATE_DELTA`、`MESSAGES_SNAPSHOT`、`RAW`、`CUSTOM` 之外，**还有 `TextMessageChunk` / `ToolCallChunk` / `ReasoningMessageChunk` 这类展开式便捷事件，`ReasoningStart/End/MessageStart/Content/End` + `EncryptedValue` 推理通道，`ActivitySnapshot` / `ActivityDelta`，`SubagentStarted/Finished/Error` 子代理生命周期，以及 `MetaEvent`**。关联规则原文：「Start/End/Result share toolCallId. Args match start's toolCallId. Chunk first requires ID/name; subsequent chunks use same ID」。

因此**差异化的空隙必须重述**——核实后仍然成立的只有三条，而这三条恰好都是 SLATE 要占的：
1. **没有 `parentToolCallId`。** 只有 `parentMessageId`（消息→工具）与 `parentRunId`（运行→运行）；`StepStarted{stepName}` 是一个没有路径的扁平字符串。跨调用因果在 AG-UI 上表达不出来 `[高]`。
2. **没有取消事件、也没有取消竞态语义。** 目录里不存在 `ToolCallCanceled` / `RunCanceled`；「取消/失败」只在 A2A 里以任务状态存在。若取消追上一个已经发出的 `ToolCallEnd`，无任何定义 `[高]`。
3. **成本与耗时只挂在运行级。** `usage` 出现在 `RunFinished`（此点在该页面未被直接证实，标 `[中]`），`ToolCall*` 上没有时长、token、重试或费用的位置——而这正是可交互树要可读所缺的东西 `[高]`。

另两条空隙按证据强度保留：目录中未见逐事件单调游标/`id` 字段，故 `Last-Event-ID` 续读、`ToolCallResult` 的 exactly-once 应用、副作用工具的重发幂等全部留给实现方 `[中]`；半成品参数只有 `delta` 字符串、**没有增量解析契约**，协议无法表达「这些键已闭合、这个还在写」`[高]`（Vercel 侧同证：`input-streaming` 下渲染 `part.input`，但文档**不保证此刻 JSON 可解析** [52]）。

**对照系各有取舍**：Vercel AI SDK 把状态放在**消息 part** 上（`tool-<name>` / `dynamic-tool` 两类 part，状态链 `input-streaming` → `input-available` → `output-available` | `output-error`，且**已把审批做进 part 状态：`approval-requested` / `approval-responded` / `output-denied`**，即 HITL 不是另一种消息类型而是同一 part 的状态），客户端回传走 `addToolOutput()`，多轮停止条件现写作 `stopWhen: isStepCount(5)`（v5 旧名 `stepCountIs`，命名漂移已证实）[52] `[高]`。A2A 走完全相反的本体：工作是**可轮询资源**，`TaskState` 实为 **8 值**（`submitted` / `working` / `input-required` / `completed` / `failed` / `canceled`〔单 l〕 / `rejected` / `auth-required`，protobuf 形式 `TASK_STATE_*`），SSE 上只有 `TaskStatusUpdateEvent` 与 `TaskArtifactUpdateEvent` 两类载荷，push 是「服务端主动 POST 到客户端提供的 webhook URL」[55] `[高]`。**关键区别：把「需要人」建模成任务状态，而不是阻塞调用**——`auth-required` 还单独区分了「要重新授权」与「要输入」。LangGraph 提供被调查者里唯一真正的层级命名空间（v2 StreamPart 键为 `{type, ns, data}`，`stream_mode` 除 `values/updates/messages/custom/debug` 外还有 `checkpoints` 与 `tasks`，`tasks` 模式即逐节点输入输出通道）[53] `[中]`；其 `interrupt()` / `Command(resume=)` 机制 `[未核实：官方页 404]`。可观测侧，OpenTelemetry 已把 GenAI 语义规范**拆出主仓**独立演进 [56] —— 这次拆分本身就是结论：它不受主 semconv 稳定性承诺约束；`gen_ai.operation.name` / `gen_ai.tool.call.id` 等属性名 `[未核实]`。

**反方/空隙的权威命名**：Thoughtworks 技术雷达（Techniques 象限，**Caution 环**，2026-04-15）条目「Ignoring durability in agent workflows」原文：「这是我们在很多团队都见过的反模式，导致系统在开发环境可用而在生产环境失败」[58] `[高]`。工程侧的务实答案也已成形：社区出现「**断线之后，不要重跑 AI**」的 POST + NDJSON + 服务端缓冲事件日志 + 客户端续读游标写法 [59] `[低]`，以及 2025-2026 一贯的 SSE-vs-WebSocket 结论——单向服务端输出选 SSE（HTTP/2 多路复用、代理/CDN 亲和、自动 `Last-Event-ID` 重连），只有当**同一条连接必须高频率双向传控制**时才上 WebSocket [60] `[中]`。

### 2.5 汇总：六条空隙，其中三条已被核实为真缺口

| # | 空隙 | 核实状态 | SLATE 是否要占 |
|---|---|---|---|
| G1 | 半成品参数无增量解析契约 | `[高]` 成立 | **是**（主张一） |
| G2 | 调用级因果（`parentToolCallId`） | `[高]` 成立（`Subagent*` 事件已部分占据「嵌套可见性」，但调用树父子边仍缺） | **是**（主张三） |
| G3 | 调用级耗时/成本/重试 | `[高]` 成立 | **是** |
| G4 | 取消事件与取消竞态语义 | `[高]` 成立 | **是**（主张二） |
| G5 | 事件游标与幂等重放 | `[中]` 成立；且 MCP 2026-07-28 **主动放弃** | **是**（主张三） |
| G6 | trace 与协议 join key 未强制同源 | `[未核实]` | 采纳但降级为约定 |

---

## 3. 第 2 部分：SLATE 现状与差距

（依据本地代码扫描 + 两条本人复核 grep，全部带 file:line）

### 3.1 结构事实：循环在前端

| 维度 | 现状 | 位置 |
|---|---|---|
| 流式端点 | **只有 LLM 透传** `POST /api/proxy/chat`，手写 `data: {json}\n\n`，无 sse-starlette | `backend/routers/proxy.py:707`、`435/486/531/560` |
| 事件词汇 | **归一化成 OpenAI Chat-Completions chunk**，不新增 `type`；`delta.content` / `delta.reasoning`（三家异构字段合并）/ `delta.tool_calls[]` / `finish_reason` / `{error}` / `data:[DONE]` | `proxy.py:425-435`、`492/619` |
| 客户端解析 | `streamChat` 异步生成器，`fetch` + `getReader()` + `TextDecoder`，按 `\n` 切，**按 index 累积 `delta.tool_calls`**，90s 空闲看门狗 + 2 次重试 | `frontend/js/services/api.js:170-303`、`242-252` |
| 工具循环 | **完全在前端**：`runToolLoop` | `chat.js:2772-3119` |
| 轮次预算 | harness `clamp(10,50)`、autopilot 18/28、普通 5 | `chat.js:3426`、`74-75` |
| 调用发现 | 文本协议 `◈◈◈name\n{json}\n◈◆◆` 与原生 `tool_calls` 取并集去重 | `chat.js:2814-2817`、`tools.js:1268-1314` |
| **参数增量** | **已经流入前端并累积，但从不渲染**：`onToolCall` 回调只是覆写一个数组，UI 要等整批结束 | `chat.js:3053`、`3361` |
| 执行并发 | **严格串行** `for … await`；全仓工具路径无 `Promise.all`（唯一并行在 `subagent.js:169`，上限 5） | `tools.js:1388-1407` |
| 进度回传 | **零**。34 个内置 skill 全是同步 `def execute()`，经 `run_in_threadpool` 跑，签名里没有任何回调通道 | `skills.py:134`、`browser_automation.py:244`、`terminal.py:445` |
| 外部 MCP | **手写 JSON-RPC，走已被 2026 移除的旧 HTTP+SSE（`GET {url}/sse`）**；无 SDK、无 stdio、无 Streamable HTTP；`initialize` 广播 `capabilities:{}`；`_listen_sse` **丢弃所有无匹配 id 的入站消息** | `backend/mcp_client.py:1-7`、`112-116`、`147-192`、`171-177` |
| MCP 高级语义 | **全仓零命中**（`progressToken` / `notifications/progress` / `notifications/cancelled` / `elicitation` 各 0 处，本人复核） | — |
| 审批 | 执行器内部 `await guard()` **阻塞式 Promise**，弹窗 + 一次性非流式解释调用；三模式 `ask/auto/full`；前端 24 条正则 + 后端镜像 + `BLOCKED_PREFIXES` 无条件拦 | `tools.js:373-380`、`riskguard.js:127-142`、`terminal.py:44/529` |
| 中断 | `stopGeneration()` → `AbortController.abort()` **只掐到 LLM reader**；**无后端 stop/cancel 端点**，已发出的 `/skills/execute` 会跑完；循环只在轮次边界检查 `signal.aborted` | `chat.js:1638-1645`、`3209`、`api.js:186`、`chat.js:2800/2967/3043/3094` |
| 渲染 | 一次成批渲染于完成时；`.tool-call-group` → `.tool-call-card`（header/title/name/meta/status-pill + body/input/output）；默认折叠、失败才展开；meta 截 48 字；body CSS 夹 `max-height:200px` | `chat.js:2132-2271`、`2971-2975`、`2164`、`style.css:4718-4728` |
| 白板 | **命令式副作用**，非事件驱动：批前逐调用 `addToolStepCard(name, params, "running")`，批后统一 `updateToolStepCard(...)`；卡片描述来自**硬编码 14 条表**（与 `TOOLS` 早已对不上，见 4.11）；`clearToolStepCards()` 于循环开头清空。**P1 已整块换成账的投影** | `chat.js:2958-2963`、`2989-2997`、`whiteboard.js:2300-2376`、`2306-2312` |
| 持久化 | SQLite `chat_history.db`；工具状态仅以 `messages.metadata` 里的 JSON 块存在；**无 per-call 行、无事件日志、无 run/turn id ⇒ 无任何可回放物**。**P1 已补 `runs` + `tool_events`** | `chat.py:61-72`、`238-262`、`chat.js:2978-2981` |
| **循环复制** | **两处同骨架**（本人复核，原记「四处」偏多）：`chat.js`(3)、`mobile/m-chat.js`(2)；`team.js`(1) 是多轮辩论循环（工具结果不回灌模型）、`services/subagent.js`(1) 是裸 `messages[]` 迷你循环，形态不同。**P0 已把同骨架两处收敛为 1 份 kernel + 2 份装配** | — |

### 3.2 差距陈述

市面方案的世界观是「服务端编排，UI 消费事件」，于是它们的问题集中在传输、重放、fan-out。**SLATE 的世界观相反**，导致两类完全不同的病灶：

- **D1 执行期黑盒**：`/skills/execute` 一问一答，进度、部分输出、耗时全不可见。这与 MCP 的天花板一致，但 SLATE 有 MCP 没有的自由度——**这 34 个工具是 SLATE 自己写的** `[高]`。
- **D2 取消是假的**：abort 只掐文本流，已发出的副作用继续执行到底。这在有 `terminal` / `file_write` / `browser_automation` 的系统里不是体验问题而是安全问题。
- **D3 已到手的增量被丢弃**：`api.js` 已经逐块拼出 `arguments`，前端也已经持有全部 `TOOLS` schema，但整条链路在轮次结束前不进 UI——**离「落笔即所见」只差一次渲染**，而这是市面协议层公开缺位的能力（G1）。
- **D4 不可审计、不可重放**：没有 run id、没有事件行。Thoughtworks 点名的正是这个 `[58]`；而 MCP 2026 明确放弃重放 `[12][13]`，等于把这个位置空出来给应用层。
- **D5 多模块无对应关系**：聊天卡片、白板步骤卡、底部计时器三处各写各的，`whiteboard.js` 还要维护一张硬编码描述表。这与中文 UX 研究的「多模块缺乏清晰对应关系」逐字对上 `[49]`。
- **D6 MCP 侧是静默无操作**：即便外部服务端发 progress，SLATE 的 `_listen_sse` 会因为「无匹配 pending id」而丢弃 `[mcp_client.py:171-177]`，且能力声明是空对象。同时其传输用的是 2026 已移除的 GET-SSE 机制——**双重落后**。
- **C1（成本项）循环复制四处**：任何协议改造都要落四遍，或先收敛成单一 runner。这是本方案最大的实施风险，第 5 部分据此排序。**→ P0 已收敛**：实测同骨架循环只有桌面/移动两处（`team.js` 是多轮辩论、`subagent.js` 是裸 `messages[]` 迷你循环，形态不同故不并入），现两处均为 `createAgentLoop({policy, view, io})` 的一次装配。

---

## 4. 第 3 部分：砚流（InkStream）设计方案

### 4.1 定位与原则

一句话定位：**把一次工具调用当作书法里的一笔——起笔（参数成形）、落笔（开始执行）、行气（进度与部分输出）、收笔（终态与产物），四态全部落在同一本账上，任何界面都只是这本账的一次重读。**

三条不可让渡约束（来自需求确认）：
- **K1 保持 SSE**：不引入 WebSocket、不引入 sse-starlette 等新依赖，沿用现有手写 `data: {json}\n\n` 风格。
- **K2 前端零依赖零构建**：不引入 React/状态库/JSON 修复库，纯原生 ES Module。
- **K3 不破坏标准 MCP 语义**：对外部 MCP 服务端只使用规范内的 `_meta.progressToken` / `notifications/progress` / 关流取消，**私有扩展只作用于 SLATE 自有工具**。

三条设计主张（每条都对应一个已被核实的市面空隙）：
- **主张一 · 落笔即所见** → 占 G1。SLATE 前端同时持有「正在流入的参数增量」与「全部工具 schema」，这是极少数客户端才具备的条件；用本地 schema 推断字段边界，不需要 constrained decoding，也不依赖任何 provider 配合。
- **主张二 · 一次调用一条流，关流即取消** → 占 G4。与 MCP 2026「HTTP 上关闭 SSE 响应流即取消信号」逐字同构，因此前端把已有的 `AbortController` 从「只掐文本」扩到「掐工具」，既零新依赖又与标准语义一致。
- **主张三 · 墨迹账（Ledger）** → 占 G2/G3/G5。MCP 已明确放弃 `Last-Event-ID` 重放，AG-UI 没有事件游标、没有 `parentToolCallId`、没有调用级耗时；SLATE 用一本本地账把三件事一次补齐，并顺带把「白板卡片」从命令式副作用升级为账的投影。

### 4.2 本体与命名

| 概念 | 代号 | 含义 | 现状锚点 |
|---|---|---|---|
| 运行 | `run` | 用户一次送发到本轮彻底结束 | 今天不存在，需新建 `runId` |
| 阶段 | `phase` | 目标模式六阶段之一（`goal/plan/execute/verify/report/trace`），非目标模式时只有一个合成阶段 | 今天只活在提示词里 |
| 批次 | `batch` | 一个轮次里由模型提出、由前端执行的一组调用 | `executeToolCalls`，`tools.js:1388` |
| 一笔 | `call` | 一次工具调用，全链路的原子单位 | `.tool-call-card` |
| 父笔 | `parentCallId` | 调用树因果边（`subagent_run` / `mcp_factory` / 未来嵌套任务） | 全仓无此概念 |
| 产物 | `artifact` | 文件 / 图 / 表 / diff，以引用而非内联呈现 | `chat.js:2243-2263` 已有雏形 |

ID 一律前端生成（因为编排在前端）：`run_` / `cal_` / `inv_`（invocation 由后端 `/skills/stream` 首帧回执）。**约定：`callId` 同时用作 OpenTelemetry `gen_ai.tool.call.id` 的取值**，把 G6 这条「join key 未强制同源」在 SLATE 内部一次性钉死（该属性名本身 `[未核实]`，故此条只作为内部约定，不作为对市面的断言）。

### 4.3 事件信封

每个事件一个对象，跨通道统一：

```json
{
  "v": 1,
  "seq": 17,
  "ts": 1789200000123,
  "runId": "run_9f2c",
  "callId": "cal_04",
  "parentCallId": null,
  "type": "call.progress",
  "data": { }
}
```

- `seq`：**每 run 单调递增**，由前端 ledger 分配（后端帧用 SSE 原生 `id:` 承载自身建议值，见 4.6）。G5 的答复。
- `ts`：毫秒墙钟，用于耗时与时间戳显示（G3 的前提）。
- `parentCallId`：G2 的答复；`StepStarted{stepName:""}` 这类扁平字符串被 `phase` + `parentCallId` 取代。
- 版本号 `v` 固定在最外层，便于账本向前兼容读取。

### 4.4 事件目录

**F 族 · 运行与阶段（信封类）**

| type | data 字段 | 说明 |
|---|---|---|
| `run.started` | `input`, `mode`(`classic/harness/autopilot/team/grind`), `budget:{rounds,seconds}`, `ui` | 一次送发的根 |
| `run.finished` | `status`, `wallMs`, `rounds`, `usage?`, `stops:{stall,dedup,abort,approval}` | `usage` 在**运行级**，与 AG-UI 一致 |
| `run.error` | `code`, `message`, `retryable`, `traceId` | 复用现有 `{error}` 帧语义 |
| `phase.started` / `phase.finished` | `phase`, `title` | 六阶段上协议；白板按此分组 |
| `round.started` / `round.finished` | `round`, `of`, `modelMs`, `toolMs` | 取代现在只在 nudge 文本里的 `x/N` |
| `batch.started` / `batch.finished` | `mode`(`parallel/sequential`), `callIds`, `laneCount`, `wallMs` | 并行组的组头信息 |

**C 族 · 一笔的生命周期（核心）**

| type | data 字段 | 说明 |
|---|---|---|
| `call.planned` | `tool`, `source`(`native/text/mcp`), `argsState:"streaming"`, `lane` | 模型刚点题、参数还在流 |
| `call.args` | `delta`, `closed:[字段名]`, `open:"字段名"\|null`, `bytes` | **前端由 4.8 算法派生**，不来自后端 |
| `call.ready` | `args`, `bytes`, `truncated`, `risk` | 参数闭合，可执行 |
| `call.approval.required` | `riskLevel`, `reason`, `preview`, `scopes:["once","session","repo"]` | 见 4.9 |
| `call.approval.resolved` | `decision`(`accept/decline/cancel`), `scope`, `comment?` | 三值 action 与 MCP elicitation 对齐 [18] |
| `call.started` | `invocationId`, `endpoint`(`skill/mcp/local`) | |
| `call.progress` | `progress?`, `total?`, `message?`, `pct?` | 标量族；字段名与 MCP `notifications/progress` 同名同义 [14] |
| `call.output` | `stream`(`stdout/stderr/log/notice`), `chunk`, `offset`, `bytesTotal` | **富流族**，仅自有工具可达 |
| `call.sideEffect` | `kind`(`file_write/git/network/process/desktop`), `targets:[]`, `count?` | 可核验性：这一笔究竟动了什么 |
| `call.artifact` | `artifactId`, `kind`(`file/image/video/doc/diff/url`), `ref`, `preview?` | 产物走引用，不内联洪泛 |
| `call.finished` | `status`(`done/error/cancelled`), `durationMs`, `bytes`, `truncated`, `retries`, `isError?`, `resultDigest`, `fidelity` | `fidelity` 见 4.7 |
| `call.error` | `code`, `message`, `retryable`, `hint?`, `durationMs` | |
| `call.cancelled` | `by`(`user/timeout/parent/budget`), `racedWith?` | G4 的答复 |
| `call.input.required` | `prompt`, `schema?`, `resumeKey` | 工具**中途反问人**（对齐 A2A `input-required` [55] 与 MCP `input_required` [18]） |

**M 族 · 模型与推理**

| type | data 字段 | 说明 |
|---|---|---|
| `text.delta` | `messageId`, `delta` | |
| `reasoning.delta` | `messageId`, `delta`, `state`(`streaming/done`) | 对齐现有 `delta.reasoning` 归一化 |
| `notice` | `level`, `text` | 空转告警、去重命中、截断拒绝等系统旁白，**不再混进文本流** |

**S 族 · 共享态（可选，第二期）**

| type | data 字段 | 说明 |
|---|---|---|
| `state.snapshot` / `state.delta` | `snapshot` / `delta`(JSON Patch) | 沿用 AG-UI 词汇 [51]，用于白板/TODOLIST 的整体态 |

### 4.5 状态机与竞态语义

```
planned ──args 闭合──▶ ready ──(需审批?)──┬─▶ queued ──▶ running ──┬─▶ done
  │  (call.args 自环，可长时间停留)        │                        ├─▶ error
                                          └─▶ awaiting_approval ───┤
                                                  │ accept         └─▶ cancelled
                                                  │ decline/cancel ─▶ error(synthetic: denied)
running ──需要人──▶ awaiting_input ──accept──▶ running
done/error/cancelled 为吸收态
```

**四条显式规则**（市面协议未定义，本方案必须自己钉）：
1. **取消竞态**：`cancelled` 与 `finished` 可能都在路上（关流后后端仍可能已经跑完并落库）。规则是**先到终态者胜**，后者以 `racedWith` 记录并作为 `notice` 上报，**不覆盖、不回滚**。理由：副作用已经发生，隐瞒比噪声更糟。
2. **参数未完成不执行**：`call.args` 阶段**永不**触发任何后端调用，也不做「根据已到达字段预判意图」的渲染捷径。这是对 A1 层「半成品参数安全性」批评的正面回答 [7][8][9]。
3. **denied 不是 error**：用户拒绝时合成一条 `call.error{code:"denied_by_user", retryable:false}` 并把 `comment` 作为其内容回灌模型——沿用 Claude Code「拒绝理由回传后继续工作」的既有做法 [35]，避免模型把一次拒绝读成一次故障。
4. **进度不保证节律**：MCP 明确把频率交给服务端且不设上下界 [14]；因此 `call.progress` 只承诺**单调不减**，前端一律按 120–200ms 节流合并，且**允许永不出现**。

### 4.6 通道拓扑：一 LLM 流 + N 调用流

```
前端 run（编排者，持有 seq 与 ledger）
 ├─ POST /api/proxy/chat            SSE：text.delta / reasoning.delta / call.planned / call.args / round.*   （已有，扩字段）
 ├─ POST /api/skills/stream         SSE：call.started / progress / output / sideEffect / artifact / finished / error   （新增，一笔一流）
 ├─ POST /api/mcp/{server}/call     同上语义，内部转 MCP tools/call + progressToken                       （新增）
 └─ 取消 = AbortController.abort()  →  连接关闭  →  后端 ASGI 收到 disconnect  →  ctx.cancelled 置位  →  工具自弃
```

为什么这是这套架构下最省的方案：**取消通道不必新造**。MCP 2026 已经把「关闭 SSE 响应流」定为 HTTP 上的取消信号 [13]；FastAPI/starlette 天然向处理器暴露 `request.is_disconnected()`，后端只需在 `ctx` 上把这个信号桥接给工具循环。K1/K2/K3 同时满足，且**语义与标准一致而非私有**。

代价与边界必须写清（见 4.14 第 4 条）：**关流即取消 ⇒ 无法「断开但仍让它在后台跑」**。要支持后台长任务，只能另走 tasks 式句柄轮询，不能与关流取消同时宣称。

LLM 流上的扩字段：现有 `delta.tool_calls[]` 已携带 `index`/`id`/`function.name`/`function.arguments` 分片，前端已在拼 [api.js:242-252]。只需在**首个分片到达**时发 `call.planned`、**每个分片**发 `call.args`、**该 item 闭合**发 `call.ready`。另建议在归一化层**恢复被抹平的「调用完成 ≠ 轮次完成」**：Responses 上游的 `.done` / Anthropic 的 `content_block_stop` 映射为一个显式 `call.ready` 时机，而不是等 `finish_reason`。

### 4.7 两级保真度：把「外部做不到」显式建模

| 级别 | 适用 | 可得事件 | 缺失时的 UI 表达 |
|---|---|---|---|
| **F2 富流** | SLATE 自有工具（34 个 skill + 前端本地工具） | `progress` + `output` 分块 + `sideEffect` + `artifact` | — |
| **F1 标量** | 自有工具尚未接入 `emit` 的过渡态 | `progress` / 心跳 / `finished` | 显示「无进度回报」灰标，**不伪造百分比** |
| **F0 瞬时** | 亚 300ms 工具 | 仅 `finished` | 不建独立卡片，折叠进批次行 |
| **FX 标准 MCP** | 外部 MCP 服务端 | 仅 `notifications/progress` 标量（规范只给这些 [14]） | 进度条 + `message`，明确标注「来自服务端上报」 |
| **FT 任务句柄** | 外部支持 Tasks 扩展 [19] | `taskId` + 轮询 `tasks/get`，状态 5 值 | 显示「后台任务」，可离开再回 |

映射规则：`working→running`、`input_required→awaiting_input`、`completed→done`（**注意 MCP 的 `completed` 涵盖 `isError:true`，须用 `isError` 二次判定** [19][21]）、`failed→error`、`cancelled→cancelled`。

这一级降级表是 **K3 的落地方式**：SLATE 自有工具用私有富通道（不违反 MCP，因为根本不经过 MCP），外部工具严格只用规范内机制，两者在前端**折叠成同一族事件**，UI 不感知来源保真度差异——但账上记 `fidelity`，以便诚实显示「这条进度是服务端上报的，不是真的输出流」。

**顺带必须修的兼容债**：`mcp_client.py` 目前用 `GET {url}/sse` 旧 HTTP+SSE 传输（2026 已移除该机制 [12][13]）、广播 `capabilities:{}`（等于主动放弃被上报进度）、且 `_listen_sse` 丢弃无匹配 id 的入站消息（等于即使收到 progress 也丢）[`mcp_client.py:171-177`]。三处都要改：声明 `capabilities`、按 `requestId` 之外的 `progressToken` 路由通知、至少支持 Streamable HTTP + stdio。

### 4.8 落笔即所见：schema-aware 容错前缀解析

**问题**（G1，已核实）：协议只给 `ToolCallArgs{delta}` 这类原始字符串片段，没有任何契约表达「哪些键已闭合」。Vercel 在 `input-streaming` 下也不保证可解析 [52]。

**SLATE 的条件**：前端 `tools.js` 持有完整 `TOOLS` 定义与 JSON Schema 序列化器 `buildOpenAITools`（`tools.js:1561-1580`）。**在客户端做前缀推断，不必要求 provider 支持 constrained decoding。**

**算法（设计描述，非实现）**：一个单遍扫描器维护 `(深度, 是否在字符串内, 转义态, 当前 key, 当前 value 类型)`，每收到一个 delta 增量推进状态机，输出：
- `closed: [字段名]` —— 引号/括号已配对、值已终结；
- `open: 字段名 | null` —— 正在写但尚未闭合；
- `absent` —— 尚未出现（对 required 字段以占位显示）。

**渲染规则（反噪声是重点）**：
1. 只渲染 `closed` 字段的值；`open` 字段显示字段名 + 一个墨点光标，**不显示半成品内容**。
2. **有界摘录**：任何可能巨大的字段（`file_create.content`、`doc_write.markdown`、`html_bundle.html`）只显示「行数 / 字节数 + 末行」，绝不逐字铺开。依据是 Claude Code 那条被证实的经验：内联上限约 30k 字符，超过转文件引用 [37]。
3. 节流 120–200ms 合并重绘（K2：手写 `requestAnimationFrame` + 时间戳闸门，不引库）。
4. **required 字段 ≤ 2 且都很短的工具直接跳过预览**，只在其后出现 `call.ready`。这是刻意的减法——`system_info` 这种没必要演一遍。
5. 卡片头部在 `planned/args` 期显示「起笔中 · 已在写 `command`」，`ready` 后翻成「落笔」。

**收益定位**：模型写一个 60 行的 `file_create` 要十几秒，今天的 UI 在此期间**什么都不显示**（`chat.js:3053` 只覆写数组）。改完之后，用户看到的是「正在写 path: notes/xxx.md · content: 41 行」——这正是 A3 认定的「无人流式渲染半成品参数」缺口的填补。

### 4.9 审批与反问：状态而非阻塞

现状是执行器内 `await guard()` 把整批卡住 [tools.js:373-380, riskguard.js:127-142]。改为：

- `call.approval.required` 只把**这一笔**置入 `awaiting_approval`，**同批其他不需要审批的调用继续执行**（前置：4.10 的并行）。
- 决策 action 固定三值 `accept | decline | cancel`，与 MCP elicitation 的 2026 定义逐字一致 [18]；作用域三档 `once | session | repo`，与 Claude Code 的分级缓存同向 [35]。
- 审批卡**内联在该笔的位置上**而不是全局模态；卡片必须展示「批准后会发生什么」的可读摘要（diff / 目标路径 / 命令 + 现有 riskguard 的一次性解释），因为规则原文值得引用：**只在弹窗能完整展示其所允许内容时才提供「不再询问」选项** [35]。
- `decline` 携带注释 → 合成为该笔结果回灌模型（规则 3）。`cancel`（用户直接 Esc 整个 run）→ 触发批量 `call.cancelled`。
- **不引入 classifier 式自动审批**。Claude Code 用第二个模型缓解疲劳 [36]，但那是多租户云端产品的取舍；SLATE 本地单用户、每次额外模型调用都直接花用户的钱与时间。替代方案是**风险分级 + 摘要前置 + 作用域缓存**，把弹窗总量降下来而不是把弹窗自动化。

### 4.10 并行轨道：不做「另一个窗口」

2026 的一致答案是把并行挪出对话流（agent view / 分屏 / 隔离 VM）[39][42][43]。**SLATE 有意偏离**：SLATE 是单窗口桌面 + 移动端遥控 UI，再开一扇窗会直接踩中「多模块缺乏清晰对应关系」[49]。设计为：

- 同批次并行调用共享 `lane`，在 transcript 中生成**一个组头行**：`并行 3 笔 · 2.1s · 需你确认 1`，展开后每笔独立成行、按 `lane` 缩进对齐；
- 输入框上方挂一条**粘性三态聚合条**（`等你确认 / 进行中 / 已完成`），借用 agent view 的状态分组，但它是**同一账本的投影**而非独立窗口，点击定位到对应行；
- 嵌套：`subagent_run` / `mcp_factory` 生成子 `callId` 并以 `parentCallId` 挂上，子笔默认折叠为 `Called 3 tools · 1.2s` 一行（Claude Code 的 `Called slack 3 times` 同构 [34]），展开即下钻，`←`/返回退级。
- 并发上限沿用现有 `subagent` 的 5 与 `harness` 轮次预算，不改变模型侧行为。

配套的必要改造：`executeToolCalls` 从串行 `for…await` 改为**受控并发**（`Promise.allSettled` + 信号量，K2 原生即可）。这是 4.9 与 4.10 的共同前置。

### 4.11 墨迹账：唯一事实源

```sql
-- 设计草案
tool_events(
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,  -- 全局单调，SSE id 用它
  run_id        TEXT NOT NULL,
  call_id       TEXT,
  parent_call_id TEXT,
  ts            INTEGER NOT NULL,
  type          TEXT NOT NULL,
  tool          TEXT,
  payload       TEXT NOT NULL                        -- data 字段 JSON
)
runs(run_id PRIMARY KEY, conversation_id, mode, started_at, ended_at, status, budget_rounds, wall_ms)
```

写入以 run 为单位批量提交（一次 flush 合并数十事件），避免每事件 fsync。**投影函数取代命令式渲染**：

| 视图 | 由何投影 | 被删除的旧机制 |
|---|---|---|
| 聊天工具卡片 | `projectChat(events)` | `lastMsg.toolResults = [...]` 成批一次渲染（`chat.js:2971-2975`） |
| 白板步骤卡 | `projectBoard(events)` | `addToolStepCard` / `updateToolStepCard` / **硬编码 14 条描述表**（`whiteboard.js:2300-2376`） |
| 底部计时器 / 轮次 | `projectTimer(events)` | 散落的 round 文本与 nudge |
| 审计视图（新） | `projectAudit(events)` | 不存在，新增 |

**这三样东西从「各自被调用」变成「同源重读」，就是 D5 的解。** 同时 `run_id + seq` 让 D4 消失：刷新页面、切会话、断连（我们自己的端点，不是 MCP 服务端）都能按 `seq` 续读；历史会话不再是 metadata 里的一坨 JSON 快照，而是可重放的账本。副作用（`call.sideEffect`）单独成事件类型，为的就是审计视图能回答「这一轮到底改了哪些文件」。

**P1 落地实况（P1-a/P1-b，与上面草案的四处出入）**

实际建表在 `data/chat_history.db`，连接复用 `chat.py` 的 `_get_db`，写入走 `POST /api/events/append`（`backend/routers/events.py`）：

```sql
-- 实际落地
runs(run_id TEXT PRIMARY KEY, conversation_id TEXT, mode TEXT,
     started_at_ms INTEGER, ended_at_ms INTEGER, status TEXT,
     budget_rounds INTEGER, wall_ms INTEGER, final INTEGER DEFAULT 0)
tool_events(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
     ts INTEGER NOT NULL, type TEXT NOT NULL, call_id TEXT, parent_call_id TEXT,
     tool TEXT, message_id TEXT, payload TEXT)
CREATE UNIQUE INDEX idx_tool_events_seq ON tool_events(run_id, seq);
```

1. **两个序空间不混用**：草案让 `seq` 兼任物理自增主键（"SSE id 用它"），实际把物理序留给自增 `id`，`seq` 退化为**前端逻辑序**（每 run 单调）。落账靠 `INSERT OR IGNORE + UNIQUE(run_id,seq)` 幂等重放，前端可放心重试同一批。
2. **时间戳单位是 epoch 毫秒**，与 `messages.created_at` 的秒不同，列名一律以 `_ms` 自证。
3. `callId` **实为 `r{round}c{index}`**，不是草案的 `cal_{index}`：白板卡片以 callId 为复用键，而跨轮的同一个 index 是**不同的调用**，`cal_{index}` 会让第二轮的第 0 笔覆盖第一轮那张卡。
4. **已落的事件是一个子集**：`run.started/finished`、`round.started/finished`、`notice`（去重命中、空转告警等系统旁白，不再混进文本流）、`call.planned/ready/started/finished/cancelled`。未落：`phase.*`（依赖目标模式六阶段升级）、`batch.*`、`call.approval.*`、`call.artifact`、`call.sideEffect`、M 族——分别属 P4/P6。内存账存全量（投影要原文参数与完整输出），**上行才裁**：参数与输出各留 2000 字符摘要加字节数与 `truncated` 位。
5. 读端点（按 `seq` 续读、`projectAudit`、`projectTimer`）**本轮不做**，属 P6。所以聊天工具卡片这一路是「投影 + 兼容写」：`projectChat` 产出与旧 `[{call, result}]` 同形状的结果，仍赋给 `lastMsg.toolResults` 并 `PATCH /chat/messages/{id}`，同时写一个 `ledgerRunId` 作判别子，等 P6 有读端点后即可换成直接续读账本。
6. 被删除的白板硬编码描述表**其实早已失效**（脚本核对过 `git HEAD`）：那 14 条里 `file_tree`/`file_peek`/`terminal`/`code_scan`/`todo_scan`/`memory_manage` 六个键在当前 `TOOLS` 里已不存在，而 25 个工具中有 17 个从来没被覆盖到——包括用得最多的 `skill_run` 与 `project_read_file`。也就是说步骤卡标题长期是裸英文名。现在标签与参数摘要统一由 `tool_meta.js` 从 `TOOLS` 一处派生，schema 里 `required` 的标量优先当摘要。
7. **标签事实源实际要喂三个界面**，不是两个：桌面聊天卡、**移动端聊天卡**、白板步骤卡。端到端核对时抓到移动端 `.m-tool-name` 仍在写裸 `call.name`（同一笔 `system_info` 在桌面显示「系统信息」、在移动端显示 `system_info`），已一并改为 `toolLabel(name, args)`。`skill_run` 的标签取其 `params.skill` 子工具名，故账本里的 `tool` 是 `skill_run` 而界面标题是「执行命令」——账记事实、投影给语义。
8. **`call.finished.status` 的保真度上限（已核实，未修）**：`skill_run` 这类内置工具把后端错误**作为字符串输出**返回，`result.success` 仍为真，于是 `status` 记成 `"done"`、错误正文只活在 `resultDigest` 里。要区分「执行成功但内容是报错」需要工具层返回结构化失败，属 P4 审批与状态化一并处理，不记在 P1 的账上。

### 4.12 与目标模式六阶段 / 白板的关系（用户确认可调整）

- **六阶段从提示词约定升级为协议一等公民**：`phase.started/finished` 进账，侧边栏与白板按阶段分组，「当前在第几阶段的第几轮」不再靠 nudge 文本推测。目标模式的退出条件（手动停 / 轮次耗尽 / 清单完成）分别对应 `run.finished{stops}` 的三种取值，可观测化。
- **白板降级为投影**：不再由 `runToolLoop` 命令式喂卡片。这同时消掉「`clearToolStepCards()` 在循环开头清空」这类脆弱同步。
- **磨墨三段式不动**：它是对话式提问节奏，不是工具流，强行并入会损害其简洁性。
- **团队模式与移动端**复用同一事件族——这也是必须先做循环收敛（C1）的原因。

### 4.13 跨协议对齐（保留可导出性）

| 砚流事件 | AG-UI [51] | Vercel [52] | MCP 2026 | A2A [55] | OpenAI [3] | Anthropic [1] |
|---|---|---|---|---|---|---|
| `call.planned` | `TOOL_CALL_START` | `input-streaming` | — | — | `output_item.added` | `content_block_start` |
| `call.args` | `TOOL_CALL_ARGS` | `input-streaming` | — | `function_call_arguments.delta` | `input_json_delta` |
| `call.ready` | `TOOL_CALL_END` | `input-available` | — | `arguments.done` | `content_block_stop` |
| `call.started` | （无） | （无） | 请求发出 | `working` | — | — |
| `call.progress` | （无） | （无） | `notifications/progress` | — | — | — |
| `call.output` | （无） | （无） | **无对应** | — | — | — |
| `call.finished` | `TOOL_CALL_RESULT` | `output-available` | `CallToolResult`+`structuredContent` | `completed` | `output_item.done` | — |
| `call.approval.*` | `Custom` 兜底 | `approval-requested/responded` | MRTR `input_required` | `input-required` | — | — |
| `call.cancelled` | （无） | （无） | **关流即取消** | `canceled` | — | — |
| `parentCallId` | **无**（仅 `parentMessageId`） | part 索引隐含 | — | — | `output_index` | `index` |
| `seq` / 游标 | 无事件游标 `[中]` | — | **明确不支持** | 任务句柄 | `sequence_number`(社区) | — |
| 调用级耗时 | **无** | **无** | — | — | — | — |

表中空白格即差异化：**砚流比现有任何一套词汇多出 `call.output`（富流）、`call.sideEffect`、`call.cancelled`、`parentCallId`、`seq`、调用级 `durationMs/bytes/retries` 六项**，其余全部可无损映射到 AG-UI，故**保留一个单向导出适配器即可对外讲 AG-UI**（K3 精神：不私有化外部可见语义）。

### 4.14 明确不做的五件事

1. **不做 WebSocket**。K1；且 2026 的 SSE-vs-WS 论证一致指向：单向服务端输出用 SSE 更省 [60]，需要双向控制的场景在 SLATE 里已由「关流即取消」承担。
2. **不把 agent 循环搬到后端**。这是 SLATE 的结构性资产：编排在前端使 `seq` 分配、审批、降级、多 provider 归一化都不需要新的服务端会话态，恰好绕开 MCP 无状态化最难的那部分。代价（四处复制）交给 C1 处理，不用架构反转来解。**→ 已兑现**：P0 把两处同骨架循环收进一个 kernel，重复的只是各平台的 policy/view/io 装配，协议改造现在落一遍。
3. **不宣称能对**外部 MCP 服务端**流式其工具输出**。规范里没有这个通道 [14][13]，任何这样做的实现都是幻觉。
4. **不做同时「关流取消」与「断开仍后台运行」**。二者互斥；后台化必须走 `taskId` 句柄（4.7 FT 级），列为独立阶段。
5. **不做审批 classifier**。理由见 4.9。

---

## 5. 第 4 部分：现有工具改造映射表

清点（本人逐条核对代码，非代理转述）：**后端已注册 34 个内置 skill**（`backend/routers/skills.py:31-66`；`backend/skills/` 下另有 4 个支撑模块 `__init__` / `plugin_adapter` / `sandbox` / `text_io` 未注册）；**前端注册 25 个 agent 工具**（`frontend/js/services/tools.js:43` 起，逐 key 清点为 25）。两者存在 6 处同名包装（`code_search` / `image_gen` / `video_gen` / `system_info` / `file_edit` / `file_create`），前端为入口、后端为执行体。

**类别图例**：`静`=F0 瞬时不建卡 · `标`=F1 标量进度 · `流`=F2 输出分块 · `产`=F3 产物引用 · `问`=需审批/反问 · `嵌`=产生子笔 · `透`=保真度取决于下游。
**取消强度**：**强**=本地循环/纯计算，随时可断 · **中**=需 kill 子进程或停在上一步 · **弱**=外部副作用已发生、不可回滚。

### 5.1 后端 34 个内置 skill

| 技能 | 现形态 | 目标类别 | 关键 emit | 取消 | 落笔预览字段 |
|---|---|---|---|---|---|
| `file_tree` | 同步一次返回 | 静 | finished | 强 | path/depth |
| `file_peek` | 同步 | 静 | finished | 强 | path |
| `terminal` | 阻塞至 timeout(30s) 后整块返回 | **流+问** | output(stdout/stderr 逐行)+progress+sideEffect(process) | 中：kill 子进程 | command, timeout |
| `html_render` | 同步 | 静 | finished | 强 | — |
| `css_color` | 同步 | 静 | finished | 强 | — |
| `doc_write` | 同步产 md | 产+流(参数侧) | artifact | 强 | markdown(有界行数) |
| `ppt_create` | 同步产 pptx | **标+产** | progress(逐页 n/N)+artifact | 中：逐页检查点 | title, slides 数 |
| `word_create` | 同步产 docx | 标+产 | progress(逐节)+artifact | 中 | title |
| `file_edit` | 同步 | 问+产 | sideEffect(file_write)+artifact(diff) | 强（写前） | path, diff |
| `file_create` | 同步，参数常含大段正文 | **流(参数侧)+问+产** | sideEffect+artifact | 强 | path + content 行数/字节 |
| `code_search` | 同步 | 流 | output(逐命中)+progress | 强 | query, path |
| `text_summarize` | 同步（内含模型往返） | 标 | progress(阶段) | 中 | text 长度 |
| `json_tool` | 同步 | 静 | finished | 强 | op |
| `regex_test` | 同步（已有 ReDoS 超时） | 静 | finished | 强 | pattern |
| `repo_stats` | 同步遍历 | 标 | progress(逐阶段) | 强 | path |
| `todo_scan` | 同步遍历 | 流 | output(逐文件命中) | 强 | path |
| `web_search` | 同步（双引擎） | 标 | progress(检索/去重/摘要) | 强：断 httpx | query |
| `web_fetch` | 同步（含渲染降级/PDF） | 标+流 | progress(请求/渲染/抽取)+output(正文分块) | 强 | url |
| `chart_create` | 同步产 SVG | 产 | artifact | 强 | chartType |
| `qrcode_create` | 同步产图 | 产 | artifact | 强 | — |
| `python_api_extract` | 同步反射 | 标 | progress(逐模块) | 强 | module |
| `html_bundle` | 同步拉多资源 | **流+产** | progress(i/N)+output(逐资源)+artifact | 强 | url, out |
| `code_scan` | 同步全量扫 | **流+标** | progress(逐文件)+output(逐发现)+sideEffect? | 强 | path, level |
| `doc_scan` | 同步逐文档 | 流+标 | progress(逐文档) | 强 | path |
| `mcp_factory` | 同步生成并注册新工具 | **问+嵌** | sideEffect(file_write)+artifact | **弱**：注册后需回滚 | name |
| `system_info` | 同步 | 静 | finished | 强 | — |
| `browser_automation` | 同步 Playwright 多步 | **流+问** | progress(逐动作)+output(截图/DOM 摘要)+sideEffect(network) | **弱**：已提交的点击不可撤 | url, action |
| `computer_use` | 同步键鼠注入 | **流+问** | progress(逐动作)+sideEffect(desktop) | **弱**：注入即发生 | app, action |
| `excel_tool` | 同步产/读 xlsx | 标+产 | progress+artifact | 中 | path |
| `pdf_tool` | 同步产/读 pdf | 标+产 | progress+artifact | 中 | path |
| `git_tool` | 同步执行子命令 | 流+问 | output(逐行)+sideEffect(git) | **弱**：push/checkout 不可回滚 | repo, subcommand |
| `screenshot_to_code` | 同步模型往返 | 标+产 | progress(读图/生成/校正) | 中 | image ref |
| `image_gen` | 同步等外部 API | 标+产 | progress(提交/生成/回传)+artifact | 中：可弃但上游已计费 | prompt |
| `video_gen` | 同步等外部 API（最慢） | **标+产** | progress(阶段)+artifact | 中：同上 | prompt |

**统计**：需接入 `call.output` 富流者 **10 个**（terminal / code_search / todo_scan / web_fetch / html_bundle / code_scan / doc_scan / browser_automation / computer_use / git_tool）；需接入逐阶段 `call.progress` 者 **14 个**；纯 `静`（明确不建卡）者 **8 个**；需审批/反问者 **8 个**；产物引用者 **12 个**。→ **首批只需做 terminal + code_scan + html_bundle 三个，即覆盖「逐行输出、逐文件进度、逐资源计数」三种典型形态。**

### 5.2 前端 25 个 agent 工具

| 工具 | 目标类别 | 说明 |
|---|---|---|
| `project_info` / `project_files` / `project_read_file` / `project_find_file` | 静 | 本地内存/文件读，亚 300ms，只落 finished |
| `board_add` / `board_read` / `board_update` / `board_batch` / `board_clear` | 静 | 白板本地态；`board_batch` 建议 emit `sideEffect{kind:"state"}` 计数，因为它是账本自引用 |
| `code_search` | 透 | 包装后端同名 skill，继承其 `流` 级 |
| `image_gen` / `video_gen` | 透 | 包装后端，继承 `标+产` |
| `system_info` | 透 | 静 |
| `file_edit` / `file_create` / `file_append` | 问+产 | 前端已有 diff 预览能力，接 `sideEffect(file_write)` |
| `skill_run` | **透（枢纽）** | 34 个 skill 的唯一入口，**也是保真度衰减点**：现在把结果字符串截到 2000 字符（`tools.js:388`）。改为一笔一流后，此工具是主改造面 |
| `skill_search` | 静 | 工具目录检索（见 5.3） |
| `subagent_run` | **嵌** | 已存在 `Promise.all` 并发 5（`subagent.js:169`），必须补 `parentCallId` 与子笔聚合，否则嵌套层仍黑盒 |
| `user_ask` | **问** | 天然是 `call.input.required` 的实现，应直接对齐三值 action，不必另造 |
| `knowledge_search` / `knowledge_add` | 静 | — |
| `prompt_gen` | 标 | 内含模型往返，宜给阶段进度 |
| `chat_context` / `todo_manage` | 静 | — |

### 5.3 附带建议：工具目录分层（已由 `skill_search` 领先半步）

SLATE 现状是 25 个内联 schema + 34 个后端 skill 靠 `skill_search` 现查现用（`CORE_AGENT_TOOLS` 紧凑列表，`tools.js:1044`）——**这已经是 Anthropic Tool Search 的雏形** [2]，只是没被形式化。建议明确成两级：`tier1` 内联完整 schema（高频约 10 个）；`tier2` 只暴露「名字 + 一行描述」，模型 `skill_search` 命中后**按需 materialize schema**。因为编排在前端，这个展开**不消耗任何 provider 能力**（不需要 `defer_loading`），成本仅是一次本地查表——这恰好是模型侧那套「10,000 工具、省 85% token」机制 [2] 在本地客户端的免费等价物。

---

## 6. 第 5 部分：分阶段落地路线（P0、P1、P2 与 P3 首批已落地，其余仅排序）

| 阶段 | 内容 | 依赖 | 触碰面 | 风险 |
|---|---|---|---|---|
| **P0 循环收敛** | 把 `chat.js` / `mobile/m-chat.js` 两处同骨架 `runToolLoop` 抽成单一 `agent_loop.js` kernel（`team.js` 是多轮辩论循环、`subagent.js` 是裸 `messages[]` 迷你循环，形态不同不并入，只共享截断守卫） | — | 2 文件 → 1 | **高**（回归面最大），但不做则后续每步都要落两遍 |
| **P1 事件化（零行为变更）** | 引入 `runId` / `callId` / `seq` + `tool_events` 表；现有信息以事件形式**先落账**；白板与聊天卡片改为账的投影，删除 `addToolStepCard`/硬编码描述表 | P0 | chat.js、whiteboard.js、chat.py | 中（纯结构，功能不变） |
| **P2 落笔即所见** | 前端 `call.args` + schema-aware 前缀解析 + 节流渲染。**不依赖后端任何改动**，可与 P1 并行 | — | chat.js、api.js、tools.js | 低（前端独立，最易回退）|
| **P3 取消真达** | 新增 `POST /api/skills/stream`（一笔一流）+ `ctx` 桥接 disconnect；**首批只接 terminal / code_scan / html_bundle** | P1 | skills.py、3 个 skill、tools.js | 中（线程池内协作取消需谨慎） |
| **P4 并行 + 审批状态化** | `executeToolCalls` 改受控并发；`await guard()` 拆为 `awaiting_approval` 状态 + 内联审批卡 + 三档作用域缓存；粘性三态条 | P3 | tools.js、riskguard.js、chat.js、style.css | **高**（改变执行时序，需重跑目标模式回归） |
| **P5 MCP 客户端现代化** | 声明 `capabilities`、按 `progressToken` 路由通知、支持 Streamable HTTP + stdio；把 `FX/FT` 两级降级接进同一事件族 | P3 | mcp_client.py、mcp_servers.py | 中（外部服务端行为不可控，须保守超时） |
| **P6 重放与后台化** | 审计视图（`projectAudit`）+ 按 `seq` 续读；如需「断开仍跑」，另立 tasks 式 `invocationId` 轮询通道 | P1,P3 | 新组件 | 低，但**必须与关流取消二选一表述清楚** |

**落地状态（2026-09-06，缓存串 `20260907-022`）**

- **P0 已落地**（循环收敛）：`frontend/js/services/agent_loop.js` 的 `createAgentLoop({ policy, view, io })` 是唯一的工具循环实现，桌面 `chat.js` 与移动 `m-chat.js` 各留一份装配。三个注入面分工：`io` 管后端与存储（探测调用、执行、落库、新建气泡续写一轮），`view` 管 DOM（气泡重锚定、正文回显、进度条、步骤卡），`policy` 管产品决策与**模型可见字符串**（桌面六条空轮策略、去重催办、轮末是否退出）。共享 helpers 早一步抽到 `agent_common.js`（`dedupeToolCalls` / `formatToolResultForModel` / `buildToolFollowupInstruction` / 截断守卫），三端分歧全部收敛为具名常量，由 `scripts/check_agent_prompts.mjs` 逐字钉住输出；骨架语义由 `scripts/check_agent_loop.mjs` 的 11 个桩件场景钉住。`team.js` 与 `subagent.js` 按上面核实结论不并入，前者只删死导入，后者只共享截断守卫。顺带修掉两处既有缺陷：退出清理从「只有正常路径才走」搬进 `try/finally`（抛异常时 `_pendingToolMsgs` 泄漏，残留标记会被渲染成伪造的"历史恢复"卡片）；移动端 `finalContent = await mContinueTruncated(...)` 拿到的是对象而非 `.content`。
- **P1 已落地**（事件化，零行为变更）：建表与实际出入见 4.11「P1 落地实况」。账**由 kernel 驱动**（`policy.openRun` 注入，所以三端一次到位，不再落两遍），客户端在 `agent_ledger.js`：轮次边界 + 收尾 + `pagehide` 三个 flush 点，一律 fire-and-forget 且异常只 warn——**落账失败绝不影响聊天**（`check_agent_loop.mjs` 场景 11 用 `openRun → null` 钉这条，`check_agent_ledger.mjs` 钉上行字段名与投影形状）。白板步骤卡与聊天工具卡片同时改为这份账的投影，`addToolStepCard` / `updateToolStepCard` 与硬编码描述表删除，工具标签与参数摘要改由 `tool_meta.js` 从 `TOOLS` 一处派生。
- **P0/P1 之前手动垫付的代价已收敛**：`signal` 只在 kernel 一处贯穿（原先三处调用点各贯穿一遍）；「气泡被整表重渲染替换」时的实例迁移收进 `view.reanchorBubble` seam，`chat.js` 不再手写这层补丁；砚流条**仍是即时投影**——它演的是字节级参数增量，不进账（账只到 `call.*` 粒度），这条是有意的边界而非欠账。
- **P2 已落地**（纯前端）：`frontend/js/services/inkstream.js` 承担 schema-aware 容错前缀解析、有界摘录、150ms 节流与 `required ≤ 2` 短参跳过；`api.js` 在 `delta.tool_calls[]` 分片上透出参数增量；`chat.js` 在生成/续写/追问/重生成四处挂条。行键约定：`n{index}`=原生协议参数行、`t0`=文本协议参数行、`e{i}`=执行行，执行行以 `hide` 接管其参数行。
- **P3 首批已落地**：`POST /api/skills/stream`（一笔一流，`backend/routers/skills.py`）+ `backend/skills/call_ctx.py` 的 `CallContext` 桥接 ASGI disconnect（1s 宽限后 drain 队列再发终态帧）；terminal / code_scan / html_bundle 三个 skill 加 `run_stream`，其余 31 个仍走 `/execute`（字节兼容，前端仅在流从未建立时才回落，abort 与半途中断一律不重放）。
- **未触碰**：并行与审批状态化（P4）、MCP 客户端现代化（P5）、账本读端点与重放/后台化（P6）。

**排序理由**：P0 最痛但唯一不可跳过；P2 排在后端改造之前，因为它是**纯前端、零协议风险、且直接填补 G1 这一被核实的市面空白**——投入产出比最高。P3 之后才谈并行与审批，因为没有真取消通道的并行会把「不可撤销副作用」的窗口放大（`computer_use`、`git_tool`、`browser_automation` 取消强度为弱）。

---

## 7. 第 6 部分：反方观点与方案自检

1. **最大风险不是设计而是「循环在前端」这个前提本身。** 市面把编排放服务端不是偶然：一处编排逻辑意味着一份事件语义。SLATE 现在有 **4 份**（3.1 末）。若 P0 不做，砚流会变成 4 套方言，「唯一事实源」当场破产。**接受这个前提的代价要显式支付**，不能用「架构更先进」糊过去。**→ 已支付（P0/P1）**：4 份的计数经复核应为 2 份同骨架循环，两者已收进 `services/agent_loop.js`；事件语义同样由 kernel 单点 emits（`services/agent_ledger.js`），桌面/移动装配层不再各自决定落什么账。
2. **「落笔即所见」有变成噪声的现实风险。** Claude Code 之所以专门做全屏渲染器，动因就是「工具输出流入导致屏幕闪烁、滚动跳顶」[38]——**洪泛在 2026 年已是渲染器级性能问题**。砚流的对策是三条硬规则（只渲染闭合字段、有界摘录、`required ≤ 2` 直接跳过）+ 120–200ms 节流，并应从一开始就提供**「展示详细程度」滑杆**（七模式框架里的「思考外显」明确要求这一点 [49]）。若这三条不做，P2 会比现状更差。
3. **「关流即取消」与「断开仍后台运行」互斥，本方案选了前者。** 反面证据明确存在：OpenAI 用 `background:true` + 重连拿到部分结果 [11]，MCP 用 `taskId` 作为断连恢复句柄 [19]，Cloudflare Durable Objects 干脆把耐久与多路流做成同一个原语 [61]。它们都在解决「长任务不该因为客户端断开而死」。**砚流在 P6 之前不具备这个能力**，对 `video_gen`（分钟级）这类工具，用户关窗即杀任务将是真实投诉来源。诚实的写法是承认边界，而不是宣称两者兼得。
4. **观看得多，未必是好事。** 中文技术媒体把 Claude Code 的 agent view 读作「监工屏」，同时有相当分量的反方声音：「我不想整天坐着看 agent 改来改去」[50][48]。砚流的三态聚合条与逐行动作流**都在往「多看」方向走**，与「认知减负」原则相抵 [49]。缓解：默认折叠（继承产品层通用语法 [34]）、聚合条只在**有笔在等你**时才亮、`静` 级工具明确不建卡。
5. **审批疲劳的解法被有意削弱了。** Anthropic 已用第二个模型替你审 [36]，Codex 走 sandbox×approval 的正交分级 [44]。砚流只做「分级 + 摘要 + 缓存 + 不阻塞兄弟笔」，**没有解决「用户开始无脑点确认」这个行为层面缺陷** [48]。备选（未纳入）：批准后 N 秒内可撤销的「延迟生效」窗口，以及把同一批同类审批合并成一次决策。
6. **调用级耗时/成本是本地测量，不是真账。** Claude Code 的成本面板做到 `Total duration (API)` 与 `(wall)` 分列、按模型分列 token、甚至给出 prompt cache 命中率 [41]。砚流的 `durationMs/bytes/retries` 只覆盖工具自身，**不含模型侧归因**，因此不能被宣传为「成本可核验」，只能说「耗时可核验」。
7. **两处规范依赖不稳。** MCP 约每年两版且含破坏性变更 [27]，2026-07-28 一次性移除了 GET 流、重放、session、`initialize`，并废弃 Roots/Sampling/Logging [12]；AG-UI 目录本身在长（核实发现已有 `Subagent*`、`Reasoning*`、`Activity*`、`MetaEvent`，超出常见引述）。**任何写死字面量的适配器都是半年债**，4.13 的对齐表应作为回归测试对象而非一次性文档。此外 `initialize`/`notifications/initialized` 被移除意味着 opencode 那类「客户端能力不全」的问题 [29] 会普遍存在——**不能假设外部服务端真的会发进度**，`F1/FX` 的「不伪造百分比」规则因此是必需的。
8. **对比案例说明这不是过度设计。** Aider 的形态是「diff 直接打进聊天、靠 git 做审阅与回退、没有 in-flight 工具态、没有日志面板」[46]——那是 2024 年的够用线。2026 年把它当成可接受基线的产品已经不存在；LangChain 干脆把规划、子代理、自校验、文件系统状态与**中断钩子**统称为 harness 的一等职责 [47]。砚流是在补作业，不是在叠功能。
9. **本报告的证据边界**：LangGraph 的人机中断机制（`interrupt()` / `Command(resume=)`）所引官方页 404，正文全程按 `[未核实]` 处理，砚流的 `awaiting_input` 设计**未依赖它**，而是钉在已逐字核实的 MCP `input_required` [18] 与 A2A `input-required` [55] 上。OTel 属性名 `[未核实]`，故 4.2 只把它写成内部约定。

---

## 8. 附录：来源清单（61 条）

标注：`✓`=已逐字回源核实；`◐`=一手页面已取但抽取不完整；`[s]`=仅搜索片段，未取正文；`✗`=回源失败，正文已标 `[未核实]`。

### A1 模型 API 层
1. Anthropic — Fine-grained tool streaming — https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming — T1 ✓（已 GA，beta header 转遗留）
2. Anthropic — Tool Search Tool — https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool — T1 ✓
3. OpenAI — Function calling / Responses streaming — https://developers.openai.com/api/docs/guides/function-calling — T1 ◐
4. Dong et al., Microsoft Research — XGrammar — https://arxiv.org/abs/2411.15100 — T1 ✓
5. Google — Gemini Function calling — https://ai.google.dev/gemini-api/docs/function-calling — T1 ◐
6. Google — Gemini Streaming — https://ai.google.dev/gemini-api/docs/streaming — T1 ◐
7. vLLM — Issue #42400（流式 tool call 间歇解析失败）— https://github.com/vllm-project/vllm/issues/42400 — T1 [s]
8. SGLang — Issue #12626（streaming tool_calls 双重 unicode 转义）— https://github.com/sgl-project/sglang/issues/12626 — T1 [s]
9. LiteLLM — Issue #17246（Responses 上游丢 tool_calls）— https://github.com/BerriAI/litellm/issues/17246 — T2 [s]
10. OpenAI Dev Community — Responses API streaming guide — https://community.openai.com/t/responses-api-streaming-the-simple-guide-to-events/1363122 — T3 [s]
11. Microsoft Learn — Azure OpenAI Responses API（`background`）— https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/responses — T1 [s]

### A2 MCP 协议层
12. MCP — Key Changes 2026-07-28 — https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/changelog.mdx — T1 ✓
13. MCP — Streamable HTTP 2026-07-28 — …/2026-07-28/basic/transports/streamable-http.mdx — T1 ✓
14. MCP — Progress Notifications — https://modelcontextprotocol.io/specification/2026-07-28/basic/utilities/progress — T1 ✓
15. MCP — Cancellation Notifications — https://modelcontextprotocol.io/specification/2026-07-28/basic/utilities/cancellation — T1 ✓
16. MCP — Subscriptions pattern — …/2026-07-28/basic/patterns/subscriptions.mdx — T1 ✓
17. MCP — MRTR pattern（SEP-2322）— …/2026-07-28/basic/patterns/mrtr.mdx — T1 ✓
18. MCP — Elicitation — …/2026-07-28/client/elicitation.mdx — T1 ✓
19. MCP ext-tasks — Tasks Extension 2026-07-28 — https://raw.githubusercontent.com/modelcontextprotocol/ext-tasks/main/specification/2026-07-28/tasks.md — T1 ✓
20. MCP — Tasks extension overview — https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/extensions/tasks/overview.mdx — T1 ✓
21. MCP — Tools 2026-07-28 — https://modelcontextprotocol.io/specification/2026-07-28/server/tools — T1 ✓
22. MCP — Transports 2025-11-25（旧基线）— https://modelcontextprotocol.io/specification/2025-11-25/basic/transports — T1 [s]
23. tonybai — MCP 史上最大更新：State 消失 — https://tonybai.com/2026-07-30/mcp-2026-07-28-stateless-core-claude/ — T2 [s]
24. WorkOS — MCP Async Tasks / Everything about MCP in 2026 — https://workos.com/blog/mcp-async-tasks-ai-agent-workflows — T2 [s]
25. Agnost AI — Long Running Tasks in MCP（call-now, fetch-later）— https://agnost.ai/blog/long-running-tasks-mcp — T3 [s]
26. Microsoft — Can You Build Agent2Agent Communication on MCP? — https://developer.microsoft.com/blog/can-you-build-agent2agent-communication-on-mcp-yes — T1 [s]
27. Hidekazu Konishi — MCP Specification Version Timeline — https://hidekazu-konishi.com/entry/mcp_specification_version_timeline.html — T3 [s]
28. MCP Registry / Nordic APIs — Official Registry API — https://registry.modelcontextprotocol.io — T1 [s]
29. opencode — Issue #28567 Full MCP client capabilities — https://github.com/anomalyco/opencode/issues/28567 — T3 [s]
30. Microsoft Learn — Use tool search with Azure OpenAI Responses — https://learn.microsoft.com/zh-cn/azure/foundry/openai/how-to/tool-search — T1 [s]
31. ACP (Zed) — Elicitation RFD + Streamable HTTP/WebSocket Transport RFD — https://agentclientprotocol.com/rfds/elicitation — T1 [s]
32. 掘金 — MCP 协议 2026 信任危机 — https://juejin.cn/post/7618795660519833654 — T3 [s]
33. aibsz / developer.aliyun.com — MCP 2.0 无状态评测；「成熟始于主动收缩协议边界」 — https://aibsz.com/2026-08-14/mcp-2-0-stateless-protocol-review-2026/ — T3 [s]

### A3 产品交互层
34. Anthropic — Claude Code Interactive mode — https://code.claude.com/docs/en/interactive-mode — T1 ✓
35. Anthropic — Claude Code Permissions — https://code.claude.com/docs/en/permissions — T1 ✗（配额耗尽，未复核）
36. Anthropic — Claude Code Permission modes — https://code.claude.com/docs/en/permission-modes — T1 ✗（未复核）
37. Anthropic — Claude Code Tools reference（输出上限）— https://code.claude.com/docs/en/tools-reference — T1 ✓
38. Anthropic — Claude Code Fullscreen rendering — https://code.claude.com/docs/en/fullscreen — T1 ✓
39. Anthropic — Claude Code Agent view — https://code.claude.com/docs/en/agent-view — T1 ✓
40. Anthropic — Claude Code Agent teams / Run agents in parallel — https://code.claude.com/docs/en/agent-teams — T1 ✓
41. Anthropic — Claude Code Checkpointing / Manage costs — https://code.claude.com/docs/en/checkpointing — T1 ✓
42. Cursor — Agent overview / tools — https://cursor.com/docs/agent/overview — T1 ◐
43. Cursor — Changelog — https://cursor.com/changelog — T1 [s]
44. OpenAI — Codex CLI docs — https://learn.chatgpt.com/docs/codex/cli — T1 ✗（仅取到摘要）
45. Google — Gemini CLI keyboard shortcuts — https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/keyboard-shortcuts.md — T1 ✓
46. Aider — Usage — https://aider.chat/docs/usage.html — T1 ◐
47. Vivek Trivedy (LangChain) — The Anatomy of an Agent Harness — https://www.langchain.com/blog/the-anatomy-of-an-agent-harness — T2 [s]
48. Hacker News（IAXT / grith / LaneKeep / Raindrop 等一手评论）— https://news.ycombinator.com/ — T3 ✓（评论原文）
49. 贾思玉 Siyu Jia — AI Agent 产品交互设计：设计模式与案例分析 — https://siyujia.net/posts/ai-agent-hci — T2 ✓
50. 网易 / 头条 — Claude Code「监工屏」与 Agent View 讨论 — https://www.163.com/dy/article/KSO4IGF0051180F7.html — T3 [s]

### A4 编排框架与事件协议层
51. CopilotKit / AG-UI — Events（concepts + JS core events）— https://docs.ag-ui.com/concepts/events — T1 ✓（含清单更正）
52. Vercel — AI SDK Chatbot Tool Usage — https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage — T1 ✓（含审批状态新证）
53. LangChain — LangGraph Streaming — https://docs.langchain.com/oss/python/langgraph/streaming — T1 ◐
54. LangChain — LangGraph Human-in-the-loop — https://docs.langchain.com/oss/python/langgraph/add-human-in-the-loop — T1 ✗（404）
55. Google / Linux Foundation — A2A Specification — https://a2a-protocol.org/latest/specification/ — T1 ◐（状态清单已更正为 8 值）
56. OpenTelemetry — GenAI semantic conventions（已拆独立仓）— https://opentelemetry.io/docs/specs/semconv/gen-ai/ — T1 ✓
57. OpenTelemetry blog — Inside the LLM Call: GenAI Observability — https://opentelemetry.io/blog/2026/genai-observability/ — T1 [s]
58. Thoughtworks — Radar: Ignoring durability in agent workflows（Techniques · Caution · 2026-04-15）— https://www.thoughtworks.com/radar/techniques/ignoring-durability-in-agent-workflows — T2 ✓
59. CSDN HWY336 — 断线之后，不要重跑 AI（POST + NDJSON 续读）— https://blog.csdn.net/HWY336/article/details/163274241 — T3 [s]
60. Channel — Streaming AI Responses: SSE, WebSockets — https://www.channel.tel/blog/streaming-ai-responses-sse-websockets-real-time — T2/3 [s]
61. Cloudflare — Agents SDK / Durable Objects — https://developers.cloudflare.com/agents/ — T1 [s]

### A5 本地代码依据（SLATE，非外部来源）
`backend/routers/proxy.py`、`skills.py`、`chat.py`、`events.py`、`mcp_client.py`、`backend/skills/*`、`frontend/js/services/{api,tools,riskguard,subagent,store,agent_common,agent_loop,agent_ledger,tool_meta,inkstream}.js`、`frontend/js/components/{chat,whiteboard,schedule,team,mcp_server_panel}.js`、`frontend/js/mobile/m-chat.js`、`frontend/css/style.css`。全部引用以 `文件:行` 形式内联，其中 `progressToken` 等 MCP 高级语义零命中已由本人 grep 复核；「工具循环四处复制」一条写作时按 grep 命中计为 4，P0 实施时逐处读码复核为 **2 处同骨架循环 + 2 处形态不同**，正文与 §6 路线表已按后者修正。
