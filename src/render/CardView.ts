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

    let color: number = CardSkin.spadesColor;
    if (this.data.suit === "♥") color = CardSkin.heartsColor;
    else if (this.data.suit === "♦") color = CardSkin.diamondsColor;
    else if (this.data.suit === "♣") color = CardSkin.clubsColor;

    const textStyle = {
      fontFamily: CardSkin.fontFamily,
      fontSize: CardSkin.cornerFontSize,
      fill: color,
      fontWeight: "900",
      align: "center",
      dropShadow: true,
      dropShadowColor: 0xffffff,
      dropShadowDistance: 1,
    } as const;

    const topLeftRank = new Text({
      text: this.data.rank,
      style: { ...textStyle, fontSize: CardSkin.cornerFontSize + 4 },
    });
    topLeftRank.anchor.set(0.5, 0);
    topLeftRank.position.set(12, 4);
    this.addChild(topLeftRank);

    const topLeftSuit = new Text({
      text: this.data.suit,
      style: { ...textStyle, fontSize: CardSkin.cornerFontSize },
    });
    topLeftSuit.anchor.set(0.5, 0);
    topLeftSuit.position.set(12, 24);
    this.addChild(topLeftSuit);

    const bottomRightRank = new Text({
      text: this.data.rank,
      style: { ...textStyle, fontSize: CardSkin.cornerFontSize + 4 },
    });
    bottomRightRank.anchor.set(0.5, 0);
    bottomRightRank.position.set(width - 12, height - 4);
    bottomRightRank.rotation = Math.PI;
    this.addChild(bottomRightRank);
    
    const bottomRightSuit = new Text({
      text: this.data.suit,
      style: { ...textStyle, fontSize: CardSkin.cornerFontSize },
    });
    bottomRightSuit.anchor.set(0.5, 0);
    bottomRightSuit.position.set(width - 12, height - 24);
    bottomRightSuit.rotation = Math.PI;
    this.addChild(bottomRightSuit);

    // 绘制中心区域
    if (["J", "Q", "K"].includes(this.data.rank)) {
       // Face card placeholder (a colored rect + letter)
       const faceBg = new Graphics();
       faceBg.rect(width * 0.2, height * 0.2, width * 0.6, height * 0.6);
       faceBg.fill({ color: 0xe8e8e8 });
       faceBg.stroke({ width: 2, color: color });
       this.addChild(faceBg);

       const faceText = new Text({
         text: this.data.rank,
         style: {
           fontFamily: CardSkin.fontFamily,
           fontSize: CardSkin.centerFontSize,
           fill: color,
           fontWeight: "900",
         },
       });
       faceText.anchor.set(0.5);
       faceText.position.set(width / 2, height / 2);
       this.addChild(faceText);
    } else {
      this.drawPips(width, height, color);
    }

    // 把 pivot 放到几何中心，让旋转/缩放围绕中心展开。
    this.pivot.set(width / 2, height / 2);
  }

  private drawPips(width: number, height: number, color: number): void {
    const rank = this.data.rank;
    const suit = this.data.suit;
    const fontSize = rank === "A" ? CardSkin.centerFontSize * 1.5 : CardSkin.centerFontSize * 0.6;
    
    const style = {
      fontFamily: CardSkin.fontFamily,
      fontSize: fontSize,
      fill: color,
      align: "center" as const,
    };

    const addPip = (x: number, y: number, flipY = false) => {
      const pip = new Text({ text: suit, style });
      pip.anchor.set(0.5);
      pip.position.set(width * x, height * y);
      if (flipY) pip.rotation = Math.PI;
      this.addChild(pip);
    };

    if (rank === "A") {
      addPip(0.5, 0.5);
    } else if (rank === "2") {
      addPip(0.5, 0.2); addPip(0.5, 0.8, true);
    } else if (rank === "3") {
      addPip(0.5, 0.2); addPip(0.5, 0.5); addPip(0.5, 0.8, true);
    } else if (rank === "4") {
      addPip(0.3, 0.2); addPip(0.7, 0.2);
      addPip(0.3, 0.8, true); addPip(0.7, 0.8, true);
    } else if (rank === "5") {
      addPip(0.3, 0.2); addPip(0.7, 0.2);
      addPip(0.5, 0.5);
      addPip(0.3, 0.8, true); addPip(0.7, 0.8, true);
    } else if (rank === "6") {
      addPip(0.3, 0.2); addPip(0.7, 0.2);
      addPip(0.3, 0.5); addPip(0.7, 0.5);
      addPip(0.3, 0.8, true); addPip(0.7, 0.8, true);
    } else if (rank === "7") {
      addPip(0.3, 0.2); addPip(0.7, 0.2);
      addPip(0.5, 0.35);
      addPip(0.3, 0.5); addPip(0.7, 0.5);
      addPip(0.3, 0.8, true); addPip(0.7, 0.8, true);
    } else if (rank === "8") {
      addPip(0.3, 0.2); addPip(0.7, 0.2);
      addPip(0.5, 0.35);
      addPip(0.3, 0.5); addPip(0.7, 0.5);
      addPip(0.5, 0.65, true);
      addPip(0.3, 0.8, true); addPip(0.7, 0.8, true);
    } else if (rank === "9") {
      addPip(0.3, 0.2); addPip(0.7, 0.2);
      addPip(0.3, 0.4); addPip(0.7, 0.4);
      addPip(0.5, 0.5);
      addPip(0.3, 0.6, true); addPip(0.7, 0.6, true);
      addPip(0.3, 0.8, true); addPip(0.7, 0.8, true);
    } else if (rank === "10") {
      addPip(0.3, 0.2); addPip(0.7, 0.2);
      addPip(0.5, 0.3);
      addPip(0.3, 0.4); addPip(0.7, 0.4);
      addPip(0.3, 0.6, true); addPip(0.7, 0.6, true);
      addPip(0.5, 0.7, true);
      addPip(0.3, 0.8, true); addPip(0.7, 0.8, true);
    }
  }

  private bindEvents(): void {
    this.eventMode = "static";
    this.cursor = "pointer";
    this.on("pointerdown", () => this.callbacks.onClick(this));
    this.on("pointerover", () => this.callbacks.onHoverIn(this));
    this.on("pointerout", () => this.callbacks.onHoverOut(this));
  }
}
