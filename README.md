<div align="center">

<img src="frontend/icon.png" width="96" alt="SLATE" />

# SLATE

**Local AI Collaboration Studio — Turn Sparks of Ideas into Structured Plans**

*SLATE（砚）— Grind inspiration into polished deliverables.*

[![License: MIT](https://img.shields.io/badge/License-MIT-1a1a1a.svg)](LICENSE)
[![Website](https://img.shields.io/badge/Website-carywang1234.github.io%2FSLATE-1a1a1a.svg)](https://carywang1234.github.io/SLATE/)
[![Guide](https://img.shields.io/badge/Guide-User%20Tutorial-d4a24e.svg)](https://carywang1234.github.io/SLATE/docs/guide.html)
[![Python](https://img.shields.io/badge/Python-3.13%2B-1a1a1a.svg)](https://www.python.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows-1a1a1a.svg)]()
[![Build](https://img.shields.io/badge/Build-Zero%20npm%20%2F%20Zero%20Bundler-1a1a1a.svg)]()

**English** · [中文](README-zh.md)

</div>

---

SLATE is a **lightweight local AI collaboration tool** focused on prompt engineering, context management, and project ideation.

It features multi-model chat, Agent Autopilot, MCP tool calling, Target Mode autonomous execution, Grind Mode, AI team debates, and a whiteboard-style logic chain. It can either drive built-in tools to complete tasks directly, or generate high-quality prompts for external Coding Agents (Claude Code, Codex, Cursor, etc.).

**Zero npm dependencies. Zero build tools. Native tech stack. Local-first.**

---

## ✨ Highlights

- 🗣️ **Unified Multi-Model Access** — Major LLMs worldwide + custom OpenAI-compatible endpoints + local models (Ollama / LM Studio)
- ⚡ **Agent Autopilot + Target Mode** — Ordinary project requests now auto-run in an Agent loop without needing repeated "continue" prompts; Target Mode remains the explicit six-phase, 50-round closed-loop mode for large tasks
- ✒️ **InkStream — arguments as they are written** — While the model streams a tool call token by token, SLATE parses the half-formed JSON against the local schema and shows which fields are closed and which is still being written; preview only — incomplete arguments never reach execution, and long body fields collapse to line/char counts
- 🛑 **Stop really cancels** — Pressing Stop closes both the LLM stream and the tool-call stream, so the backend terminates the running subprocess or task instead of "UI stopped, work still going"; cancelled calls are recorded as their own status in the event ledger
- 🖌️ **Grind Mode** — `/grind` a rough idea, AI refines it through three-phase questioning into a structured task brief, one-click send to Target Mode
- 🗂️ **Chat & Data Management** — Full-text search, export/rename/batch-manage sessions, edit/delete messages, one-click backup/restore, storage usage visualization
- 🛠️ **34 Built-in MCP Tools** — File read/write/edit/append, project-wide code search, Unicode-safe terminal, PPT/Word/Excel/PDF tools, SVG charts & QR codes, Python API doc extraction, portable web bundling, code & document security scanning, read-only git info, web search & page scraping, MCP Factory for self-production, screenshot-to-code, AI image & video generation, browser & desktop automation
- 🧩 **Custom Skill System** — `SKILL.md` plug-and-play, `@` mention in chat to inject context
- 🎓 **Expert Packs** — Persona + rules + knowledge + skills in a zip, importable/exportable, injectable via chat dropdown / team cards / @mention
- 📖 **Better Project Understanding** — Three scan levels (brief/balanced/detailed) auto-generate project guide & rulebook
- 🔍 **Code Review** — Read git diff (staged/unstaged/commit range), AI reviews across code quality, security, performance, and maintainability with structured report and line-level comments
- 🔔 **Task Completion Notifications** — Chime sound + system notification when Harness/team/workflow finishes; both toggleable in settings
- 📡 **LAN Remote Control with Auth** — Opens port 8001 on launch; phone/tablet browsers auto-switch to the dedicated **SLATE Mobile UI** — bottom-tab navigation across Chat / Conversations / Memory / Tasks / Settings, full chat & tool-loop capability, bottom-sheet confirmations for high-risk commands and file diffs, desktop zero-regression; optional LAN password prevents other devices on the network from operating SLATE
- 🛡️ **High-Risk Command Approval** — Dual-layer frontend+backend interception with hardcoded rules; AI explains command purpose before approval; catastrophic commands unconditionally blocked
- 👥 **AI Team Multi-Round Debate** — Multi-role propose/oppose/decide with light/heavy model division; plus DAG workflow pipeline with **8 built-in templates** (Dev Flow, Code Review, Doc Generation, Data Analysis, Research Report, Product Requirements, Bug Investigation, Parallel Research); stop button for mid-debate interruption; **9 built-in team presets** (Code Review, Product Brainstorm, Red-Blue Debate, etc.) + custom configuration; workflow import/export/delete
- ⏰ **Scheduled Chat Tasks** — Auto-execute preset prompts on schedule, results archived as separate sessions
- ➕ **Unified ＋ Mode Menu** — one ＋ button left of the chat input consolidates every mode entry: Grind / Brainstorm / Target Mode / Scheduled Tasks, plus an **@-mention group** (Skills / Tools / MCP / Files) that opens a filtered picker; works in both the classic and the minimal Codex UI
- 🧠 **Upgraded Whiteboard** — Card + connector brainstorming, Mermaid-rendered flowcharts & mindmaps, flow/kanban/outline modes, draggable Git tree view for branches/commits/worktrees/staged/unpushed state, and auto-logged tool execution steps
- 💾 **Long-Term Memory & Knowledge Base** — Auto-distill chat highlights, cross-session recall; **overwrite outdated memories and delete obsolete ones** via AI-driven add/overwrite/delete actions; **✨ Spark** — auto-capture technical insights when conversations end, archive as knowledge docs for future RAG injection
- 🗜️ **Smart Context Compression** — Auto-summarize over threshold, four-layer truncation defense with auto-continuation, four-layer timeout prevention
- 🏭 **Prompt Factory** — Constitution + context + constraints integrated into a deliverable prompt
- 🎤 **Voice Input** — Click the mic button to dictate messages via Web Speech API; auto-detects language (Chinese/English); real-time transcription preview
- 🌍 **Multilingual UI** — Choose Simplified Chinese or English at install time; full interface and toast localization

---

## 🧩 Feature Landscape

### Multi-Model Chat

- Preset models: GPT / Claude / Gemini, DeepSeek / Kimi / Qwen / GLM / Doubao / MiniMax / ERNIE, etc.
- Custom models (any OpenAI-compatible API) and local models supported
- Optional Responses API mode for compatible OpenAI-style models
- One-click sidebar switching, API Keys encrypted locally
- Streaming output, code block copy, smart scroll follow, regenerate last reply

### Agent Autopilot

- Project/action requests are detected automatically and run through an Agent loop without requiring you to type "continue"
- Default loop budget: 18 rounds for ordinary environment tasks, 28 rounds for broad project-wide tasks; Harness keeps its configurable 50-round strong mode
- If a model only says it will inspect/edit/verify, SLATE nudges it to call tools; if it claims completion without tool evidence, SLATE asks it to verify or actually act
- Tool results are fed back invisibly so the model can observe → act → verify → report in one run
- **InkStream**: while the model writes a tool call token by token, a local schema-aware prefix parser infers which fields are already closed and which one is still being written, and renders that as a live one-line preview — preview only, half-formed arguments never enter execution, and large content fields fold into line / character counts
- **Real cancellation**: Stop closes the LLM stream and the tool-call stream together, and the backend terminates the subprocess or task through its `CallContext`; cancelled calls get their own status instead of being blurred into "done"
- **One loop, one ledger, one label source**: desktop and mobile run the same agent-loop kernel, and every plan / start / finish / cancel is written as an event into the local ledger (`runs` + `tool_events`). The chat tool card, the mobile card, and the whiteboard step card are projections of that ledger and take their titles from one label source (`services/tool_meta.js`), so no surface ever degrades to a raw tool name

### Target Mode (Harness)

- Six-phase loop: Goal → Plan → Execute → Verify → Report → Trace
- Auto-generates TODOLIST for large tasks (live sidebar display), batch progress tracking, no sign-off until all items resolved
- 50 tool-call rounds by default; exits only on: manual stop / rounds exhausted / checklist done — model failures, zero output, and repeated calls auto-recover
- Each round shows current round number (x/N), model self-paces based on remaining budget
- Four-layer truncation defense: 6-round anchor continuation + truncation guard + `file_append` segmented write + prompt prevention

### Grind Mode

- Type `/grind <idea>`, or open the **＋ menu** (left of the chat input) → Grind Mode, to refine rough ideas into a structured task brief
- Three-phase questioning: Receive → Grind → Collect (up to 10 rounds), sidebar ink panel marks ✔ resolved / ✘ unknown in real-time
- Brief includes goals / audience / deliverables / acceptance criteria / boundaries / suggested path / open questions; three actions: send to Target Mode / push to whiteboard / save as template
- Grind sessions persist and auto-restore on refresh or switch

### MCP Tools & Skill System

Built-in tools — 34 in total (`backend/skills/`):

| Tool | Description |
|------|-------------|
| `file_tree` / `file_peek` | Browse project structure / Read files |
| `file_create` / `file_edit` | Create files / Diff-preview editing; preserves UTF-8/BOM/GB18030/GBK/UTF-16 and handles Chinese/emoji safely |
| `file_append` | Append to files, segmented writes for long content |
| `terminal` | Sandboxed command execution; hidden Windows subprocesses and Unicode-safe native output capture |
| `html_render` / `css_color` | HTML skeleton generation / CSS color tuning |
| `doc_write` / `text_summarize` | Markdown writing / Text summarization |
| `ppt_create` / `word_create` | .pptx presentations / .docx Word documents |
| `excel_tool` / `pdf_tool` | Excel/CSV spreadsheets (generate .xlsx, read tables, csv↔xlsx conversion) / PDF metadata, text and table extraction |
| `json_tool` / `regex_test` | JSON processing / Regex testing |
| `code_search` | Project-wide code search by text or regex, defaults to the project root, scope narrowable to a subdirectory |
| `repo_stats` / `todo_scan` | Repository stats / TODO scanning |
| `system_info` | System metacognition: date/time, hardware specs, battery, network status |
| `git_tool` | Read-only git info: branch state, commit log, diff stats, branch and remote lists |
| `web_search` / `web_fetch` | Web search (no key needed) / Page content retrieval |
| `chart_create` / `qrcode_create` | SVG charts (bar/line/pie) / QR codes, inline preview |
| `python_api_extract` / `html_bundle` | Python library API extraction / Web page bundling |
| `code_scan` / `doc_scan` | Code security scanning (hardcoded keys / SQL injection / XSS / weak crypto / debug leftovers) / Document security scanning (PII, credentials, financial data, confidentiality marks across md/docx/pptx/xlsx/pdf) |
| `mcp_factory` | MCP tool self-production — SLATE generates its own adapters |
| `browser_automation` / `computer_use` | Browser automation (Playwright) / Desktop automation (mouse/keyboard) |
| `screenshot_to_code` | Screenshot to code — AI reads image and generates HTML/CSS to match |
| `image_gen` / `video_gen` | AI image generation / AI video generation (OpenAI-compatible endpoints, model and API key configured in Settings), returns local file and preview link |

Custom Skills: Upload or import `SKILL.md` to extend capabilities; `@` mention in chat to auto-inject context.

### Expert Packs

- Five-piece structure: `persona.md` + `rules.md` + `knowledge/` + `skills/` + `data.json`
- Zip import/export, shareable; includes sample pack "Creative Writing Mentor"
- Three injection paths: chat dropdown (session-wide), team member cards (role-configured), @mention (single-message injection)

### Better Project Understanding

- Three scan budgets: brief / balanced / detailed, priority-reading of README, dependency manifests, and core files
- Auto-generates two documents: project guide & encyclopedia, and rulebook (evidence-based dev rules)
- Results persisted to `.slate/config.json`, instant access on reopen

### Code Review

- Read git diff in three modes: unstaged changes, staged changes, commit range
- AI reviews across four dimensions: code quality, security, performance, maintainability
- Structured report with overall assessment, per-dimension analysis, and line-level comments
- Line-level comments with severity badges (critical/major/minor/info), clickable file:line locations
- Three result views: full report (Markdown), line comments list, four-dimension cards

### Scheduled Tasks

- Three scheduling modes: one-time / daily at time / fixed interval
- **Event-driven triggers**: file change watcher / Git push detector / Webhook receiver — auto-execute tasks when events occur
- Backend asyncio scheduler calls model directly, results archived to `[Scheduled]` or `[Event]` prefixed sessions
- Frontend visual management: add/remove, enable/disable, run now, execution status display

### Chat & Data Management

- Full-text content search in history sidebar, context excerpts on match, click to jump to session
- Rename sessions, export as Markdown, batch manage/delete; messages support individual edit/delete
- One-click backup: all data (chats/memories/assets/settings) exported as JSON, import to restore
- Storage management: itemized usage, database compression, clear chats, WebView cache cleanup
- LAN access settings: QR/code URL display, optional remote password, and clear warnings when LAN auth is not configured
- First-launch onboarding guide
- Auto-check for updates on startup, prompts upgrade when new GitHub Release found

### SLATE Mobile (Remote UI)

- Phone/tablet browsers visiting the LAN address automatically get the dedicated mobile UI (desktop UAs keep the full desktop interface — zero regression)
- Bottom-tab navigation with five panels: Chat / Conversations / Memory / Schedule / Settings
- Full chat capability: streaming output, tool loop on the same agent-loop kernel as the desktop, bottom-sheet risk approval and diff previews, @-mentions, voice input
- Session history management, long-term memory CRUD, scheduled tasks, and streamlined settings (model switching, API keys, theme, LAN info)

### AI Team Collaboration

- Multi-model / multi-role debate rounds: propose → support/oppose/rebut → decide
- Light models for discussion, heavy models for final decisions
- Auto-generated discussion summaries (≤500 tokens), user can intervene with votes
- **Stop mechanism**: Abort mid-debate with one click; completed replies are preserved
- **Whiteboard integration**: Debate steps auto-logged as cards with action type and summary
- **Team Workflow DAG**: Requirements → Decompose → Code → Review → Summarize pipeline with upstream/downstream artifact passing, real-time node status, auto-archive to knowledge base; **parallel execution** for independent nodes, **stop button** for mid-run interruption

### Whiteboard Logic Chain

- Idea/feature/thought cards, drag-to-layout, arrow connectors for dependencies and data flow
- Mermaid.js rendered flowcharts & mindmaps
- Display modes: main freeform board, Git tree, flow, kanban, and outline
- Git tree recognizes the opened project's repository state: HEAD, local/remote branches, commits, tags, remotes, worktrees, staged/changed/untracked counts, stashes, and unpushed commits; nodes and canvas are draggable in SLATE style
- **Auto-logging**: Tool execution steps automatically create step cards with icons, descriptions, and status colors (yellow=running, green=done, red=error); the cards are a projection of the call event ledger — created and updated per call id, cleared when a new run starts, and titled from the same label source as the chat tool cards
- **Thinking process display**: Model reasoning/thinking shown in collapsible panel, auto-collapses after thinking completes

### More

- 📦 **Multimodal Input**: docx / csv / markdown / html / images, backend parsing with zero token waste
- 💾 **Long-Term Memory**: Auto-distill chat highlights, cross-session persistence
- 📚 **Knowledge Base**: Local knowledge snippet retrieval and injection
- 🛡️ **Terminal Security**: Hardcoded high-risk command rules, frontend approval + backend interception dual defense, catastrophic commands (`rm -rf /`, `format`, etc.) unconditionally blocked
- 🔤 **Unicode-Safe Local Tools**: File editing and terminal output handle Chinese, emoji, UTF-8 BOM, GB18030/GBK, and UTF-16 without mojibake or accidental re-encoding
- 🔒 **Full Sandbox Protection**: Path traversal prevention (sensitive system dirs blacklisted), credential file access blocked, output truncation (50K chars), file size limits (5MB), request body size cap (20MB), upload filename sanitization, ReDoS timeout protection, env var cleanup — all transparent to users, zero friction
- 🗜️ **Context Compression**: Auto-summarize over token threshold, manual compression supported
- 🏭 **Prompt Factory**: Constitution summary → context snippets → task description → constraints → delivery requirements
- 🎨 **Dual Theme UI**: Light / Dark one-click switch

---

## 🚀 Quick Start

### Option 1: Windows Installer (Recommended)

1. Download `SLATE-Setup-x.x.x.exe` from [Releases](https://github.com/CaryWang1234/SLATE/releases)
2. During installation, choose your interface language (Simplified Chinese / English), then launch
3. Configure your model API Keys in Settings

### Option 2: Run from Source

**Prerequisites:** Python 3.13+

```bash
git clone https://github.com/CaryWang1234/SLATE.git
cd SLATE
pip install -r requirements.txt
```

**Windows:**

```bash
start.bat
```

**Linux / macOS:**

```bash
chmod +x start.sh
./start.sh
```

Then visit `http://127.0.0.1:8000`

### Build Desktop Package Yourself

```bash
build_desktop.bat      # PyInstaller single-file desktop app
build_installer.bat    # Inno Setup Windows installer (requires ISCC)
```

---

## 🛠️ Tech Stack

| Layer | Choice |
|-------|--------|
| Frontend | Vanilla HTML + CSS + JavaScript (ES Modules, zero build) |
| Backend | Python 3.13+ · FastAPI · Uvicorn · httpx |
| Storage | SQLite (chat history) · JSON (state / schedules / constitution) |
| Rendering | Highlight.js · Mermaid.js (CDN) |
| Desktop | webview2 shell + PyInstaller + Inno Setup installer |

---

## 📁 Directory Structure

```
SLATE/
├── desktop.py                  # Desktop entry (webview shell, PyInstaller target)
├── start.bat / start.sh        # Source one-click launch (Windows / Unix)
├── build_desktop.bat           # PyInstaller build script
├── SLATE.spec                  # PyInstaller config
├── SLATE_InnoSetup.iss         # Inno Setup installer script
├── README.md / README-zh.md    # Project docs (English / Chinese)
├── GUIDE.md                    # Bilingual user guide (source)
├── QODER.md                    # Development specification
├── backend/
│   ├── main.py                 # FastAPI entry (static serving + route registration + scheduler)
│   ├── routers/
│   │   ├── proxy.py            # LLM API proxy (multi-vendor streaming + segmented timeout)
│   │   ├── chat.py             # Chat history / context compression
│   │   ├── scheduler.py        # Scheduled task dispatcher
│   │   ├── knowledge.py        # Knowledge base retrieval
│   │   ├── projects.py         # Project management / Better Project Understanding / Code Review
│   │   ├── experts.py          # Expert pack CRUD / zip import/export
│   │   ├── skills.py           # Skill invocation (incl. /skills/stream — closing the stream cancels)
│   │   ├── events.py           # Agent call event ledger writes (runs / tool_events)
│   │   ├── settings.py         # Settings / cross-device sync / storage management
│   │   ├── constitution.py     # Project constitution
│   │   ├── grind.py            # Grind Mode session state machine
│   │   ├── i18n.py             # UI language config (install-time choice, read-only at runtime)
│   │   ├── update.py           # Startup update check (GitHub Releases)
│   │   ├── workflows.py        # Team workflow DAG definition
│   │   └── files.py            # Multimodal file parsing
│   └── skills/                 # 34 built-in MCP tool implementations (incl. Unicode-safe file/terminal tools, high-risk command dual interception, and a cancellable call context)
├── frontend/
│   ├── index.html              # Three-column layout entry (Chat / Whiteboard / Factory+Capabilities)
│   ├── m.html                  # Mobile remote UI entry (SLATE Mobile)
│   ├── css/style.css           # Global styles (dual theme)
│   ├── css/mobile.css          # Mobile styles
│   └── js/
│       ├── app.js              # Main controller initialization
│       ├── store.js            # Global state management
│       ├── components/         # Chat / Whiteboard / Team / Skills / Memory / Schedule etc.
│       ├── services/           # api / adapter / tools / i18n / grind / agent_loop (loop kernel) / agent_ledger (event ledger) / tool_meta (label source) / inkstream
│       └── mobile/             # Mobile modules (init / app / ui / chat / conversations / memory / schedule / settings)
├── docs/                       # Website Landing Page (GitHub Pages)
│   ├── index.html              # English version
│   ├── zh/index.html           # Chinese version
│   └── guide.html              # Bilingual tutorial (scroll-style)
├── installer/                  # Installer artifacts
└── data/                       # Runtime data (SQLite / constitution / schedules / custom Skills / expert packs / grind sessions)
```

---

## 🧭 Design Principles

- **Pure black-white-gray base**: No blue-purple gradients, no excessive rounding, no shadow/frosted glass
- **Native tech**: Zero npm / Node.js, zero build tools, frontend is files — edit and it takes effect
- **Local-first**: All data stored locally, API Keys used only for LLM calls
- **Token economy**: Smart compression, tiered calls, silent processing
- **Never stuck**: Idle watchdog + zero-content auto-retry + request timeout + UI fallback — four layers of defense

---

## 🤝 Contributing

Issues and Pull Requests welcome:

1. Fork this repo and create a feature branch: `git checkout -b feat/your-feature`
2. Please maintain existing code style (vanilla JS, no new build dependencies)
3. Submit PR describing the motivation and how to test

---

## 📄 License

This project is open-sourced under the [MIT License](LICENSE).

---

<div align="center">

*SLATE — Grind inspiration into polished deliverables.*

</div>
