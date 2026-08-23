/**
 * SLATE 任务完成通知：音效 + 系统通知
 * 两个开关均可在设置中独立切换
 */

import { state } from "../store.js?v=20260818-103";

// ── 音效（Web Audio API，无需外部文件）─────────────────

let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

/** 播放双音提示音（悦耳的 "叮-咚"） */
function playChime() {
  try {
    const ctx = getAudioCtx();
    if (ctx.state === "suspended") ctx.resume();

    const now = ctx.currentTime;
    const notes = [
      { freq: 880, start: 0, dur: 0.15 },     // A5 — 清脆起音
      { freq: 1174.66, start: 0.12, dur: 0.25 }, // D6 — 明亮收尾
    ];

    for (const note of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = note.freq;
      gain.gain.setValueAtTime(0, now + note.start);
      gain.gain.linearRampToValueAtTime(0.3, now + note.start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + note.start + note.dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + note.start);
      osc.stop(now + note.start + note.dur + 0.05);
    }
  } catch (e) {
    console.warn("音效播放失败:", e);
  }
}

// ── 系统通知（Notification API）─────────────────

/** 请求通知权限（仅在用户首次开启时调用） */
export async function requestNotificationPermission() {
  if (!("Notification" in window)) return "unsupported";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  const result = await Notification.requestPermission();
  return result;
}

/** 显示系统通知 */
function showSystemNotification(title, body) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  try {
    const notif = new Notification(title, {
      body,
      icon: "./icon.png",
      badge: "./icon.png",
      tag: "slate-task-complete",
      requireInteraction: false,
    });
    // 5 秒后自动关闭（部分系统不支持 timeout）
    setTimeout(() => notif.close(), 5000);
  } catch (e) {
    console.warn("系统通知失败:", e);
  }
}

// ── 统一入口 ──────────────────────────────────

/**
 * 任务完成时调用：根据设置播放音效 / 显示系统通知
 * @param {string} title - 通知标题
 * @param {string} body  - 通知正文
 */
export function notifyTaskComplete(title, body) {
  const cfg = state.notifications || {};

  if (cfg.soundEnabled !== false) {
    playChime();
  }

  if (cfg.systemNotifEnabled) {
    showSystemNotification(title, body);
  }
}
