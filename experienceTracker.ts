// ════════════════════════════════════════════════════════════════
//  /lib/experienceTracker.ts
//  经验轨迹系统 · Experience Trace System
//  迷宫书店 MAZEBOOK · 状态入口系统第六层（学习与进化 · 第一部分）
//
//  记录读者的真实阅读行为，作为图谱进化的输入。
//  全程容错：任何存储错误都不抛出，退化为内存模式（SAFE）。
// ════════════════════════════════════════════════════════════════

import type { UserState } from "./pathGenerator";

/** 单条经验轨迹（TASK 1 指定结构）。 */
export interface ExperienceTrace {
  userState_before: UserState;
  generatedPath: string[];                      // 展示路径的书 id（按顺序）
  books_actually_viewed: string[];              // 实际点开的书 id（按顺序）
  time_spent_per_book: Record<string, number>;  // 每本停留毫秒
  exit_state: UserState | null;                 // 离开时的状态快照
  ts: number;                                   // 记录时间戳
}

/** 存储适配器：线上用 localStorage，服务端可换 DB/文件。 */
export interface TraceStorage {
  load(): ExperienceTrace[];
  save(traces: ExperienceTrace[]): void;
}

/** 默认内存存储（无副作用，永不抛出）。 */
export class MemoryTraceStorage implements TraceStorage {
  private data: ExperienceTrace[] = [];
  load(): ExperienceTrace[] { return this.data.slice(); }
  save(traces: ExperienceTrace[]): void { this.data = traces.slice(); }
}

interface OpenView { id: string; start: number; }

const MAX_TRACES = 200;          // 仅保留近期轨迹，避免无限增长
const INTERACTION_TRIGGER = 4;   // 每 3–5 次交互触发一次进化（取 4）

/**
 * 经验记录器。线上以 localStorage 持久化；任何错误退化为内存模式。
 */
export class ExperienceTracker {
  private storage: TraceStorage;
  private pending: ExperienceTrace | null = null;
  private openView: OpenView | null = null;
  private now: () => number;
  interactions = 0;

  constructor(storage?: TraceStorage, now: () => number = () => Date.now()) {
    this.storage = storage ?? new MemoryTraceStorage();
    this.now = now;
  }

  /** 一次新路径生成：开启一条待记录轨迹。 */
  beginPath(state: UserState, generatedPath: string[]): void {
    this.finalizeOpenView();
    this.pending = {
      userState_before: { ...state },
      generatedPath: generatedPath.slice(),
      books_actually_viewed: [],
      time_spent_per_book: {},
      exit_state: null,
      ts: this.now(),
    };
  }

  /** 展示路径变化（异步精修后）时更新。 */
  updateGeneratedPath(ids: string[]): void {
    if (this.pending) this.pending.generatedPath = ids.slice();
  }

  /** 读者点开一本书。 */
  recordView(id: string): void {
    this.finalizeOpenView();
    const sid = String(id);
    this.openView = { id: sid, start: this.now() };
    if (this.pending && this.pending.books_actually_viewed.indexOf(sid) < 0) {
      this.pending.books_actually_viewed.push(sid);
    }
    this.interactions++;
  }

  /** 结算当前打开书目的停留时长。 */
  finalizeOpenView(): void {
    if (!this.openView) return;
    const dt = Math.max(0, this.now() - this.openView.start);
    if (this.pending) {
      const id = this.openView.id;
      this.pending.time_spent_per_book[id] = (this.pending.time_spent_per_book[id] || 0) + dt;
    }
    this.openView = null;
  }

  /** 读者完成 / 离开：定稿并落盘一条轨迹（无效则跳过）。 */
  recordTrace(exitState: UserState | null): ExperienceTrace | null {
    this.finalizeOpenView();
    const p = this.pending;
    if (!p || p.generatedPath.length < 1 || p.books_actually_viewed.length < 1) return null;
    p.exit_state = exitState ? { ...exitState } : null;
    p.ts = this.now();
    const traces = this.getTraces();
    traces.push(p);
    while (traces.length > MAX_TRACES) traces.shift();
    this.safeSave(traces);
    // 重置已观察序列，避免同一路径重复记录相同前缀
    this.pending = {
      userState_before: p.userState_before,
      generatedPath: p.generatedPath,
      books_actually_viewed: [],
      time_spent_per_book: {},
      exit_state: null,
      ts: this.now(),
    };
    return p;
  }

  /** 是否到达「3–5 次交互」触发点。 */
  shouldEvolveByInteractions(): boolean {
    return this.interactions > 0 && this.interactions % INTERACTION_TRIGGER === 0;
  }

  getTraces(): ExperienceTrace[] {
    try { return this.storage.load() || []; } catch (_e) { return []; }
  }

  private safeSave(traces: ExperienceTrace[]): void {
    try { this.storage.save(traces); } catch (_e) { /* SAFE：忽略存储错误 */ }
  }
}

export default ExperienceTracker;
