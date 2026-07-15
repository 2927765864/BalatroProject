/**
 * 弹性绳子牵引 — 单卡隔离沙盒
 *
 * 入口：?scene=elastic-rope
 * 与主场景共用 CardView 内嵌绳驱动。
 */

import type { App } from "@core/App";
import { Layers } from "@core/Layers";
import { CONFIG } from "@game/config";
import { CardView } from "@render/CardView";
import type { CardData } from "@domain/types";
import { ElasticRopeDebugDraw } from "@/motion/ElasticRopeDebugDraw";
import { Graphics } from "pixi.js";

export class ElasticRopeSandboxScene {
  private card: CardView | null = null;
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
        this.pointerParentX = view.x;
        this.pointerParentY = view.y;
      },
      onDragging: (_view, x, y) => {
        this.pointerParentX = x;
        this.pointerParentY = y;
        this.isPointerDown = true;
      },
      onDragEnd: () => {
        this.isPointerDown = false;
        const sb = CONFIG.elasticRopeCard.sandbox;
        // 松手：主场景会 layoutHand 回槽；沙盒按 freezeTargetOnRelease 冻结指针目标
        if (sb.freezeTargetOnRelease && this.card) {
          this.card.setMoveTarget(this.pointerParentX, this.pointerParentY);
        }
      },
    });

    card.positionDriver = "external";
    card.zIndex = Layers.Card;
    card.x = W / 2;
    card.y = H / 2;
    card.syncRopePose({ x: card.x, y: card.y, rotation: 0 });
    this.app.worldRoot.addChild(card);
    this.card = card;

    this.pointerParentX = card.x;
    this.pointerParentY = card.y;

    this.unsubUpdate = this.app.onUpdate((dtMS) => this.tick(dtMS));
  }

  private tick(dtMS: number): void {
    const card = this.card;
    if (!card) return;

    if (card.isDragging) {
      this.isPointerDown = true;
    }

    // 沙盒：按下时目标跟指针（CardView 拖拽路径已 setTarget dragTarget；
    // 松手后 setMoveTarget 冻结点由 onDragEnd 写入）
    void this.isPointerDown;

    card.update(dtMS);

    const cfg = CONFIG.elasticRopeCard;
    const snap = card.getRopeMotion().getDebug();
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
