// ════════════════════════════════════════════════════════════════
//  /lib/graphEvolution.ts
//  图谱进化引擎 · Graph Evolution Engine
//  迷宫书店 MAZEBOOK · 状态入口系统第六层（学习与进化 · 第二部分）
//
//  读经验轨迹 → 更新边权 / 新建边 / 衰减旧边。
//  以「叠加层 Overlay」形式工作：不改既有 computeForks 图谱引擎，
//  只在其输出之上叠加学习到的增量。applyOverlay 把增量合回出边。
//
//  规则：
//    Rule 1 强化  常被连续走的 A→B（存在基础边）→ 提升边权
//    Rule 2 暗线  多次共现但无基础边的 A,B → 新建 hidden_affinity 边
//    Rule 3 衰减  每轮整体衰减；低于阈值则移除
//
//  SAFE MODE：evolve() 内部全程 try/catch，出错返回「上一版 overlay」，
//             绝不破坏图谱、绝不删除轨迹数据。
// ════════════════════════════════════════════════════════════════

import type { Edge } from "./pathGenerator";
import type { ExperienceTrace } from "./experienceTracker";

export interface CreatedEdge {
  from: string;
  to: string;
  type: "hidden_affinity";
  weight: number;
}

export interface EvoMeta {
  runs: number;
  lastRun: number;
  reinforced: string[];   // 本轮强化的 pair key
  discovered: string[];   // 本轮新建的 pair key
  decaying: string[];     // 本轮被移除/淡出的 pair key
}

/** 学习叠加层。boosts 以无向对 "a|b" 为键。 */
export interface Overlay {
  boosts: Record<string, number>;
  created: Record<string, CreatedEdge>;
  meta: EvoMeta;
}

export const EVO = {
  DECAY: 0.85,            // 每轮 boost 衰减
  BOOST_PER_HIT: 0.14,    // 每次强化的增量
  BOOST_CAP: 0.9,         // boost 上限
  MIN_BOOST: 0.05,        // 低于此则移除 boost
  HIDDEN_THRESHOLD: 2,    // 共现达到此次数才建暗线
  HIDDEN_WEIGHT: 0.45,    // 新建暗线初始权重
  EDGE_DECAY: 0.92,       // 新建边每轮衰减
  MIN_EDGE: 0.20,         // 低于此则移除新建边
  WEIGHT_CAP: 2.0,        // 合并后边权上限
};

const idNum = (id: string): number => parseInt(id, 10) || 0;
function pairKey(a: string, b: string): string {
  return idNum(a) <= idNum(b) ? a + "|" + b : b + "|" + a;
}
const clampWeight = (n: number): number => Math.max(0, Math.min(EVO.WEIGHT_CAP, n));

export function emptyOverlay(): Overlay {
  return { boosts: {}, created: {}, meta: { runs: 0, lastRun: 0, reinforced: [], discovered: [], decaying: [] } };
}

/** 判断基础图谱中 a、b 间是否已有边（无向）。由调用方提供。 */
export type HasBaseEdge = (a: string, b: string) => boolean;

/**
 * 主进化函数（纯函数 + SAFE）。给定上一版 overlay 与轨迹，产出新 overlay。
 * 出错返回 prev，绝不抛出。
 */
export function evolve(prev: Overlay, traces: ExperienceTrace[], hasBaseEdge: HasBaseEdge): Overlay {
  try {
    const next: Overlay = {
      boosts: { ...prev.boosts },
      created: { ...prev.created },
      meta: { runs: prev.meta.runs, lastRun: prev.meta.lastRun, reinforced: [], discovered: [], decaying: [] },
    };

    // 1) 先整体衰减（Rule 3 的一半：时间流逝）
    for (const k of Object.keys(next.boosts)) next.boosts[k] = next.boosts[k] * EVO.DECAY;
    for (const k of Object.keys(next.created)) {
      next.created[k] = { ...next.created[k], weight: next.created[k].weight * EVO.EDGE_DECAY };
    }

    // 2) 统计轨迹中的连续转移与共现
    const transition: Record<string, number> = {};
    const cooccur: Record<string, number> = {};
    for (const t of traces) {
      const seq = t.books_actually_viewed || [];
      for (let i = 0; i < seq.length - 1; i++) {
        const k = pairKey(seq[i], seq[i + 1]);
        transition[k] = (transition[k] || 0) + 1;
      }
      const uniq = Array.from(new Set(seq));
      for (let i = 0; i < uniq.length; i++) {
        for (let j = i + 1; j < uniq.length; j++) {
          const k = pairKey(uniq[i], uniq[j]);
          cooccur[k] = (cooccur[k] || 0) + 1;
        }
      }
    }

    // 3) Rule 1 强化：存在基础边的连续转移 → 提升 boost
    for (const k of Object.keys(transition).sort()) {
      const [a, b] = k.split("|");
      if (hasBaseEdge(a, b)) {
        next.boosts[k] = Math.min(EVO.BOOST_CAP, (next.boosts[k] || 0) + EVO.BOOST_PER_HIT * transition[k]);
        next.meta.reinforced.push(k);
      }
    }

    // 4) Rule 2 暗线：无基础边但多次共现 → 新建/强化 hidden_affinity 边
    for (const k of Object.keys(cooccur).sort()) {
      const [a, b] = k.split("|");
      if (hasBaseEdge(a, b)) continue;
      if (cooccur[k] < EVO.HIDDEN_THRESHOLD) continue;
      if (next.created[k]) {
        next.created[k] = { ...next.created[k], weight: Math.min(EVO.BOOST_CAP, next.created[k].weight + EVO.BOOST_PER_HIT) };
      } else {
        next.created[k] = { from: a, to: b, type: "hidden_affinity", weight: EVO.HIDDEN_WEIGHT };
        next.meta.discovered.push(k);
      }
    }

    // 5) Rule 3 移除：低于阈值的连接淡出
    for (const k of Object.keys(next.boosts)) {
      if (next.boosts[k] < EVO.MIN_BOOST) { delete next.boosts[k]; next.meta.decaying.push(k); }
    }
    for (const k of Object.keys(next.created)) {
      if (next.created[k].weight < EVO.MIN_EDGE) { delete next.created[k]; next.meta.decaying.push(k); }
    }

    next.meta.runs = (prev.meta.runs || 0) + 1;
    next.meta.lastRun = Date.now();
    return next;
  } catch (_e) {
    return prev; // SAFE MODE：任何异常都回退上一版，绝不破坏
  }
}

/**
 * 把 overlay 合并到某节点的基础出边上：
 *   · 对基础边按无向对加 boost
 *   · 追加与该节点相连的新建暗线边（无向 → 双向暴露）
 * 永不抛出；overlay 缺失/损坏时原样返回基础边。
 */
export function applyOverlay(baseEdges: Edge[], fromId: string, overlay: Overlay | null | undefined): Edge[] {
  try {
    if (!overlay) return baseEdges;
    const out: Edge[] = baseEdges.map((e) => {
      const boost = overlay.boosts[pairKey(e.from, e.to)] || 0;
      return boost ? { ...e, weight: clampWeight(e.weight + boost) } : e;
    });
    for (const k of Object.keys(overlay.created)) {
      const c = overlay.created[k];
      const boost = overlay.boosts[k] || 0;
      if (c.from === fromId) out.push({ from: fromId, to: c.to, type: c.type, weight: clampWeight(c.weight + boost) });
      else if (c.to === fromId) out.push({ from: fromId, to: c.from, type: c.type, weight: clampWeight(c.weight + boost) });
    }
    return out;
  } catch (_e) {
    return baseEdges;
  }
}

/** 供 UI「系统学习」面板使用的摘要。 */
export interface EvolutionSummary {
  discovered: CreatedEdge[];                                  // 新发现的连接
  strongest: Array<{ a: string; b: string; weight: number }>; // 最强转移
  decaying: string[];                                         // 正在淡出的连接
  runs: number;
}

export function summarize(overlay: Overlay, topN = 5): EvolutionSummary {
  const strongest = Object.keys(overlay.boosts)
    .map((k) => { const [a, b] = k.split("|"); return { a, b, weight: overlay.boosts[k] }; })
    .sort((x, y) => y.weight - x.weight)
    .slice(0, topN);
  return {
    discovered: Object.keys(overlay.created).map((k) => overlay.created[k]),
    strongest,
    decaying: overlay.meta.decaying.slice(0, topN),
    runs: overlay.meta.runs,
  };
}

export default evolve;
