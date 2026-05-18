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
};
