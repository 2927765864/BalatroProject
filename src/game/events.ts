import type { CardData, ScoreResult } from "@domain/types";
import type { CardView } from "@render/CardView";

/**
 * 全局事件契约（事件总线的类型骨架）
 *
 * 新增事件 = 在这里加一条；EventBus 会自动推导出 payload 类型。
 *
 * 注意：必须使用 `type` 而非 `interface`，否则 TS 不会把它视为
 * 满足 `Record<string, unknown>` 的索引签名（interface 是"具名类型"，
 * 不会被自动展开为带索引签名的对象类型）。
 */
export type GameEvents = {
  "card:click": { view: CardView };
  "card:selectionChanged": { selected: readonly CardView[] };
  "hand:layoutRequest": void;

  "round:play": { cards: readonly CardData[]; result: ScoreResult };
  "round:discard": { cards: readonly CardData[] };
  "round:scoreChanged": { totalScore: number };

  "deck:changed": { size: number };

  // ── 出牌流程（PlayPipeline）的 5 阶段事件 ────────────────────────
  // 这些事件让未来的视效/音效/分析模块"挂载"在流程节点上，无需改 PlayPipeline。
  //
  // 流程：play:start
  //   → 阶段 1+2：play:cardEjected（每张牌出发）× N → play:pileFormed（全部落定）
  //   → 阶段 3：play:lifted
  //   → 阶段 4：play:settled（此时 totalScore 已经更新）
  //   → 阶段 5：play:discarded
  //   → play:end
  "play:start": { cards: readonly CardData[]; result: ScoreResult };
  "play:cardEjected": { view: CardView; index: number; total: number };
  "play:pileFormed": { views: readonly CardView[] };
  "play:lifted": { views: readonly CardView[] };
  "play:settled": { result: ScoreResult; totalScore: number };
  "play:cardSettleTextTriggered": { card: CardView; chips: number };
  "play:discarded": { cards: readonly CardData[] };
  "play:end": { result: ScoreResult; totalScore: number };
};
