# SLATE 全量代码审查 Bug 报告

- **审查日期**：2026-08-28
- **审查范围**：backend（20 个 router + 34 个 skill + 核心模块，约 14,000 行 Python）、frontend（约 40 个 JS/HTML 文件，约 21,000 行）、desktop.py、构建/CI 脚本
- **审查方法**：
  1. 客观检查：`py_compile` 全量语法编译、`node --check` 全量 JS 语法、`check_mojibake` 编码检查、ruff 静态分析（E9/F63/F7/F82/F401/F841/ASYNC 等规则）、i18n 词典覆盖率脚本
  2. 12 个并行审查代理分片逐行深读全部源码
  3. 对全部高严重度发现逐条读源码交叉核实，剔除误报
- **结论概览**：共确认 **55+ 个真实缺陷**，其中高危 12 个、中危 26 个、低危 17+ 个。语法/编码层面全部干净，问题集中在**逻辑错误、异步误用、路径校验缺陷、状态竞态**四类。

---

## 一、高危缺陷（P0）

### 1. LAN 鉴权可被伪造 Host 头完全绕过
- **位置**：`backend/routers/lan.py:76-95`（`_host_port` / `is_lan_request`）、`lan.py:136-141`（中间件）
- **置信度**：确定
```python
def is_lan_request(request: Request) -> bool:
    port = _state.get("port")
    return bool(port and _host_port(request) == port)

async def enforce_lan_auth(request: Request, call_next):
    if not is_lan_request(request):
        return await call_next(request)   # Host 端口不匹配 → 直接放行
```
- **问题**：是否要求 token 取决于客户端可任意伪造的 `Host` 头。局域网攻击者向 8001 副端口发请求时带 `Host: foo`（无端口 → 返回 None）或 `Host: x:8000`，`is_lan_request` 即返回 False，中间件直接放行，无需 token 即可访问全部 API——包括读取聊天记录、执行 terminal 技能、调用 `/api/lan/info` 拿到 token 本身。副服务绑定 `0.0.0.0`（lan.py:167），整个 token 机制形同虚设。
- **连带**：`lan.py:107` 的 `secrets.compare_digest(str(item), expected)` 在 token 含非 ASCII 字符（如中文）时抛 TypeError → 500。

### 2. experts 文件接口盘符穿越 → 任意文件读/写/删
- **位置**：`backend/routers/experts.py:117-125`（`_safe_rel_name`）；入口：上传 327-332、读取 302-313、删除 336-347
- **置信度**：确定
```python
name = str(name or "").replace("\\", "/").strip()
if not name or name.startswith("/"):
    return None
parts = [p for p in name.split("/") if p and p not in (".", "..")]
```
- **问题**：清洗只拒绝前导 `/` 和 `..`，不拒绝带盘符的名字。`name="C:/evil.bat"` 通过校验后，`target = d / folder / clean` 中 pathlib 遇到右侧绝对路径会**丢弃左侧**，target 变成 `C:/evil.bat`。上传接口的 `target.parent.mkdir + write_bytes` 即写任意绝对路径文件；删除接口的 `path.unlink()` 删任意文件；读取接口读任意文件。`file.filename` 来自 multipart，可直接 curl 构造；经发现 1 的 LAN 绕过，局域网设备同样可打这个洞。

### 3. Gemini 模型聊天完全不可用
- **位置**：`backend/routers/proxy.py:636-671`（google 分支）；前端 `frontend/js/services/api.js:159-255`
- **置信度**：确定
- **问题**：anthropic/openai 分支都有 `if is_stream: return StreamingResponse(...)`，google 分支没有——流式请求拿到普通 JSON。而前端 `streamChat` 固定发送 `stream: true` 且只解析 SSE `data:` 行 → 解析不出任何增量 → `yieldedAny=false` → 报"模型连接已结束，但没有返回任何可显示内容"并重试后失败。
- **触发条件**：模型下拉选择任意 gemini-* 模型（`team.js:35` 还默认给"创意官"成员配了 gemini-3.6-flash，团队辩论同样必挂）。

### 4. MCP 远程服务器（HTTP+SSE）连接机制损坏
- **位置**：`backend/mcp_client.py:73-103`（连接逻辑）、`106-120`（无错误检查）
- **置信度**：很可能
```python
async with self._client.stream("GET", sse_url, ...) as resp:
    ... self._message_url = ...; break            # 取到 endpoint 后退出，连接关闭
self._sse_task = asyncio.create_task(self._listen_sse())  # 另开一条新 SSE 连接
...
self.status = "connected"                          # 无条件标记成功
```
- **问题**：MCP HTTP+SSE 传输的 message URL 绑定当前 SSE 会话（含 sessionId）。第一条连接读出 endpoint 后即关闭，`_listen_sse` 新开的连接对应**新会话**，此后所有 POST 都发往已死会话的 URL → 404 或响应丢失，initialize/tools/list/tools/call 全部拿不到结果。而 `connect()` 从不检查 `init_result/tools_result` 中的 "error"，无条件标记 `connected` → 界面显示"已连接、0 工具"，每次调用 15 秒超时（mcp_servers.py:48-51 只要 status≠"error" 就返回 code 0，用户看到假成功）。另：connect 失败路径不关闭 `self._client`、不取消 `_sse_task`。

### 5. 生成中切换/新建会话 → 旧回复污染新会话并持久化
- **位置**：`frontend/js/components/chat.js:3587-3598`（switchConversation 无 abort 守卫）、`chat.js:2924/2940`（持久化用 currentConversationId）、`chat.js:4141-4153`（新建对话同样无守卫）
- **置信度**：确定
- **问题**：生成期间点击侧栏其它会话 B：`currentConversationId` 立即变为 B、`state.messages` 被 B 的消息替换；流式循环仍写旧的已脱离 DOM 的元素（输出"冻结"）。流结束后 `updateLastAssistantMessage` 直接**覆盖 B 的最后一条助手消息**；随后 `post` 用 currentConversationId 把 A 的回复**持久化进 B 的后端历史**；runToolLoop 每轮的隐藏 tool_results、followUp 也全部追加进 B。生成中点"新对话"则进行中的回复整体丢失。chat.js 全文仅 stopGeneration(1439) 和看门狗(3994) 调用 abort，切换路径没有任何守卫。

### 6. file_edit 的 replace 动作绕过用户确认直接写盘
- **位置**：`backend/skills/file_edit.py:222-227`
- **置信度**：确定
```python
new_content = content.replace(old_str, new_str, 1)
write_error, ... = _write_file(file_path, new_content, detected_encoding)
```
- **问题**：其余所有变更动作（edit/replace_range/insert/delete/paste/cut）都只返回 `new_content` 预览，由前端经 `/projects/apply-edit` 在用户点【接受】后才写入；唯独 `replace` 在后端直接备份并写盘，且返回值不含 `new_content`/`diff`，前端连 diff 卡片都渲染不出来。`mcp.py:460` 与 `skills.py:130` 都是 `module.execute(**params)` 直调、无确认拦截层——AI 经 MCP 调 `action=replace` 即可无确认落盘。这直接违反项目"零自主修改"原则（见项目记忆：文件变更必须经用户确认）。

### 7. python_api_extract 污染 sys.modules 且永不清理
- **位置**：`backend/skills/python_api_extract.py:206、224、260`
- **置信度**：确定
- **问题**：把本地文件/目录以裸名注册进 `sys.modules` 后从不删除。若提取 `json.py`、`utils.py` 或名为 `requests` 的本地目录，将永久遮蔽进程内同名标准库/第三方模块，**整个 FastAPI 后端**后续任何 `import` 都命中被污染的缓存；224 行还在 exec 失败前就注册，失败也留下半初始化模块。`sys.path` 在 finally 里移除了，但 sys.modules 泄漏无任何清理。

### 8. 事件循环阻塞（多处 async 路由/协程内同步重 IO）
- **位置**（均已核实）：
  - `backend/routers/mcp.py:460`：`module.execute(**arguments)` 同步直调——terminal/computer_use/web_search 等耗时数十秒的工具会挂起整个后端（含聊天流式）
  - `backend/routers/skills.py:310`：GitHub 导入同步 `urlretrieve`（`plugin_adapter.py:209-210` 无 timeout）——网络黑洞时**永久挂死整个后端**
  - `backend/routers/scheduler.py:128/156-159/360`：每 30 秒的 tick 里同步 `rglob` 全目录 + `subprocess.run git`（10s 超时）；`_init_event_snapshots`（startup + create_task 路由）同样同步全量 rglob
  - `backend/routers/chat.py:32-106`：全部 async handler 同步执行 SQLite；`import_all`(387-449) 循环调用同步的 `upsert_document`（分块+哈希+逐条 insert），大备份导入期间所有请求卡死
  - `backend/routers/knowledge.py:120-143/161-179/253-270`、`vault.py:247-278`：同步 SQLite/rglob 逐文件读取
- **对照**：`skills.py:130` 正确用了 `run_in_threadpool`，证明是遗漏而非风格。skills.py:284/296 的本地 IO 同步直调影响较小。

### 9. Playwright 同步 API 在事件循环内调用 → 浏览器工具经 MCP 必然失败
- **位置**：`backend/skills/browser_automation.py:47`、`backend/skills/web_fetch.py:228`
- **置信度**：确定
- **问题**：Playwright 同步 API 在运行中的 asyncio 事件循环内调用会抛 "It looks like you are using Playwright Sync API inside the asyncio loop"。MCP 主调用路径（mcp.py:460）恰在事件循环内同步调用：browser_automation 所有动作 100% 失败（launch 抛错成 isError，其余动作报"浏览器启动失败"）；web_fetch 的 JS 渲染降级被 `except Exception: return None` 静默吞掉，`render_js=on` 永远无效。

### 10. workflow.js 引用不存在的 `state.currentModelId`，兜底永不生效
- **位置**：`frontend/js/services/workflow.js:152`
- **置信度**：确定
```js
const modelId = member?.modelId || node.model || state.currentModelId || "";
```
- **问题**：`state.currentModelId` 在整个前端从未被赋值（grep 确认仅此一处使用；`setCurrentModel` 只写 `state.currentModel`）。工作流节点既无 `role` 又无 `model` 时（注释明确设计了此兜底路径），必抛"节点未绑定可用模型"，即使用户已在聊天区选好当前模型。应为 `state.currentModel?.id`。

### 11. LAN 副服务与主服务跨事件循环共享 app，async 单例跨 loop 使用
- **位置**：`backend/main.py:93-96`、`backend/routers/lan.py:175-185`、`proxy.py:31/129-147`、`mcp_client.py:182`
- **置信度**：很可能
- **问题**：startup 无条件启动 LAN 副服务（独立线程 + 独立事件循环服务同一 app）。`proxy._http_clients` 全局缓存 httpx.AsyncClient 绑定首个使用它的 loop，另一 loop 复用触发 anyio 跨 loop 错误 → 局域网遥控发起聊天（或本机先聊再遥控）必然失败；mcp_client 的 `_pending` future 跨 loop `set_result` → RuntimeError，连接被标记 error。

### 12. 高危命令审批弹窗被 Escape 关闭后，守卫永久失效
- **位置**：`frontend/js/app.js:1131-1133` + `frontend/js/services/riskguard.js:104-110`
- **置信度**：确定
- **问题**：`#risk-modal` 只有"批准/拒绝/×/背景"四个入口会 `settle()`。用户按 Escape 时 app.js 全局快捷键直接加 `hidden`，`pendingResolve` 不清空：① 正在 await 的 `guardSkillParams`（tools.js/skill_panel.js/workflow.js 三处消费方）**永远挂起**，聊天流卡死；② 此后所有高危命令命中 `pendingResolve` 非空分支，被静默拒绝且不再弹窗，直到刷新页面。同根源：Escape 还会把新手引导直接隐藏而不落盘 `onboardingSeen`，导致每次启动再弹。

---

## 二、中危缺陷（P1）

### 安全类

**13. vault `_safe_path` 前缀校验可穿越到同级目录** — `backend/routers/vault.py:22-28`（确定）
`str(target).startswith(str(VAULT_DIR.resolve()))` 未加分隔符边界，`../vault-x/a.md` 解析为 `data/vault-x/a.md`，是 `data/vault` 的字符串前缀 → 校验通过。四个 CRUD 端点均受影响，可在 `data/vault-*` 同级目录任意读写删。

**14. grind 会话 conv_id 未消毒，可任意写/删 .json** — `backend/routers/grind.py:47-61`（确定）
`conversation_id` 来自请求体无校验。传 `../constitution` 会把会话 JSON 覆盖写入 `data/constitution.json`；DELETE 端点配合 `%5C`（反斜杠）可删除任意 .json。

**15. upload_skill 的 skill_name 未消毒，可穿越写文件** — `backend/routers/skills.py:172-187`（确定）
文件名消毒了但目录名原样拼接，传 `../../evil` 可把上传内容写到 skills 目录外任意位置。同源：`execute_skill`(136) 可读任意目录 SKILL.md；`validate_skill_params` 对非 dict params 调 `.items()` → 500。对比 delete/import 都做了 `_sanitize_skill_name`，唯独 upload/execute 漏掉。

**16. CORS `allow_origins=["*"]`，主端口对任意网页开放** — `backend/main.py:22-28`（确定）
主端口 127.0.0.1:8000 无任何 Origin/Host 校验，唯一屏障是全开的 CORS。用户浏览器中的任意恶意网页可直接 fetch 聊天记录、记忆、知识库接口并读取响应，也可调用写接口。

**17. sandbox 敏感文件名正则被锚定成全名匹配，凭据文件全部放行** — `backend/skills/sandbox.py:43-49/100`（确定）
`^(...|\.pem|\.key|\.p12|...)$` 使每个备选必须等于完整文件名。意图是拦 `*.pem/*.key` 后缀，实际 `cert.pem`、`private.key`、`server.p12`、`credentials.json`、`.env` 全部通过。另 `sandbox.py:84-89` 黑名单比较区分大小写，Windows 传 `c:\Windows\System32\...` 即绕过。

**18. terminal 高危拦截漏掉 PowerShell 别名 `ri`** — `backend/skills/terminal.py:47-71`（确定）
规则覆盖 `rm/del/erase/rd/Remove-Item`，但 `ri`（= Remove-Item 的默认别名）不在列表。会话 shell 正是 PowerShell，`ri -Recurse -Force .` 无需 `approved=True` 即可执行。

**19. python_api_extract 输出文件名无穿越校验** — `backend/skills/python_api_extract.py:512-515`（确定）
`file_name` 未消毒也未过 `is_path_safe`，`..\..\x.md` 可写出 outputs 目录外。

### 后端功能类

**20. review_diff 的 subprocess 无 encoding → GBK 解码 UTF-8 diff** — `backend/routers/projects.py:384-387`（确定）
`text=True` 未传 `encoding`，Windows 默认 GBK 解码。中文项目：多数情况输出乱码，部分字节抛 UnicodeDecodeError 被吞成"git diff 失败: 'gbk' codec..."。同文件 `_run_git`(81-92) 显式传了 utf-8，证明是遗漏。Code Review 核心功能在中文项目上不可用。

**21. `_parse_unified_diff` 漏掉所有新增文件** — `backend/routers/projects.py:311-318`（确定）
git 对新增文件的 diff 头是 `--- /dev/null` + `+++ b/new.py`，不匹配 `--- a/` 分支 → 新增文件不进 `files`，total_add/del 少算。

**22. webhook payload 在消费前被清空，永远注入不进提示词** — `backend/routers/scheduler.py:179` vs `269-274`（确定）
`_check_webhook` 判定触发时已把队列置空，随后异步的 `_run_task` 读到的一定是空列表，`Payload: ...` 上下文永远不注入。

**23. `_check_file_changes` 目录监视大量漏报** — `backend/routers/scheduler.py:126-135`（确定）
目录模式只比较"当前 mtime 最大的那一个文件"。新建文件 key 不在 `_file_mtimes` 只记录不触发；修改"不是当前最新"的文件时 newest 换人同样不触发。实际只有"上次的最新文件再次被修改"能触发。

**24. 非原子 JSON 写入 + read-modify-write 竞态（系统性）** — `scheduler.py:60-71`、`settings.py:73`、`constitution.py:35`、`grind.py:51`、`projects.py:207-211`、`mcp_client.py:245-259`（确定）
(a) `write_text` 直接覆盖，写入中途崩溃 → 文件损坏；`_load_tasks` 异常静默返回 `[]` → **所有定时任务永久丢失**。(b) 后台任务完成时的 `_update_task` 与用户并发 PATCH 用旧快照互相覆盖——模型调用常持续数分钟，期间用户改的 prompt/enabled 会被回滚。(c) mcp_servers.json 损坏后 `_load_config` 返回 `[]`，下一次任何 add/remove 把空列表写回 → 全部 MCP 配置丢失。

**25. web_search `_normalize_url` 丢弃全部查询参数值 → 误去重** — `backend/skills/web_search.py:129-134`（确定）
`parse_qs().items()` 只取键，值被丢弃。`example.com/page?id=1` 与 `?id=2` 的 key 相同，后者被当重复丢弃。默认 engine=auto 双引擎合并去重，有效结果被静默删除且 count 偏小。

**26. Bing 跳转链接 base64 解码未剥离 "a1" 前缀 → 解出乱码 URL** — `backend/skills/web_search.py:184-185`（很可能）
Bing `/ck/a` 链接的 `u` 参数格式为 `a1` + base64url。对含 a1 的整体解码引入 12bit 错位，结果为乱码字符串。应先剥 `u[2:]`。Bing 搜索结果 URL 不可点。

**27. doc_scan / code_scan 扫描路径祖先目录名误判 → 静默 0 文件** — `doc_scan.py:254-257`、`code_scan.py:154-157`（确定）
`Path(dirpath).parts` 含全部祖先目录名。项目位于 `D:\dev\build\SLATE` 或 `...\env\project`（build/env/dist/vendor/target 是常见目录名）时，os.walk 首个 root 即命中排除表 → `dirs.clear()` → 返回 0 文件 0 发现，**安全扫描假阴性**且无任何警告。

**28. file_peek total_lines 统计逻辑错误** — `backend/skills/file_peek.py:44-58/152-157`（确定）
`total` 在 break 前多计 1 行：文件行数 N > line_count 时返回 line_count+1（100 行文件读 30 行报 total=31），"继续统计"分支 `==` 条件永不成立成死代码；N == line_count 时重数一遍得 2N 且 truncated 误报。行范围模式同样错。AI 拿到的总行数信息全错。

**29. file_tree 递归 + pattern 组合完全失效** — `backend/skills/file_tree.py:51-52/74-81`（确定）
pattern 过滤在递归之前作用于目录名。`recursive=True, pattern="*.py"` 时任何目录都不匹配即被 continue，只返回顶层匹配文件，子目录内容静默丢失——AI 得到"项目里没有 .py 文件"的错误结论。

**30. file_edit 的 replace 不做换行归一化 → CRLF 文件必然失败** — `backend/skills/file_edit.py:197`（确定）
`_execute_edit` 做了 `_normalize_newlines`(280-281)，`_execute_replace` 完全没有。AI 经 `view` 获取的内容已被 splitlines 去掉 `\r`，构造的 old_str 只含 `\n` → CRLF 文件上 `count==0`，replace 功能性失效。

**31. terminal 原生命令不跟随会话 cwd/env** — `backend/skills/terminal.py:244-247`（确定）
`self.cwd` 仅在 173 行 `__init__` 赋值，从不更新。`cd backend` 后 `python main.py`/`git status`/`pytest` 走原生直跑路径在**旧目录**执行：`git status` 汇报错误仓库、测试找不到。文件头宣称"状态跨命令保持"对原生命令失效。

**32. LAN 之外：desktop.py stop_process 在嵌入式后端崩溃路径抛 AttributeError** — `desktop.py:126-133`（确定）
frozen 模式 embedded 线程在 `server` 赋值前异常退出时，`thread.server` 为 None，走到对 Thread 调 `poll()` → AttributeError，错误提示窗口逻辑被打断，atexit 再炸一次。

**33. mcp_factory 模板注入未转义 default/description** — `backend/skills/mcp_factory.py:87/157`（确定）
`default` 含 `"`、换行时生成语法错误的 Python 文件；description 含 `"""` 破坏 docstring。生成的工具 import 失败（有 warning 兜底不崩服务，但功能失败）。

**34. plugin_adapter frontmatter 解析被正文 `---` 水平线破坏** — `backend/skills/plugin_adapter.py:43-47`（确定）
状态机在正文遇到 `---`（Markdown 水平线极常见）会重新进入 frontmatter 模式，吸收后续正文里所有 `xxx: yyy` 行，name/description 被正文内容覆盖，导入技能名错乱。

**35. 前后端 API 契约：upload() 缺超时与错误体解析** — `frontend/js/services/api.js:276-286`（确定）
无 AbortController（request 有 180s）；失败只抛 `HTTP 413` 不解析后端中文 message；413（>20MB 中间件）时用户只看到英文状态码，后端挂起时上传 UI 永久等待。

### 前端功能类

**36. `i18n-pending` 遮蔽类从未被添加——语句被同行注释吞掉** — `frontend/index.html:13`（确定）
`classList.add("i18n-pending")` 与 `//` 注释写在同一行被吞掉。英文模式"翻译前遮蔽页面"机制完全失效：每次启动闪现未翻译中文界面。

**37. 自定义模型作为当前模型时，重启后不恢复且持久化被清写** — `frontend/js/store.js:663-673`（确定）
恢复只在内置 registry 查找，从不查 `state.customModels`；且无论找没找到都 `delete state._pendingModelId`。重启后回到"选择模型…"，此后任何 savePersistent 把 currentModelId 覆写为 null——持久化数据被真正清掉。

**38. 高危命令被拒绝后，"执行"按钮永久禁用** — `frontend/js/components/skill_panel.js:390-398`（确定）
按钮复位代码在 try/catch 之后而非 finally，`return` 跳过它。触发：terminal 工具输入高危命令并在审批弹窗点拒绝 → 按钮永远停在"执行中…"，重开弹窗也不复位（openSkillModal 不恢复 disabled）。

**39. buildPrompt 引号缺失，"已知上下文"内容整体丢失** — `frontend/js/components/prompt_factory.js:437-439`（确定）
`sections.push("", "# 已知上下文, context")` 少一个引号——本意 `"# 已知上下文", context`。用户粘贴的报错/代码片段**完全不进入**生成的 Prompt，输出只剩一行字面标题。核心功能静默数据丢失。

**40. 手动添加的素材删除后"复活"（前后端 id 断链）** — `frontend/js/components/memory.js:807-813/723-726`（确定）
POST 请求体不带 `id`，后端另生成 uuid；删除时用本地 makeId 去删服务端，匹配 0 行且返回 code 0。下次打开记忆面板刷新列表，被删素材原样复活。对比 prompt_factory.js:501 传了 id 可正常删除。

**41. vault 笔记路径未 encodeURIComponent** — `frontend/js/components/vault.js:159/183/249/267`（确定）
含 `#` 或 `?` 的笔记名（如"C# 入门"）在打开/保存/删除时 URL 被截断，服务端只收到部分路径，笔记永远无法操作；树内删除不检查 res.code 也无 catch，失败静默。

**42. selectedFiles 不随项目切换清空** — `frontend/js/components/prompt_factory.js:66/340-373`（确定）
切换项目只重画列表，Map 里旧项目勾选路径残留 → 生成 Prompt 的"重点文件"章节携带上一个项目的路径。

**43. addMessage 同步触发全量重渲染后又手动 appendChild → 流式期间重复空气泡** — `frontend/js/components/chat.js:2832-2835/2575-2583/4155`（确定）
store.addMessage 同步 notify → renderAllMessages 先重建出一条**空的 assistant 气泡**（含模型标签与 hover 按钮），随后又手动 append 第二个元素用于流式。整个流式期间存在两个 `.msg-assistant`。runToolLoop 每轮同样。

**44. 上下文压缩后用户气泡改显注入后的完整提示词** — `frontend/js/components/chat.js:2999-3021/3260-3294`（确定）
发给 /chat/compress 的消息只含 role/content，后端 keep_messages 原样返回。压缩后用户消息的 `display`（干净原文）丢失，renderMessage 回退渲染 content=fullText——气泡直接显示 HARNESS_PREFIX、[附件内容]、[提及技能…] 等全部注入内容。

**45. 文件选择器多选只处理第一个文件** — `frontend/js/components/chat.js:4055-4058`（很可能）
handleFiles 未 await，内部首个 await 挂起后 `fileInput.value=""` 清空正在迭代的 live FileList → 第 2..N 个文件静默丢弃。拖拽/粘贴路径不受影响。

**46. 连续语音听写丢失除最后一段外的所有结果** — `frontend/js/components/chat.js:4199-4222`（确定）
`origValue` 仅开始时捕获，每个 onresult 只含新 final 的文本却整体覆盖赋值——上一段识别文本和听写期间手动输入全部被抹掉。

**47. 未执行的工具调用被渲染成伪造的"历史恢复"成功卡片** — `frontend/js/components/chat.js:676-694/2924/2410-2412`（确定）
重渲染发生在"content 含未执行工具标记"时生成假成功卡片。sendMessage 的 2924 重渲染与真正的 setMessages(2539) 之间有多个 await（含可能数秒的 autoReview）——用户看到一叠假"已执行/成功"卡片；连续重复调用触发 break 时假卡片**永久滞留**。

**48. 辩论无法停止 + stopDiscussion 逻辑本身是坏的** — `frontend/js/components/team.js:1272/791-807`（确定）
`btn-stop-discuss` 元素在 index.html 中不存在（全仓 grep 仅 team.js:1272 一处引用），监听器从未绑定，`stopDiscussion` 无任何调用方。开始后 `btnStartDiscuss.disabled=true`，唯一出路是跑完全部轮次。即使调用：catch 吞 AbortError 后循环继续；`discussAbortController=null` 使后续成员发出不受控请求；`isDiscussing=false` 解锁按钮可并发两场辩论写同一输出区。

**49. 删除单卡片不清理他卡 arrows（悬空引用）** — `frontend/js/components/whiteboard.js:1213-1219/1743-1750`（确定）
对照组 `deleteSelectedCards`(1755-1757) 有清理，单卡删除两条路径都没有。存活卡片箭头角标持续显示死 ID；`cardsToMermaid` 输出 `A --> 死ID` 产生幽灵节点；悬空引用随持久化保存。

**50. parseFileWriteParams 分隔符容错吞掉文件内容首行** — `frontend/js/services/tools.js:898-899`（确定）
正则 `/^[◈─—\-=:*]{2,}\s*$/` 匹配 `---`——创建带 YAML frontmatter 的 Markdown（首行 `---`）时首行被当"路径分隔符"误删，文件静默损坏。同函数 902-907 的围栏剥离也会误删以代码围栏开头且结尾的文件首尾行。

**51. experts selectExpert 异步竞态** — `frontend/js/components/experts.js:105-123`（很可能）
`currentId` 在 await 之后赋值。快速连点 A 再 B 且 A 后返回时，表单显示 A；随后 handleSave 用错位的 currentId 保存，把 A 的内容写进错误对象。同类竞态在 `project_bar.js:198-207` refreshFileTree。

**52. 白板：切换标签页强制重置视图状态 / 半坐标丢弃 / 工作流失败后停止按钮残留** — `whiteboard.js:1166-1173`（app.js:52 每次切页调用 refreshWhiteboard 强制重置 boardViewCollapsed/currentBoardView）、`whiteboard.js:161-166`（仅一个坐标缺失时另一个有效坐标也被默认布局覆盖）、`team.js:1202-1208`（catch 分支缺 `wfAbortBtn.classList.add("hidden")`，失败后点停止永远停留在"正在停止..."）

---

## 三、低危缺陷（P2）

| # | 位置 | 问题 |
|---|------|------|
| 53 | `proxy.py:238-239/278-279/357-358/645` | `if temperature := body.get("temperature")` 把 0 当假值丢弃，temperature=0 不转发（四条路径同病） |
| 54 | `chat.py` 各 handler | 无 try/finally，`create_snippet` id 重复 → IntegrityError 500 且连接泄漏 |
| 55 | `terminal.py:359-371/269-279` | 超时只杀 shell 不杀进程树 → 孤儿进程存活、端口占用；持久会话被杀后 cwd/env 静默丢失 |
| 56 | `terminal.py:296-299/223-229` | 会话无并发互斥（两并发 run_command 输出串扰）；output_buffer 无界增长 |
| 57 | `terminal.py:44/467-470` | BLOCKED_PREFIXES 裸 `"format"` 误伤 `Format-Table`/`Format-List` |
| 58 | `file_edit.py:463-482` | `_execute_delete` 不校验 start_line > total，越界删除静默返回 ok |
| 59 | `computer_use.py:407-410` | locate 捕获 TypeError 但 pyscreeze 抛 NotImplementedError，"需安装 opencv"提示不可达 |
| 60 | `python_api_extract.py:247` | 本地路径目标忽略 depth 参数，硬编码 -1 无限递归 |
| 61 | `excel_tool.py:146-154` | 读 xlsx 时工作表不存在提前 return 跳过 wb.close()，Windows 上文件被锁；iter_rows 异常路径同样泄漏 |
| 62 | `excel_tool.py:105/196` | 所有单元格 `str()` 化 → 数字以文本存储，SUM/公式失效 |
| 63 | `qrcode_create.py:25-26` | 长度限制按字符数，中文 ~770 字即超 QR 容量，DataOverflowError 未捕获 |
| 64 | `text_summarize.py:11` | `(?<=[。！？.!?])\s+` 要求中文句号后有空格——中文分句失效，摘要输出整段原文 |
| 65 | `regex_test.py:96-110` | Windows 超时后 daemon 线程继续跑灾难正则烧 CPU；matches 恰等于上限时误报 truncated |
| 66 | `repo_stats.py:39-41` | 截断时 file_count = limit+1（off-by-one） |
| 67 | `css_color.py:75/83-85` | KEYWORD_MAP 按插入序首中即返，"蓝"先于"天蓝" → "天蓝"是死映射 |
| 68 | `chart_create.py:224-229` | 饼图 >17 项时图例溢出画布底部被裁剪 |
| 69 | `word_create.py:233-236` | 多个有序列表共用同一 "List Number" 编号实例，第二组从 6 继续而非从 1 |
| 70 | `doc_write.py:88` | "文档生成时间" 标签后没有实际时间戳 |
| 71 | `doc_scan.py:207-217/283-285` | xlsx 提取异常时 wb 未关闭；1-4 字符匹配脱敏时切片重叠（脱敏形同虚设） |
| 72 | `code_scan.py:242` | `fpath.stat()` 无 OSError 防护，断链时整个扫描中止、已收集发现全丢 |
| 73 | `browser_automation.py:102-107` | launch 重启浏览器泄漏 Playwright driver 进程（不调 `.stop()`） |
| 74 | `browser_automation.py:164` | `file://{path}` 用反斜杠生成非法 file URL |
| 75 | `app.js:1304-1318` | init() 恢复项目路径三个 await 无 try/catch，失败中断启动尾部（更新检查被跳过） |
| 76 | `app.js:843/847` | checkUpdateNow 两个按钮的 post() 无 catch → unhandled rejection |
| 77 | `chat.js:1396` | 占位符笔误 `{n)`，队列非空时发送按钮显示字面量"发言{n)" |
| 78 | `chat.js:3594-3598` | switchConversation 快速连点无请求序号守卫，响应后到者获胜 → 界面与 currentConversationId 错位 |
| 79 | `chat.js:3654-3655` | renderUsageBar 用 innerHTML 拼接模型名/base_url 未转义（自定义模型名含 HTML 即注入，自伤面） |
| 80 | `skill_panel.js:529-540` | 插件发现只 catch 网络异常，`code!==0` 也计入 imported →"成功导入 N 个"虚报 |
| 81 | `memory.js:616/620-636` | 知识搜索/添加无 try/catch（unhandled rejection）+ 失败静默 |
| 82 | `schedule.js:113-142`、`project_bar.js:132/157/199/297`、`experts.js:190` | 事件回调裸 await fetch，失败 unhandled rejection 且 UI 与后端状态错位 |
| 83 | `tools.js:866-876` | `validateToolCall` 把空字符串当"缺少必填参数"，file_create 无法创建空文件 |
| 84 | `i18n.js:99` | 语言探测用相对路径 fetch，file: 协议下失效回落中文 |
| 85 | `experts.js:52-57`（services） | expertExportUrl 的 file: 分支生成 `file://:8000/...` 无效 URL 且硬编码端口 |
| 86 | `workflows.py:188-192` | export_workflow 对损坏 JSON 抛未捕获异常 → 500（get_workflow 有 valid 检查，唯独 export 漏了） |
| 87 | `update.py:26-29/93` | open-url 白名单前缀无边界，`/SLATE/../../` 可放宽到整站（危害有限） |
| 88 | `vault.py:262-266` | 搜索摘要索引在"标题+正文"拼接串上计算却用作正文下标，偏移 len(title)+1 |
| 89 | i18n 词典 | 307 个在用 t() key 中 33 个未收录英文词典（含 whiteboard 全部新增按钮文案），英文界面残留中文 |
| 90 | `SLATE.spec:27-105` | hiddenimports 漏了 `plugin_adapter` 和 `text_io`（当前靠 datas 里的 .py 源文件兜底，打包方式一变即坏） |
| 91 | `requirements.txt`（根） vs `backend/requirements.txt` | 两份不同步：根目录（CI 用）缺 `trafilatura`；CI 冒烟测试环境与本地不一致 |
| 92 | `frontend/js/components/settings.js`、`file_tree.js` | 0 字节空文件，未被引用（死文件） |
| 93 | 后端 5 个端点前端零调用 | `GET /schedule/events/status`、`GET/POST /mcp-servers/tools|call`、`POST /workflows/import`、`GET /workflows/{id}/export`——远程 MCP 工具浏览/调用、工作流导入导出在 UI 上不可达 |

---

## 四、已排除的误报（审查过程中核实后否定）

1. **"proxy.py `_sse_error_from_exception` 7 处漏 await"** — 误报。该函数是同步 `def`（proxy.py:86），调用无需 await，现有代码正确。同文件的 `_sse_error_from_response` 才是 async 且已正确 await。
2. **"markdown.js 链接/wikilink 属性注入 XSS"** — 误报。`escapeHtml`（markdown.js:12-18）转义 `"` 且在链接/wikilink 替换**之前**执行（renderInline:30），属性值中的引号已是 `&quot;`，无法逃逸。前端各渲染路径（消息、工具卡片、提及高亮）经逐一核查均无 XSS。
3. **"前端多文件重复定义全局符号（toast/renderList 等 13 组）"** — 误报。前端是 ES modules，各文件模块作用域独立，同名导出互不冲突。
4. **"mermaid/hljs CDN 加载失败导致崩溃"** — 非缺陷。所有使用点都有 `window.mermaid`/`window.hljs` 存在性保护，离线仅降级不高亮。

---

## 五、客观检查结果

| 检查项 | 结果 |
|--------|------|
| Python 语法编译（py_compile 全量） | ✅ 通过 |
| JS 语法检查（node --check 全量 40 文件） | ✅ 通过 |
| 乱码检查（check_mojibake.mjs） | ✅ 通过 |
| ruff CI 规则（E9,F63,F7,F82） | ✅ 通过 |
| 后端 `open()` 缺 encoding 扫描 | ✅ 干净（仅二进制模式） |
| i18n 词典覆盖率 | ⚠️ 33/307 key 未收录（见 #89） |

---

## 六、修复优先级建议

1. **立即修**（安全 + 数据破坏）：#1 LAN Host 绕过、#2 experts 穿越、#5 会话切换污染、#16 CORS、#6 replace 绕过确认、#7 sys.modules 污染
2. **尽快修**（核心功能不可用）：#3 Gemini 流式、#4 MCP SSE 会话、#9 Playwright、#10 workflow currentModelId、#20 review_diff GBK、#39 buildPrompt 引号
3. **排期修**（体验与数据完整性）：#24 非原子写、#36-#49 前端交互类、其余中危
4. **顺手清**：低危表格项、死文件（#92）、requirements 同步（#91）、spec hiddenimports（#90）

---

*本报告由静态审查产生，所有高危发现均经源码逐行核实；标注"很可能"的项机制推演成立但未实际运行验证。修复后建议按第六节顺序回归测试。*
