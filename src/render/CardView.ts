import { Container, Graphics, Sprite, Text, Texture, FederatedPointerEvent, type ContainerChild } from "pixi.js";
import type { CardData } from "@domain/types";
import { assets } from "@core/AssetManager";
import { CONFIG } from "@game/config";
import { CardSkin } from "./CardSkin";
import { getPixelOutlineTexture } from "./PixelOutlineTexture";

/**
 * 手牌的四种核心状态
 */
export enum CardState {
  Normal = "normal",       // 常态：没有任何特殊情况的状态
  Hovered = "hovered",     // 被触碰态：鼠标在卡牌上游走，无点击/拖拽
  Dragging = "dragging",   // 拖拽态：只要鼠标处于按下状态，即进入拖拽态
  Selected = "selected",   // 点击选中态：在时间阈值内快速抬起鼠标左键进入
}

/**
 * 卡牌视图
 *
 * 一个 CardView 持有一份 CardData（只读），负责把它画出来并响应交互。
 * 视图的可变状态只剩"是否选中"和"目标位姿"，由外部 controller 设置。
 *
 * 渲染策略（优先级从高到低）：
 *   1. CONFIG.cardArt.useSprites && AssetManager 已就绪 → 直接用 8BitDeck 切出来的 Sprite。
 *   2. 否则回退到 Graphics + Text 程序化绘制（与原型一致），便于素材未加载时也能看到牌。
 *
 * 设计要点：
 *   - 位姿的平滑插值不再在内部 ticker 里手写，而是由外部 TweenManager 统一驱动。
 *     CardView 只提供 x/y/rotation 字段供 tween 写入。
 *   - 不再持有 `targetX/targetY/targetRotation`，让 view 更像纯展示对象。
 *   - hover / click 通过回调向上抛出，不与 GameState 直接耦合。
 */
export interface CardViewCallbacks {
  onClick: (view: CardView) => void;
  onHoverIn: (view: CardView) => void;
  onHoverOut: (view: CardView) => void;
  onDragStart?: (view: CardView) => void;
  onDragEnd?: (view: CardView) => void;
}

export class CardView extends Container {
  selected = false;
  layoutX = 0;
  layoutY = 0;
  layoutRotation = 0;
  isDragging = false;
  isReturning = false;

  // 状态机核心字段
  cardState: CardState = CardState.Normal;
  isMouseOver = false;
  private dragStartTime = 0;
  private dragMaxDistance = 0;

  // 视觉效果积累与辅助变量
  private breathingTime = Math.random() * 100;
  private wobbleTime = Math.random() * 100;
  private currentScale = 1.0;

  public mouseOffsetX = 0;
  public mouseOffsetY = 0;

  private breathingY = 0;
  private wobbleRot = 0;
  private visualOffsetX = 0;
  private visualOffsetY = 0;

  // 视觉子容器，用于承载除阴影外所有的视觉卡面，以便在不影响外部布局/拖拽计算的前提下施加各种动画/视效
  private contentContainer: Container | null = null;

  private dragData: FederatedPointerEvent | null = null;
  private dragStartPointerX = 0;
  private dragStartPointerY = 0;
  private dragStartCardX = 0;
  private dragStartCardY = 0;
  private oldStageEventMode: any = null;
  private shadowGraphics: Graphics | null = null;
  private dragTargetX = 0;
  private dragTargetY = 0;

  override addChild<U extends ContainerChild[]>(...children: U): U[0] {
    for (const child of children) {
      if (child && "roundPixels" in child) {
        (child as any).roundPixels = true;
      }
    }
    // 视觉元素重定向：除 shadowGraphics 和 contentContainer 本身，其余全部塞进 contentContainer
    if (this.contentContainer && children[0] !== this.contentContainer && children[0] !== this.shadowGraphics) {
      return this.contentContainer.addChild(...children);
    }
    return super.addChild(...children);
  }

  constructor(
    readonly data: CardData,
    private readonly callbacks: CardViewCallbacks,
    private readonly shadowContainer?: Container
  ) {
    super();
    this.draw();
    this.bindEvents();
  }

  /** 运行时美术参数变化后，保留位置/交互状态，只重建内部绘制节点。 */
  refreshArt(): void {
    if (this.shadowGraphics && this.shadowGraphics.parent) {
      this.shadowGraphics.parent.removeChild(this.shadowGraphics);
      this.shadowGraphics.destroy();
      this.shadowGraphics = null;
    }
    this.removeChildren().forEach((child) => {
      child.destroy({ children: true });
    });
    this.draw();
  }

  override destroy(options?: any): void {
    if (this.shadowGraphics) {
      if (this.shadowGraphics.parent) {
        this.shadowGraphics.parent.removeChild(this.shadowGraphics);
      }
      this.shadowGraphics.destroy();
      this.shadowGraphics = null;
    }
    super.destroy(options);
  }

  private draw(): void {
    // 实例化视觉子容器，并设其 pivot 为卡牌中心，确保所有视觉晃动/缩放围绕中心展开
    this.contentContainer = new Container();
    this.contentContainer.pivot.set(CardSkin.width / 2, CardSkin.height / 2);
    this.contentContainer.position.set(CardSkin.width / 2, CardSkin.height / 2);
    super.addChild(this.contentContainer);

    this.shadowGraphics = new Graphics();
    this.shadowGraphics.pivot.set(CardSkin.width / 2, CardSkin.height / 2);
    if (!this.isDragging && this.shadowContainer) {
      this.shadowContainer.addChild(this.shadowGraphics);
    } else {
      this.addChild(this.shadowGraphics);
    }

    const tex = CONFIG.cardArt.useSprites && assets.isReady
      ? assets.getFront(this.data.rank, this.data.suit)
      : undefined;

    if (tex) {
      this.drawSprite(tex);
    } else {
      this.drawProcedural();
    }

    // 把 pivot 放到几何中心，让旋转/缩放围绕中心展开。
    this.pivot.set(CardSkin.width / 2, CardSkin.height / 2);

    this.updateShadow();
  }

  updateShadow(): void {
    if (!this.shadowGraphics) return;

    const width = CardSkin.width;
    const height = CardSkin.height;
    const cornerRadius = CONFIG.cardArt.cornerRadius;

    // 拖动状态与常态使用两套完全独立的阴影配置，可在拖动时产生“卡牌升起”的精美视效
    const shadowConf = this.isDragging ? CONFIG.dragShadow : CONFIG.cardShadow;

    this.shadowGraphics.clear();
    this.shadowGraphics.roundRect(0, 0, width, height, cornerRadius);
    this.shadowGraphics.fill({ color: shadowConf.color });

    // 计算阴影位置
    const cx = this.x;
    const cy = this.y;
    const lx = shadowConf.lightX;
    const ly = shadowConf.lightY;
    const ratio = shadowConf.distanceRatio;

    // 世界坐标系中的相对偏移
    const worldDx = (lx - cx) * ratio;
    const worldDy = (ly - cy) * ratio;

    // 同步可见性
    this.shadowGraphics.visible = this.visible;

    if (this.isDragging || !this.shadowContainer) {
      // 确保它挂在当前 CardView 下
      if (this.shadowGraphics.parent !== this) {
        if (this.shadowGraphics.parent) {
          this.shadowGraphics.parent.removeChild(this.shadowGraphics);
        }
        this.addChildAt(this.shadowGraphics, 0);
      }

      // 将世界偏移转换到局部坐标（逆向旋转卡牌的 rotation）
      const theta = this.rotation;
      const cosT = Math.cos(-theta);
      const sinT = Math.sin(-theta);
      const localDx = worldDx * cosT - worldDy * sinT;
      const localDy = worldDx * sinT + worldDy * cosT;

      this.shadowGraphics.position.set(width / 2 + localDx, height / 2 + localDy);
      this.shadowGraphics.rotation = 0;
      this.shadowGraphics.scale.set(shadowConf.scaleRatio);
      this.shadowGraphics.alpha = shadowConf.alpha;
    } else {
      // 确保它挂在独立的 shadowContainer 下
      if (this.shadowGraphics.parent !== this.shadowContainer) {
        if (this.shadowGraphics.parent) {
          this.shadowGraphics.parent.removeChild(this.shadowGraphics);
        }
        this.shadowContainer.addChild(this.shadowGraphics);
      }

      // 处于独立的层级中，因此我们需要使用其在父容器下的绝对位姿
      this.shadowGraphics.position.set(cx + worldDx, cy + worldDy);
      this.shadowGraphics.rotation = this.rotation;
      this.shadowGraphics.scale.set(this.scale.x * shadowConf.scaleRatio, this.scale.y * shadowConf.scaleRatio);
      this.shadowGraphics.alpha = shadowConf.alpha;
      this.shadowGraphics.pivot.set(width / 2, height / 2);
    }
  }

  /** 精灵图分支：背景+正面贴图+1像素外描边，整体保持与程序化绘制相同的外尺寸。 */
  private drawSprite(tex: Texture): void {
    const { width, height } = CardSkin;
    const cornerRadius = CONFIG.cardArt.cornerRadius;
    const faceColor = CONFIG.cardArt.faceColor;

    // 让 sprite 在卡牌内框留一点 padding，避免圆角被切硬边。
    const pad = 2;
    const innerW = width - pad * 2;
    const innerH = height - pad * 2;
    const innerRadius = Math.max(0, cornerRadius);

    // 白色底：尺寸与 sprite 完全一致，不再外扩到 100×140。
    const bg = new Graphics();
    bg.roundRect(pad, pad, innerW, innerH, innerRadius);
    bg.fill({ color: faceColor });
    this.addChild(bg);

    const sprite = new Sprite(tex);
    sprite.position.set(pad, pad);
    sprite.width = innerW;
    sprite.height = innerH;
    this.addChild(sprite);

    this.drawPixelOutline(pad, pad, innerW, innerH, innerRadius, tex.width, tex.height);
  }

  /** 程序化绘制分支：与原型一致，作为贴图未加载时的兜底。 */
  private drawProcedural(): void {
    const { width, height } = CardSkin;
    const cornerRadius = CONFIG.cardArt.cornerRadius;
    const faceColor = CONFIG.cardArt.faceColor;

    const bg = new Graphics();
    bg.roundRect(0, 0, width, height, cornerRadius);
    bg.fill({ color: faceColor });
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

    // 中心区域
    if (["J", "Q", "K"].includes(this.data.rank)) {
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

    this.drawPixelOutline(0, 0, width, height, cornerRadius, 71, 95);
  }

  /**
   * 沿指定矩形外缘画一圈"素材 1 像素"等粗的描边。
   *
   * 这里不用 Graphics.stroke，而是在素材像素尺寸上生成透明描边纹理，
   * 再用 nearest 放大到显示尺寸。这样全局 antialias 可以平滑几何边，
   * 但描边本身仍保持与卡牌素材一致的像素颗粒感。
   */
  private drawPixelOutline(
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number,
    sourceW: number,
    sourceH: number,
  ): void {
    const outlineColor = CONFIG.cardArt.outlineColor;
    const scaleX = w / sourceW;
    const scaleY = h / sourceH;
    const sourceRadius = radius / ((scaleX + scaleY) / 2);
    const outline = new Sprite(getPixelOutlineTexture(sourceW, sourceH, sourceRadius, outlineColor));
    outline.position.set(x, y);
    outline.width = w;
    outline.height = h;
    this.addChild(outline);
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

  private getRootStage(): any {
    let root: any = this.parent;
    if (!root) return null;
    while (root.parent) {
      root = root.parent;
    }
    return root;
  }

  private onPointerDown(event: FederatedPointerEvent): void {
    if (event.button !== 0) return;

    this.dragData = event;
    this.dragStartTime = Date.now();
    this.dragMaxDistance = 0;

    // 按下鼠标左键即刻进入拖拽态（按照需求：只要鼠标处于按下状态，就会进入拖拽态）
    this.isDragging = true;
    this.cardState = CardState.Dragging;
    this.callbacks.onDragStart?.(this);

    const parent = this.parent;
    if (parent) {
      const parentPos = event.getLocalPosition(parent);
      this.dragStartPointerX = parentPos.x;
      this.dragStartPointerY = parentPos.y;
    } else {
      this.dragStartPointerX = event.global.x;
      this.dragStartPointerY = event.global.y;
    }
    this.dragStartCardX = this.x;
    this.dragStartCardY = this.y;
    this.dragTargetX = this.x;
    this.dragTargetY = this.y;

    // 监听 root stage 的指针移动与释放，并且在按下时临时将 stage.eventMode 设为 "static"，
    // 从而保证即便划过非交互背景区域时，全局 move 和 up 事件也能 100% 触发，不会出现卡死 or 松开不回弹。
    const stage = this.getRootStage();
    if (stage) {
      this.oldStageEventMode = stage.eventMode;
      stage.eventMode = "static";
      if (!stage.hitArea && stage.renderer) {
        stage.hitArea = stage.renderer.screen;
      }
      stage.on("pointermove", this.onPointerMove, this);
      stage.on("pointerup", this.onPointerUp, this);
      stage.on("pointerupoutside", this.onPointerUp, this);
    }
  }

  private onPointerMove(event: FederatedPointerEvent): void {
    if (!this.dragData) return;

    let dx = 0;
    let dy = 0;
    const parent = this.parent;
    if (parent) {
      const parentPos = event.getLocalPosition(parent);
      dx = parentPos.x - this.dragStartPointerX;
      dy = parentPos.y - this.dragStartPointerY;
    } else {
      dx = event.global.x - this.dragStartPointerX;
      dy = event.global.y - this.dragStartPointerY;
    }

    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > this.dragMaxDistance) {
      this.dragMaxDistance = dist;
    }

    if (this.isDragging) {
      this.dragTargetX = this.dragStartCardX + dx;
      this.dragTargetY = this.dragStartCardY + dy;
    }
  }

  private onPointerUp(): void {
    if (!this.dragData) return;

    const duration = Date.now() - this.dragStartTime;
    this.dragData = null;
    
    // 从 root stage 注销监听器，恢复空闲状态且还原 stage.eventMode
    const stage = this.getRootStage();
    if (stage) {
      stage.off("pointermove", this.onPointerMove, this);
      stage.off("pointerup", this.onPointerUp, this);
      stage.off("pointerupoutside", this.onPointerUp, this);
      if (this.oldStageEventMode !== null) {
        stage.eventMode = this.oldStageEventMode;
        this.oldStageEventMode = null;
      }
    }

    this.isDragging = false;

    // 获取配置中的快速点击时间阈值
    const threshold = CONFIG.cardVisuals?.clickThresholdMS ?? 250;
    const distanceThreshold = CONFIG.cardVisuals?.clickDistanceThreshold ?? 10;

    if (duration <= threshold && this.dragMaxDistance <= distanceThreshold) {
      // 一定时间阈值与距离阈值内，快速抬起鼠标左键，且没有显著位移，卡牌从拖拽态进入点击选中态
      this.callbacks.onClick(this);
      
      // 同步卡牌状态
      if (this.selected) {
        this.cardState = CardState.Selected;
      } else {
        this.cardState = this.isMouseOver ? CardState.Hovered : CardState.Normal;
      }
      this.callbacks.onDragEnd?.(this);
    } else {
      // 超过时间或距离阈值抬起鼠标左键，从拖拽态回到常态（不选中）
      if (this.selected) {
        this.selected = false;
      }
      this.cardState = this.isMouseOver ? CardState.Hovered : CardState.Normal;
      this.callbacks.onDragEnd?.(this);
    }
  }

  private onHoverMove(event: FederatedPointerEvent): void {
    const localPos = event.getLocalPosition(this);
    const centerX = CardSkin.width / 2;
    const centerY = CardSkin.height / 2;
    
    // 鼠标在卡牌上的相对坐标（以中心为 0, 0）
    const rawDx = localPos.x - centerX;
    const rawDy = localPos.y - centerY;
    
    const visualConf = CONFIG.cardVisuals;
    if (visualConf && visualConf.mouseOffsetEnabled) {
      let targetOffsetX = rawDx * visualConf.mouseOffsetFactorX;
      let targetOffsetY = rawDy * visualConf.mouseOffsetFactorY;
      
      const limit = visualConf.mouseOffsetLimit;
      const dist = Math.sqrt(targetOffsetX * targetOffsetX + targetOffsetY * targetOffsetY);
      if (dist > limit && dist > 0) {
        targetOffsetX = (targetOffsetX / dist) * limit;
        targetOffsetY = (targetOffsetY / dist) * limit;
      }
      this.mouseOffsetX = targetOffsetX;
      this.mouseOffsetY = targetOffsetY;
    } else {
      this.mouseOffsetX = 0;
      this.mouseOffsetY = 0;
    }
  }

  /**
   * 视觉效果更新 Ticker
   */
  public update(dtMS: number): void {
    if (!this.contentContainer) return;

    // 0. 更新拖拽追赶逻辑
    this.updateDragging(dtMS);

    // 如果处于从拖拽结束返回原位的过程中，且已经非常接近目标位置，重置 isReturning 状态
    if (this.isReturning && !this.isDragging) {
      const dist = Math.hypot(this.x - this.layoutX, this.y - this.layoutY);
      if (dist < 2) {
        this.isReturning = false;
      }
    }

    // 1. 常态化的手牌的呼吸晃动
    this.updateBreathing(dtMS);

    // 2. 鼠标悬停小弹性缩放
    this.updateHoverScale(dtMS);

    // 3. 鼠标在单张手牌上移动时的牌的偏移（包含常态和点击选中态）
    this.updateMouseOffset(dtMS);

    // 4. 将计算后的效果应用到视觉容器
    this.applyVisuals();
  }

  private updateDragging(dtMS: number): void {
    if (!this.isDragging) return;

    const diffX = this.dragTargetX - this.x;
    const diffY = this.dragTargetY - this.y;
    const distance = Math.sqrt(diffX * diffX + diffY * diffY);

    if (distance > 0.01) {
      const config = CONFIG.dragHandCard;
      const lerpFactor = config?.lerpFactor ?? 0.15;
      
      // 基于时间步长计算插值，确保在不同帧率下平滑度一致
      const actualLerp = 1 - Math.pow(1 - lerpFactor, dtMS / 16.666);
      let step = distance * Math.min(1, Math.max(0, actualLerp));

      // 速度上限 (像素/秒)
      const maxSpeed = config?.maxSpeed ?? 3000;
      const maxStep = (maxSpeed / 1000) * dtMS;

      if (step > maxStep) {
        step = maxStep;
      }

      this.x += (diffX / distance) * step;
      this.y += (diffY / distance) * step;
    }
  }

  private updateBreathing(dtMS: number): void {
    const visualConf = CONFIG.cardVisuals;
    if (!visualConf || !visualConf.breathingEnabled) {
      this.breathingY = 0;
      this.wobbleRot = 0;
      return;
    }

    // 拖动状态下不施加呼吸晃动，避免卡牌发抖
    if (this.cardState === CardState.Dragging) {
      this.breathingY = 0;
      this.wobbleRot = 0;
      return;
    }

    // 积累时间
    this.breathingTime += dtMS * visualConf.breathingSpeed;
    this.wobbleTime += dtMS * visualConf.wobbleSpeed;

    // y 轴位置呼吸摆动
    this.breathingY = Math.sin(this.breathingTime) * visualConf.breathingAmplitude;
    // z 轴旋转晃动
    this.wobbleRot = Math.cos(this.wobbleTime) * visualConf.wobbleAmplitude;
  }

  private updateHoverScale(dtMS: number): void {
    const visualConf = CONFIG.cardVisuals;
    if (!visualConf || !visualConf.hoverScaleEnabled) {
      this.contentContainer?.scale.set(1.0);
      return;
    }

    // 如果鼠标在这个牌上游走 (Hovered) 或者是点击选中态且有鼠标悬停 (Selected + isMouseOver)
    const isHovered = this.cardState === CardState.Hovered || (this.isMouseOver && this.cardState === CardState.Selected);
    const targetScale = isHovered ? visualConf.hoverScaleFactor : 1.0;

    // 弹性插值，基于 delta time 保证帧率无关
    const speed = visualConf.hoverScaleSpeed;
    this.currentScale += (targetScale - this.currentScale) * speed * (dtMS / 16.67);
    this.contentContainer?.scale.set(this.currentScale);
  }

  private updateMouseOffset(dtMS: number): void {
    const visualConf = CONFIG.cardVisuals;
    if (!visualConf || !visualConf.mouseOffsetEnabled || this.cardState === CardState.Dragging) {
      this.visualOffsetX = 0;
      this.visualOffsetY = 0;
      return;
    }

    // 仅在常态 (Normal)、被触碰态 (Hovered)、点击选中态 (Selected) 响应鼠标游走偏移
    const isEffectState =
      this.cardState === CardState.Normal ||
      this.cardState === CardState.Hovered ||
      this.cardState === CardState.Selected;

    const targetX = (this.isMouseOver && isEffectState) ? this.mouseOffsetX : 0;
    const targetY = (this.isMouseOver && isEffectState) ? this.mouseOffsetY : 0;

    // 平滑插值，避免偏移跳变
    const speed = 0.15;
    this.visualOffsetX += (targetX - this.visualOffsetX) * speed * (dtMS / 16.67);
    this.visualOffsetY += (targetY - this.visualOffsetY) * speed * (dtMS / 16.67);
  }

  private applyVisuals(): void {
    if (!this.contentContainer) return;
    this.contentContainer.position.set(
      CardSkin.width / 2 + this.visualOffsetX,
      CardSkin.height / 2 + this.breathingY + this.visualOffsetY
    );
    this.contentContainer.rotation = this.wobbleRot;
  }

  private bindEvents(): void {
    this.eventMode = "static";
    this.cursor = "pointer";

    this.on("pointerdown", this.onPointerDown, this);

    this.on("pointerover", () => {
      this.isMouseOver = true;
      if (this.cardState === CardState.Normal) {
        this.cardState = CardState.Hovered;
      }
      if (this.isDragging) return;
      this.callbacks.onHoverIn(this);
    });

    this.on("pointerout", () => {
      this.isMouseOver = false;
      if (this.cardState === CardState.Hovered) {
        this.cardState = CardState.Normal;
      }
      this.mouseOffsetX = 0;
      this.mouseOffsetY = 0;
      if (this.isDragging) return;
      this.callbacks.onHoverOut(this);
    });

    this.on("pointermove", (event) => {
      if (!this.isDragging && this.isMouseOver) {
        this.onHoverMove(event);
      }
    });
  }
}
