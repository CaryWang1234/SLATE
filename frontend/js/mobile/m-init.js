/**
 * SLATE Mobile — 入口装配
 * 1. 提取局域网 token 并注入 API 层（含 cookie，供静态资源与原生 fetch 使用）
 * 2. 初始化 i18n → 加载本地与服务端状态 → 应用主题
 * 3. 装配外壳与各面板
 */

import { state, loadPersistent, loadSharedPersistent, setModelRegistry } from "../store.js?v=20260830-003";
import { setLanToken, get } from "../services/api.js?v=20260830-003";
import { initI18n } from "../services/i18n.js?v=20260830-003";
import { initMApp } from "./m-app.js?v=20260830-003";
import { mToast } from "./m-ui.js?v=20260830-003";
import { initMChat } from "./m-chat.js?v=20260830-003";
import { initMChatInput } from "./m-chat-input.js?v=20260830-003";
import { initMConversations } from "./m-conversations.js?v=20260830-003";
import { initMMemory } from "./m-memory.js?v=20260830-003";
import { initMSchedule } from "./m-schedule.js?v=20260830-003";
import { initMSettings } from "./m-settings.js?v=20260830-003";
import { mGuardTerminal } from "./m-auth.js?v=20260830-003";

// 移动端接管高危命令审批 UI（底部 sheet），桌面不受影响
window.__slateGuardOverride = mGuardTerminal;

function extractLanToken() {
  const token = new URLSearchParams(window.location.search).get("slate_lan_token") || "";
  if (!token) return "";
  setLanToken(token);
  try {
    document.cookie = `slate_lan_auth=${encodeURIComponent(token)}; path=/; max-age=${30 * 24 * 3600}; SameSite=Lax`;
  } catch (e) { /* cookie 设置失败不阻塞 */ }
  return token;
}

function applyTheme() {
  document.documentElement.setAttribute("data-theme", state.theme || "dark");
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = state.theme === "dark" ? "#0A0A0A" : "#FFFFFF";
}

async function init() {
  extractLanToken();
  await initI18n();
  loadPersistent();
  try {
    await loadSharedPersistent();
  } catch (e) {
    console.warn("[SLATE-Mobile] 拉取共享状态失败:", e);
  }
  // 解析模型注册表：将持久化的当前模型 id 还原为 currentModel（与桌面 loadModels 同链）
  try {
    const res = await get("/proxy/models");
    if (res.code === 0) setModelRegistry(res.data);
  } catch (e) {
    console.warn("[SLATE-Mobile] 模型列表加载失败:", e);
  }
  applyTheme();

  initMApp();
  initMChat();
  initMChatInput();
  initMConversations();
  initMMemory();
  initMSchedule();
  initMSettings();

  console.log("[SLATE-Mobile] ready");
}

document.addEventListener("DOMContentLoaded", init);

export { mToast };
