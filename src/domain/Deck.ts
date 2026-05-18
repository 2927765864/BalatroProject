import { RANKS, SUITS, type CardData, type Rank, type Suit } from "./types";

/**
 * 牌库：纯数据，无视图引用。
 *
 * 提供：标准 52 张构造、Fisher-Yates 洗牌、抽牌、回收。
 * 视图侧通过事件订阅"牌被抽走/回收"并自行播放动画。
 */
export class Deck {
  private cards: CardData[] = [];

  /** 牌堆当前牌数。 */
  get size(): number {
    return this.cards.length;
  }

  /** 重置为标准 52 张并洗牌。 */
  reset(): void {
    this.cards = [];
    for (const s of SUITS) {
      for (let i = 0; i < RANKS.length; i++) {
        const r = RANKS[i] as Rank;
        const value = i + 2; // "2"->2 ... "A"->14
        const chips = value <= 10 ? value : value === 14 ? 11 : 10;
        this.cards.push({
          id: `${s}-${r}`,
          rank: r,
          suit: s as Suit,
          value,
          chips,
        });
      }
    }
    this.shuffle();
  }

  /** Fisher-Yates 洗牌。 */
  shuffle(): void {
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.cards[i], this.cards[j]] = [
        this.cards[j] as CardData,
        this.cards[i] as CardData,
      ];
    }
  }

  /** 从堆顶抽 n 张（不足则抽光）。 */
  draw(n: number): CardData[] {
    const count = Math.min(n, this.cards.length);
    const drawn: CardData[] = [];
    for (let i = 0; i < count; i++) {
      const c = this.cards.pop();
      if (c) drawn.push(c);
    }
    return drawn;
  }

  /** 把若干张牌放入堆底（用于打出/弃牌后回收）。 */
  recycle(cards: readonly CardData[]): void {
    // unshift 即放到堆底；后续 shuffle 会再次打散。
    for (const c of cards) this.cards.unshift(c);
  }

  snapshot(): readonly CardData[] {
    return [...this.cards];
  }
}
