import { Container, Graphics, Text } from "pixi.js";
import type { CardData } from "@domain/types";
import { CardSkin } from "./CardSkin";

/**
 * 卡牌视图
 *
 * 一个 CardView 持有一份 CardData（只读），负责把它画出来并响应交互。
 * 视图的可变状态只剩"是否选中"和"目标位姿"，由外部 controller 设置。
 *
 * 与原型相比的差异：
 *   - 位姿的平滑插值不再在内部 ticker 里手写，而是由外部 TweenManager 统一驱动。
 *     CardView 只提供 x/y/rotation 字段供 tween 写入。
 *   - 不再持有 `targetX/targetY/targetRotation`，让 view 更像纯展示对象。
 *   - hover / click 通过 EventEmitter 风格的回调向上抛出，不与 GameState 直接耦合。
 */
export interface CardViewCallbacks {
  onClick: (view: CardView) => void;
  onHoverIn: (view: CardView) => void;
  onHoverOut: (view: CardView) => void;
}

export class CardView extends Container {
  selected = false;

  constructor(
    readonly data: CardData,
    private readonly callbacks: CardViewCallbacks
  ) {
    super();
    this.draw();
    this.bindEvents();
  }

  private draw(): void {
    const { width, height, cornerRadius, borderColor, borderWidth, faceColor } =
      CardSkin;

    const bg = new Graphics();
    bg.roundRect(0, 0, width, height, cornerRadius);
    bg.fill({ color: faceColor });
    bg.stroke({ width: borderWidth, color: borderColor });
    this.addChild(bg);

    const isRed = this.data.suit === "♥" || this.data.suit === "♦";
    const color = isRed ? CardSkin.redColor : CardSkin.blackColor;

    const topLeft = new Text({
      text: `${this.data.rank}\n${this.data.suit}`,
      style: {
        fontFamily: CardSkin.fontFamily,
        fontSize: CardSkin.cornerFontSize,
        fill: color,
        fontWeight: "bold",
        align: "center",
      },
    });
    topLeft.position.set(10, 5);
    this.addChild(topLeft);

    const bottomRight = new Text({
      text: `${this.data.rank}\n${this.data.suit}`,
      style: {
        fontFamily: CardSkin.fontFamily,
        fontSize: CardSkin.cornerFontSize,
        fill: color,
        fontWeight: "bold",
        align: "center",
      },
    });
    bottomRight.anchor.set(1, 1);
    bottomRight.position.set(width - 10, height - 5);
    bottomRight.rotation = Math.PI;
    this.addChild(bottomRight);

    const center = new Text({
      text: this.data.suit,
      style: {
        fontFamily: CardSkin.fontFamily,
        fontSize: CardSkin.centerFontSize,
        fill: color,
      },
    });
    center.anchor.set(0.5);
    center.position.set(width / 2, height / 2);
    this.addChild(center);

    // 把 pivot 放到几何中心，让旋转/缩放围绕中心展开。
    this.pivot.set(width / 2, height / 2);
  }

  private bindEvents(): void {
    this.eventMode = "static";
    this.cursor = "pointer";
    this.on("pointerdown", () => this.callbacks.onClick(this));
    this.on("pointerover", () => this.callbacks.onHoverIn(this));
    this.on("pointerout", () => this.callbacks.onHoverOut(this));
  }
}
