import type { CardData, HandTypeInfo, HandTypeName } from "./types";

/**
 * 牌型识别 + 基础筹码/倍率表
 *
 * 当前规则与原型保持一致（只在选了 5 张时识别顺子/同花/同花顺/皇家同花顺）。
 * 未来加"短顺"、"五条"等只需修改 evaluate 与 HAND_TABLE。
 */
export const HAND_TABLE: Record<HandTypeName, { chips: number; mult: number }> = {
  无: { chips: 0, mult: 0 },
  高牌: { chips: 5, mult: 1 },
  对子: { chips: 10, mult: 2 },
  两对: { chips: 20, mult: 2 },
  三条: { chips: 30, mult: 3 },
  顺子: { chips: 30, mult: 4 },
  同花: { chips: 35, mult: 4 },
  葫芦: { chips: 40, mult: 4 },
  四条: { chips: 60, mult: 7 },
  同花顺: { chips: 100, mult: 8 },
  皇家同花顺: { chips: 100, mult: 8 },
};

/**
 * 给定一组（≤5 张）牌，识别牌型并返回基础筹码/倍率，以及参与计分的牌。
 * 空选择 -> name="无"。
 *
 * 参与计分的牌（scoringCards）：
 *   - 高牌：最大那一张
 *   - 对子 / 三条 / 四条：组成该组的所有同点牌
 *   - 两对：两对共 4 张
 *   - 葫芦：全部 5 张
 *   - 顺子 / 同花 / 同花顺 / 皇家同花顺：全部 5 张
 */
export function evaluateHand(cards: readonly CardData[]): HandTypeInfo {
  if (cards.length === 0) {
    return { name: "无", chips: 0, mult: 0, scoringCards: [] };
  }

  const sorted = [...cards].sort((a, b) => b.value - a.value);
  const isFlush =
    cards.length >= 5 && cards.every((c) => c.suit === sorted[0]!.suit);

  let isStraight = false;
  if (cards.length >= 5) {
    isStraight = true;
    for (let i = 1; i < 5; i++) {
      if ((sorted[i - 1]!.value - sorted[i]!.value) !== 1) {
        isStraight = false;
        break;
      }
    }
    // A-2-3-4-5 特例
    if (
      !isStraight &&
      sorted[0]!.value === 14 &&
      sorted[1]!.value === 5 &&
      sorted[2]!.value === 4 &&
      sorted[3]!.value === 3 &&
      sorted[4]!.value === 2
    ) {
      isStraight = true;
    }
  }

  const counts: Record<string, number> = {};
  for (const c of cards) counts[c.rank] = (counts[c.rank] ?? 0) + 1;
  const freqs = Object.values(counts).sort((a, b) => b - a);

  // 按出现频次取出某一组 rank 的所有牌（用于对子/三条/四条/葫芦/两对）
  const cardsOfRanksWithCount = (count: number): CardData[] => {
    const ranks = Object.keys(counts).filter((r) => counts[r] === count);
    return cards.filter((c) => ranks.includes(c.rank));
  };

  let name: HandTypeName = "高牌";
  let scoringCards: readonly CardData[] = [];

  if (isStraight && isFlush && sorted[0]!.value === 14 && sorted[1]!.value === 13) {
    name = "皇家同花顺";
    scoringCards = cards;
  } else if (isStraight && isFlush) {
    name = "同花顺";
    scoringCards = cards;
  } else if (freqs[0] === 4) {
    name = "四条";
    scoringCards = cardsOfRanksWithCount(4);
  } else if (freqs[0] === 3 && freqs[1] === 2) {
    name = "葫芦";
    scoringCards = cards;
  } else if (isFlush) {
    name = "同花";
    scoringCards = cards;
  } else if (isStraight) {
    name = "顺子";
    scoringCards = cards;
  } else if (freqs[0] === 3) {
    name = "三条";
    scoringCards = cardsOfRanksWithCount(3);
  } else if (freqs[0] === 2 && freqs[1] === 2) {
    name = "两对";
    scoringCards = cardsOfRanksWithCount(2);
  } else if (freqs[0] === 2) {
    name = "对子";
    scoringCards = cardsOfRanksWithCount(2);
  } else {
    // 高牌：取点数最大的一张
    name = "高牌";
    scoringCards = [sorted[0]!];
  }

  const base = HAND_TABLE[name];
  return { name, chips: base.chips, mult: base.mult, scoringCards };
}
