import { Container, Graphics, Text } from "pixi.js";
import { CardSkin } from "./CardSkin";

/**
 * 牌堆视图
 *
 * 显示一摞牌的层叠效果 + 当前牌数/总数。
 * 当前位置由 HUD 负责放置（世界坐标系）。
 */
export class DeckView extends Container {
  private readonly countText: Text;
  private readonly totalCount: number;

  constructor(totalCount = 52) {
    super();
    this.totalCount = totalCount;
    
    const cw = CardSkin.width;
    const ch = CardSkin.height;

    // Draw stacked cards effect
    const g = new Graphics();
    
    // Draw bottom cards to simulate depth
    for (let i = 4; i >= 1; i--) {
        g.roundRect(-i * 1.5, -i * 1.5, cw, ch, CardSkin.cornerRadius);
        g.fill({ color: 0xdddddd });
        g.stroke({ width: 1, color: 0x888888 });
    }

    // Top card back
    g.roundRect(0, 0, cw, ch, CardSkin.cornerRadius);
    g.fill({ color: 0xffffff }); // white border for the back
    g.stroke({ width: CardSkin.borderWidth, color: CardSkin.borderColor });
    
    // Blue interior
    const innerMargin = 4;
    g.roundRect(innerMargin, innerMargin, cw - innerMargin * 2, ch - innerMargin * 2, CardSkin.cornerRadius - 2);
    g.fill({ color: 0x1f75e0 }); // Vibrant blue

    // Draw some pixel-like patterns on the back
    const patternMargin = innerMargin + 4;
    const pw = cw - patternMargin * 2;
    const ph = ch - patternMargin * 2;
    
    // Inner white border
    g.rect(patternMargin, patternMargin, pw, ph);
    g.stroke({ width: 1, color: 0xffffff });
    
    // Outer dashed/dotted effect
    for (let x = patternMargin + 4; x < cw - patternMargin - 4; x += 6) {
        g.rect(x, patternMargin + 4, 2, 2);
        g.rect(x, ch - patternMargin - 6, 2, 2);
    }
    for (let y = patternMargin + 4; y < ch - patternMargin - 4; y += 6) {
        g.rect(patternMargin + 4, y, 2, 2);
        g.rect(cw - patternMargin - 6, y, 2, 2);
    }
    g.fill({ color: 0xffffff });
    
    // Center decorative patterns (like an intricate eye or circle motif)
    const cx = cw / 2;
    const cy = ch / 2;
    g.circle(cx, cy - 20, 12);
    g.stroke({ width: 2, color: 0xffffff });
    g.circle(cx, cy + 20, 12);
    g.stroke({ width: 2, color: 0xffffff });
    
    g.circle(cx, cy, 8);
    g.stroke({ width: 2, color: 0xffffff });
    
    g.rect(cx - 2, cy - 2, 4, 4);
    g.rect(cx - 2, cy - 24, 4, 4);
    g.rect(cx - 2, cy + 20, 4, 4);
    g.fill({ color: 0xffffff });

    this.addChild(g);

    this.countText = new Text({
      text: `${totalCount}/${totalCount}`,
      style: {
        fontFamily: CardSkin.fontFamily,
        fontSize: 16,
        fill: 0xffffff,
        fontWeight: "900",
      },
    });
    this.countText.anchor.set(0.5, 0);
    this.countText.position.set(cw / 2, ch + 8);
    this.addChild(this.countText);
  }

  setCount(current: number): void {
    this.countText.text = `${current}/${this.totalCount}`;
  }
}
