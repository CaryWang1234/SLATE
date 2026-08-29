/**
 * SLATE AI 团队组件：多模型协作讨论
 * 轻量模型初步讨论，重型模型最终决策。
 */

import { state, subscribe, getModelKey, hasModelKey, estimateTokens, addBoardCard } from "../store.js?v=20260829-142";
import { notifyTaskComplete } from "../services/notify.js?v=20260829-142";
import { streamChat } from "../services/api.js?v=20260829-142";
import { detectToolCalls, stripToolCalls, executeToolCalls, getToolsSystemPrompt } from "../services/tools.js?v=20260829-142";
import { renderMarkdown } from "../services/markdown.js?v=20260829-142";
import { loadWorkflows, getWorkflow, runWorkflow, stopWorkflow, saveRunToKnowledge } from "../services/workflow.js?v=20260829-142";
import { getExpert, buildExpertPrompt } from "../services/experts.js?v=20260829-142";
import { getExpertsCached } from "./experts.js?v=20260829-142";
import { addToolStepCard, updateToolStepCard } from "./whiteboard.js?v=20260829-142";
import { t } from "../services/i18n.js?v=20260829-142";
import { makeId } from "../services/utils.js?v=20260829-142";

// 当模型列表加载完成后，重新渲染团队成员（填充下拉选项）
subscribe("modelRegistry", () => renderTeamMembers());

let teamPanel, teamMembersArea, teamTopicInput, btnStartDiscuss, teamOutput, btnAddMember;
let teamHistoryList, teamUsageBar, btnNewTeamDiscussion, btnStopDiscuss;
let teamMembers = [];
let teamHistory = [];
let currentTeamUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, messageCount: 0 };
let isDiscussing = false;
let maxRounds = 5;
let discussAbortController = null;
const TEAM_HISTORY_KEY = "slate_team_history";

// ── 默认团队成员 ────────────────────────────

const DEFAULT_MEMBERS = [
  { id: "member-1", name: "分析师", modelId: "deepseek-v4-flash", persona: "你是务实派分析师。关注可行性和成本，回答简洁（1-3句）。", role: "analyst" },
  { id: "member-2", name: "创意官", modelId: "gemini-3.6-flash", persona: "你是创意导向的思考者。关注创新可能性和用户体验，回答简洁（1-3句）。", role: "creative" },
  { id: "member-3", name: "决策者", modelId: "gpt-5.6-sol", persona: "你是最终决策者。综合各方观点给出明确建议和理由，回答简洁（1-3句）。", role: "decider" },
];

// ── 团队预设 ────────────────────────────

const TEAM_PRESETS = [
  {
    "id": "classic",
    "name": "经典三人组",
    "desc": "分析师 + 创意者 + 决策者",
    "members": [
      {
        "name": "分析师",
        "modelId": "deepseek-v4-flash",
        "persona": "你是务实派分析师。关注可行性和成本，回答简洁（1-3句）。",
        "role": "analyst"
      },
      {
        "name": "创意者",
        "modelId": "gemini-3.6-flash",
        "persona": "你是创意导向的思考者。关注创新可能性和用户体验，回答简洁（1-3句）。",
        "role": "creative"
      },
      {
        "name": "决策者",
        "modelId": "gpt-5.6-sol",
        "persona": "你是最终决策者。综合各方观点给出明确建议和理由，回答简洁（1-3句）。",
        "role": "decider"
      }
    ]
  },
  {
    "id": "code-review",
    "name": "代码审查组",
    "desc": "安全专家 + 性能专家 + 架构师",
    "members": [
      {
        "name": "安全专家",
        "modelId": "deepseek-v4-flash",
        "persona": "你是安全审计专家。专注代码安全漏洞、注入风险、敏感信息泄露，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "性能专家",
        "modelId": "gemini-3.6-flash",
        "persona": "你是性能优化专家。关注算法复杂度、内存泄漏、并发问题，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "架构师",
        "modelId": "gpt-5.6-sol",
        "persona": "你是资深架构师。关注代码结构、设计模式、可维护性，综合给出改进方案。",
        "role": "decider"
      }
    ]
  },
  {
    "id": "product-brainstorm",
    "name": "产品头脑风暴",
    "desc": "产品经理 + 设计师 + 用户代言 + 技术负责人",
    "members": [
      {
        "name": "产品经理",
        "modelId": "gemini-3.6-flash",
        "persona": "你是资深产品经理。关注用户价值、市场定位和商业可行性，回答简洁。",
        "role": "creative"
      },
      {
        "name": "设计师",
        "modelId": "deepseek-v4-flash",
        "persona": "你是交互设计师。关注用户体验、信息架构和视觉层次，回答简洁。",
        "role": "creative"
      },
      {
        "name": "用户代言",
        "modelId": "kimi-k2.7-code",
        "persona": "你代表终端用户发声。关注易用性、学习成本和真实使用场景，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "技术负责人",
        "modelId": "gpt-5.6-sol",
        "persona": "你是技术负责人。综合产品、设计、用户视角给出技术可行方案和优先级。",
        "role": "decider"
      }
    ]
  },
  {
    "id": "tech-selection",
    "name": "技术选型",
    "desc": "前端专家 + 后端专家 + 基础设施专家",
    "members": [
      {
        "name": "前端专家",
        "modelId": "deepseek-v4-flash",
        "persona": "你是前端技术专家。从框架生态、开发体验、性能角度评估技术方案，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "后端专家",
        "modelId": "gemini-3.6-flash",
        "persona": "你是后端技术专家。从可扩展性、维护成本、社区成熟度角度评估技术方案，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "基础设施专家",
        "modelId": "kimi-k2.7-code",
        "persona": "你是基础设施专家。从部署运维、监控告警、成本角度评估技术方案，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "技术总监",
        "modelId": "gpt-5.6-sol",
        "persona": "你是技术总监。综合前端、后端、基础设施的意见，给出最终技术选型建议和理由。",
        "role": "decider"
      }
    ]
  },
  {
    "id": "red-blue",
    "name": "红蓝对抗",
    "desc": "正方辩手 + 反方辩手 + 裁判",
    "members": [
      {
        "name": "正方辩手",
        "modelId": "gemini-3.6-flash",
        "persona": "你是正方辩手。积极论证方案的可行性、优势和价值，用事实和逻辑支撑，回答简洁。",
        "role": "creative"
      },
      {
        "name": "反方辩手",
        "modelId": "deepseek-v4-flash",
        "persona": "你是反方辩手。尖锐质疑方案的漏洞、风险和盲点，用反例和数据反驳，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "裁判",
        "modelId": "gpt-5.6-sol",
        "persona": "你是公正的裁判。听取正反双方论点，裁定谁的论证更有说服力，给出平衡的结论。",
        "role": "decider"
      }
    ]
  },
  {
    "id": "fullstack-review",
    "name": "全栈评审",
    "desc": "前端 + 后端 + 数据库 + 运维",
    "members": [
      {
        "name": "前端评审",
        "modelId": "deepseek-v4-flash",
        "persona": "你负责前端评审。关注组件设计、状态管理、渲染性能和可访问性，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "后端评审",
        "modelId": "gemini-3.6-flash",
        "persona": "你负责后端评审。关注 API 设计、业务逻辑、错误处理和安全性，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "数据库评审",
        "modelId": "kimi-k2.7-code",
        "persona": "你负责数据层评审。关注数据模型、查询效率、索引策略和数据一致性，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "运维评审",
        "modelId": "deepseek-v4-flash",
        "persona": "你负责运维评审。关注部署流程、日志监控、容灾恢复和成本，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "技术总监",
        "modelId": "gpt-5.6-sol",
        "persona": "你是技术总监。综合各层评审意见，给出最终改进方案和优先级排序。",
        "role": "decider"
      }
    ]
  },
  {
    "id": "writing-workshop",
    "name": "写作工坊",
    "desc": "内容策划 + 文案写手 + 编辑",
    "members": [
      {
        "name": "内容策划",
        "modelId": "gemini-3.6-flash",
        "persona": "你是内容策划。负责确定主题、受众、核心论点和内容结构，回答简洁。",
        "role": "creative"
      },
      {
        "name": "文案写手",
        "modelId": "deepseek-v4-flash",
        "persona": "你是文案写手。负责文字表达、修辞润色和节奏把控，回答简洁。",
        "role": "creative"
      },
      {
        "name": "编辑",
        "modelId": "gpt-5.6-sol",
        "persona": "你是资深编辑。负责质量把关、逻辑校对和整体改进建议，综合给出最终版本。",
        "role": "decider"
      }
    ]
  },
  {
    "id": "startup-advisory",
    "name": "创业顾问团",
    "desc": "市场顾问 + 技术顾问 + 财务顾问 + 运营顾问",
    "members": [
      {
        "name": "市场顾问",
        "modelId": "gemini-3.6-flash",
        "persona": "你是市场营销顾问。关注目标市场、获客策略、品牌定位和竞争分析，回答简洁。",
        "role": "creative"
      },
      {
        "name": "技术顾问",
        "modelId": "deepseek-v4-flash",
        "persona": "你是技术顾问。关注技术可行性、MVP 范围、开发周期和技术债，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "财务顾问",
        "modelId": "kimi-k2.7-code",
        "persona": "你是财务顾问。关注成本结构、盈利模式、现金流和融资策略，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "运营顾问",
        "modelId": "gemini-3.6-flash",
        "persona": "你是运营顾问。关注用户增长、留存策略、团队搭建和运营效率，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "CEO",
        "modelId": "gpt-5.6-sol",
        "persona": "你是 CEO。综合市场、技术、财务、运营意见，做出战略决策和优先级排序。",
        "role": "decider"
      }
    ]
  },
  {
    "id": "academic-seminar",
    "name": "学术研讨",
    "desc": "方法论专家 + 实证研究者 + 批判者",
    "members": [
      {
        "name": "方法论专家",
        "modelId": "gemini-3.6-flash",
        "persona": "你是方法论专家。关注研究设计、理论框架和方法论严谨性，回答简洁。",
        "role": "creative"
      },
      {
        "name": "实证研究者",
        "modelId": "deepseek-v4-flash",
        "persona": "你是实证研究者。关注数据证据、实验设计和统计分析，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "批判者",
        "modelId": "kimi-k2.7-code",
        "persona": "你是学术批判者。质疑假设、指出逻辑漏洞和替代解释，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "主持人",
        "modelId": "gpt-5.6-sol",
        "persona": "你是研讨会主持人。综合各方观点，总结共识与分歧，指出未来研究方向。",
        "role": "decider"
      }
    ]
  }
];

function applyTeamPreset(presetId) {
  if (presetId === "custom") return; // 自定义模式：保留当前成员
  const preset = TEAM_PRESETS.find(p => p.id === presetId);
  if (!preset) return;
  teamMembers = preset.members.map((m, i) => ({
    id: `preset-${presetId}-${i}`,
    name: m.name,
    modelId: m.modelId,
    persona: m.persona,
    role: m.role,
    expertId: "",
  }));
  renderTeamMembers();
}


function fmtTok(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n || 0);
}

function makeSessionId() {
  return makeId();
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
    <span class="usage-stat">${t("轮次 {n}", { n: usage.messageCount || 0 })}</span>
    <span class="usage-sep">|</span>
    <span class="usage-stat">${t("输入 {n}", { n: fmtTok(usage.promptTokens || 0) })}</span>
    <span class="usage-sep">|</span>
    <span class="usage-stat">${t("输出 {n}", { n: fmtTok(usage.completionTokens || 0) })}</span>
    <span class="usage-sep">|</span>
    <span class="usage-stat">${t("总计 {n}", { n: fmtTok(usage.totalTokens || 0) })}</span>
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
    const turnCount = session.entries?.length ?? session.responses?.length ?? 0;
    meta.textContent = time + t(" · {n} 条发言 · ~{tok} tok", { n: turnCount, tok: fmtTok(session.usage?.totalTokens || 0) });
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
    const empty = document.createElement("div");
    empty.className = "team-empty";
    empty.textContent = "暂无团队成员，点击 + 添加";
    teamMembersArea.appendChild(empty);
    return;
  }

  teamMembers.forEach((m, i) => {
    const card = document.createElement("div");
    card.className = "team-member-card";

    const header = document.createElement("div");
    header.className = "team-member-header";

    const avatar = document.createElement("span");
    avatar.className = "team-member-avatar";
    avatar.textContent = m.role === "analyst" ? "A" : m.role === "creative" ? "C" : m.role === "decider" ? "D" : "M";
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

    // 专家包绑定：辩论时注入专属 persona + rules
    const expertRow = document.createElement("div");
    expertRow.className = "team-member-expert-row";
    const expertLabel = document.createElement("span");
    expertLabel.className = "team-member-expert-label";
    expertLabel.textContent = "专家包";
    expertRow.appendChild(expertLabel);
    const expertSelect = document.createElement("select");
    expertSelect.className = "team-member-model member-expert-select";
    expertSelect.dataset.current = m.expertId || "";
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "无专家";
    expertSelect.appendChild(noneOpt);
    for (const item of getExpertsCached()) {
      const opt = document.createElement("option");
      opt.value = item.id;
      opt.textContent = item.name || item.id;
      if (item.id === m.expertId) opt.selected = true;
      expertSelect.appendChild(opt);
    }
    expertSelect.addEventListener("change", () => {
      m.expertId = expertSelect.value;
      expertSelect.dataset.current = expertSelect.value;
    });
    expertRow.appendChild(expertSelect);
    card.appendChild(expertRow);

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
    optgroup.label = t(label);
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name + (hasModelKey(m.id) ? "" : "（未配置 Key）");
      if (m.id === selectedId) opt.selected = true;
      optgroup.appendChild(opt);
    }
    select.appendChild(optgroup);
  }

  // 自定义模型
  if (state.customModels.length > 0) {

    const optgroup = document.createElement("optgroup");
    optgroup.label = t("自定义");
    for (const m of state.customModels) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name + (hasModelKey(m.id) ? "" : "（未配置 Key）");
      if (m.id === selectedId) opt.selected = true;
      optgroup.appendChild(opt);
    }
    select.appendChild(optgroup);
  }
}

// ── 辩论逻辑：提案 / 支持 / 反对 / 反驳 / 补充 / 决策 ────

const DEBATE_ACTIONS = {
  propose: "提案",
  support: "支持",
  oppose: "反对",
  rebut: "反驳",
  supplement: "补充",
  verdict: "决策",
};

/** 解析发言的动作前缀与回应对象：【动作】@成员{n}*/
function parseDebateAction(text) {
  const m = String(text || "").match(/^\s*【(提案|支持|反对|反驳|补充|决策)】\s*(?:@([^\s【】@]+))?/);
  if (!m) return { action: "propose", target: "", content: String(text || "").trim() };
  const action = Object.keys(DEBATE_ACTIONS).find(k => DEBATE_ACTIONS[k] === m[1]) || "propose";
  return { action, target: m[2] || "", content: String(text || "").slice(m[0].length).trim() };
}

function buildTranscript(entries) {
  return entries.map(e =>
    `[${e.round}轮] ${e.member.name} ${DEBATE_ACTIONS[e.action] || "发言"}${e.target ? `（回${e.target}）` : ""}: ${e.text}`
  ).join("\n");
}

function addRoundHeader(round) {
  const el = document.createElement("div");
  el.className = "debate-round-header";
  el.textContent = t("—— 第 {n} 轮 ——", { n: round });
  teamOutput.appendChild(el);
}

function addDebateEntry(member, action = "propose") {
  const el = document.createElement("div");
  el.className = `debate-entry action-${action} streaming`;

  const header = document.createElement("div");
  header.className = "debate-header";

  const avatar = document.createElement("span");
  avatar.className = "debate-avatar";
  avatar.textContent = (member.name || "?").charAt(0);
  header.appendChild(avatar);

  const name = document.createElement("span");
  name.className = "debate-name";
  name.textContent = member.name;
  header.appendChild(name);

  const badge = document.createElement("span");
  badge.className = `debate-action-badge action-${action}`;
  badge.textContent = DEBATE_ACTIONS[action] || "发言";
  header.appendChild(badge);

  const model = document.createElement("span");
  model.className = "debate-model";
  model.textContent = findModel(member.modelId)?.name || member.modelId;
  header.appendChild(model);

  el.appendChild(header);

  const replyRef = document.createElement("div");
  replyRef.className = "debate-reply-ref hidden";
  el.appendChild(replyRef);

  const content = document.createElement("div");
  content.className = "debate-content";
  el.appendChild(content);

  teamOutput.appendChild(el);
  teamOutput.scrollTop = teamOutput.scrollHeight;
  return { el, badge, replyRef, content };
}

function finalizeEntry(entry, action, target, text) {
  entry.el.classList.remove("streaming");
  if (!DEBATE_ACTIONS[action]) action = "propose";
  entry.el.className = `debate-entry action-${action}`;
  entry.badge.className = `debate-action-badge action-${action}`;
  entry.badge.textContent = DEBATE_ACTIONS[action];
  if (target) {
    entry.replyRef.textContent = t("回应 {name}", { name: target });
    entry.replyRef.classList.remove("hidden");
  }
  entry.content.textContent = text;
  teamOutput.scrollTop = teamOutput.scrollHeight;
}

function buildMemberPrompt(member, topic, boardContext, entries, round, isLastRound, expertDetail = null) {
  let prompt = `${member.persona}\n`;
  // 绑定的专家包：注入专家人格与规则
  const expertPrompt = buildExpertPrompt(expertDetail);
  if (expertPrompt) prompt += `${expertPrompt}\n`;
  prompt += `\n议题: ${topic}${boardContext}\n\n`;
  if (entries.length === 0) {
    prompt += "这是第一轮，请提出你的想法或方案。";
  } else {
    prompt += `已有发言记录:\n${buildTranscript(entries)}\n\n请继续参与讨论：可以提出新想法，也可以支持、反对、反驳或补充他人的想法。`;
  }
  prompt += `\n\n发言格式：第一行以【提案】【支持】【反对】【反驳】【补充】之一开头，回应他人时在动作后写 @对方成员名，第二行起写正文（1-3句）。`;
  if (member.role === "decider") {
    prompt += isLastRound
      ? "\n这是最后一轮：请综合各方观点，以【决策】开头给出最终方案、理由与取舍。"
      : "\n若各方已达成共识或分歧无法调和，你可以【决策】开头直接给出最终方案（讨论将立即结束）；否则继续正常参与讨论。";
  }
  return prompt;
}

async function startDiscussion() {
  const topic = teamTopicInput.value.trim();
  if (!topic) return;
  if (teamMembers.length === 0) return;
  if (isDiscussing) return;

  isDiscussing = true;
  discussAbortController = new AbortController();
  btnStartDiscuss.disabled = true;
  btnStartDiscuss.textContent = "辩论中…";
  if (btnStopDiscuss) {
    btnStopDiscuss.classList.remove("hidden");
    btnStopDiscuss.disabled = false;
  }
  teamOutput.innerHTML = "";
  resetTeamUsage();

  const topicEl = document.createElement("div");
  topicEl.className = "team-topic";
  topicEl.textContent = t("议题: {topic}", { topic });
  teamOutput.appendChild(topicEl);

  // 注入黑板上下文
  let boardContext = "";

  if (state.boardCards.length > 0) {
    boardContext = "\n\n当前黑板卡片:\n" + state.boardCards.map(c =>
      `[${c.id}] ${c.title}${c.body ? " " + c.body : ""}`
    ).join("\n");
  }

  const entries = [];
  let verdict = null;

  // 预加载成员绑定的专家包
  const expertDetails = new Map();

  for (const member of teamMembers) {
    if (member.expertId && !expertDetails.has(member.expertId)) {
      try {
        expertDetails.set(member.expertId, await getExpert(member.expertId));
      } catch (e) {
        console.warn(`专家包加载失败（${member.expertId}）`, e);
      }
    }
  }

  // 多轮辩论：每轮每位成员可提案或回应他人，直到决策产生或轮次用尽
  for (let round = 1; round <= maxRounds && !verdict; round++) {
    if (discussAbortController?.signal.aborted) break;
    addRoundHeader(round);
    const isLastRound = round === maxRounds;

    for (const member of teamMembers) {
      if (verdict || discussAbortController?.signal.aborted) break;

      const apiKey = getModelKey(member.modelId);
      if (!apiKey) {
        const skipEntry = addDebateEntry(member, "propose");
        finalizeEntry(skipEntry, "propose", "", "未配置 API Key，已跳过");
        continue;
      }

      const entry = addDebateEntry(member, "propose");
      const systemPrompt = `你是 SLATE 团队协作成员：始终从自己的角色立场出发发表独立观点，直接给观点，不寒暄、不复述他人。${getToolsSystemPrompt({ minimal: true })}`;
      const userPrompt = buildMemberPrompt(member, topic, boardContext, entries, round, isLastRound, member.expertId ? expertDetails.get(member.expertId) : null);

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
          signal: discussAbortController?.signal,
        })) {
          fullText += chunk;
          entry.content.textContent = fullText;
          teamOutput.scrollTop = teamOutput.scrollHeight;
        }
      } catch (e) {
        if (discussAbortController?.signal.aborted) break;
        fullText = t("请求失败: {msg}", { msg: e.message });
      }

      // 处理工具调用
      const toolCalls = detectToolCalls(fullText);
      if (toolCalls.length > 0) {
        fullText = stripToolCalls(fullText);
        const results = await executeToolCalls(toolCalls);
        for (const r of results) {
          const toolEl = document.createElement("div");
          toolEl.className = "team-tool-result";
          toolEl.textContent = `${r.output}`;
          teamOutput.appendChild(toolEl);
        }
      }

      const parsed = parseDebateAction(fullText);
      // 非决策者不允许越权拍板
      const action = parsed.action === "verdict" && member.role !== "decider" ? "propose" : parsed.action;
      finalizeEntry(entry, action, parsed.target, parsed.content || "（无内容）");
      addTeamUsage(`${systemPrompt}\n\n${userPrompt}`, fullText);

      const rec = { round, member: { ...member }, action, target: parsed.target, text: parsed.content || fullText };
      entries.push(rec);
      if (action === "verdict") verdict = rec;
    }

    // 轮次用尽仍无决策：决策者强制拍板
    if (!verdict && isLastRound) {
      if (discussAbortController?.signal.aborted) break;
      verdict = await forceVerdict(topic, boardContext, entries);
    }
  }

  if (btnStopDiscuss) {
    btnStopDiscuss.classList.add("hidden");
    btnStopDiscuss.disabled = true;
  }
  const stoppedManually = !!discussAbortController?.signal.aborted;
  if (!stoppedManually) {
    const summaryMarkdown = renderDebateSummary(topic, entries, verdict);
    persistTeamSession({
      id: makeSessionId(),
      topic,
      createdAt: Date.now(),
      members: teamMembers.map(m => ({ ...m })),
      entries,
      verdictText: verdict?.text || "",
      summaryMarkdown,
      usage: { ...currentTeamUsage },
    });
  }

  isDiscussing = false;
  discussAbortController = null;
  btnStartDiscuss.disabled = false;
  btnStartDiscuss.textContent = "开始讨论";
}

/** 轮次用尽仍无共识时，由决策者（或首位有 Key 的成员）给出最终方案 */

/** 停止正在进行的讨论 */
function stopDiscussion() {
  if (!isDiscussing || !discussAbortController) return;
  if (discussAbortController.signal.aborted) return; // 已停止过，等待循环收尾
  discussAbortController.abort();
  // 不在此重置状态：保持 controller 非空，后续成员请求拿到已中止的 signal 立即失败，
  // 不会发出不受控请求；isDiscussing/按钮由循环结束后统一收尾，避免并发第二场辩论
  notifyTaskComplete(t("团队讨论完成"), t("辩论已结束"));
  const stopEl = document.createElement("div");
  stopEl.className = "team-stopped-notice";
  stopEl.textContent = t("讨论已手动停止");
  teamOutput.appendChild(stopEl);
}

async function forceVerdict(topic, boardContext, entries) {
  const decider = teamMembers.find(m => m.role === "decider") || teamMembers[0];
  const apiKey = decider ? getModelKey(decider.modelId) : "";
  if (!decider || !apiKey) return null;

  addRoundHeader("最终决策");
  const entry = addDebateEntry(decider, "verdict");
  const systemPrompt = `你是 SLATE 团队协作成员：始终从自己的角色立场出发发表独立观点，直接给观点，不寒暄、不复述他人。${getToolsSystemPrompt({ minimal: true })}`;
  const userPrompt = `${decider.persona}\n\n议题: ${topic}${boardContext}\n\n辩论记录:\n${buildTranscript(entries)}\n\n讨论轮次已用尽。请综合各方观点，以【决策】开头给出最终方案、理由与取舍。`;

  let fullText = "";
  try {
    for await (const chunk of streamChat({
      model: decider.modelId,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      api_key: apiKey,
      temperature: 0.3,
      max_tokens: 800,
      stream: true,
      signal: discussAbortController?.signal,
    })) {
      fullText += chunk;
      entry.content.textContent = fullText;
      teamOutput.scrollTop = teamOutput.scrollHeight;
    }
  } catch (e) {
    if (discussAbortController?.signal.aborted) return null;
    fullText = t("请求失败: {msg}", { msg: e.message });
  }

  fullText = stripToolCalls(fullText);
  const parsed = parseDebateAction(fullText);
  finalizeEntry(entry, "verdict", parsed.target, parsed.content || fullText);
  addTeamUsage(`${systemPrompt}\n\n${userPrompt}`, fullText);

  const rec = { round: "最终决策", member: { ...decider }, action: "verdict", target: parsed.target, text: parsed.content || fullText };
  entries.push(rec);
  return rec;
}

function renderDebateSummary(topic, entries, verdict) {
  if (entries.length === 0) return "";

  const summaryEl = document.createElement("div");
  summaryEl.className = "team-summary";
  summaryEl.innerHTML = '<div class="team-summary-title">辩论摘要</div><div class="team-summary-content"></div>';
  teamOutput.appendChild(summaryEl);

  const names = [...new Set(entries.map(e => e.member.name))];
  const actionCount = {};
  for (const e of entries) actionCount[e.action] = (actionCount[e.action] || 0) + 1;
  const countText = Object.entries(actionCount)
    .map(([k, n]) => `${t(DEBATE_ACTIONS[k] || k)} ${n}`).join(" · ");

  let summary = t("**议题**: {topic}", { topic }) + "\n\n";
  summary += t("**参与成员**: {names}", { names: names.join("、") }) + "\n\n";
  summary += t("**发言统计**: 共 {n} 条（{counts}）", { n: entries.length, counts: countText }) + "\n\n";
  if (verdict) {
    summary += t("**最终方案**（{name}）:", { name: verdict.member.name }) + "\n" + verdict.text;
  } else {
    summary += t("**结果**: 未达成明确决策");
  }

  summaryEl.querySelector(".team-summary-content").innerHTML = renderSimpleMarkdown(summary);
  teamOutput.scrollTop = teamOutput.scrollHeight;
  return summary;
}

function renderLoadedSession(session) {
  if (!session || !teamOutput) return;
  teamOutput.innerHTML = "";
  teamTopicInput.value = session.topic || "";

  const topicEl = document.createElement("div");
  topicEl.className = "team-topic";
  topicEl.textContent = t("议题: {topic}", { topic: session.topic || t("未命名讨论") });
  teamOutput.appendChild(topicEl);

  if (Array.isArray(session.entries)) {
    // 新版辩论记录：按轮次分组渲染
    let lastRound = null;
    for (const e of session.entries) {
      if (e.round !== lastRound) {
        addRoundHeader(e.round);
        lastRound = e.round;
      }
      const entry = addDebateEntry(e.member, e.action || "propose");
      finalizeEntry(entry, e.action || "propose", e.target || "", e.text || "");
    }
  } else {
    // 旧版单轮记录兼容
    for (const response of session.responses || []) {
      addTeamResponse(response.member, response.text || "");
    }
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
let wfAbortBtn = null;

const WF_STATUS_TEXT = {
  waiting: "等待",
  running: "运行中",
  success: "成功",
  failed: "失败",
  skipped: "跳过",
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

  // 工作流停止按钮
  wfAbortBtn = document.getElementById("btn-wf-stop");
  if (wfAbortBtn) {
    wfAbortBtn.addEventListener("click", () => {
      stopWorkflow();
      wfAbortBtn.classList.add("hidden");
      wfRunStatus.textContent = t("工作流正在停止...");
    });
    wfAbortBtn.classList.add("hidden");
  }

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
      opt.textContent = wf.valid ? wf.name + t("（{n} 节点）", { n: wf.node_count }) : wf.name + t("（定义非法）");
      wfSelect.appendChild(opt);
    }
    renderWfDesc();
  } catch (e) {
    wfDesc.textContent = t("工作流列表加载失败: {msg}", { msg: e.message });
  }
}

function renderWfDesc() {
  const wf = wfList.find(w => w.id === wfSelect.value);
  if (!wf) { wfDesc.textContent = ""; return; }
  wfDesc.textContent = wf.valid
    ? (wf.description || "") + t("（节点 {n} · 依赖边 {m}）", { n: wf.node_count, m: wf.edge_count })
    : t("该工作流定义非法：{msg}", { msg: wf.error });
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
    bindEl.textContent = node.skill ? `${node.skill}` : "";
    head.appendChild(bindEl);

    const caret = document.createElement("span");
    caret.className = "wf-node-caret";
    caret.textContent = "▸";
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
    errEl.textContent = `${rec.error}`;
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
    wfRunStatus.textContent = t("该工作流定义非法，无法执行：{msg}", { msg: selected.error });
    return;
  }

  wfRunning = true;
  btnWfRun.disabled = true;
  wfAbortBtn?.classList.remove("hidden");
  wfResultBar.innerHTML = "";
  wfRunStatus.textContent = "加载工作流定义…";

  try {
    const wf = await getWorkflow(selected.id);
    renderWfNodeRows(wf);

    const total = (wf.nodes || []).length;
    let doneCount = 0;
    wfRunStatus.textContent = t("运行中（0/{n}）…", { n: total });

    const result = await runWorkflow(wf, userInput, teamMembers, {
      onNode: (rec) => {
        updateWfNodeRow(rec);
        if (["success", "failed", "skipped"].includes(rec.status)) {
          doneCount += 1;
          wfRunStatus.textContent = doneCount < total
            ? t("运行中（{done}/{n}）…", { done: doneCount, n: total })
            : "工作流已结束，正在将产物写入知识库…";
        }
      },
    });

    const okCount = result.order.filter(id => result.records[id].status === "success").length;
    try {
      const docId = await saveRunToKnowledge(wf, result);
      wfResultBar.textContent = "";
      const ok = document.createElement("span");
      ok.className = "wf-result-ok";
      ok.textContent = t("{ok}/{n} 节点成功 · 产物已写入知识库（{title}），可在记忆面板查看", { ok: okCount, n: total, title: docId });
      wfResultBar.appendChild(ok);
    } catch (e) {
      wfResultBar.textContent = "";
      const err = document.createElement("span");
      err.className = "wf-result-error";
      err.textContent = t("节点成功 {ok}/{n}，但写入知识库失败: {msg}", { ok: okCount, n: total, msg: e.message });
      wfResultBar.appendChild(err);
    }
    wfRunStatus.textContent = "";
    wfAbortBtn?.classList.add("hidden");
    notifyTaskComplete(t("工作流完成"), t("{ok}/{n} 节点成功", { ok: okCount, n: total }));
  } catch (e) {
    wfRunStatus.textContent = "";
    wfResultBar.textContent = "";
    wfAbortBtn?.classList.add("hidden");
    const err = document.createElement("span");
    err.className = "wf-result-error";
    err.textContent = t("工作流执行失败: {msg}", { msg: e.message });
    wfResultBar.appendChild(err);
  } finally {
    wfRunning = false;
    btnWfRun.disabled = false;
  }
}

// ── 初始化 ─────────────────────────────────

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

  // 预设选择器
  const presetSelect = document.getElementById("team-preset-select");
  if (presetSelect) {
    presetSelect.innerHTML = "";
    // 自定义选项
    const customOpt = document.createElement("option");
    customOpt.value = "custom";
    customOpt.textContent = t("自定义");
    presetSelect.appendChild(customOpt);
    // 预设选项
    for (const preset of TEAM_PRESETS) {
      const opt = document.createElement("option");
      opt.value = preset.id;
      opt.textContent = t(preset.name);
      presetSelect.appendChild(opt);
    }
    // 默认选中第一个预设
    presetSelect.value = "classic";
    presetSelect.addEventListener("change", () => {
      applyTeamPreset(presetSelect.value);
    });
  }
  loadTeamHistory();
  renderTeamHistory();
  renderTeamUsage();
  renderTeamMembers();

  btnAddMember.addEventListener("click", () => {
    teamMembers.push({
      id: `member-${Date.now()}`,
      name: t("成员{n}", { n: teamMembers.length + 1 }),
      modelId: "gpt-5.6-terra",
      persona: "你是团队成员。简洁发表观点（1-3句）。",
      role: "member",
    });
    renderTeamMembers();
  });

  btnStartDiscuss.addEventListener("click", startDiscussion);

  // 停止按钮
  btnStopDiscuss = document.getElementById("btn-stop-discuss");
  if (btnStopDiscuss) {
    btnStopDiscuss.addEventListener("click", stopDiscussion);
    btnStopDiscuss.classList.add("hidden");
  }

  // 最大辩论轮数
  const maxRoundsSelect = document.getElementById("team-max-rounds");

  if (maxRoundsSelect) {
    maxRounds = parseInt(maxRoundsSelect.value, 10) || 5;
    maxRoundsSelect.addEventListener("change", () => {
      maxRounds = parseInt(maxRoundsSelect.value, 10) || 5;
    });
  }

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

export { initTeamPanel, stopDiscussion };
