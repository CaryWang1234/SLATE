/**
 * SLATE 用量数字工具：token 格式化与趣味等价换算
 * 供聊天用量条悬浮弹窗与设置页用量统计共用
 */

// 等价物阶梯（token 数为约值）：中文按 1 字 ≈ 1 token 粗估
// base 为不带量词的名称，拼接格式统一为 "一{unit}{base}" / "{count} {unit}{base}"
const EQUIV_LADDER = [
  { tokens: 40, base: "《静夜思》", unit: "首" },
  { tokens: 150, base: "微博", unit: "条" },
  { tokens: 800, base: "中学作文", unit: "篇" },
  { tokens: 3000, base: "深度长文", unit: "篇" },
  { tokens: 23000, base: "《老人与海》", unit: "本" },
  { tokens: 150000, base: "《三体》", unit: "部" },
  { tokens: 500000, base: "《红楼梦》", unit: "部" },
];

/** token 数格式化：1234 → 1.2K，百万级 → 1.5M */
function fmtTokens(n) {
  n = Math.max(0, Math.round(n || 0));
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return n.toLocaleString();
}

/** 趣味等价换算：23000 → "约相当于一本《老人与海》"；不足返回空串由调用方兜底 */
function tokenEquivalence(n) {
  if (!n || n <= 0) return "";
  let ref = null;
  for (const item of EQUIV_LADDER) {
    if (n >= item.tokens) ref = item;
    else break;
  }
  if (!ref) return "不到一首《静夜思》";
  const ratio = n / ref.tokens;
  if (ratio < 1.5) return `约相当于一${ref.unit}${ref.base}`;
  const count = ratio >= 10 ? Math.round(ratio) : Number(ratio.toFixed(1));
  return `约相当于 ${count} ${ref.unit}${ref.base}`;
}

export { fmtTokens, tokenEquivalence };
