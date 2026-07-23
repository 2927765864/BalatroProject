/**
 * 盲注徽章（BlindChips 硬币）
 *
 * 素材仍是 BlindChips 帧动画，交互与视效对齐手牌 CardView：
 *   - 点击判定（仅视觉反馈，不可选中、不出牌）
 *   - 按下拖拽 + ElasticRopeMotion 物理跟手 / 松手回正
 *   - hover 弹性缩放 / 拖拽缩放 / 触碰呼吸晃动
 *   - 伪 3D 倾斜（PerspectiveMesh + idle / mouse 倾斜，读 CONFIG.cardVisuals）
 *   - 阴影（常态挂 shadowLayer，拖拽挂自身；读 blindChipShadow / blindChipDragShadow）
 *
 * 运行时由 GameController 挂到 cardLayer（高于 UI），阴影进 shadowLayer。
 */
import {
  Container,
  FederatedPointerEvent,
  Graphics,
  PerspectiveMesh,
  Text,
  Texture,
  type Ticker,
} from "pixi.js";
import { assets } from "@core/AssetManager";
import {
  beginDragSession,
  endDragSession,
  isDragSessionActive,
} from "@core/input/DragSession";
import { CONFIG } from "@game/config";
import { ElasticRopeMotion } from "@/motion/ElasticRopeMotion";
import {
  defaultElasticRopeAnchorLocal,
  readElasticRopeParams,
} from "@/motion/elasticRopeUtils";
import { SpringDamper1D } from "@/motion/SpringDamper1D";
import { Theme } from "../theme";
import { UINode, uiHierarchy } from "@ui/hierarchy";
import { GameFonts } from "../fonts";

enum BadgeState {
  Normal = "normal",
  Hovered = "hovered",
  Dragging = "dragging",
}

export interface BlindChipBadgeOptions {
  id: string;
  displayName?: string;
  size?: number;
  /** 常态阴影容器（通常为 cardLayer 下的 shadowLayer）。 */
  shadowContainer?: Container;
}

export class BlindChipBadge extends UINode {
  readonly size: number;

  layoutX = 0;
  layoutY = 0;
  layoutRotation = 0;

  isDragging = false;
  /** 是否已向全局 DragSession 占位（幂等 acquire/release）。 */
  private dragSessionHeld = false;
  isReturning = false;

  private shadowContainer: Container | null;

  private readonly ropeMotion = new ElasticRopeMotion();
  private moveTargetX = 0;
  private moveTargetY = 0;
  private moveTargetRotation = 0;
  private hasMoveTarget = true;

  private dragTargetX = 0;
  private dragTargetY = 0;
  private dragData: FederatedPointerEvent | null = null;
  private dragStartTime = 0;
  private dragMaxDistance = 0;
  private dragStartPointerX = 0;
  private dragStartPointerY = 0;
  private dragStartCardX = 0;
  private dragStartCardY = 0;
  private oldStageEventMode: string | null = null;

  private badgeState: BadgeState = BadgeState.Normal;
  private isMouseOver = false;

  private currentScale = 1;
  private readonly hoverScaleSpring = (() => {
    const s = new SpringDamper1D();
    s.reset(1, 0);
    return s;
  })();
  private hoverScaleWasHovered = false;
  private suppressHoverScaleUntilReenter = false;

  private dragScaleAnim: "in" | "out" | null = null;
  private dragScaleSpringTarget = 1;
  private readonly dragScaleSpring = (() => {
    const s = new SpringDamper1D();
    s.reset(1, 0);
    return s;
  })();
  private dragScaleMul = 1;

  private breathingTime = Math.random() * 100;
  private wobbleTime = Math.random() * 100;
  private breathingY = 0;
  private wobbleRot = 0;

  private hoverBreathingActive = false;
  private hoverBreathingElapsedMS = 0;
  private readonly hoverBreathYSpring = (() => {
    const s = new SpringDamper1D();
    s.reset(0, 0);
    return s;
  })();
  private readonly hoverBreathRotSpring = (() => {
    const s = new SpringDamper1D();
    s.reset(0, 0);
    return s;
  })();
  private hoverBreathingY = 0;
  private hoverWobbleRot = 0;

  private idleTiltTime = Math.random() * Math.PI * 2;
  private mouseLocalX: number | null = null;
  private mouseLocalY: number | null = null;
  private lastPointerGlobalX = 0;
  private lastPointerGlobalY = 0;
  private hasLastPointerGlobal = false;

  private readonly targetCornerOffset = {
    tlX: 0, tlY: 0, trX: 0, trY: 0, brX: 0, brY: 0, blX: 0, blY: 0,
  };
  private readonly currentCornerOffset = {
    tlX: 0, tlY: 0, trX: 0, trY: 0, brX: 0, brY: 0, blX: 0, blY: 0,
  };

  /** 外层视效根：scale / 呼吸 / wobble（对齐 CardView.displayWrapper）。 */
  private readonly displayWrapper = new Container();
  private tiltMesh: PerspectiveMesh | null = null;
  private shadowGraphics: Graphics | null = null;

  /** 硬币动画帧；空则走程序化纹理。 */
  private coinFrames: Texture[] = [];
  private animFrame = 0;
  private animAccumMS = 0;
  private fallbackTexture: Texture | null = null;

  private unsubscribeTick: (() => void) | null = null;
  /** true 时由 GameController cardLayer 循环驱动 update；否则自绑 ticker。 */
  private externalUpdate = false;

  constructor(opts: BlindChipBadgeOptions) {
    super({
      id: opts.id,
      displayName: opts.displayName ?? "盲注徽章",
    });
    this.size = opts.size ?? 72;
    this.shadowContainer = opts.shadowContainer ?? null;
    const S = this.size;

    this.pivot.set(S / 2, S / 2);

    this.displayWrapper.label = "blindChipDisplay";
    this.displayWrapper.pivot.set(S / 2, S / 2);
    this.displayWrapper.position.set(S / 2, S / 2);
    this.displayWrapper.eventMode = "none";
    this.addChild(this.displayWrapper);

    this.buildArt();
    this.buildShadow();
    this.bindEvents();
    this.applyProgramRopeAnchor();
    this.ropeMotion.reset({ x: 0, y: 0, rotation: 0 });

    this.on("added", () => {
      queueMicrotask(() => this.syncHomeFromPoseIfIdle());
      setTimeout(() => this.syncHomeFromPoseIfIdle(), 0);
    });

    this.tryBindSelfTicker();
  }

  /**
   * 切换为由外部（GameController cardLayer 循环）驱动 update/updateShadow。
   * 避免与自绑 ticker 双更。
   */
  useExternalUpdate(enabled: boolean): void {
    this.externalUpdate = enabled;
    if (enabled) {
      this.unbindSelfTicker();
    } else {
      this.tryBindSelfTicker();
    }
  }

  setShadowContainer(container: Container | null): void {
    this.shadowContainer = container;
    if (this.shadowGraphics && !this.isDragging && container) {
      if (this.shadowGraphics.parent && this.shadowGraphics.parent !== container) {
        this.shadowGraphics.parent.removeChild(this.shadowGraphics);
      }
      if (this.shadowGraphics.parent !== container) {
        container.addChild(this.shadowGraphics);
      }
    }
  }

  setHome(x: number, y: number, opts?: { snap?: boolean; rotation?: number }): void {
    this.layoutX = x;
    this.layoutY = y;
    if (opts?.rotation !== undefined) {
      this.layoutRotation = opts.rotation;
    }
    this.moveTargetX = x;
    this.moveTargetY = y;
    this.moveTargetRotation = this.layoutRotation;
    this.hasMoveTarget = true;
    if (opts?.snap !== false && !this.isDragging) {
      this.syncRopePose({ x, y, rotation: this.layoutRotation });
    } else if (!this.isDragging) {
      this.ropeMotion.setTarget(x, y);
    }
  }

  private syncHomeFromPoseIfIdle(): void {
    if (this.destroyed || this.isDragging || this.isReturning) return;
    this.layoutX = this.x;
    this.layoutY = this.y;
    this.layoutRotation = this.rotation;
    this.moveTargetX = this.x;
    this.moveTargetY = this.y;
    this.moveTargetRotation = this.rotation;
    this.hasMoveTarget = true;
    this.ropeMotion.reset({ x: this.x, y: this.y, rotation: 0 });
    this.ropeMotion.setTarget(this.x, this.y);
    this.applyProgramRopeAnchor();
  }

  // ---- art / mesh ------------------------------------------------

  private buildArt(): void {
    const S = this.size;
    this.coinFrames = [...assets.getBlindChipCoinFrames()];

    let tex: Texture;
    if (this.coinFrames.length > 0) {
      tex = this.coinFrames[0]!;
    } else {
      tex = this.buildFallbackTexture();
    }

    this.tiltMesh = new PerspectiveMesh({
      texture: tex,
      verticesX: 10,
      verticesY: 10,
      x0: 0, y0: 0,
      x1: S, y1: 0,
      x2: S, y2: S,
      x3: 0, y3: S,
    });
    (this.tiltMesh as any).roundPixels = false;
    this.tiltMesh.eventMode = "none";
    this.displayWrapper.addChild(this.tiltMesh);
  }

  private buildFallbackTexture(): Texture {
    if (this.fallbackTexture) return this.fallbackTexture;
    const S = this.size;
    const g = new Graphics();
    g.circle(S / 2, S / 2, S / 2);
    g.fill({ color: Theme.colors.blindBadge });
    g.circle(S / 2, S / 2, S / 2 - 1.5);
    g.stroke({ width: 3, color: 0x1a3a8a });
    // 无 renderer 时退回 WHITE；真正纹理在首帧 update 里可再试——此处用动态 Text 叠层。
    // 简化：直接用 Graphics 作为非 mesh 路径时的子节点；mesh 需要 Texture。
    // 用纯色 Texture.WHITE + tint 不够，挂一个 label 在 mesh 之上。
    const label = new Text({
      text: "SMALL\nBLIND",
      style: {
        fontFamily: GameFonts.textFxStack,
        fontSize: 11,
        fill: Theme.colors.textWhite,
        fontWeight: "bold",
        align: "center",
        lineHeight: 13,
      },
    });
    label.anchor.set(0.5);
    label.position.set(S / 2, S / 2);
    label.eventMode = "none";
    this.displayWrapper.addChild(label);

    this.fallbackTexture = Texture.WHITE;
    return this.fallbackTexture;
  }

  private buildShadow(): void {
    const S = this.size;
    this.shadowGraphics = new Graphics();
    this.shadowGraphics.label = "blindChipShadow";
    this.shadowGraphics.pivot.set(S / 2, S / 2);
    this.shadowGraphics.eventMode = "none";
    this.shadowGraphics.roundPixels = false;
    if (this.shadowContainer) {
      this.shadowContainer.addChild(this.shadowGraphics);
    } else {
      this.addChildAt(this.shadowGraphics, 0);
    }
  }

  private advanceCoinAnim(dtMS: number): void {
    if (!this.tiltMesh || this.coinFrames.length === 0) return;
    const fps = CONFIG.cardArt.blindChipAnim.fps;
    if (!(fps > 0)) return;
    const frameMS = 1000 / fps;
    this.animAccumMS += dtMS;
    while (this.animAccumMS >= frameMS) {
      this.animAccumMS -= frameMS;
      this.animFrame = (this.animFrame + 1) % this.coinFrames.length;
    }
    const tex = this.coinFrames[this.animFrame]!;
    if (this.tiltMesh.texture !== tex) {
      this.tiltMesh.texture = tex;
    }
  }

  // ---- input -----------------------------------------------------

  private bindEvents(): void {
    this.eventMode = "dynamic";
    this.cursor = "pointer";

    const S = this.size;
    const self = this;
    this.hitArea = {
      contains(x: number, y: number): boolean {
        const cv = CONFIG.cardVisuals;
        const scale =
          cv?.hoverHitEnabled === false
            ? 1
            : self.isMouseOver
              ? (cv?.hoverHitLeaveScale ?? 1)
              : (cv?.hoverHitEnterScale ?? 0.9);
        const r = (S / 2) * scale;
        const cx = S / 2;
        const cy = S / 2;
        const dx = x - cx;
        const dy = y - cy;
        return dx * dx + dy * dy <= r * r;
      },
    };

    this.on("pointerdown", this.onPointerDown, this);

    this.on("pointerover", () => {
      this.isMouseOver = true;
      if (this.badgeState === BadgeState.Normal) {
        this.badgeState = BadgeState.Hovered;
      }
      this.suppressHoverScaleUntilReenter = false;
      this.refreshMouseLocalFromGlobal();
      // 自身拖拽中，或其它卡牌/徽章拖拽划过：不触发触碰动画。
      if (this.isDragging || this.isForeignDragHoverSuppressed()) return;
      this.triggerHoverBreathing();
    });

    this.on("pointerout", () => {
      this.isMouseOver = false;
      if (this.badgeState === BadgeState.Hovered) {
        this.badgeState = BadgeState.Normal;
      }
      if (!this.isDragging) {
        this.mouseLocalX = null;
        this.mouseLocalY = null;
      }
      this.suppressHoverScaleUntilReenter = false;
    });

    this.on("pointermove", (event) => {
      if (this.isMouseOver || this.isDragging) {
        this.cachePointerGlobal(event);
        const localPos = event.getLocalPosition(this);
        this.mouseLocalX = localPos.x;
        this.mouseLocalY = localPos.y;
      }
    });
  }

  private onPointerDown(event: FederatedPointerEvent): void {
    if (event.button !== 0) return;

    this.dragData = event;
    this.dragStartTime = Date.now();
    this.dragMaxDistance = 0;
    this.cachePointerGlobal(event);
    {
      const localPos = event.getLocalPosition(this);
      this.mouseLocalX = localPos.x;
      this.mouseLocalY = localPos.y;
      const anchor = this.mapAnchorLocal(localPos.x, localPos.y);
      this.ropeMotion.setAnchorLocal(anchor.x, anchor.y);
    }

    this.isDragging = true;
    this.isReturning = false;
    this.badgeState = BadgeState.Dragging;
    this.acquireDragSession();

    if (this.parent) {
      this.parent.setChildIndex(this, this.parent.children.length - 1);
    }
    this.zIndex = 9999;

    {
      const dragConf = CONFIG.dragHandCard;
      const scaleIn = dragConf?.scaleIn;
      const target = dragConf?.dragScaleTarget ?? 1.15;
      this.dragScaleAnim = "in";
      this.dragScaleSpringTarget = target;
      const x0 = this.dragScaleSpring.x + (scaleIn?.impulseScale ?? 0);
      this.dragScaleSpring.reset(x0, scaleIn?.impulseScaleVel ?? 0);
      this.dragScaleMul = this.dragScaleSpring.x;
    }

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

    this.moveTargetRotation = this.rotation;
    this.moveTargetX = this.x;
    this.moveTargetY = this.y;
    this.hasMoveTarget = true;
    this.ropeMotion.reset({ x: this.x, y: this.y, rotation: 0 });
    this.ropeMotion.setTarget(this.x, this.y);

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
    this.cachePointerGlobal(event);
    this.refreshMouseLocalFromGlobal();

    let curX = 0;
    let curY = 0;
    const parent = this.parent;
    if (parent) {
      const parentPos = event.getLocalPosition(parent);
      curX = parentPos.x;
      curY = parentPos.y;
    } else {
      curX = event.global.x;
      curY = event.global.y;
    }

    const dx = curX - this.dragStartPointerX;
    const dy = curY - this.dragStartPointerY;
    const dist = Math.hypot(dx, dy);
    if (dist > this.dragMaxDistance) this.dragMaxDistance = dist;

    if (this.isDragging) {
      this.dragTargetX = this.dragStartCardX + dx;
      this.dragTargetY = this.dragStartCardY + dy;
    }
  }

  private onPointerUp(): void {
    if (!this.dragData) return;

    const duration = Date.now() - this.dragStartTime;
    this.dragData = null;

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
    this.releaseDragSession();
    this.zIndex = 0;

    // 拖拽缩放瞬间回 1；触碰入场由 restartHoverScaleEntrance 负责。
    this.snapDragScaleToRest();

    const threshold = CONFIG.cardVisuals?.clickThresholdMS ?? 250;
    const distanceThreshold = CONFIG.cardVisuals?.clickDistanceThreshold ?? 10;
    const isClick =
      duration <= threshold && this.dragMaxDistance <= distanceThreshold;

    if (isClick) {
      this.badgeState = this.isMouseOver ? BadgeState.Hovered : BadgeState.Normal;
      if (this.isMouseOver) {
        this.restartHoverScaleEntrance({ forceImmediate: true });
      }
    } else {
      this.badgeState = this.isMouseOver ? BadgeState.Hovered : BadgeState.Normal;
      if (this.isMouseOver) {
        this.restartHoverScaleEntrance({ forceImmediate: true });
      }
    }

    this.isReturning = true;
    this.applyProgramRopeAnchor();
    this.moveTargetX = this.layoutX;
    this.moveTargetY = this.layoutY;
    this.moveTargetRotation = this.layoutRotation;
    this.hasMoveTarget = true;
    this.ropeMotion.setTarget(this.layoutX, this.layoutY);
  }

  // ---- update loop -----------------------------------------------

  /** 由 GameController 或自绑 ticker 调用。 */
  public update(dtMS: number): void {
    this.advanceCoinAnim(dtMS);
    this.stepElasticRope(dtMS);
    this.updateDragScale(dtMS);
    this.updateBreathing(dtMS);
    this.updateHoverBreathing(dtMS);
    this.refreshMouseLocalFromGlobal();
    this.updateHoverScale(dtMS);
    this.updateMouse3DTilt(dtMS);
    this.applyVisuals();
  }

  public updateShadow(): void {
    if (!this.shadowGraphics) return;

    const S = this.size;
    const shadowConf = this.isDragging
      ? CONFIG.blindChipDragShadow
      : CONFIG.blindChipShadow;

    this.shadowGraphics.clear();
    // 硬币阴影用圆，比圆角矩形更贴合。
    this.shadowGraphics.circle(S / 2, S / 2, S / 2);
    this.shadowGraphics.fill({ color: shadowConf.color });

    const wrapper = this.displayWrapper;
    const innerRot = wrapper.rotation;
    const innerLocalOffsetX = wrapper.position.x - S / 2;
    const innerLocalOffsetY = wrapper.position.y - S / 2;
    const visualRot = this.rotation + innerRot;

    const cosOuter = Math.cos(this.rotation);
    const sinOuter = Math.sin(this.rotation);
    const innerWorldOffsetX =
      (innerLocalOffsetX * cosOuter - innerLocalOffsetY * sinOuter) * this.scale.x;
    const innerWorldOffsetY =
      (innerLocalOffsetX * sinOuter + innerLocalOffsetY * cosOuter) * this.scale.y;

    const cx = this.x + innerWorldOffsetX;
    const cy = this.y + innerWorldOffsetY;

    const lx = shadowConf.lightX;
    const ly = shadowConf.lightY;
    const ratio = shadowConf.distanceRatio;
    const cyForStretch =
      shadowConf.stretchLimitY !== undefined
        ? Math.max(cy, shadowConf.stretchLimitY)
        : cy;
    const worldDx = (lx - cx) * ratio;
    const worldDy = (ly - cyForStretch) * ratio;

    this.shadowGraphics.visible = this.visible;

    if (this.isDragging || !this.shadowContainer) {
      if (this.shadowGraphics.parent !== this) {
        if (this.shadowGraphics.parent) {
          this.shadowGraphics.parent.removeChild(this.shadowGraphics);
        }
        this.addChildAt(this.shadowGraphics, 0);
      }
      const sx = this.scale.x || 1;
      const sy = this.scale.y || 1;
      const invCos = Math.cos(-this.rotation);
      const invSin = Math.sin(-this.rotation);
      const localDx = (worldDx * invCos - worldDy * invSin) / sx;
      const localDy = (worldDx * invSin + worldDy * invCos) / sy;
      this.shadowGraphics.position.set(
        S / 2 + innerLocalOffsetX + localDx,
        S / 2 + innerLocalOffsetY + localDy,
      );
      this.shadowGraphics.rotation = innerRot;
      this.shadowGraphics.scale.set(shadowConf.scaleRatio, shadowConf.scaleRatio);
      // 拖拽阴影挂在自身，自带 alpha。
      this.shadowGraphics.alpha = shadowConf.alpha;
    } else {
      if (this.shadowGraphics.parent !== this.shadowContainer) {
        if (this.shadowGraphics.parent) {
          this.shadowGraphics.parent.removeChild(this.shadowGraphics);
        }
        this.shadowContainer.addChild(this.shadowGraphics);
      }
      this.shadowGraphics.position.set(cx + worldDx, cy + worldDy);
      this.shadowGraphics.rotation = visualRot;
      this.shadowGraphics.scale.set(
        this.scale.x * shadowConf.scaleRatio,
        this.scale.y * shadowConf.scaleRatio,
      );
      // 共享 shadowLayer 由 AlphaFilter 统一控制透明度；子阴影保持不透明以免重叠变黑。
      this.shadowGraphics.alpha = 1;
      this.shadowGraphics.pivot.set(S / 2, S / 2);
    }
  }

  private stepElasticRope(dtMS: number): void {
    if (this.isDragging) {
      this.ropeMotion.setTarget(this.dragTargetX, this.dragTargetY);
    } else if (this.hasMoveTarget) {
      this.ropeMotion.setTarget(this.moveTargetX, this.moveTargetY);
    }

    const params = readElasticRopeParams();
    if (!params.enabled) {
      if (this.isDragging) {
        this.x = this.dragTargetX;
        this.y = this.dragTargetY;
      } else if (this.hasMoveTarget) {
        this.x = this.moveTargetX;
        this.y = this.moveTargetY;
        this.rotation = this.moveTargetRotation;
        this.ropeMotion.reset({ x: this.x, y: this.y, rotation: 0 });
        this.ropeMotion.setTarget(this.x, this.y);
      }
      if (this.isReturning && !this.isDragging) this.isReturning = false;
      return;
    }

    const pose = this.ropeMotion.step(dtMS, params);
    this.x = pose.x;
    this.y = pose.y;
    this.rotation = this.moveTargetRotation + pose.rotation;

    if (this.isReturning && !this.isDragging && this.ropeMotion.isSettled(params)) {
      this.isReturning = false;
    }
  }

  /** 拖拽缩放瞬间归 1，并解除 hoverScale suppress。 */
  private snapDragScaleToRest(): void {
    this.dragScaleSpring.reset(1, 0);
    this.dragScaleMul = 1;
    this.dragScaleSpringTarget = 1;
    this.dragScaleAnim = null;
    this.suppressHoverScaleUntilReenter = false;
  }

  private updateDragScale(dtMS: number): void {
    if (this.dragScaleAnim === "out") {
      this.snapDragScaleToRest();
      return;
    }

    if (this.dragScaleAnim === null) {
      this.dragScaleMul = this.dragScaleSpring.x;
      return;
    }

    // dragScaleAnim === "in"
    const dragConf = CONFIG.dragHandCard;
    const springConf = dragConf?.scaleIn;
    const target = this.dragScaleSpringTarget;
    const params = {
      mass: springConf?.mass ?? 1,
      angularFreq: springConf?.angularFreq ?? 14,
      dampingRatio: springConf?.dampingRatio ?? 0.45,
    };
    const maxDtSec = springConf?.maxDtSec ?? 1 / 30;
    const substeps = springConf?.substeps ?? 2;
    const eps = springConf?.settleEpsScale ?? 0.004;
    const velEps = springConf?.settleVelScale ?? 0.05;

    const speed = CONFIG.gameSpeed;
    const effectiveDtMS =
      dtMS * (Number.isFinite(speed) && speed > 0 ? speed : 1);
    const dtSec = effectiveDtMS / 1000;

    this.dragScaleSpring.step(dtSec, target, params, maxDtSec, substeps);
    this.dragScaleMul = this.dragScaleSpring.x;

    if (this.dragScaleSpring.isSettled(target, eps, velEps)) {
      this.dragScaleSpring.reset(target, 0);
      this.dragScaleMul = target;
      this.dragScaleAnim = null;
    }
  }

  private updateBreathing(dtMS: number): void {
    const visualConf = CONFIG.cardVisuals;
    if (!visualConf?.breathingEnabled) {
      this.breathingY = 0;
      this.wobbleRot = 0;
      return;
    }
    this.breathingTime += dtMS * visualConf.breathingSpeed;
    this.wobbleTime += dtMS * visualConf.wobbleSpeed;
    this.breathingY = Math.sin(this.breathingTime) * visualConf.breathingAmplitude;
    this.wobbleRot = Math.cos(this.wobbleTime) * visualConf.wobbleAmplitude;
  }

  private triggerHoverBreathing(): void {
    const conf = CONFIG.cardVisuals;
    if (!conf?.hoverBreathingEnabled) return;
    if ((conf.hoverBreathingMaxDurationMS ?? 0) <= 0) return;

    const deg2rad = (deg: number) => (deg * Math.PI) / 180;
    this.hoverBreathYSpring.reset(
      conf.hoverBreathingImpulseY ?? 0,
      conf.hoverBreathingImpulseYVel ?? 0,
    );
    this.hoverBreathRotSpring.reset(
      deg2rad(conf.hoverBreathingImpulseRotDeg ?? 0),
      deg2rad(conf.hoverBreathingImpulseRotVelDeg ?? 0),
    );
    this.hoverBreathingY = this.hoverBreathYSpring.x;
    this.hoverWobbleRot = this.hoverBreathRotSpring.x;
    this.hoverBreathingElapsedMS = 0;
    this.hoverBreathingActive = true;
  }

  private updateHoverBreathing(dtMS: number): void {
    const conf = CONFIG.cardVisuals;
    if (
      !conf?.hoverBreathingEnabled ||
      this.badgeState === BadgeState.Dragging ||
      !this.hoverBreathingActive
    ) {
      this.hoverBreathingY = 0;
      this.hoverWobbleRot = 0;
      if (!conf?.hoverBreathingEnabled || this.badgeState === BadgeState.Dragging) {
        this.hoverBreathingActive = false;
        this.hoverBreathYSpring.reset(0, 0);
        this.hoverBreathRotSpring.reset(0, 0);
        this.hoverBreathingElapsedMS = 0;
      }
      return;
    }

    const params = {
      mass: conf.hoverBreathingMass ?? 1,
      angularFreq: conf.hoverBreathingAngularFreq ?? 14,
      dampingRatio: conf.hoverBreathingDampingRatio ?? 0.45,
    };
    const maxDtSec = conf.hoverBreathingMaxDtSec ?? 1 / 30;
    const substeps = conf.hoverBreathingSubsteps ?? 2;
    const maxDurationMS = conf.hoverBreathingMaxDurationMS ?? 1200;

    const speed = CONFIG.gameSpeed;
    const effectiveDtMS =
      dtMS * (Number.isFinite(speed) && speed > 0 ? speed : 1);
    const dtSec = effectiveDtMS / 1000;
    this.hoverBreathingElapsedMS += effectiveDtMS;

    this.hoverBreathYSpring.step(dtSec, 0, params, maxDtSec, substeps);
    this.hoverBreathRotSpring.step(dtSec, 0, params, maxDtSec, substeps);
    this.hoverBreathingY = this.hoverBreathYSpring.x;
    this.hoverWobbleRot = this.hoverBreathRotSpring.x;

    const deg2rad = (deg: number) => (deg * Math.PI) / 180;
    const ySettled = this.hoverBreathYSpring.isSettled(
      0,
      conf.hoverBreathingSettleEpsY ?? 0.15,
      conf.hoverBreathingSettleVelY ?? 2,
    );
    const rotSettled = this.hoverBreathRotSpring.isSettled(
      0,
      deg2rad(conf.hoverBreathingSettleEpsRotDeg ?? 0.15),
      deg2rad(conf.hoverBreathingSettleVelRotDeg ?? 2),
    );
    const timedOut = this.hoverBreathingElapsedMS >= maxDurationMS;

    if ((ySettled && rotSettled) || timedOut) {
      this.hoverBreathingActive = false;
      this.hoverBreathingElapsedMS = 0;
      this.hoverBreathYSpring.reset(0, 0);
      this.hoverBreathRotSpring.reset(0, 0);
      this.hoverBreathingY = 0;
      this.hoverWobbleRot = 0;
    }
  }

  private updateHoverScale(dtMS: number): void {
    const visualConf = CONFIG.cardVisuals;
    if (!visualConf?.hoverScaleEnabled) {
      this.hoverScaleSpring.reset(1, 0);
      this.currentScale = 1;
      this.hoverScaleWasHovered = false;
      return;
    }

    const isHovered =
      !this.suppressHoverScaleUntilReenter &&
      !this.isForeignDragHoverSuppressed() &&
      this.badgeState === BadgeState.Hovered;

    const settleScale = visualConf.hoverSettleScale ?? 1.05;
    const target = isHovered ? settleScale : 1.0;

    if (isHovered && !this.hoverScaleWasHovered) {
      const x0 =
        this.hoverScaleSpring.x + (visualConf.hoverScaleImpulseScale ?? 0);
      this.hoverScaleSpring.reset(
        x0,
        visualConf.hoverScaleImpulseScaleVel ?? 0,
      );
    }
    this.hoverScaleWasHovered = isHovered;

    const params = {
      mass: visualConf.hoverScaleMass ?? 1,
      angularFreq: visualConf.hoverScaleAngularFreq ?? 16,
      dampingRatio: visualConf.hoverScaleDampingRatio ?? 0.45,
    };
    const maxDtSec = visualConf.hoverScaleMaxDtSec ?? 1 / 30;
    const substeps = visualConf.hoverScaleSubsteps ?? 2;
    const eps = visualConf.hoverScaleSettleEpsScale ?? 0.004;
    const velEps = visualConf.hoverScaleSettleVelScale ?? 0.05;

    const speed = CONFIG.gameSpeed;
    const effectiveDtMS =
      dtMS * (Number.isFinite(speed) && speed > 0 ? speed : 1);
    const dtSec = effectiveDtMS / 1000;

    this.hoverScaleSpring.step(dtSec, target, params, maxDtSec, substeps);
    if (this.hoverScaleSpring.isSettled(target, eps, velEps)) {
      this.hoverScaleSpring.reset(target, 0);
    }
    this.currentScale = this.hoverScaleSpring.x;
  }

  private updateMouse3DTilt(dtMS: number): void {
    const visualConf = CONFIG.cardVisuals;
    const S = this.size;

    const hoverActive =
      !!visualConf &&
      !!visualConf.mouse3DTiltEnabled &&
      !this.isDragging &&
      !this.isForeignDragHoverSuppressed() &&
      this.isMouseOver &&
      this.mouseLocalX !== null &&
      this.mouseLocalY !== null;

    const idleActive =
      !hoverActive &&
      !!visualConf &&
      !!visualConf.idleTiltEnabled &&
      !this.isDragging &&
      (this.badgeState === BadgeState.Normal || this.badgeState === BadgeState.Hovered);

    if (visualConf) {
      this.idleTiltTime += dtMS * (visualConf.idleTiltSpeed ?? 0.0008);
    }

    if (hoverActive) {
      const strength = visualConf!.mouse3DTiltStrength ?? 2.0;
      this.computeTiltTargetFromMouse(this.mouseLocalX!, this.mouseLocalY!, strength);
    } else if (idleActive) {
      const radius = Math.max(0, Math.min(1, visualConf!.idleTiltRadius ?? 0.55));
      const t = this.idleTiltTime;
      const cx = S / 2;
      const cy = S / 2;
      const rx = (S / 2) * radius;
      const ry = (S / 2) * radius;
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

    const smoothEnabled = visualConf?.mouse3DTiltSmoothEnabled ?? true;
    let k: number;
    if (!smoothEnabled) {
      k = 1;
    } else {
      const speed = visualConf?.mouse3DTiltSmoothing ?? 0.15;
      k = Math.min(1, Math.max(0, speed * (dtMS / 16.67)));
    }
    const c = this.currentCornerOffset;
    const t = this.targetCornerOffset;
    c.tlX += (t.tlX - c.tlX) * k;
    c.tlY += (t.tlY - c.tlY) * k;
    c.trX += (t.trX - c.trX) * k;
    c.trY += (t.trY - c.trY) * k;
    c.brX += (t.brX - c.brX) * k;
    c.brY += (t.brY - c.brY) * k;
    c.blX += (t.blX - c.blX) * k;
    c.blY += (t.blY - c.blY) * k;
  }

  private computeTiltTargetFromMouse(mx: number, my: number, strength: number): void {
    const S = this.size;
    const zMax = strength * 14;
    const focal = 240;
    const corners: Array<{ x: number; y: number; key: "tl" | "tr" | "br" | "bl" }> = [
      { x: 0, y: 0, key: "tl" },
      { x: S, y: 0, key: "tr" },
      { x: S, y: S, key: "br" },
      { x: 0, y: S, key: "bl" },
    ];
    const diag = Math.hypot(S, S);
    // 与 CardView 共用基础圆球半径（徽章无手牌左右梯度）。
    const sphereRadius = Math.max(0.05, CONFIG.cardVisuals?.mouse3DTiltSphereRadius ?? 1);
    const charLen = Math.max(1e-3, diag * sphereRadius);
    const cx = S / 2;
    const cy = S / 2;

    for (const corner of corners) {
      const d = Math.hypot(corner.x - mx, corner.y - my);
      const tt = d / charLen;
      const z = zMax * (1 - 2 * tt);
      const denom = focal + z;
      const k = focal / denom;
      const projX = cx + (corner.x - cx) * k;
      const projY = cy + (corner.y - cy) * k;
      const dx = projX - corner.x;
      const dy = projY - corner.y;
      if (corner.key === "tl") {
        this.targetCornerOffset.tlX = dx; this.targetCornerOffset.tlY = dy;
      } else if (corner.key === "tr") {
        this.targetCornerOffset.trX = dx; this.targetCornerOffset.trY = dy;
      } else if (corner.key === "br") {
        this.targetCornerOffset.brX = dx; this.targetCornerOffset.brY = dy;
      } else {
        this.targetCornerOffset.blX = dx; this.targetCornerOffset.blY = dy;
      }
    }
  }

  private applyVisuals(): void {
    const S = this.size;
    if (this.tiltMesh) {
      const co = this.currentCornerOffset;
      this.tiltMesh.setCorners(
        0 + co.tlX, 0 + co.tlY,
        S + co.trX, 0 + co.trY,
        S + co.brX, S + co.brY,
        0 + co.blX, S + co.blY,
      );
    }

    const scale = this.currentScale * this.dragScaleMul;
    this.displayWrapper.scale.set(scale);
    this.displayWrapper.position.set(
      S / 2,
      S / 2 + this.breathingY + this.hoverBreathingY,
    );
    this.displayWrapper.rotation = this.wobbleRot + this.hoverWobbleRot;
  }

  private restartHoverScaleEntrance(opts?: { forceImmediate?: boolean }): void {
    const conf = CONFIG.cardVisuals;
    const impulse = conf?.hoverScaleImpulseScale ?? 0;
    const impulseVel = conf?.hoverScaleImpulseScaleVel ?? 0;
    this.hoverScaleSpring.reset(1 + impulse, impulseVel);
    this.currentScale = this.hoverScaleSpring.x;
    this.hoverScaleWasHovered = true;

    const immediate = opts?.forceImmediate === true || this.dragScaleMul <= 1.02;
    if (immediate) {
      this.suppressHoverScaleUntilReenter = false;
      this.triggerHoverBreathing();
    } else {
      this.suppressHoverScaleUntilReenter = true;
      this.hoverScaleWasHovered = false;
    }
  }

  // ---- rope / helpers --------------------------------------------

  private syncRopePose(opts?: { x?: number; y?: number; rotation?: number }): void {
    const x = opts?.x ?? this.x;
    const y = opts?.y ?? this.y;
    const rot = opts?.rotation ?? this.rotation;
    this.x = x;
    this.y = y;
    this.rotation = rot;
    this.moveTargetX = x;
    this.moveTargetY = y;
    this.moveTargetRotation = rot;
    this.hasMoveTarget = true;
    this.ropeMotion.reset({ x, y, rotation: 0 });
    this.ropeMotion.setTarget(x, y);
    this.applyProgramRopeAnchor();
  }

  private applyProgramRopeAnchor(): void {
    const a = defaultElasticRopeAnchorLocal();
    this.ropeMotion.setAnchorLocal(a.x, a.y);
  }

  private mapAnchorLocal(localX: number, _localY: number): { x: number; y: number } {
    const a = CONFIG.elasticRopeCard.anchor;
    const S = this.size;
    const cx = localX - S / 2;
    let anchorLocalX: number;
    if (a.mapMode === "leftRightHalf") {
      anchorLocalX = cx < 0 ? a.anchorXMin : a.anchorXMax;
    } else {
      const t = Math.max(0, Math.min(1, localX / S));
      anchorLocalX = a.anchorXMin + (a.anchorXMax - a.anchorXMin) * t;
    }
    return { x: anchorLocalX, y: a.anchorY };
  }

  private cachePointerGlobal(event: FederatedPointerEvent): void {
    this.lastPointerGlobalX = event.global.x;
    this.lastPointerGlobalY = event.global.y;
    this.hasLastPointerGlobal = true;
  }

  private refreshMouseLocalFromGlobal(): void {
    if (!this.hasLastPointerGlobal) return;
    if (!this.isMouseOver && !this.isDragging) return;
    const local = this.toLocal({
      x: this.lastPointerGlobalX,
      y: this.lastPointerGlobalY,
    });
    this.mouseLocalX = local.x;
    this.mouseLocalY = local.y;
  }

  private tryBindSelfTicker(): void {
    if (this.externalUpdate || this.unsubscribeTick) return;
    const tryBind = (): void => {
      if (this.externalUpdate || this.destroyed) return;
      const ticker = uiHierarchy.getTicker();
      if (!ticker) {
        requestAnimationFrame(tryBind);
        return;
      }
      const onTick = (t: Ticker): void => {
        if (this.destroyed || this.externalUpdate) return;
        this.update(t.deltaMS);
        this.updateShadow();
      };
      ticker.add(onTick);
      this.unsubscribeTick = (): void => {
        ticker.remove(onTick);
      };
    };
    tryBind();
  }

  private unbindSelfTicker(): void {
    if (this.unsubscribeTick) {
      this.unsubscribeTick();
      this.unsubscribeTick = null;
    }
  }

  private getRootStage(): any {
    let root: any = this.parent;
    if (!root) return null;
    while (root.parent) root = root.parent;
    return root;
  }

  /** 注册全局拖拽会话，阻止其它卡牌在拖拽期间触发触碰动画。 */
  private acquireDragSession(): void {
    if (this.dragSessionHeld) return;
    beginDragSession();
    this.dragSessionHeld = true;
  }

  private releaseDragSession(): void {
    if (!this.dragSessionHeld) return;
    endDragSession();
    this.dragSessionHeld = false;
  }

  /**
   * 是否应抑制「他人拖拽划过」带来的 hover 视效。
   * 自身 isDragging 时不算 foreign。
   */
  private isForeignDragHoverSuppressed(): boolean {
    return isDragSessionActive() && !this.isDragging;
  }

  override destroy(options?: Parameters<UINode["destroy"]>[0]): void {
    this.unbindSelfTicker();
    this.releaseDragSession();
    if (this.dragData) {
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
      this.dragData = null;
    }
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
    super.destroy(options);
  }
}
