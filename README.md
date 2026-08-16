<div align="center">

<img src="frontend/icon.png" width="96" alt="SLATE" />

# SLATE

**Local AI Collaboration Studio — Turn Sparks of Ideas into Structured Plans**

*SLATE（砚）— Grind inspiration into polished deliverables.*

[![License: MIT](https://img.shields.io/badge/License-MIT-1a1a1a.svg)](LICENSE)
[![Website](https://img.shields.io/badge/Website-carywang1234.github.io%2FSLATE-1a1a1a.svg)](https://carywang1234.github.io/SLATE/docs/index.html)
[![Python](https://img.shields.io/badge/Python-3.13%2B-1a1a1a.svg)](https://www.python.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows-1a1a1a.svg)]()
[![Build](https://img.shields.io/badge/Build-Zero%20npm%20%2F%20Zero%20Bundler-1a1a1a.svg)]()

**English** · [中文](README-zh.md)

</div>

---

SLATE is a **lightweight local AI collaboration tool** focused on prompt engineering, context management, and project ideation.

It features multi-model chat, MCP tool calling, Harness autonomous execution, Grind Mode, AI team debates, and a whiteboard-style logic chain. It can either drive built-in tools to complete tasks directly, or generate high-quality prompts for external Coding Agents (Claude Code, Codex, Cursor, etc.).

**Zero npm dependencies. Zero build tools. Native tech stack. Local-first.**

---

## ✨ Highlights

- 🗣️ **Unified Multi-Model Access** — Major LLMs worldwide + custom OpenAI-compatible endpoints + local models (Ollama / LM Studio)
- ⚡ **Harness Autonomous Execution** — Six-phase closed-loop with 50 rounds by default; auto-generates TODOLIST for large tasks; stop doesn't quit — only manual stop / rounds exhausted / checklist done ends the session
- 🖌️ **Grind Mode** — `/grind` a rough idea, AI refines it through three-phase questioning into a structured task brief, one-click send to Harness
- 🗂️ **Chat & Data Management** — Full-text search, export/rename/batch-manage sessions, edit/delete messages, one-click backup/restore, storage usage visualization
- 🛠️ **22 Built-in MCP Tools** — File read/write/edit/append, terminal sandbox, PPT/Word generation, SVG charts & QR codes, Python API doc extraction, portable web bundling, web search & page scraping, MCP Factory for self-production
- 🧩 **Custom Skill System** — `SKILL.md` plug-and-play, `@` mention in chat to inject context
- 🎓 **Expert Packs** — Persona + rules + knowledge + skills in a zip, importable/exportable, injectable via chat dropdown / team cards / @mention
- 📖 **Better Project Understanding** — Three scan levels (brief/balanced/detailed) auto-generate project guide & rulebook
- 📡 **LAN Remote Control** — Opens port 8001 on launch; scan QR from phone/tablet browser for the full interface
- 🛡️ **High-Risk Command Approval** — Dual-layer frontend+backend interception with hardcoded rules; AI explains command purpose before approval; catastrophic commands unconditionally blocked
- 👥 **AI Team Multi-Round Debate** — Multi-role propose/oppose/decide with light/heavy model division; plus DAG workflow pipeline; stop button for mid-debate interruption
- ⏰ **Scheduled Chat Tasks** — Auto-execute preset prompts on schedule, results archived as separate sessions
- 🧠 **Whiteboard Logic Chain** — Card + connector brainstorming, Mermaid-rendered flowcharts & mindmaps; auto-logs tool execution steps as colored status cards with arrow connections
- 💾 **Long-Term Memory & Knowledge Base** — Auto-distill chat highlights, cross-session recall; **overwrite outdated memories and delete obsolete ones** via AI-driven add/overwrite/delete actions; **✨ Spark** — auto-capture technical insights when conversations end, archive as knowledge docs for future RAG injection
- 🗜️ **Smart Context Compression** — Auto-summarize over threshold, four-layer truncation defense with auto-continuation, four-layer timeout prevention
- 🏭 **Prompt Factory** — Constitution + context + constraints integrated into a deliverable prompt
- 🌍 **Multilingual UI** — Choose Simplified Chinese or English at install time; full interface and toast localization

---

## 🧩 Feature Landscape

### Multi-Model Chat

- Preset models: GPT / Claude / Gemini, DeepSeek / Kimi / Qwen / GLM / Doubao / MiniMax / ERNIE, etc.
- Custom models (any OpenAI-compatible API) and local models supported
- One-click sidebar switching, API Keys encrypted locally
- Streaming output, code block copy, smart scroll follow, regenerate last reply

### Harness Autonomous Execution

- Six-phase loop: Goal → Plan → Execute → Verify → Report → Trace
- Auto-generates TODOLIST for large tasks (live sidebar display), batch progress tracking, no sign-off until all items resolved
- 50 tool-call rounds by default; exits only on: manual stop / rounds exhausted / checklist done — model failures, zero output, and repeated calls auto-recover
- Each round shows current round number (x/N), model self-paces based on remaining budget
- Four-layer truncation defense: 6-round anchor continuation + truncation guard + `file_append` segmented write + prompt prevention

### Grind Mode

- Type `/grind <idea>` or click the 🖌 sidebar button to refine rough ideas into a structured task brief
- Three-phase questioning: Receive → Grind → Collect (up to 7 rounds), sidebar ink panel marks ✔ resolved / ✘ unknown in real-time
- Brief includes goals / audience / deliverables / acceptance criteria / boundaries / suggested path / open questions; three actions: send to Harness / push to whiteboard / save as template
- Grind sessions persist and auto-restore on refresh or switch

### MCP Tools & Skill System

Built-in tools (`backend/skills/`):

| Tool | Description |
|------|-------------|
| `file_tree` / `file_peek` | Browse project structure / Read files |
| `file_create` / `file_edit` | Create files / Diff-preview editing |
| `file_append` | Append to files, segmented writes for long content |
| `terminal` | Sandboxed command execution |
| `html_render` / `css_color` | HTML skeleton generation / CSS color tuning |
| `doc_write` / `text_summarize` | Markdown writing / Text summarization |
| `ppt_create` / `word_create` | .pptx presentations / .docx Word documents |
| `json_tool` / `regex_test` | JSON processing / Regex testing |
| `repo_stats` / `todo_scan` | Repository stats / TODO scanning |
| `web_search` / `web_fetch` | Web search (no key needed) / Page content retrieval |
| `chart_create` / `qrcode_create` | SVG charts (bar/line/pie) / QR codes, inline preview |
| `python_api_extract` / `html_bundle` | Python library API extraction / Web page bundling |
| `code_scan` / `mcp_factory` | Code security scanning / MCP tool self-production |
| `browser_automation` / `computer_use` | Browser automation (Playwright) / Desktop automation (mouse/keyboard) |

Custom Skills: Upload or import `SKILL.md` to extend capabilities; `@` mention in chat to auto-inject context.

### Expert Packs

- Five-piece structure: `persona.md` + `rules.md` + `knowledge/` + `skills/` + `data.json`
- Zip import/export, shareable; includes sample pack "Creative Writing Mentor"
- Three injection paths: chat dropdown (session-wide), team member cards (role-configured), @mention (single-message injection)

### Better Project Understanding

- Three scan budgets: brief / balanced / detailed, priority-reading of README, dependency manifests, and core files
- Auto-generates two documents: project guide & encyclopedia, and rulebook (evidence-based dev rules)
- Results persisted to `.slate/config.json`, instant access on reopen

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
- First-launch onboarding guide
- Auto-check for updates on startup, prompts upgrade when new GitHub Release found

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
- **Auto-logging**: Tool execution steps automatically create step cards with icons, descriptions, and status colors (yellow=running, green=done, red=error)
- **Thinking process display**: Model reasoning/thinking shown in collapsible panel, auto-collapses after thinking completes

### More

- 📦 **Multimodal Input**: docx / csv / markdown / html / images, backend parsing with zero token waste
- 💾 **Long-Term Memory**: Auto-distill chat highlights, cross-session persistence
- 📚 **Knowledge Base**: Local knowledge snippet retrieval and injection
- 🛡️ **Terminal Security**: Hardcoded high-risk command rules, frontend approval + backend interception dual defense, catastrophic commands (`rm -rf /`, `format`, etc.) unconditionally blocked
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
├── QODER.md                    # Development specification
├── backend/
│   ├── main.py                 # FastAPI entry (static serving + route registration + scheduler)
│   ├── routers/
│   │   ├── proxy.py            # LLM API proxy (multi-vendor streaming + segmented timeout)
│   │   ├── chat.py             # Chat history / context compression
│   │   ├── scheduler.py        # Scheduled task dispatcher
│   │   ├── knowledge.py        # Knowledge base retrieval
│   │   ├── projects.py         # Project management / Better Project Understanding
│   │   ├── experts.py          # Expert pack CRUD / zip import/export
│   │   ├── skills.py           # Skill invocation
│   │   ├── settings.py         # Settings / cross-device sync / storage management
│   │   ├── constitution.py     # Project constitution
│   │   ├── grind.py            # Grind Mode session state machine
│   │   ├── i18n.py             # UI language config (install-time choice, read-only at runtime)
│   │   ├── update.py           # Startup update check (GitHub Releases)
│   │   ├── workflows.py        # Team workflow DAG definition
│   │   └── files.py            # Multimodal file parsing
│   └── skills/                 # 24 built-in MCP tool implementations (incl. high-risk command dual interception)
├── frontend/
│   ├── index.html              # Three-column layout entry (Chat / Whiteboard / Factory+Capabilities)
│   ├── css/style.css           # Global styles (dual theme)
│   └── js/
│       ├── app.js              # Main controller initialization
│       ├── store.js            # Global state management
│       ├── components/         # Chat / Whiteboard / Team / Skills / Memory / Schedule etc.
│       └── services/           # api / adapter / tools / markdown / i18n / grind
├── docs/                       # Website Landing Page (GitHub Pages)
│   ├── index.html              # English version
│   └── zh/index.html           # Chinese version
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
