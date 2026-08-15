/**
 * SLATE 工作流引擎：DAG 拓扑执行、节点状态机、产物入�?
 * - 依赖后端 /workflows 读取定义�?proxy/chat 调用模型�?skills/execute 复用技能链�?
 * - 执行完成后通过 /knowledge/docs 复用现有知识库写入逻辑
 */

import { get, post } from "./api.js?v=20260815-51";
import { state, getModelKey } from "../store.js?v=20260815-51";
import { guardSkillParams } from "./riskguard.js?v=20260815-51";
import { t } from "./i18n.js?v=20260815-51";

const STATUS = { WAITING: "waiting", RUNNING: "running", SUCCESS: "success", FAILED: "failed", SKIPPED: "skipped" };

// ── 定义读取 ────────────────────────────────

async function loadWorkflows() {
  const res = await get("/workflows");
  if (res.code !== 0) throw new Error(res.message || "工作流列表加载失�?);
  return res.data || [];
}

async function getWorkflow(id) {
  const res = await get(`/workflows/${encodeURIComponent(id)}`);
  if (res.code !== 0) throw new Error(res.message || "工作流加载失�?);
  return res.data;
}

// ── DAG 工具 ────────────────────────────────

/** 合并显式 edges �?inputs 隐式引用�?node_id），构建前置依赖�?*/
function buildDeps(wf) {
  const ids = new Set((wf.nodes || []).map(n => n.id));
  const preds = new Map([...ids].map(id => [id, new Set()]));
  const addEdge = (from, to) => {
    if (!ids.has(from) || !ids.has(to) || from === to) return;
    preds.get(to).add(from);
  };
  for (const e of wf.edges || []) addEdge(e.from, e.to);
  for (const n of wf.nodes || []) {
    for (const v of Object.values(n.inputs || {})) {
      if (typeof v === "string" && v.startsWith("$") && v !== "$input" && ids.has(v.slice(1))) {
        addEdge(v.slice(1), n.id);
      }
    }
  }
  return preds;
}

/** Kahn 拓扑排序；有环时返回 error */
function topoSort(wf) {
  const preds = buildDeps(wf);
  const indeg = new Map([...preds].map(([id, s]) => [id, s.size]));
  const queue = [...indeg].filter(([, d]) => d === 0).map(([id]) => id);
  const order = [];
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const [other, s] of preds) {
      if (s.has(id)) {
        indeg.set(other, indeg.get(other) - 1);
        if (indeg.get(other) === 0) queue.push(other);
      }
    }
  }
  if (order.length < preds.size) {
    const cyclic = [...preds.keys()].filter(id => !order.includes(id));
    return { order: [], error: t("DAG 存在环，涉及节点: {nodes}", { nodes: cyclic.join(", ") }) };
  }
  return { order, error: null };
}

// ── 变量解析 ────────────────────────────────

/** $input �?用户输入�?node_id �?上游节点输出；其余视为字面量 */
function resolveVar(value, userInput, outputs) {
  if (typeof value !== "string") return value == null ? "" : String(value);
  if (value === "$input") return userInput;
  if (value.startsWith("$")) {
    const refId = value.slice(1);
    if (refId in outputs) return outputs[refId];
  }
  return value;
}

function resolveInputs(node, userInput, outputs) {
  const vars = {};
  for (const [key, value] of Object.entries(node.inputs || {})) {
    vars[key] = resolveVar(value, userInput, outputs);
  }
  return vars;
}

function fillTemplate(tpl, vars) {
  return String(tpl || "").replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g, (match, key) =>
    key in vars ? String(vars[key]) : match
  );
}

function truncate(text, max = 300) {
  const s = String(text || "");
  return s.length > max ? s.slice(0, max) + "�? : s;
}

// ── 节点绑定解析 ────────────────────────────

function findModelName(modelId) {
  if (!modelId) return "";
  for (const models of Object.values(state.modelRegistry || {})) {
    const found = models.find(m => m.id === modelId);
    if (found) return found.name;
  }
  const custom = (state.customModels || []).find(m => m.id === modelId);
  return custom?.name || modelId;
}

/** 优先级：role 绑定团队成员（沿用其模型与人设） > node.model > 当前模型 */
function resolveBinding(node, members) {
  let member = null;
  if (node.role) {
    member = (members || []).find(m => m.role === node.role || m.name === node.role) || null;
  }
  const modelId = member?.modelId || node.model || state.currentModelId || "";
  return { member, modelId, modelLabel: findModelName(modelId), persona: member?.persona || "" };
}

// ── 执行引擎 ────────────────────────────────

function makeRunId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * �?DAG 拓扑顺序执行工作流�?
 * hooks: { onNode(record), onDone(result) }
 * record: { id, name, status, skill, outputKey, modelLabel, inputPreview, output, error, startedAt, finishedAt }
 */
async function runWorkflow(wf, userInput, members, hooks = {}) {
  const { order, error } = topoSort(wf);
  if (error) throw new Error(error);

  const nodeMap = new Map((wf.nodes || []).map(n => [n.id, n]));
  const preds = buildDeps(wf);
  const records = {};
  const outputs = {};
  for (const n of wf.nodes || []) {
    records[n.id] = {
      id: n.id, name: n.name, status: STATUS.WAITING,
      skill: n.skill || "", outputKey: n.output_key || n.id,
      modelLabel: "", inputPreview: "", output: "", error: "",
      startedAt: 0, finishedAt: 0,
    };
  }

  const result = {
    runId: makeRunId(), workflowId: wf.id, workflowName: wf.name,
    startedAt: Date.now(), finishedAt: 0, order, records, outputs,
  };

  for (const nodeId of order) {
    const node = nodeMap.get(nodeId);
    const rec = records[nodeId];

    // 上游存在失败/跳过 �?本节点跳过（明确错误信息�?
    const blockedBy = [...preds.get(nodeId)].filter(pid =>
      records[pid].status === STATUS.FAILED || records[pid].status === STATUS.SKIPPED
    );
    if (blockedBy.length > 0) {
      rec.status = STATUS.SKIPPED;
      rec.error = t("上游节点未成功（{names}），自动跳过", { names: blockedBy.map(id => records[id].name).join("�?) });
      hooks.onNode?.(rec);
      continue;
    }

    rec.status = STATUS.RUNNING;
    rec.startedAt = Date.now();
    hooks.onNode?.(rec);

    try {
      const vars = resolveInputs(node, userInput, outputs);
      rec.inputPreview = Object.entries(node.inputs || {})
        .map(([key, raw]) => `{{${key}}} �?${raw}�?{truncate(vars[key], 120)}`)
        .join("\n");

      let output;
      if (node.skill) {
        // 技能节点：复用现有 /skills/execute 链路，inputs 作为工具参数
        rec.modelLabel = `�?${node.skill}`;
        const params = {};
        for (const [key, raw] of Object.entries(node.inputs || {})) params[key] = vars[key] ?? raw;
        // 高危命令审批：命中写死规则时弹框请求批准
        if (!(await guardSkillParams(node.skill, params))) {
          throw new Error(t("高危命令被用户拒绝执�? {cmd}", { cmd: params.command || node.skill }));
        }
        const res = await post("/skills/execute", { skill: node.skill, params });
        if (res.code !== 0) throw new Error(res.message || t("技�?{name} 执行失败", { name: node.skill }));
        output = typeof res.data === "string" ? res.data : JSON.stringify(res.data, null, 2);
      } else {
        // LLM 节点：role/model 绑定解析 + API Key 校验
        const binding = resolveBinding(node, members);
        rec.modelLabel = binding.modelLabel || binding.modelId;
        if (!binding.modelId) throw new Error(t("节点未绑定可用模型（role/model 均为空且无当前模型）"));
        const apiKey = getModelKey(binding.modelId);
        if (!apiKey) throw new Error(t("模型 {name} 未配�?API Key，请先在设置页配�?, { name: rec.modelLabel }));

        const systemPrompt = binding.persona || "你是 SLATE 工作流的执行成员：认真完成分配的任务，紧扣任务要求作答，只输出结果本身，不要寒暄与前言�?;
        const userPrompt = fillTemplate(node.prompt || "", vars);
        const res = await post("/proxy/chat", {
          model: binding.modelId,
          api_key: apiKey,
          stream: false,
          temperature: node.temperature ?? 0.5,
          max_tokens: node.max_tokens || 1200,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        });
        if (res.code !== 0) throw new Error(res.message || "模型请求失败");
        output = res.data?.choices?.[0]?.message?.content ?? "";
        if (!String(output).trim()) throw new Error("模型返回内容为空");
      }

      rec.status = STATUS.SUCCESS;
      rec.output = String(output);
      rec.finishedAt = Date.now();
      outputs[nodeId] = rec.output;
    } catch (e) {
      rec.status = STATUS.FAILED;
      rec.error = e.message || String(e);
      rec.finishedAt = Date.now();
    }
    hooks.onNode?.(rec);
  }

  result.finishedAt = Date.now();
  hooks.onDone?.(result);
  return result;
}

// ── 产物写入 knowledge（复用现�?/knowledge/docs 链路�?──

async function saveRunToKnowledge(wf, result) {
  const icons = { success: "�?, failed: "�?, skipped: "�?, waiting: "�?, running: "�? };
  const recs = result.order.map(id => result.records[id]);
  const okCount = recs.filter(r => r.status === STATUS.SUCCESS).length;
  const finalNodeId = [...result.order].reverse().find(id => result.records[id].status === STATUS.SUCCESS);
  const finalOutput = finalNodeId ? result.records[finalNodeId].output : "（无成功节点产出�?;

  let content = `# 工作流产�?· ${wf.name}\n\n`;
  content += `- 工作�?ID: \`${wf.id}\`\n`;
  content += `- 运行 ID: \`${result.runId}\`\n`;
  content += `- 运行时间: ${new Date(result.startedAt).toLocaleString()}\n`;
  content += `- 节点结果: ${okCount}/${recs.length} 成功\n\n`;
  content += `## 节点摘要\n\n`;
  for (const r of recs) {
    content += `### ${icons[r.status] || ""} ${r.name}�?{r.outputKey}）\n`;
    content += `绑定: ${r.modelLabel || "�?} · 状�? ${r.status}\n\n`;
    if (r.error) content += `> 错误: ${r.error}\n\n`;
    if (r.output) content += truncate(r.output, 800) + "\n\n";
  }
  content += `## 最终结果\n\n${finalOutput}\n`;

  const res = await post("/knowledge/docs", {
    title: `工作流产�?· ${wf.name}`,
    source: "workflow",
    kind: "workflow",
    content,
    metadata: {
      workflow_id: wf.id,
      run_id: result.runId,
      workflow_name: wf.name,
      node_count: recs.length,
      success_count: okCount,
      started_at: result.startedAt,
      finished_at: result.finishedAt,
    },
  });
  if (res.code !== 0) throw new Error(res.message || t("写入知识库失�?));
  return res.data?.id;
}

export { STATUS, loadWorkflows, getWorkflow, topoSort, runWorkflow, saveRunToKnowledge };
