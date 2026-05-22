import {
  Container,
  Graphics,
  Sprite,
  Text,
  Texture,
  FederatedPointerEvent,
  PerspectiveMesh,
  Rectangle,
  type ContainerChild,
} from "pixi.js";
import type { CardData } from "@domain/types";
import { assets } from "@core/AssetManager";
import { CONFIG } from "@game/config";
import { sampleCurve } from "@/debug/BezierCurveEditor";
import { uiHierarchy } from "@ui/hierarchy";
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
  // 常态伪3D倾斜呼吸晃动的时间累加器（随机初相，避免所有手牌同步）
  private idleTiltTime = Math.random() * Math.PI * 2;
  private currentScale = 1.0;
  private hoverScaleProgress = 0;

  // 鼠标在卡牌本地坐标系下的位置（以左上角为 0,0；如果鼠标不在卡上则为 null）。
  // 由 onHoverMove 写入，updateMouse3DTilt 消费。
  public mouseLocalX: number | null = null;
  public mouseLocalY: number | null = null;

  private breathingY = 0;
  private wobbleRot = 0;

  // 4 个角的目标偏移量（相对于矩形几何角的位移，即"角点 = 几何角 + 偏移"）
  // TL=top-left, TR=top-right, BR=bottom-right, BL=bottom-left
  private targetCornerOffset = { tlX: 0, tlY: 0, trX: 0, trY: 0, brX: 0, brY: 0, blX: 0, blY: 0 };
  // 4 个角的当前偏移量（向 target 平滑插值）
  private currentCornerOffset = { tlX: 0, tlY: 0, trX: 0, trY: 0, brX: 0, brY: 0, blX: 0, blY: 0 };

  // 视觉子容器：承载所有卡面绘制（Graphics、Text、Sprite 等），
  // 但不直接显示在场景里——而是被 generateTexture 烤成 cardTexture 后由 tiltMesh 显示。
  private contentContainer: Container | null = null;
  // 离屏烘焙得到的卡面纹理（透视 mesh 的源贴图）
  private cardTexture: Texture | null = null;
  // 真正显示的透视 mesh（PerspectiveMesh）
  private tiltMesh: PerspectiveMesh | null = null;
  // 外层容器（承载 tiltMesh），用于施加 hover scale / wobble rotation / breathing y
  private displayWrapper: Container | null = null;

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
        (child as any).roundPixels = false;
      }
    }
    // 视觉元素重定向：除 shadowGraphics / contentContainer / displayWrapper 本身，
    // 其余全部塞进 contentContainer（用于离屏烘焙）。
    const first = children[0];
    if (
      this.contentContainer &&
      first !== this.contentContainer &&
      first !== this.shadowGraphics &&
      first !== this.displayWrapper
    ) {
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
    // 清理 displayWrapper（自身在 CardView children 内，由 removeChildren 处理）和它内部的 mesh。
    if (this.tiltMesh) {
      this.tiltMesh.destroy();
      this.tiltMesh = null;
    }
    this.displayWrapper = null; // 由 removeChildren 自动 destroy
    // 离屏 contentContainer 不在 CardView children 里，要单独 destroy。
    if (this.contentContainer) {
      this.contentContainer.destroy({ children: true });
      this.contentContainer = null;
    }
    if (this.cardTexture) {
      this.cardTexture.destroy(true);
      this.cardTexture = null;
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
    if (this.tiltMesh) {
      this.tiltMesh.destroy();
      this.tiltMesh = null;
    }
    if (this.contentContainer) {
      // contentContainer 不挂在场景树里，单独 destroy。
      this.contentContainer.destroy({ children: true });
      this.contentContainer = null;
    }
    if (this.cardTexture) {
      this.cardTexture.destroy(true);
      this.cardTexture = null;
    }
    super.destroy(options);
  }

  private draw(): void {
    const W = CardSkin.width;
    const H = CardSkin.height;

    // 1. contentContainer：承载所有卡面绘制内容，但 **不直接挂在 CardView 上**——
    //    它只用作离屏烘焙的源场景。pivot/position 都置零，整个卡面正好覆盖 (0,0)~(W,H)。
    this.contentContainer = new Container();
    this.contentContainer.pivot.set(0, 0);
    this.contentContainer.position.set(0, 0);

    // 2. shadowGraphics：阴影逻辑保持不变
    this.shadowGraphics = new Graphics();
    this.shadowGraphics.pivot.set(W / 2, H / 2);
    if (!this.isDragging && this.shadowContainer) {
      this.shadowContainer.addChild(this.shadowGraphics);
    } else {
      super.addChild(this.shadowGraphics);
    }

    // 3. 绘制卡面元素。drawSprite/drawProcedural 内部用 this.addChild，
    //    会被重定向到 contentContainer。
    const tex = CONFIG.cardArt.useSprites && assets.isReady
      ? assets.getFront(this.data.rank, this.data.suit)
      : undefined;

    if (tex) {
      this.drawSprite(tex);
    } else {
      this.drawProcedural();
    }

    // 4. 圆角遮罩（保持与原逻辑一致），作用在 contentContainer 上。
    const pad = tex ? 2 : 0;
    const maskW = tex ? W - pad * 2 : W;
    const maskH = tex ? H - pad * 2 : H;
    const maskR = tex ? Math.max(0, CONFIG.cardArt.cornerRadius) : CONFIG.cardArt.cornerRadius;

    const cardMask = new Graphics();
    cardMask.roundRect(pad, pad, maskW, maskH, maskR);
    cardMask.fill({ color: 0xffffff });
    cardMask.roundPixels = false;
    // 直接放进 contentContainer（绕开 addChild 重定向，避免无谓判断）
    this.contentContainer.addChild(cardMask);
    this.contentContainer.mask = cardMask;

    // 5. 创建 RenderTexture 并烘焙 contentContainer。
    this.bakeCardTexture();

    // 6. 创建 PerspectiveMesh + displayWrapper（承载所有外部 transform：scale/rotation/breathingY）。
    this.tiltMesh = new PerspectiveMesh({
      texture: this.cardTexture ?? Texture.WHITE,
      // 顶点密度：越高越平滑，但开销越大。卡牌尺寸小，10x14 已足够丝滑且仍是高效区间。
      verticesX: 10,
      verticesY: 14,
      x0: 0, y0: 0,
      x1: W, y1: 0,
      x2: W, y2: H,
      x3: 0, y3: H,
    });
    (this.tiltMesh as any).roundPixels = false;

    this.displayWrapper = new Container();
    this.displayWrapper.pivot.set(W / 2, H / 2);
    this.displayWrapper.position.set(W / 2, H / 2);
    this.displayWrapper.addChild(this.tiltMesh);
    super.addChild(this.displayWrapper);

    // 7. CardView 自身的 pivot/几何中心（保持与原逻辑一致，使外部 rotation/scale 围绕中心）。
    this.pivot.set(W / 2, H / 2);

    this.updateShadow();
  }

  /**
   * 把 contentContainer 离屏烤成 cardTexture，供 PerspectiveMesh 当作贴图。
   * 调用时机：首次 draw() / refreshArt() / 选中态变化等需要刷新卡面静态外观时。
   *
   * 注意：mesh 上的纹理只反映 contentContainer 的"静态"内容（卡面 art + 圆角）。
   * 呼吸晃动、hover 缩放、3D 倾斜等动效不进入纹理，而是作用在 displayWrapper / mesh corners 上。
   */
  private bakeCardTexture(): void {
    if (!this.contentContainer) return;
    const renderer = uiHierarchy.getRenderer();
    if (!renderer) {
      // 没有 renderer（很早期阶段或测试环境）：暂时不烤，等下一次再尝试。
      return;
    }

    const W = CardSkin.width;
    const H = CardSkin.height;

    try {
      const tex = renderer.generateTexture({
        target: this.contentContainer,
        frame: new Rectangle(0, 0, W, H),
        resolution: renderer.resolution,
        antialias: true,
      });
      const old = this.cardTexture;
      this.cardTexture = tex;
      if (this.tiltMesh) {
        this.tiltMesh.texture = tex;
      }
      if (old && old !== tex) old.destroy(true);
    } catch (err) {
      console.warn(`[CardView] bakeCardTexture 失败：`, err);
    }
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

  /**
   * 鼠标在卡上移动：把鼠标位置投影到卡牌本地坐标系（左上角为原点，单位像素）。
   *
   * 注意：必须把鼠标位置转换到 **未变形之前的卡面坐标系**——
   * 我们对 displayWrapper 应用 hoverScale + wobble rotation，对 mesh 应用 corner 透视；
   * mesh 的角点是以"原始矩形"为基准的，所以这里期望的鼠标坐标也是相对"原始矩形"。
   *
   * 由于 displayWrapper 的 transform（scale/rotation/breathing）作用在外层，
   * 而 `event.getLocalPosition(this)` 给出的是相对 CardView 自身的坐标，
   * 而 CardView 自身的 pivot 是 (W/2, H/2)、scale=1（外部由 tween 控制），
   * 这个本地坐标恰好就是原始未变形矩形的 (x, y)——直接使用即可。
   */
  private onHoverMove(event: FederatedPointerEvent): void {
    const localPos = event.getLocalPosition(this);
    this.mouseLocalX = localPos.x;
    this.mouseLocalY = localPos.y;
  }

  /**
   * 视觉效果更新 Ticker
   */
  public update(dtMS: number): void {
    if (!this.contentContainer || !this.tiltMesh) return;

    // 如果首次烤纹理失败（例如 renderer 还没注入），每帧重试一次直到成功。
    if (!this.cardTexture) {
      this.bakeCardTexture();
    }

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

    // 3. 卡牌伪3D倾斜：真实鼠标悬停时按鼠标位置倾斜；未悬停时由"常态伪3D倾斜呼吸晃动"
    //    通过虚拟鼠标产生缓慢的圆周倾斜。两种来源共用同一套投影公式与同一份目标角偏移，
    //    悬停一旦激活，呼吸态会自然让位（同 target，靠插值平滑切换）。
    this.updateMouse3DTilt(dtMS);

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
      this.currentScale = 1.0;
      this.hoverScaleProgress = 0;
      // 立即把 displayWrapper 恢复到 1.0 缩放（applyVisuals 当帧也会同步，但这里保险一下）。
      this.displayWrapper?.scale.set(1.0);
      return;
    }

    // 如果鼠标在这个牌上游走 (Hovered) 或者是点击选中态且有鼠标悬停 (Selected + isMouseOver)
    const isHovered = this.cardState === CardState.Hovered || (this.isMouseOver && this.cardState === CardState.Selected);

    if (isHovered) {
      // 触碰悬停：向 1 递增 progress
      if (this.hoverScaleProgress < 1) {
        const duration = visualConf.hoverScaleDurationMS || 250;
        this.hoverScaleProgress = Math.min(1, this.hoverScaleProgress + dtMS / duration);
      }

      const curve = visualConf.hoverScaleCurve;
      // 采样曲线
      const y = sampleCurve(curve, this.hoverScaleProgress);

      const H = visualConf.hoverOvershootScale - 1.0;
      const D = visualConf.hoverSettleScale - 1.0;

      if (H > D && D > 0) {
        // 利用抛物线映射 A * y + B * y^2 实现完美的过弹回缩：
        // 保证 y=0 时 scale=1.0, y=1.0 时 scale=hoverSettleScale, peak 处为 hoverOvershootScale
        const A = 2 * H + 2 * Math.sqrt(H * (H - D));
        const B = D - A;
        this.currentScale = 1.0 + A * y + B * y * y;
      } else {
        // 退化分支：普通插值
        const s = typeof visualConf.hoverSettleScale === "number" ? visualConf.hoverSettleScale : 1.05;
        this.currentScale = 1.0 + (s - 1.0) * y;
      }
    } else {
      // 离开：递减 progress 并平滑缩回 1.0
      if (this.hoverScaleProgress > 0) {
        const duration = visualConf.hoverScaleOutDurationMS || 150;
        this.hoverScaleProgress = Math.max(0, this.hoverScaleProgress - dtMS / duration);
      }

      // 平滑插值缩回 1.0
      const targetScale = 1.0;
      const speed = visualConf.hoverScaleOutSpeed || 0.15;
      this.currentScale += (targetScale - this.currentScale) * speed * (dtMS / 16.67);
    }
  }

  /**
   * 计算 4 角偏移（伪 3D 翻折）。
   *
   * 数学模型：
   *   把卡牌视为厚度为零的 3D 平板，4 个角处于平面 z=0。
   *   鼠标位置即"按下点"。**离鼠标越近的角向 +z（屏幕里、背景方向）凹陷，
   *   越远的角向 -z（屏幕外）凸起**。
   *
   *   然后用透视投影 (x', y') = center + (x - center) * focal / (focal + z)
   *   投影到 2D 平面，得到 4 角的视觉位移。
   *
   *   z > 0  -> 分母大 -> 角靠向中心 -> 看起来"远" = 凹陷 ✓
   *   z < 0  -> 分母小 -> 角远离中心 -> 看起来"近" = 凸出 ✓
   *
   * 这是真正的 3D 翻折投影，能 100% 复现你描述的"鼠标处下压 / 对角抬起"视觉。
   */
  private updateMouse3DTilt(dtMS: number): void {
    const visualConf = CONFIG.cardVisuals;
    const W = CardSkin.width;
    const H = CardSkin.height;

    // 仅在常态 / Hovered / Selected 触发；Dragging 时关闭
    const isEffectState =
      this.cardState === CardState.Normal ||
      this.cardState === CardState.Hovered ||
      this.cardState === CardState.Selected;

    // 1) 真实鼠标触发的 3D 倾斜（最高优先级）
    const hoverActive =
      !!visualConf &&
      !!visualConf.mouse3DTiltEnabled &&
      this.cardState !== CardState.Dragging &&
      isEffectState &&
      this.isMouseOver &&
      this.mouseLocalX !== null &&
      this.mouseLocalY !== null;

    // 2) 常态伪 3D 倾斜呼吸（仅当 hover 未激活时起效，状态机仍需是 Normal/Hovered/Selected 且非拖拽）
    //    注：状态机里 Hovered 必伴随 isMouseOver=true，所以 idle 实际只发生在 Normal/Selected 且鼠标不在卡上。
    const idleActive =
      !hoverActive &&
      !!visualConf &&
      !!visualConf.idleTiltEnabled &&
      this.cardState !== CardState.Dragging &&
      isEffectState;

    // 推进常态倾斜呼吸的相位（即便当前未激活也持续走时，避免重新激活时相位跳变）
    if (visualConf) {
      this.idleTiltTime += dtMS * (visualConf.idleTiltSpeed ?? 0.0008);
    }

    // 计算 4 角"目标"偏移
    if (hoverActive) {
      const strength = visualConf!.mouse3DTiltStrength ?? 2.0;
      this.computeTiltTargetFromMouse(this.mouseLocalX!, this.mouseLocalY!, strength);
    } else if (idleActive) {
      // 用时间驱动一个"虚拟鼠标"在卡牌中心附近做缓慢的椭圆轨迹运动，
      // 复用与 mouse3DTilt 完全相同的投影公式，得到呼吸般的伪 3D 倾斜。
      const radius = Math.max(0, Math.min(1, visualConf!.idleTiltRadius ?? 0.55));
      const t = this.idleTiltTime;
      // 椭圆运动：x 用 sin，y 用 cos 并乘以略低的比率，避免完美正圆显得机械
      const cx = W / 2;
      const cy = H / 2;
      const rx = (W / 2) * radius;
      const ry = (H / 2) * radius;
      const vmx = cx + Math.sin(t) * rx;
      const vmy = cy + Math.cos(t * 0.85) * ry;
      const strength = visualConf!.idleTiltStrength ?? 0.6;
      this.computeTiltTargetFromMouse(vmx, vmy, strength);
    } else {
      this.targetCornerOffset.tlX = 0; this.targetCornerOffset.tlY = 0;
      this.targetCornerOffset.trX = 0; this.targetCornerOffset.trY = 0;
      this.targetCornerOffset.brX = 0; this.targetCornerOffset.brY = 0;
      this.targetCornerOffset.blX = 0; this.targetCornerOffset.blY = 0;
    }

    // 平滑插值：current -> target
    const speed = 0.15;
    const k = Math.min(1, speed * (dtMS / 16.67));
    this.currentCornerOffset.tlX += (this.targetCornerOffset.tlX - this.currentCornerOffset.tlX) * k;
    this.currentCornerOffset.tlY += (this.targetCornerOffset.tlY - this.currentCornerOffset.tlY) * k;
    this.currentCornerOffset.trX += (this.targetCornerOffset.trX - this.currentCornerOffset.trX) * k;
    this.currentCornerOffset.trY += (this.targetCornerOffset.trY - this.currentCornerOffset.trY) * k;
    this.currentCornerOffset.brX += (this.targetCornerOffset.brX - this.currentCornerOffset.brX) * k;
    this.currentCornerOffset.brY += (this.targetCornerOffset.brY - this.currentCornerOffset.brY) * k;
    this.currentCornerOffset.blX += (this.targetCornerOffset.blX - this.currentCornerOffset.blX) * k;
    this.currentCornerOffset.blY += (this.targetCornerOffset.blY - this.currentCornerOffset.blY) * k;
  }

  /**
   * 共用的角点投影计算：给定卡牌本地坐标系中的一个"鼠标位置" (mx, my) 和强度，
   * 用与 mouse3DTilt 完全相同的透视投影模型，写入 this.targetCornerOffset。
   *
   * 由 updateMouse3DTilt（真实鼠标）和常态伪3D倾斜呼吸（虚拟鼠标）共同使用，
   * 这样能确保两种倾斜的视觉模型 100% 一致。
   */
  private computeTiltTargetFromMouse(mx: number, my: number, strength: number): void {
    const W = CardSkin.width;
    const H = CardSkin.height;

    // 把"强度"转换成 z 深度的最大幅度（像素）。strength=2.0 -> 约 28 像素。
    const zMax = strength * 14;
    // 焦距：越大透视越温和，越小越夸张。
    const focal = 240;

    const corners: Array<{ x: number; y: number; key: "tl" | "tr" | "br" | "bl" }> = [
      { x: 0, y: 0, key: "tl" },
      { x: W, y: 0, key: "tr" },
      { x: W, y: H, key: "br" },
      { x: 0, y: H, key: "bl" },
    ];

    const diag = Math.hypot(W, H);
    const cx = W / 2;
    const cy = H / 2;

    for (const c of corners) {
      const d = Math.hypot(c.x - mx, c.y - my);
      const t = d / diag;
      const z = zMax * (1 - 2 * t);
      const denom = focal + z;
      const k = focal / denom;
      const projX = cx + (c.x - cx) * k;
      const projY = cy + (c.y - cy) * k;
      const dx = projX - c.x;
      const dy = projY - c.y;

      if (c.key === "tl") { this.targetCornerOffset.tlX = dx; this.targetCornerOffset.tlY = dy; }
      else if (c.key === "tr") { this.targetCornerOffset.trX = dx; this.targetCornerOffset.trY = dy; }
      else if (c.key === "br") { this.targetCornerOffset.brX = dx; this.targetCornerOffset.brY = dy; }
      else { this.targetCornerOffset.blX = dx; this.targetCornerOffset.blY = dy; }
    }
  }

  private applyVisuals(): void {
    const W = CardSkin.width;
    const H = CardSkin.height;

    // 1. 透视变形：通过 4 角偏移驱动 PerspectiveMesh
    if (this.tiltMesh) {
      const co = this.currentCornerOffset;
      this.tiltMesh.setCorners(
        0 + co.tlX,     0 + co.tlY,      // TL
        W + co.trX,     0 + co.trY,      // TR
        W + co.brX,     H + co.brY,      // BR
        0 + co.blX,     H + co.blY,      // BL
      );
    }

    // 2. 外层呼吸晃动 / hover 缩放 / 旋转晃动 —— 全部作用在 displayWrapper 上。
    //    displayWrapper 的 pivot 是 (W/2, H/2)、position = (W/2, H/2 + breathingY)，
    //    确保旋转/缩放围绕几何中心，breathingY 让卡牌做上下呼吸位移。
    if (this.displayWrapper) {
      this.displayWrapper.position.set(W / 2, H / 2 + this.breathingY);
      this.displayWrapper.rotation = this.wobbleRot;
      this.displayWrapper.scale.set(this.currentScale, this.currentScale);
    }
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
      this.mouseLocalX = null;
      this.mouseLocalY = null;
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
