import { Container, Graphics, Text } from "pixi.js";

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

    const g = new Graphics();
    g.roundRect(-4, -4, 80, 120, 6);
    g.stroke({ width: 1, color: 0xaaaaaa });
    g.roundRect(0, 0, 80, 120, 6);
    g.fill({ color: 0x1166cc });
    g.stroke({ width: 3, color: 0xffffff });
    this.addChild(g);

    const pattern = new Text({
      text: "❉",
      style: { fontSize: 40, fill: 0xffffff, align: "center" },
    });
    pattern.anchor.set(0.5);
    pattern.position.set(40, 60);
    this.addChild(pattern);

    this.countText = new Text({
      text: `${totalCount}/${totalCount}`,
      style: {
        fontFamily: "Arial",
        fontSize: 16,
        fill: 0xffffff,
        fontWeight: "bold",
      },
    });
    this.countText.anchor.set(0.5, 0);
    this.countText.position.set(40, 125);
    this.addChild(this.countText);
  }

  setCount(current: number): void {
    this.countText.text = `${current}/${this.totalCount}`;
  }
}
