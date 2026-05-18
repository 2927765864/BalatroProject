/**
 * 卡牌与牌型的纯数据类型
 *
 * 这一层禁止 import 任何 PIXI / DOM 内容，让逻辑可单测、可在 Worker 跑。
 */

export type Suit = "♠" | "♥" | "♣" | "♦";

export type Rank =
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "10"
  | "J"
  | "Q"
  | "K"
  | "A";

export const SUITS: readonly Suit[] = ["♠", "♥", "♣", "♦"];
export const RANKS: readonly Rank[] = [
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
  "A",
];

/** 卡牌身份的稳定 ID，便于 View ↔ Data 映射。 */
export type CardId = string;

/** 卡牌的"纯数据"。视图层 CardView 拿到 CardData 后再画出来。 */
export interface CardData {
  readonly id: CardId;
  readonly rank: Rank;
  readonly suit: Suit;
  /** 用于比较大小的数值：2..10 -> 2..10，J=11, Q=12, K=13, A=14。 */
  readonly value: number;
  /** 该牌打出时携带的基础筹码（2-10 即数值，J/Q/K=10，A=11）。 */
  readonly chips: number;
}

export type HandTypeName =
  | "高牌"
  | "一对"
  | "两对"
  | "三条"
  | "顺子"
  | "同花"
  | "葫芦"
  | "四条"
  | "同花顺"
  | "皇家同花顺"
  | "无";

export interface HandTypeInfo {
  name: HandTypeName;
  chips: number;
  mult: number;
}

export interface ScoreResult {
  handType: HandTypeName;
  baseChips: number; // 牌型基础筹码
  cardChips: number; // 参与牌自身筹码之和
  totalChips: number; // baseChips + cardChips
  mult: number;
  score: number; // totalChips * mult
}
