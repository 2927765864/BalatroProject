import type { CardData, ScoreResult } from "./types";
import { evaluateHand } from "./HandEvaluator";

/**
 * 计分管线
 *
 * 当前实现：base + 参与计分的牌（scoringCards）自身 chips，再乘 mult。
 * 未参与构成牌型的"打酱油"牌（如三条里的两张杂牌）不计入 chips。
 *
 * 未来插入点（保留接口形态以便后续扩展）：
 *   - beforeEvaluate(cards)         // 小丑牌可加倍/修改牌型
 *   - duringPerCard(card, acc)      // 每张牌单独触发效果（如玻璃牌+50 chips）
 *   - afterEvaluate(result)         // 最终倍率/筹码加成（如+X mult 小丑）
 *
 * 这些钩子留到"卡牌逻辑专项"轮子动手时再补，本次保持行为与原型一致。
 */
export function calculateScore(cards: readonly CardData[]): ScoreResult {
  const info = evaluateHand(cards);
  const cardChips = info.scoringCards.reduce((s, c) => s + c.chips, 0);
  const totalChips = info.chips + cardChips;
  return {
    handType: info.name,
    baseChips: info.chips,
    cardChips,
    totalChips,
    mult: info.mult,
    score: totalChips * info.mult,
  };
}
