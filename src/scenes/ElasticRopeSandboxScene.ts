/**
 * 弹性绳子牵引 — 单卡隔离沙盒
 *
 * 入口：?scene=elastic-rope
 * 规格：docs/elastic-rope-traction-card-model.md
 */

import type { App } from "@core/App";
import { Layers } from "@core/Layers";
import { CONFIG } from "@game/config";
import { CardView } from "@render/CardView";
import { CardSkin } from "@render/CardSkin";
import type { CardData } from "@domain/types";
import { ElasticRopeMotion } from "@/motion/ElasticRopeMotion";
import { ElasticRopeDebugDraw } from "@/motion/ElasticRopeDebugDraw";
import type { ElasticRopeParams } from "@/motion/ElasticRopeTypes";
import { Graphics } from "pixi.js";

function readRopeParams(): ElasticRopeParams {
  const c = CONFIG.elasticRopeCard;
  return {
    enabled: c.enabled,
    spring: { ...c.spring },
    airDrag: { ...c.airDrag },
    integration: { ...c.integration },
    settle: { ...c.settle },
    rotation: { ...c.rotation },
  };
}

function mapAnchorLocal(
  localX: number,
  _localY: number,
): { x: number; y: number } {
  const a = CONFIG.elasticRopeCard.anchor;
  const W = CardSkin.width;
  // CardView pivot 在中心；getLocalPosition 的原点在牌左上 → 中心相对量
  const cx = localX - W / 2;
  let anchorLocalX: number;
  if (a.mapMode === "leftRightHalf") {
    anchorLocalX = cx < 0 ? a.anchorXMin : a.anchorXMax;
  } else {
    const t = Math.max(0, Math.min(1, localX / W));
    anchorLocalX = a.anchorXMin + (a.anchorXMax - a.anchorXMin) * t;
  }
  return { x: anchorLocalX, y: a.anchorY };
}

export class ElasticRopeSandboxScene {
  private card: CardView | null = null;
  private motion = new ElasticRopeMotion();
  private debugDraw = new ElasticRopeDebugDraw();
  private bg: Graphics | null = null;
  private unsubUpdate: (() => void) | null = null;
  private pointerParentX = 0;
  private pointerParentY = 0;
  private isPointerDown = false;

  constructor(private readonly app: App) {}

  start(): void {
    const W = CONFIG.world.width;
    const H = CONFIG.world.height;

    this.bg = new Graphics();
    this.bg.rect(0, 0, W, H);
    this.bg.fill({ color: CONFIG.world.backgroundColor });
    this.bg.zIndex = Layers.Background;
    this.bg.eventMode = "none";
    this.app.worldRoot.addChild(this.bg);

    this.debugDraw.root.zIndex = Layers.Fx;
    this.app.worldRoot.addChild(this.debugDraw.root);

    const data: CardData = {
      id: "elastic-sandbox-AS",
      suit: "♠",
      rank: "A",
      value: 14,
      chips: 11,
    };
    const card = new CardView(data, {
      onClick: () => {},
      onHoverIn: () => {},
      onHoverOut: () => {},
      onDragStart: (view) => {
        this.isPointerDown = true;
        // 按下瞬间目标贴当前牌心，随后 onDragging 用 dragTarget 更新
        this.pointerParentX = view.x;
        this.pointerParentY = view.y;
        if (CONFIG.elasticRopeCard.sandbox.followPointerWhileDown) {
          this.motion.setTarget(view.x, view.y);
        }
      },
      onDragging: (_view, x, y) => {
        this.pointerParentX = x;
        this.pointerParentY = y;
        this.isPointerDown = true;
      },
      onDragEnd: () => {
        this.isPointerDown = false;
        const sb = CONFIG.elasticRopeCard.sandbox;
        if (sb.freezeTargetOnRelease) {
          this.motion.setTarget(this.pointerParentX, this.pointerParentY);
        }
      },
    });

    card.positionDriver = "external";
    card.zIndex = Layers.Card;
    card.x = W / 2;
    card.y = H / 2;
    this.app.worldRoot.addChild(card);
    this.card = card;

    this.motion.reset({ x: card.x, y: card.y, rotation: 0 });
    this.pointerParentX = card.x;
    this.pointerParentY = card.y;

    // 在 pointerdown 时设置锚点：劫持 card 的事件不够干净，用 stage 捕获
    card.on("pointerdown", this.onCardPointerDown);

    this.unsubUpdate = this.app.onUpdate((dtMS) => this.tick(dtMS));
  }

  private readonly onCardPointerDown = (e: {
    getLocalPosition: (o: CardView) => { x: number; y: number };
  }): void => {
    if (!this.card) return;
    const local = e.getLocalPosition(this.card);
    const anchor = mapAnchorLocal(local.x, local.y);
    this.motion.setAnchorLocal(anchor.x, anchor.y);
  };

  private tick(dtMS: number): void {
    const card = this.card;
    if (!card) return;

    const cfg = CONFIG.elasticRopeCard;
    const sb = cfg.sandbox;

    if (this.isPointerDown && sb.followPointerWhileDown) {
      this.motion.setTarget(this.pointerParentX, this.pointerParentY);
    }

    // 同步 isPointerDown 与 isDragging（CardView 内部会设 isDragging）
    if (card.isDragging) {
      this.isPointerDown = true;
    }

    const params = readRopeParams();
    const pose = this.motion.step(dtMS, params);
    card.x = pose.x;
    card.y = pose.y;
    card.rotation = pose.rotation;

    // CardView 自身 update（缩放/阴影等），位置已由 external 接管
    card.update(dtMS);

    const snap = this.motion.getDebug();
    this.debugDraw.update(snap, {
      drawRope: cfg.debug.drawRope,
      drawAnchor: cfg.debug.drawAnchor,
      showHud: cfg.debug.showHudReadouts,
      elasticColor: cfg.debug.elasticColor,
      rigidColor: cfg.debug.rigidColor,
    });
  }

  destroy(): void {
    this.unsubUpdate?.();
    this.unsubUpdate = null;
    if (this.card) {
      this.card.off("pointerdown", this.onCardPointerDown);
      this.card.destroy({ children: true });
      this.card = null;
    }
    this.debugDraw.destroy();
    if (this.bg) {
      this.bg.destroy();
      this.bg = null;
    }
  }
}
