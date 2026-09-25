/**
 * 项目现场解析（并行运行的"这一场在哪个项目里干活"）
 *
 * 一句话：`state.project` 是"用户正在看的那一个"，而后台那一场要按它**自己**的项目
 * 落文件、开终端、读宪法。两者混用的话，用户在 A 项目里点一下，B 项目的任务就把
 * 文件写进了 A —— 这是并行最坏的一种串台，所以单独收在一处。
 *
 * 缓存只存"读到的现场"，不存 active：active 由后端 projects.json 说话，这里跟着
 * 注册表快照一起失效（换项目/删项目后重新取，不拿旧 path 去猜新项目）。
 */

import { state } from "../store.js?v=20260925-001";
import { get } from "./api.js?v=20260925-001";

const cache = new Map();   // project_id -> info（含 project_id / path / name / constitution）

/** 视野内那一项直接用 state.project：它已经带着前端展开好的字段，也不必多发一次请求 */
export function projectScopeOf(projectId = "") {
  const id = String(projectId || state.project?.project_id || "");
  if (!id) return null;
  if (id === String(state.project?.project_id || "")) return state.project;
  return cache.get(id) || null;
}

/**
 * 取一个项目的现场（有缓存就用，没有去后端读一次）。
 * 读不到就返回 null：调用方要**停下来问用户**，而不是退回 state.project——
 * 退回就等于把 B 项目的活儿干到 A 项目目录里。
 */
export async function ensureProjectScope(projectId = "") {
  const id = String(projectId || "");
  if (!id) return state.project || null;
  const hit = projectScopeOf(id);
  if (hit) return hit;
  const res = await get(`/projects/registry/${encodeURIComponent(id)}/info`);
  if (res.code !== 0 || !res.data?.path) return null;
  const info = { ...res.data, project_id: id };
  cache.set(id, info);
  return info;
}

export function forgetProjectScope(projectId = "") {
  cache.delete(String(projectId || ""));
}

/** 换项目 / 注册表变了：把除视野外的缓存全丢掉（磁盘上的宪法可能刚被改过） */
export function invalidateProjectScopes() {
  const activeId = String(state.project?.project_id || "");
  for (const key of [...cache.keys()]) if (key !== activeId) cache.delete(key);
}

/**
 * 一场生成用哪份宪法：它自己的项目那份，而不是"现在屏幕上那个项目"的。
 * 视野外的项目还没取到现场时回落全局——宁可用无项目规则的默认档，
 * 也不能拿别的项目的规则去约束这一场。
 */
export function constitutionForScope(project) {
  if (!project) return state.constitution;
  if (String(project.project_id || "") === String(state.project?.project_id || "")) {
    const own = state.project?.constitution;
    return own && typeof own === "object" ? own : state.constitution;
  }
  const own = project?.constitution;
  return own && typeof own === "object" ? own : state.constitution;
}
