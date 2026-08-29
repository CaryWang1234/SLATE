# SLATE v0.3.5 Release Notes

**Release Date:** 2026-08-29

---

## Overview

v0.3.5 is a focused refinement release that modernizes the chat input UI, renames "Harness" to "Target Mode" across all user-facing surfaces, and fixes several critical bugs affecting Qwen model compatibility and placeholder rendering. All documentation (README, landing pages, user guide) has been updated to reflect the new naming.

---

## New Features & Improvements

### Modernized Chat Input UI

The chat input area has been redesigned into a cohesive card-style container following SLATE's flat/border-driven design language:

- **Two-zone layout**: Borderless textarea on top, toolbar row (attach + expert select / voice + send) on bottom
- **Card container**: Single `border-radius: 8px` with `focus-within` shadow elevation
- **Paperclip icon**: Attach button upgraded from plain "+" text to SVG paperclip for visual consistency
- **Improved spatial organization**: Toolbar actions clearly separated into left/right groups
- **Mention highlight integration**: Updated to work seamlessly within the new `.input-editor-zone` structure

### "Harness" Renamed to "Target Mode" (目标模式)

All user-visible references to "Harness" have been renamed to "Target Mode" / "目标模式" for clearer semantics:

- **Button label & icon**: Lightning bolt replaced with bullseye/target SVG; tooltip updated
- **Onboarding cards**: Title and description text updated in both English and Chinese
- **Toast messages**: Toggle on/off, idle status, round progress, exit reason, abort notice — all updated
- **Grind mode actions**: "Send to Target Mode" replaces "Send to Harness"
- **System prompt**: `HARNESS_PREFIX` internal constant renamed; round tag `[Target Mode · x/N]`
- **Settings & notifications**: Description text updated
- **i18n translations**: 15+ Chinese/English translation pairs synchronized

### Documentation Updates

All public-facing documentation now reflects "Target Mode" naming:

- `README.md` / `README-zh.md`: Intro, highlights, feature sections
- `docs/index.html`: Meta description, stat hints, feature cards, highlight section
- `docs/zh/index.html`: Full Chinese localization parity
- `docs/guide.html`: TOC, Chapter 4 heading, bilingual content, Grind Mode three-action description

---

## Bug Fixes

### Qwen Model Stream Compatibility (#P0)

**Problem:** Qwen3.7-Plus (and potentially other OpenAI-compatible providers) sends SSE chunks with empty `choices: []` arrays during streaming. The backend crashed with `list index out of range` when accessing `choices[0]`.

**Fix:** Added safety checks before array access in both streaming (`_stream_openai`) and non-streaming (`_call_openai`) paths:
- Empty choices → skip chunk (streaming) or return friendly error (non-streaming)
- No more crashes on metadata-only frames

### Placeholder Overlap After Send (#P1)

**Problem:** After sending a message, the textarea placeholder text would visually overlap with the empty input box. Clicking/focusing the textarea fixed it temporarily.

**Root cause:** Programmatic `value = ""` clearing doesn't always trigger browser placeholder recalculation when the element retains focus.

**Fix:** Dispatch `new Event("input", { bubbles: true })` after every textarea clear (4 locations: normal send, queue capture, `/grind` command, abstract task detection). Forces browser to recompute and correctly render the placeholder.

### `escapeHtml` ReferenceError (#P0)

**Problem:** `renderUsageBar()` called undefined `escapeHtml()`, crashing model list initialization. The actual function is named `escapeHtmlLocal()` (chat.js line 396).

**Fix:** Updated two calls at lines 3695 and 3697 to use `escapeHtmlLocal()`.

---

## Technical Details

### Files Modified

| File | Changes |
|------|---------|
| `frontend/index.html` | Input area HTML restructure; harness button icon/title; onboarding cards; settings text |
| `frontend/css/style.css` | New `#chat-input-area` card styles; `.input-editor-zone`; `.input-toolbar`; updated `#chat-input`; mention layer padding |
| `frontend/js/components/chat.js` | `setupMentionHighlight()` targets `.input-editor-zone`; `escapeHtmlLocal` fix; all "目标" → "目标模式" toast/progress messages; input event dispatch after clear |
| `frontend/js/services/i18n_dict.js` | 15+ translation key updates for Target Mode naming |
| `frontend/js/app.js` | Enhanced `loadModels()` logging for debugging |
| `backend/routers/proxy.py` | Empty `choices` safety check in `_stream_openai` and `_call_openai` |
| `README.md` / `README-zh.md` | All Harness → Target Mode references |
| `docs/index.html` / `docs/zh/index.html` | Landing page content updates |
| `docs/guide.html` | User guide chapter updates |

### Version Bump Chain

This release accumulated multiple version bumps during development:
- `20260828-132` → Input UI HTML restructure
- `20260828-133` → Input UI CSS + JS integration
- `20260828-134` → Target Mode rename (icon, HTML, onboarding)
- `20260828-135` → Target Mode rename (chat.js toasts, i18n)
- `20260828-136` → `escapeHtml` fix
- `20260828-137` → Placeholder overlap fix
- `20260828-138` → Documentation updates

**Final frontend version:** `20260828-138`
**Installer version:** `0.3.5`

---

## Upgrade Notes

- **Frontend cache**: All JS/CSS files carry `?v=20260828-138` query string; browsers will fetch fresh copies automatically
- **Backend**: Only `proxy.py` changed; restart the server to apply the empty-choices fix
- **No database migration required**: This release contains no schema changes
- **No breaking changes**: "Target Mode" is a rename only; all existing conversations, TODOLISTs, and settings remain intact

---

## Known Issues

None introduced in this release. Pre-existing issues from prior versions remain unchanged.

---

## Credits

All changes authored and verified by the SLATE core team. Syntax checks, mojibake validation, and manual browser testing completed before release.
