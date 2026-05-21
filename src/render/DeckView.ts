import { Container, Graphics, Sprite, type ContainerChild } from "pixi.js";
import { assets } from "@core/AssetManager";
import { CONFIG } from "@game/config";
import { UINode } from "@ui/hierarchy";
import { UIText } from "@ui/components/UIText";
import { CardSkin } from "./CardSkin";
import { getPixelOutlineTexture } from "./PixelOutlineTexture";

/**
 * 牌堆视图
 *
 * 显示一摞牌的层叠效果 + 当前牌数/总数。
 * 当前位置由 HUD 负责放置（世界坐标系）。
 *
 * 渲染策略：
 *   - CONFIG.cardArt.useSprites && AssetManager 就绪 → 使用 Enhancers 切出来的背面贴图。
 *   - 否则回退到原本的 Graphics 像素装饰画法，避免黑屏。
 *
 * 牌背是会被运行时切换的（ControlPanel 里能选行列）。所以 refresh() 会被外部调用，
 * 它把整层 children 清空再重画一遍——成本可以忽略，因为一帧只有一个 DeckView。
 */
export class DeckView extends UINode {
  private readonly cardLayer = new (class extends Container {
    override addChild<U extends ContainerChild[]>(...children: U): U[0] {
      for (const child of children) {
        if (child && "roundPixels" in child) {
          (child as any).roundPixels = false;
        }
      }
      return super.addChild(...children);
    }
  })();
  private readonly countText: UIText;
  private readonly totalCount: number;

  constructor(totalCount = 52) {
    super({ id: "hud.deckView", displayName: "牌堆" });
    this.totalCount = totalCount;

    this.addChild(this.cardLayer);
    this.drawStack();

    this.countText = new UIText({
      id: "hud.deckView.countText",
      displayName: "牌堆数量文字",
      text: `${totalCount}/${totalCount}`,
      style: {
        fontFamily: CardSkin.fontFamily,
        fontSize: 16,
        fill: 0xffffff,
        fontWeight: "900",
      },
    });
    this.countText.setAnchor(0.5, 0);
    this.countText.position.set(CardSkin.width / 2, CardSkin.height + 8);
    this.addChild(this.countText);
  }

  /** 牌数变化时由 GameController 调用。 */
  setCount(current: number): void {
    this.countText.setText(`${current}/${this.totalCount}`);
  }

  /** 外部切换牌背后调用：清掉旧层重画一摞。 */
  refresh(): void {
    this.cardLayer.removeChildren().forEach((c) => c.destroy());
    this.drawStack();
  }

  // ---- 内部 ----

  private drawStack(): void {
    const useSprite = CONFIG.cardArt.useSprites && assets.isReady;
    if (useSprite) {
      this.drawSpriteStack();
    } else {
      this.drawProceduralStack();
    }
  }

  private drawSpriteStack(): void {
    const cw = CardSkin.width;
    const ch = CardSkin.height;
    const cornerRadius = CONFIG.cardArt.cornerRadius;
    const { row, col } = CONFIG.cardArt.back;
    const tex = assets.getBack(row, col);
    if (!tex) {
      this.drawProceduralStack();
      return;
    }

    // 底部叠层（程序化阴影），让"一摞牌"的层次感不靠多次绘制 sprite 完成。
    const g = new Graphics();
    for (let i = 4; i >= 1; i -= 1) {
      g.roundRect(-i * 1.5, -i * 1.5, cw, ch, cornerRadius);
      g.fill({ color: 0xdddddd });
      g.stroke({ width: 1, color: 0x888888 });
    }
    this.cardLayer.addChild(g);

    // 顶面：让白底/贴图/描边三者外缘对齐，与 CardView 精灵分支保持一致
    const pad = 2;
    const innerW = cw - pad * 2;
    const innerH = ch - pad * 2;
    const innerRadius = Math.max(0, cornerRadius);

    const topCardContainer = new Container();
    this.cardLayer.addChild(topCardContainer);

    const bgTop = new Graphics();
    bgTop.roundRect(pad, pad, innerW, innerH, innerRadius);
    bgTop.fill({ color: CONFIG.cardArt.faceColor });
    topCardContainer.addChild(bgTop);

    const sprite = new Sprite(tex);
    sprite.position.set(pad, pad);
    sprite.width = innerW;
    sprite.height = innerH;
    topCardContainer.addChild(sprite);

    // 顶面像素画 1 像素描边（与 CardView 保持一致）
    const scaleX = innerW / tex.width;
    const scaleY = innerH / tex.height;
    const sourceRadius = innerRadius / ((scaleX + scaleY) / 2);
    const outline = new Sprite(getPixelOutlineTexture(tex.width, tex.height, sourceRadius, CONFIG.cardArt.outlineColor));
    outline.position.set(pad, pad);
    outline.width = innerW;
    outline.height = innerH;
    topCardContainer.addChild(outline);

    // 应用抗锯齿遮罩，消除边缘产生的锯齿
    const cardMask = new Graphics();
    cardMask.roundRect(pad, pad, innerW, innerH, innerRadius);
    cardMask.fill({ color: 0xffffff });
    cardMask.roundPixels = false;
    topCardContainer.addChild(cardMask);
    topCardContainer.mask = cardMask;
  }

  private drawProceduralStack(): void {
    const cw = CardSkin.width;
    const ch = CardSkin.height;
    const cornerRadius = CONFIG.cardArt.cornerRadius;

    const g = new Graphics();

    for (let i = 4; i >= 1; i -= 1) {
      g.roundRect(-i * 1.5, -i * 1.5, cw, ch, cornerRadius);
      g.fill({ color: 0xdddddd });
      g.stroke({ width: 1, color: 0x888888 });
    }

    g.roundRect(0, 0, cw, ch, cornerRadius);
    g.fill({ color: 0xffffff });

    const innerMargin = 4;
    g.roundRect(innerMargin, innerMargin, cw - innerMargin * 2, ch - innerMargin * 2, Math.max(0, cornerRadius - 2));
    g.fill({ color: 0x1f75e0 });

    const patternMargin = innerMargin + 4;
    const pw = cw - patternMargin * 2;
    const ph = ch - patternMargin * 2;

    g.rect(patternMargin, patternMargin, pw, ph);
    g.stroke({ width: 1, color: 0xffffff });

    for (let x = patternMargin + 4; x < cw - patternMargin - 4; x += 6) {
      g.rect(x, patternMargin + 4, 2, 2);
      g.rect(x, ch - patternMargin - 6, 2, 2);
    }
    for (let y = patternMargin + 4; y < ch - patternMargin - 4; y += 6) {
      g.rect(patternMargin + 4, y, 2, 2);
      g.rect(cw - patternMargin - 6, y, 2, 2);
    }
    g.fill({ color: 0xffffff });

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

    this.cardLayer.addChild(g);
  }
}
