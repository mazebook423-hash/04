// ════════════════════════════════════════════════════════════════
//  /app/api/graph-evolve/route.ts
//  后台图谱进化端点 · Background graph-evolution route (App Router)
//  迷宫书店 MAZEBOOK · 状态入口系统第六层（学习与进化 · 第三部分）
//
//  异步处理读者轨迹 → 进化 overlay → 持久化（graph.json / DB）。
//  不阻塞 UI：前端 fire-and-forget 调用；返回即可，不必等待渲染。
//
//  SAFE MODE（TASK 6）：任何失败都返回上一版 overlay（HTTP 200），
//  绝不破坏图谱、绝不删除轨迹数据。
//
//  说明：本仓库的线上形态是单文件应用，无服务端，进化在客户端同构执行
//        （见 index.html 内 STEP 5 注入层中的 window.graphEvolve.run）。
//        此路由是可部署到 Next.js 时的等价实现，复用同一套纯函数。
// ════════════════════════════════════════════════════════════════

import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

import { evolve, emptyOverlay, summarize } from "@/lib/graphEvolution";
import type { Overlay } from "@/lib/graphEvolution";
import type { ExperienceTrace } from "@/lib/experienceTracker";

const OVERLAY_PATH = path.join(process.cwd(), "data", "graph-overlay.json");
const BACKUP_PATH = path.join(process.cwd(), "data", "graph-overlay.backup.json");

interface EvolveRequest {
  traces: ExperienceTrace[];
  /** 基础图谱邻接：id → 直接相连的 id 列表（用于 hasBaseEdge 判定）。 */
  baseAdjacency: Record<string, string[]>;
}

async function readOverlay(): Promise<Overlay> {
  try {
    const raw = await fs.readFile(OVERLAY_PATH, "utf8");
    return JSON.parse(raw) as Overlay;
  } catch (_e) {
    return emptyOverlay();
  }
}

async function writeOverlaySafely(next: Overlay, prev: Overlay): Promise<void> {
  // 先备份上一版（SAFE），再写新版；任一步失败都不抛出。
  try {
    await fs.mkdir(path.dirname(OVERLAY_PATH), { recursive: true });
    try { await fs.writeFile(BACKUP_PATH, JSON.stringify(prev), "utf8"); } catch (_e) { /* 备份失败不致命 */ }
    await fs.writeFile(OVERLAY_PATH, JSON.stringify(next), "utf8");
  } catch (_e) {
    // 写入失败：保持磁盘上的旧 overlay 不变，绝不删除
  }
}

export async function POST(req: Request): Promise<Response> {
  const prev = await readOverlay();
  try {
    const body = (await req.json()) as Partial<EvolveRequest>;
    const traces = Array.isArray(body.traces) ? body.traces : [];
    const adj = body.baseAdjacency || {};
    const hasBaseEdge = (a: string, b: string): boolean =>
      (adj[a]?.includes(b) ?? false) || (adj[b]?.includes(a) ?? false);

    const next = evolve(prev, traces, hasBaseEdge);   // evolve 自身 SAFE，出错返回 prev
    await writeOverlaySafely(next, prev);
    return NextResponse.json({ ok: true, overlay: next, summary: summarize(next) });
  } catch (_e) {
    // 顶层 SAFE：回退上一版，系统不崩
    return NextResponse.json({ ok: false, overlay: prev, summary: summarize(prev) }, { status: 200 });
  }
}

export async function GET(): Promise<Response> {
  const overlay = await readOverlay();
  return NextResponse.json({ ok: true, overlay, summary: summarize(overlay) });
}
