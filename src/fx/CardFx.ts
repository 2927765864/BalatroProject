import type { CardView } from "@render/CardView";
import type { TweenManager } from "@tween/TweenManager";
import { CONFIG } from "@game/config";

/**
 * 卡牌位移集合 — 弹性绳子牵引后端
 *
 * 所有「移动到目标点」的路径：kill 旧位移 tween → setMoveTarget → waitSettled。
 * 速度、过冲、路径由 CardView 内 ElasticRopeMotion 处理。
 * TweenManager 仍可用于非位移（记分数字等）；位移坐标不再由 Tween 写入。
 */
export const CardFx = {
  /**
   * 平滑移动到目标位姿（弹性绳）。
   * durationMS 参数保留兼容签名，不再使用。
   */
  moveTo(
    tm: TweenManager,
    card: CardView,
    target: { x: number; y: number; rotation: number },
    _durationMS = 280
  ): Promise<void> {
    void _durationMS;
    tm.killOf(card);
    if (card.isDragging) return Promise.resolve();
    card.setMoveTarget(target.x, target.y, target.rotation);
    return card.waitSettled();
  },

  /**
   * 手牌整体垂直位移（出牌前后的下移/上移）。
   * 只改 y 与 layoutY；运动由弹性绳完成。
   */
  shiftHandGroupY(
    tm: TweenManager,
    cards: readonly CardView[],
    deltaY: number,
    _opts?: unknown
  ): Promise<void> {
    void _opts;
    if (cards.length === 0 || Math.abs(deltaY) < 1e-3) {
      return Promise.resolve();
    }

    return Promise.all(
      cards.map((card) => {
        tm.killOf(card);
        const targetY = card.y + deltaY;
        card.layoutY = (card.layoutY ?? card.y) + deltaY;
        card.setMoveTarget(card.x, targetY, card.rotation);
        return card.waitSettled();
      })
    ).then(() => undefined);
  },

  /**
   * 移动到目标位姿。原「距离过冲」已由弹性绳自然过冲替代；
   * 签名保留以兼容 layoutHand / 发牌调用方。
   */
  moveToWithOvershoot(
    tm: TweenManager,
    card: CardView,
    target: { x: number; y: number; rotation: number },
    _totalMS = 280,
    _currentSpeed = 0,
    _forceOvershoot = false,
    _speedRatio = 1.0
  ): Promise<void> {
    void _totalMS;
    void _currentSpeed;
    void _forceOvershoot;
    void _speedRatio;
    return CardFx.moveTo(tm, card, target);
  },

  /** 飞出屏幕的回收动画（终点在世界右上方外）。 */
  flyOut(
    tm: TweenManager,
    card: CardView,
    worldWidth: number,
    _durationMS = 320
  ): Promise<void> {
    void _durationMS;
    tm.killOf(card);
    card.setMoveTarget(worldWidth + 200, -200, Math.PI);
    return card.waitSettled();
  },

  /**
   * 飞向弃牌堆：终点在世界正右方外、垂直居中。
   * durationMS 仅用于 startDiscardFlip 节奏参考，位移由绳驱动。
   */
  flyToDiscardPile(
    tm: TweenManager,
    card: CardView,
    worldWidth: number,
    worldHeight: number,
    _durationMS = 320,
    targetRotation?: number
  ): Promise<void> {
    void _durationMS;
    tm.killOf(card);
    const rot =
      targetRotation !== undefined ? targetRotation : card.rotation;
    card.setMoveTarget(worldWidth + 200, worldHeight / 2, rot);
    return card.waitSettled();
  },

  /**
   * 换位 / 挤位：只设目标点，弹性绳完成运动。
   * 仍维护 isSwapAnimating + swapAnimGen 供 layoutHand 豁免。
   */
  swapMove(
    tm: TweenManager,
    card: CardView,
    target: { x: number; y: number; rotation: number },
    customCfg?: { enabled?: boolean } | null
  ): Promise<void> {
    void customCfg;
    return CardFx.runSwapStyleMove(tm, card, target, {
      enabled: customCfg?.enabled !== false,
    });
  },

  /**
   * 理牌动画：与 swap 相同，仅设目标。
   */
  sortMove(
    tm: TweenManager,
    card: CardView,
    target: { x: number; y: number; rotation: number }
  ): Promise<void> {
    return CardFx.runSwapStyleMove(tm, card, target, {
      enabled: CONFIG.handSort?.enabled !== false,
    });
  },

  /**
   * swap / sort 共用：setMoveTarget + waitSettled + 标志位。
   */
  runSwapStyleMove(
    tm: TweenManager,
    card: CardView,
    target: { x: number; y: number; rotation: number },
    opts: {
      enabled: boolean;
    }
  ): Promise<void> {
    const gen = ++card.swapAnimGen;
    card.isSwapAnimating = true;

    const clearIfMine = (): void => {
      if (card.swapAnimGen === gen) {
        card.isSwapAnimating = false;
      }
    };

    const dist = Math.hypot(target.x - card.x, target.y - card.y);
    if (dist < 1e-3 || !opts.enabled) {
      card.syncRopePose({
        x: target.x,
        y: target.y,
        rotation: target.rotation,
      });
      clearIfMine();
      return Promise.resolve();
    }

    if (card.isDragging) {
      clearIfMine();
      return Promise.resolve();
    }

    tm.killOf(card);
    card.setMoveTarget(target.x, target.y, target.rotation);

    return card.waitSettled().then(() => {
      clearIfMine();
    });
  },

  /**
   * 选中 / 取消选中位移：只设最终目标（含 selectRiseY 偏移），
   * 过冲由弹性绳自然产生。
   */
  selectMove(
    tm: TweenManager,
    card: CardView,
    target: { x: number; y: number; rotation: number },
    _direction: "rise" | "fall",
    opts: {
      startSpeed: number;
      overshoot: number;
      stiffness: number;
      onSettle?: () => void;
    }
  ): Promise<void> {
    void _direction;
    void opts.startSpeed;
    void opts.overshoot;
    void opts.stiffness;

    tm.killOf(card);

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      opts.onSettle?.();
    };

    const dist = Math.hypot(target.x - card.x, target.y - card.y);
    if (dist < 1e-3) {
      card.syncRopePose({
        x: target.x,
        y: target.y,
        rotation: target.rotation,
      });
      settle();
      return Promise.resolve();
    }

    if (card.isDragging) {
      settle();
      return Promise.resolve();
    }

    card.setMoveTarget(target.x, target.y, target.rotation);
    return card.waitSettled().then(() => {
      settle();
    });
  },
};
