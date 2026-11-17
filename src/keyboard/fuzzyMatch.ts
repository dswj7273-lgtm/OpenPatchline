/**
 * 轻量模糊匹配（命令面板用）：子序列匹配 + 简单打分。
 *
 * 不引入依赖；命中返回非负分数（越高越相关），未命中返回 null。
 * 打分规则：连续命中 +2/字符，词首（下划线 / 空格 / 连字符后或首字符）
 * 命中 +3，起始命中 +5，短文本优先。
 */

export interface FuzzyResult {
  score: number;
}

/** 判断 query 是否为 text 的（不区分大小写）子序列，返回得分或 null。 */
export function fuzzyMatch(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) {
      streak = 0;
      continue;
    }
    streak += 1;
    score += 2 * streak;
    if (ti === 0 || /[\s\-_/.]/.test(t[ti - 1] ?? "")) score += 3;
    qi += 1;
  }
  if (qi < q.length) return null;
  // 短文本同等命中时更相关
  score += Math.max(0, 24 - t.length);
  return score;
}

/** 对多条候选文本取最高分（标题 + 关键词联合搜索）。 */
export function fuzzyMatchAny(query: string, texts: string[]): number | null {
  let best: number | null = null;
  for (const text of texts) {
    const s = fuzzyMatch(query, text);
    if (s !== null && (best === null || s > best)) best = s;
  }
  return best;
}
