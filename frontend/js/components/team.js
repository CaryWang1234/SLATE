/**
 * SLATE AI 团队组件：多模型协作讨论
 * 轻量模型初步讨论 → 重型模型最终决策
 */

import { state, subscribe, getModelKey, hasModelKey, estimateTokens } from "../store.js?v=20260808-9";
import { streamChat } from "../services/api.js?v=20260808-9";
import { detectToolCalls, stripToolCalls, executeToolCalls, getToolsSystemPrompt } from "../services/tools.js?v=20260808-9";
import { renderMarkdown } from "../services/markdown.js?v=20260808-9";
import { loadWorkflows, getWorkflow, runWorkflow, saveRunToKnowledge } from "../services/workflow.js?v=20260808-9";

// 当模型列表加载完成后，重新渲染团队成员（填充下拉选项）
subscribe("modelRegistry", () => renderTeamMembers());

let teamPanel, teamMembersArea, teamTopicInput, btnStartDiscuss, teamOutput, btnAddMember;
let teamHistoryList, teamUsageBar, btnNewTeamDiscussion;
let teamMembers = [];
let teamHistory = [];
let currentTeamUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, messageCount: 0 };
let isDiscussing = false;
const TEAM_HISTORY_KEY = "slate_team_history";

// ── 默认团队成员 ────────────────────────────

const DEFAULT_MEMBERS = [
  { id: "member-1", name: "分析师", modelId: "deepseek-v4-flash", persona: "你是务实派分析师。关注可行性和成本，回答简洁（1-3句）。", role: "analyst" },
  { id: "member-2", name: "创意官", modelId: "gemini-3.6-flash", persona: "你是创意导向的思考者。关注创新可能性和用户体验，回答简洁（1-3句）。", role: "creative" },
  { id: "member-3", name: "决策者", modelId: "gpt-5.6-sol", persona: "你是最终决策者。综合各方观点给出明确建议和理由，回答简洁（1-3句）。", role: "decider" },
];

function fmtTok(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n || 0);
}

function makeSessionId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function resetTeamUsage() {
  currentTeamUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, messageCount: 0 };
  renderTeamUsage();
}

function addTeamUsage(promptText, completionText = "") {
  const promptTokens = estimateTokens(promptText || "");
  const completionTokens = estimateTokens(completionText || "");
  currentTeamUsage.promptTokens += promptTokens;
  currentTeamUsage.completionTokens += completionTokens;
  currentTeamUsage.totalTokens = currentTeamUsage.promptTokens + currentTeamUsage.completionTokens;
  currentTeamUsage.messageCount += 1;
  renderTeamUsage();
}

function renderTeamUsage(usage = currentTeamUsage) {
  if (!teamUsageBar) return;
  teamUsageBar.innerHTML = `
    <span class="usage-model">团队讨论</span>
    <span class="usage-sep">|</span>
    <span class="usage-stat">轮次 ${usage.messageCount || 0}</span>
    <span class="usage-sep">|</span>
    <span class="usage-stat">输入 ${fmtTok(usage.promptTokens || 0)}</span>
    <span class="usage-sep">|</span>
    <span class="usage-stat">输出 ${fmtTok(usage.completionTokens || 0)}</span>
    <span class="usage-sep">|</span>
    <span class="usage-stat">总计 ${fmtTok(usage.totalTokens || 0)}</span>
  `;
}

function loadTeamHistory() {
  try {
    const raw = localStorage.getItem(TEAM_HISTORY_KEY);
    teamHistory = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(teamHistory)) teamHistory = [];
  } catch {
    teamHistory = [];
  }
}

function saveTeamHistory() {
  try {
    localStorage.setItem(TEAM_HISTORY_KEY, JSON.stringify(teamHistory.slice(0, 50)));
  } catch {}
}

function renderTeamHistory() {
  if (!teamHistoryList) return;
  teamHistoryList.innerHTML = "";
  if (teamHistory.length === 0) {
    teamHistoryList.innerHTML = '<div class="team-history-empty">暂无团队历史</div>';
    return;
  }
  for (const session of teamHistory) {
    const item = document.createElement("div");
    item.className = "team-history-item";
    item.dataset.sessionId = session.id;

    const title = document.createElement("div");
    title.className = "team-history-title";
    title.textContent = session.topic || "未命名讨论";
    item.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "team-history-meta";
    const time = session.createdAt ? new Date(session.createdAt).toLocaleString() : "";
    meta.textContent = `${time} · ${session.responses?.length || 0}人 · ~${fmtTok(session.usage?.totalTokens || 0)} tok`;
    item.appendChild(meta);

    item.addEventListener("click", () => loadTeamSession(session.id));
    teamHistoryList.appendChild(item);
  }
}

function persistTeamSession(session) {
  teamHistory = [session, ...teamHistory.filter(item => item.id !== session.id)].slice(0, 50);
  saveTeamHistory();
  renderTeamHistory();
}

// ── 渲染 ────────────────────────────────────

function renderTeamMembers() {
  if (!teamMembersArea) return;
  teamMembersArea.innerHTML = "";

  if (teamMembers.length === 0) {
    teamMembersArea.innerHTML = '<div class="team-empty">暂无团队成员，点击 + 添加</div>';
    return;
  }

  teamMembers.forEach((m, i) => {
    const card = document.createElement("div");
    card.className = "team-member-card";

    const header = document.createElement("div");
    header.className = "team-member-header";

    const avatar = document.createElement("span");
    avatar.className = "team-member-avatar";
    avatar.textContent = m.role === "analyst" ? "分" : m.role === "creative" ? "创" : m.role === "decider" ? "决" : "成";
    header.appendChild(avatar);

    const info = document.createElement("div");
    info.className = "team-member-info";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "team-member-name";
    nameInput.value = m.name;
    nameInput.placeholder = "成员名称";
    nameInput.addEventListener("change", () => { m.name = nameInput.value; });
    info.appendChild(nameInput);

    const modelSelect = document.createElement("select");
    modelSelect.className = "team-member-model";
    populateModelOptions(modelSelect, m.modelId);
    modelSelect.addEventListener("change", () => { m.modelId = modelSelect.value; });
    info.appendChild(modelSelect);

    header.appendChild(info);

    const removeBtn = document.createElement("button");
    removeBtn.className = "team-member-remove";
    removeBtn.textContent = "×";
    removeBtn.title = "移除";
    removeBtn.addEventListener("click", () => {
      teamMembers.splice(i, 1);
      renderTeamMembers();
    });
    header.appendChild(removeBtn);

    card.appendChild(header);

    const personaInput = document.createElement("textarea");
    personaInput.className = "team-member-persona";
    personaInput.value = m.persona;
    personaInput.placeholder = "角色设定…";
    personaInput.rows = 2;
    personaInput.addEventListener("change", () => { m.persona = personaInput.value; });
    card.appendChild(personaInput);

    teamMembersArea.appendChild(card);
  });
}

function populateModelOptions(select, selectedId) {
  select.innerHTML = "";
  const groups = { international: "国外", domestic: "国内", local: "本地" };
  for (const [cat, label] of Object.entries(groups)) {
    const models = state.modelRegistry[cat];
    if (!models) continue;
    const optgroup = document.createElement("optgroup");
    optgroup.label = label;
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name + (hasModelKey(m.id) ? "" : " ⚠");
      if (m.id === selectedId) opt.selected = true;
      optgroup.appendChild(opt);
    }
    select.appendChild(optgroup);
  }

  // 自定义模型
  if (state.customModels.length > 0) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = "自定义";
    for (const m of state.customModels) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name + (hasModelKey(m.id) ? "" : " ⚠");
      if (m.id === selectedId) opt.selected = true;
      optgroup.appendChild(opt);
    }
    select.appendChild(optgroup);
  }
}

// ── 讨论逻辑 ────────────────────────────────

async function startDiscussion() {
  const topic = teamTopicInput.value.trim();
  if (!topic) return;
  if (teamMembers.length === 0) return;
  if (isDiscussing) return;

  isDiscussing = true;
  btnStartDiscuss.disabled = true;
  btnStartDiscuss.textContent = "讨论中…";
  teamOutput.innerHTML = "";
  resetTeamUsage();

  // 添加话题标题
  const topicEl = document.createElement("div");
  topicEl.className = "team-topic";
  topicEl.textContent = `议题: ${topic}`;
  teamOutput.appendChild(topicEl);

  // 注入黑板上下文
  let boardContext = "";
  if (state.boardCards.length > 0) {
    boardContext = "\n\n当前黑板卡片:\n" + state.boardCards.map(c =>
      `[${c.id}] ${c.title}${c.body ? " — " + c.body : ""}`
    ).join("\n");
  }

  const responses = [];

  // 依次调用每个成员
  for (const member of teamMembers) {
    const apiKey = getModelKey(member.modelId);
    if (!apiKey) {
      addTeamResponse(member, `⚠ 未配置 API Key，跳过`);
      continue;
    }

    // 显示思考中状态
    const thinkingEl = addTeamResponse(member, "思考中…");
    const contentEl = thinkingEl.querySelector(".team-response-content");

    // 构建消息（含黑板上下文 + 工具描述）
    const contextSummary = responses.map(r => `[${r.member.name}]: ${r.text}`).join("\n");
    let userPrompt = `${member.persona}\n\n议题: ${topic}${boardContext}`;
    if (contextSummary) {
      userPrompt += `\n\n其他成员观点:\n${contextSummary}`;
    }
    userPrompt += "\n\n请发表你的看法（1-3句话）。如需操作黑板或调用技能，可使用工具。";

    const systemPrompt = `你是 SLATE 团队协作成员。${getToolsSystemPrompt()}`;
    let fullText = "";
    try {
      for await (const chunk of streamChat({
        model: member.modelId,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        api_key: apiKey,
        temperature: member.role === "decider" ? 0.3 : 0.7,
        max_tokens: 500,
        stream: true,
      })) {
        fullText += chunk;
        if (contentEl) contentEl.textContent = fullText;
      }
    } catch (e) {
      fullText = `⚠ 请求失败: ${e.message}`;
      if (contentEl) contentEl.textContent = fullText;
    }

    // 处理工具调用
    const toolCalls = detectToolCalls(fullText);
    if (toolCalls.length > 0) {
      const cleanText = stripToolCalls(fullText);
      if (contentEl) contentEl.textContent = cleanText;

      const results = await executeToolCalls(toolCalls);
      for (const r of results) {
        const toolEl = document.createElement("div");
        toolEl.className = "team-tool-result";
        toolEl.textContent = `⚙ ${r.output}`;
        teamOutput.appendChild(toolEl);
      }

      fullText = cleanText + "\n[已执行工具: " + toolCalls.map(c => c.name).join(", ") + "]";
    }

    addTeamUsage(`${systemPrompt}\n\n${userPrompt}`, fullText);
    responses.push({ member, text: fullText });
  }

  // 生成讨论摘要
  const summaryMarkdown = await generateSummary(topic, responses);
  persistTeamSession({
    id: makeSessionId(),
    topic,
    createdAt: Date.now(),
    members: teamMembers.map(m => ({ ...m })),
    responses: responses.map(r => ({ member: { ...r.member }, text: r.text })),
    summaryMarkdown,
    usage: { ...currentTeamUsage },
  });

  isDiscussing = false;
  btnStartDiscuss.disabled = false;
  btnStartDiscuss.textContent = "开始讨论";
}

async function generateSummary(topic, responses) {
  // 找到决策者角色的响应
  const decider = responses.find(r => r.member.role === "decider");
  if (!decider) return "";

  const summaryEl = document.createElement("div");
  summaryEl.className = "team-summary";
  summaryEl.innerHTML = '<div class="team-summary-title">讨论摘要</div><div class="team-summary-content">生成中…</div>';
  teamOutput.appendChild(summaryEl);

  const contentEl = summaryEl.querySelector(".team-summary-content");

  // 共识点
  const consensus = [];
  const divergence = [];
  for (let i = 0; i < responses.length; i++) {
    for (let j = i + 1; j < responses.length; j++) {
      // 简单判断：如果两个响应有相同的关键词，认为有共识
      const words1 = new Set(responses[i].text.split(/\s+/));
      const words2 = new Set(responses[j].text.split(/\s+/));
      const overlap = [...words1].filter(w => words2.has(w) && w.length > 2);
      if (overlap.length > 2) {
        consensus.push(`${responses[i].member.name} 与 ${responses[j].member.name} 观点接近`);
      }
    }
  }

  let summary = `**议题**: ${topic}\n\n`;
  summary += `**参与成员**: ${responses.map(r => r.member.name).join("、")}\n\n`;
  if (consensus.length > 0) {
    summary += `**共识点**: ${consensus.join("；")}\n\n`;
  }
  summary += `**各方观点**:\n`;
  for (const r of responses) {
    summary += `- ${r.member.name}(${r.member.role === "analyst" ? "分析" : r.member.role === "creative" ? "创意" : "决策"}): ${r.text}\n`;
  }
  summary += `\n**决策建议**: ${decider.text}`;

  contentEl.innerHTML = renderSimpleMarkdown(summary);
  return summary;
}

function renderLoadedSession(session) {
  if (!session || !teamOutput) return;
  teamOutput.innerHTML = "";
  teamTopicInput.value = session.topic || "";

  const topicEl = document.createElement("div");
  topicEl.className = "team-topic";
  topicEl.textContent = `议题: ${session.topic || "未命名讨论"}`;
  teamOutput.appendChild(topicEl);

  for (const response of session.responses || []) {
    addTeamResponse(response.member, response.text || "");
  }

  if (session.summaryMarkdown) {
    const summaryEl = document.createElement("div");
    summaryEl.className = "team-summary";
    summaryEl.innerHTML = '<div class="team-summary-title">讨论摘要</div><div class="team-summary-content"></div>';
    summaryEl.querySelector(".team-summary-content").innerHTML = renderSimpleMarkdown(session.summaryMarkdown);
    teamOutput.appendChild(summaryEl);
  }

  currentTeamUsage = {
    promptTokens: session.usage?.promptTokens || 0,
    completionTokens: session.usage?.completionTokens || 0,
    totalTokens: session.usage?.totalTokens || 0,
    messageCount: session.usage?.messageCount || 0,
  };
  renderTeamUsage();
}

function loadTeamSession(sessionId) {
  if (isDiscussing) return;
  const session = teamHistory.find(item => item.id === sessionId);
  if (!session) return;
  renderLoadedSession(session);
  teamHistoryList?.querySelectorAll(".team-history-item").forEach(item => {
    item.classList.toggle("active", item.dataset.sessionId === sessionId);
  });
}

function addTeamResponse(member, text) {
  const el = document.createElement("div");
  el.className = "team-response";

  const header = document.createElement("div");
  header.className = "team-response-header";

  const avatar = document.createElement("span");
  avatar.className = "team-response-avatar";
  avatar.textContent = member.name.charAt(0);
  header.appendChild(avatar);

  const name = document.createElement("span");
  name.className = "team-response-name";
  name.textContent = member.name;
  header.appendChild(name);

  const model = document.createElement("span");
  model.className = "team-response-model";
  const modelCfg = findModel(member.modelId);
  model.textContent = modelCfg?.name || member.modelId;
  header.appendChild(model);

  el.appendChild(header);

  const content = document.createElement("div");
  content.className = "team-response-content";
  content.textContent = text;
  el.appendChild(content);

  teamOutput.appendChild(el);
  teamOutput.scrollTop = teamOutput.scrollHeight;
  return el;
}

function findModel(modelId) {
  for (const models of Object.values(state.modelRegistry)) {
    const found = models.find(m => m.id === modelId);
    if (found) return found;
  }
  return null;
}

function renderSimpleMarkdown(text) {
  return renderMarkdown(text);
}

// ── 工作流视图 ────────────────────────────

let wfSelect, wfDesc, wfInput, btnWfRun, wfRunStatus, wfNodeList, wfResultBar;
let wfList = [];
let wfRunning = false;

const WF_STATUS_TEXT = {
  waiting: "⏸ 等待",
  running: "● 运行中",
  success: "✓ 成功",
  failed: "✗ 失败",
  skipped: "⊘ 跳过",
};

async function initWorkflowView() {
  wfSelect = document.getElementById("wf-select");
  wfDesc = document.getElementById("wf-desc");
  wfInput = document.getElementById("wf-input");
  btnWfRun = document.getElementById("btn-wf-run");
  wfRunStatus = document.getElementById("wf-run-status");
  wfNodeList = document.getElementById("wf-node-list");
  wfResultBar = document.getElementById("wf-result-bar");
  if (!wfSelect) return;

  // 讨论 / 工作流视图切换（不影响原有团队讨论功能）
  const discussView = document.getElementById("team-discuss-view");
  const workflowView = document.getElementById("team-workflow-view");
  const tabDiscuss = document.getElementById("btn-team-view-discuss");
  const tabWorkflow = document.getElementById("btn-team-view-workflow");
  const switchView = (isWorkflow) => {
    discussView?.classList.toggle("hidden", isWorkflow);
    workflowView?.classList.toggle("hidden", !isWorkflow);
    tabDiscuss?.classList.toggle("active", !isWorkflow);
    tabWorkflow?.classList.toggle("active", isWorkflow);
  };
  tabDiscuss?.addEventListener("click", () => switchView(false));
  tabWorkflow?.addEventListener("click", () => switchView(true));

  wfSelect.addEventListener("change", renderWfDesc);
  btnWfRun.addEventListener("click", runSelectedWorkflow);
  await refreshWorkflowList();
}

async function refreshWorkflowList() {
  try {
    wfList = await loadWorkflows();
    wfSelect.innerHTML = "";
    if (wfList.length === 0) {
      wfDesc.textContent = "暂无工作流，请在 backend/workflows/ 目录放置 JSON 定义文件";
      return;
    }
    for (const wf of wfList) {
      const opt = document.createElement("option");
      opt.value = wf.id;
      opt.textContent = wf.valid ? `${wf.name}（${wf.node_count} 节点）` : `⚠ ${wf.name}（定义非法）`;
      wfSelect.appendChild(opt);
    }
    renderWfDesc();
  } catch (e) {
    wfDesc.textContent = `工作流列表加载失败: ${e.message}`;
  }
}

function renderWfDesc() {
  const wf = wfList.find(w => w.id === wfSelect.value);
  if (!wf) { wfDesc.textContent = ""; return; }
  wfDesc.textContent = wf.valid
    ? `${wf.description || ""}（节点 ${wf.node_count} · 依赖边 ${wf.edge_count}）`
    : `⚠ 该工作流定义非法：${wf.error}`;
}

function makeWfIo(label, text) {
  const box = document.createElement("div");
  box.className = "wf-node-io";
  const labelEl = document.createElement("div");
  labelEl.className = "wf-node-io-label";
  labelEl.textContent = label;
  const pre = document.createElement("pre");
  pre.textContent = text;
  box.appendChild(labelEl);
  box.appendChild(pre);
  return box;
}

function renderWfNodeRows(wf) {
  wfNodeList.innerHTML = "";
  // 按拓扑顺序展示（后端已返回 order）
  const orderIndex = new Map((wf.order || []).map((id, i) => [id, i]));
  const nodes = [...(wf.nodes || [])].sort((a, b) =>
    (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0)
  );
  for (const node of nodes) {
    const row = document.createElement("div");
    row.className = "wf-node";
    row.dataset.nodeId = node.id;
    row.dataset.status = "waiting";

    const head = document.createElement("div");
    head.className = "wf-node-head";

    const statusEl = document.createElement("span");
    statusEl.className = "wf-node-status";
    statusEl.textContent = WF_STATUS_TEXT.waiting;
    head.appendChild(statusEl);

    const nameEl = document.createElement("span");
    nameEl.className = "wf-node-name";
    nameEl.textContent = node.name;
    head.appendChild(nameEl);

    const bindEl = document.createElement("span");
    bindEl.className = "wf-node-bind";
    bindEl.textContent = node.skill ? `⚙ ${node.skill}` : "";
    head.appendChild(bindEl);

    const caret = document.createElement("span");
    caret.className = "wf-node-caret";
    caret.textContent = "▾";
    head.appendChild(caret);

    const detail = document.createElement("div");
    detail.className = "wf-node-detail hidden";

    head.addEventListener("click", () => detail.classList.toggle("hidden"));
    row.appendChild(head);
    row.appendChild(detail);
    wfNodeList.appendChild(row);
  }
}

function updateWfNodeRow(rec) {
  const row = wfNodeList?.querySelector(`.wf-node[data-node-id="${rec.id}"]`);
  if (!row) return;
  row.dataset.status = rec.status;
  row.querySelector(".wf-node-status").textContent = WF_STATUS_TEXT[rec.status] || rec.status;
  if (rec.modelLabel) row.querySelector(".wf-node-bind").textContent = rec.modelLabel;

  const detail = row.querySelector(".wf-node-detail");
  detail.innerHTML = "";
  if (rec.error) {
    const errEl = document.createElement("div");
    errEl.className = "wf-node-error";
    errEl.textContent = `✗ ${rec.error}`;
    detail.appendChild(errEl);
  }
  if (rec.inputPreview) detail.appendChild(makeWfIo("输入", rec.inputPreview));
  if (rec.output) detail.appendChild(makeWfIo("输出", rec.output));
}

async function runSelectedWorkflow() {
  if (wfRunning) return;
  const userInput = wfInput.value.trim();
  if (!userInput) {
    wfRunStatus.textContent = "请先输入任务需求";
    return;
  }
  const selected = wfList.find(w => w.id === wfSelect.value);
  if (!selected) return;
  if (!selected.valid) {
    wfRunStatus.textContent = `该工作流定义非法，无法执行：${selected.error}`;
    return;
  }

  wfRunning = true;
  btnWfRun.disabled = true;
  wfResultBar.innerHTML = "";
  wfRunStatus.textContent = "加载工作流定义…";

  try {
    const wf = await getWorkflow(selected.id);
    renderWfNodeRows(wf);

    const total = (wf.nodes || []).length;
    let doneCount = 0;
    wfRunStatus.textContent = `运行中（0/${total}）…`;

    const result = await runWorkflow(wf, userInput, teamMembers, {
      onNode: (rec) => {
        updateWfNodeRow(rec);
        if (["success", "failed", "skipped"].includes(rec.status)) {
          doneCount += 1;
          wfRunStatus.textContent = doneCount < total
            ? `运行中（${doneCount}/${total}）…`
            : "工作流已结束，正在将产物写入知识库…";
        }
      },
    });

    const okCount = result.order.filter(id => result.records[id].status === "success").length;
    try {
      const docId = await saveRunToKnowledge(wf, result);
      wfResultBar.innerHTML = `<span class="wf-result-ok">✓ ${okCount}/${total} 节点成功 · 产物已写入知识库（${docId}），可在记忆面板查看</span>`;
    } catch (e) {
      wfResultBar.innerHTML = `<span class="wf-result-error">节点成功 ${okCount}/${total}，但写入知识库失败: ${e.message}</span>`;
    }
    wfRunStatus.textContent = "";
  } catch (e) {
    wfRunStatus.textContent = "";
    wfResultBar.innerHTML = `<span class="wf-result-error">✗ 工作流执行失败: ${e.message}</span>`;
  } finally {
    wfRunning = false;
    btnWfRun.disabled = false;
  }
}

// ── 初始化 ──────────────────────────────────

function initTeamPanel() {
  teamPanel = document.getElementById("team-panel");
  teamMembersArea = document.getElementById("team-members-area");
  teamTopicInput = document.getElementById("team-topic-input");
  btnStartDiscuss = document.getElementById("btn-start-discuss");
  teamOutput = document.getElementById("team-output");
  btnAddMember = document.getElementById("btn-add-member");
  teamHistoryList = document.getElementById("team-history-list");
  teamUsageBar = document.getElementById("team-usage-bar");
  btnNewTeamDiscussion = document.getElementById("btn-new-team-discussion");

  // 默认成员
  teamMembers = [...DEFAULT_MEMBERS.map(m => ({ ...m }))];
  loadTeamHistory();
  renderTeamHistory();
  renderTeamUsage();
  renderTeamMembers();

  btnAddMember.addEventListener("click", () => {
    teamMembers.push({
      id: `member-${Date.now()}`,
      name: `成员${teamMembers.length + 1}`,
      modelId: "gpt-5.6-terra",
      persona: "你是团队成员。简洁发表观点（1-3句）。",
      role: "member",
    });
    renderTeamMembers();
  });

  btnStartDiscuss.addEventListener("click", startDiscussion);
  btnNewTeamDiscussion?.addEventListener("click", () => {
    if (isDiscussing) return;
    teamOutput.innerHTML = "";
    teamTopicInput.value = "";
    resetTeamUsage();
    teamHistoryList?.querySelectorAll(".team-history-item.active").forEach(item => item.classList.remove("active"));
    teamTopicInput.focus();
  });

  // 工作流视图初始化（讨论视图之外的新能力）
  initWorkflowView();

  // 团队/对话切换
  const btnTeamMode = document.getElementById("btn-team-mode");
  const btnChatMode = document.getElementById("btn-chat-mode");
  const chatArea = document.getElementById("chat-area");

  if (btnTeamMode && btnChatMode && chatArea) {
    btnTeamMode.addEventListener("click", () => {
      chatArea.classList.add("hidden");
      teamPanel.classList.remove("hidden");
      btnTeamMode.classList.add("active");
      btnChatMode.classList.remove("active");
    });

    btnChatMode.addEventListener("click", () => {
      teamPanel.classList.add("hidden");
      chatArea.classList.remove("hidden");
      btnChatMode.classList.add("active");
      btnTeamMode.classList.remove("active");
    });
  }
}

export { initTeamPanel };
