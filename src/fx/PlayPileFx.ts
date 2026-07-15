import type { CardView } from "@render/CardView";
import type { TweenManager } from "@tween/TweenManager";
import { CONFIG } from "@game/config";
import { SpringDamper1D } from "@/motion/SpringDamper1D";
import { CardFx } from "./CardFx";

/**
 * 出牌堆视效集合 — 位移统一走弹性绳（setMoveTarget / waitSettled）。
 * 结算缩放/旋转：弹簧阻尼 1D（docs/play-pile-settle-spring-damper-plan.md）。
 */

/** 结算弹簧配置（与 CONFIG.playPileSettleEffect 弹簧字段一致；时间字段由 Pipeline 预缩放）。 */
export type SettleSpringConfig = {
  mass: number;
  angularFreq: number;
  dampingRatio: number;
  impulseScale: number;
  impulseScaleVel: number;
  impulseRotDeg: number;
  impulseRotVelDeg: number;
  settleEpsScale: number;
  settleVelScale: number;
  settleEpsRotDeg: number;
  settleVelRotDeg: number;
  maxDurationMS: number;
  maxDtSec: number;
  substeps: number;
  textTriggerMS: number;
};

/** 等待若干毫秒。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const PlayPileFx = {
  /**
   * 把一张牌从当前位置飞到出牌堆槽位。
   * overshootPx / durationMS 保留签名，位移由弹性绳处理。
   */
  landOnPile(
    tm: TweenManager,
    card: CardView,
    slot: { x: number; y: number; rotation: number },
    _overshootPx: number,
    _durationMS: number
  ): Promise<void> {
    void _overshootPx;
    void _durationMS;

    card.isPlayCardMoving = true;

    const dist = Math.hypot(slot.x - card.x, slot.y - card.y);
    if (dist < 1e-3) {
      card.syncRopePose({
        x: slot.x,
        y: slot.y,
        rotation: slot.rotation,
      });
      card.isPlayCardMoving = false;
      return Promise.resolve();
    }

    tm.killOf(card);
    card.setMoveTarget(slot.x, slot.y, slot.rotation);
    return card.waitSettled().then(() => {
      card.isPlayCardMoving = false;
    });
  },

  /**
   * 整堆上抬：每张牌 y 目标 -= liftPx。
   */
  liftPile(
    tm: TweenManager,
    views: readonly CardView[],
    liftPx: number,
    _durationMS: number,
    _overshootPx: number = 0
  ): Promise<void> {
    void _durationMS;
    void _overshootPx;
    return Promise.all(
      views.map((v) => {
        tm.killOf(v);
        v.setMoveTarget(v.x, v.y - liftPx, v.rotation);
        return v.waitSettled();
      })
    ).then(() => undefined);
  },

  /**
   * 结算占位：y 微抖动节奏（仍用目标点 + 绳，避免 Tween 与绳抢写）。
   */
  settleSquash(
    tm: TweenManager,
    views: readonly CardView[],
    params: {
      squashScale: number;
      bouncePeakScale: number;
      bounceCount: number;
      squashDurationMS: number;
      bounceDurationMS: number;
    }
  ): Promise<void> {
    void params.squashScale;
    const peak = (params.bouncePeakScale - 1) * 80;
    const squash = (1 - params.squashScale) * 50;

    return (async () => {
      const bases = views.map((v) => v.y);
      await Promise.all(
        views.map((v, i) => {
          tm.killOf(v);
          v.setMoveTarget(v.x, bases[i]! + squash, v.rotation);
          return v.waitSettled();
        })
      );
      for (let b = 0; b < Math.max(1, params.bounceCount); b++) {
        await Promise.all(
          views.map((v, i) => {
            tm.killOf(v);
            v.setMoveTarget(v.x, bases[i]! + squash - peak, v.rotation);
            return v.waitSettled();
          })
        );
        await Promise.all(
          views.map((v, i) => {
            tm.killOf(v);
            v.setMoveTarget(v.x, bases[i]! + squash, v.rotation);
            return v.waitSettled();
          })
        );
      }
      // 回到内缩前基准
      await Promise.all(
        views.map((v, i) => {
          tm.killOf(v);
          v.setMoveTarget(v.x, bases[i]!, v.rotation);
          return v.waitSettled();
        })
      );
    })();
  },

  /**
   * 整堆下移：与 lift 对称。
   */
  dropPile(
    tm: TweenManager,
    views: readonly CardView[],
    liftPx: number,
    _durationMS: number
  ): Promise<void> {
    void _durationMS;
    return Promise.all(
      views.map((v) => {
        tm.killOf(v);
        v.setMoveTarget(v.x, v.y + liftPx, v.rotation);
        return v.waitSettled();
      })
    ).then(() => undefined);
  },

  flyToDiscard(
    tm: TweenManager,
    card: CardView,
    worldWidth: number,
    worldHeight: number,
    durationMS: number,
    targetRotation?: number
  ): Promise<void> {
    return CardFx.flyToDiscardPile(
      tm,
      card,
      worldWidth,
      worldHeight,
      durationMS,
      targetRotation
    );
  },

  /**
   * 计分抬升：目标 = 当前 y 上移 peakDist（自然过冲由绳提供）。
   */
  liftCardScoring(
    tm: TweenManager,
    card: CardView,
    cfg: {
      startSpeed: number;
      decelerateTime: number;
    }
  ): Promise<void> {
    const peakDist = (cfg.startSpeed * cfg.decelerateTime) / 2;
    const stableY = card.y - peakDist;

    card.isScoringLifted = true;
    card.updateShadow();

    tm.killOf(card);
    card.setMoveTarget(card.x, stableY, card.rotation);
    return card.waitSettled();
  },

  /**
   * 计分下落：目标 = targetY（自然过冲由绳提供）。
   */
  dropCardScoring(
    tm: TweenManager,
    card: CardView,
    targetY: number,
    _cfg?: unknown
  ): Promise<void> {
    void _cfg;

    card.isScoringLifted = false;
    card.updateShadow();

    tm.killOf(card);
    card.setMoveTarget(card.x, targetY, card.rotation);
    return card.waitSettled();
  },

  /**
   * 计分卡牌结算：双通道弹簧阻尼（scale→1，rot→0），只写 scoring 通道。
   * 时钟：CardView.settleSpringTick（App 帧 dt）；逻辑时间 dtMS * gameSpeed。
   * 见 docs/play-pile-settle-spring-damper-plan.md §5.2 方式 B。
   */
  animateCardSettle(
    tm: TweenManager,
    card: CardView,
    cfg: SettleSpringConfig,
    onTextTrigger?: () => void
  ): Promise<void> {
    const deg2rad = (deg: number) => (deg * Math.PI) / 180;

    tm.killOf(card);
    card.settleSpringTick = null;

    const scaleSpring = new SpringDamper1D();
    const rotSpring = new SpringDamper1D();
    scaleSpring.reset(1 + cfg.impulseScale, cfg.impulseScaleVel);
    rotSpring.reset(deg2rad(cfg.impulseRotDeg), deg2rad(cfg.impulseRotVelDeg));

    card.scoringScaleMul = scaleSpring.x;
    card.scoringRotOffset = rotSpring.x;

    const params = {
      mass: cfg.mass,
      angularFreq: cfg.angularFreq,
      dampingRatio: cfg.dampingRatio,
    };

    let elapsedMS = 0;
    let textFired = false;
    let finished = false;

    return new Promise<void>((resolve) => {
      const finish = (): void => {
        if (finished) return;
        finished = true;
        card.settleSpringTick = null;
        scaleSpring.x = 1;
        scaleSpring.v = 0;
        rotSpring.x = 0;
        rotSpring.v = 0;
        card.scoringScaleMul = 1;
        card.scoringRotOffset = 0;
        resolve();
      };

      card.settleSpringTick = (dtMS: number) => {
        if (finished) return;

        const speed = CONFIG.gameSpeed;
        const effectiveDtMS =
          dtMS * (Number.isFinite(speed) && speed > 0 ? speed : 1);
        const dtSec = effectiveDtMS / 1000;
        elapsedMS += effectiveDtMS;

        scaleSpring.step(dtSec, 1, params, cfg.maxDtSec, cfg.substeps);
        rotSpring.step(dtSec, 0, params, cfg.maxDtSec, cfg.substeps);
        card.scoringScaleMul = scaleSpring.x;
        card.scoringRotOffset = rotSpring.x;

        if (!textFired && elapsedMS >= cfg.textTriggerMS) {
          textFired = true;
          onTextTrigger?.();
        }

        const rotEps = deg2rad(cfg.settleEpsRotDeg);
        const rotVelEps = deg2rad(cfg.settleVelRotDeg);
        const settled =
          scaleSpring.isSettled(1, cfg.settleEpsScale, cfg.settleVelScale) &&
          rotSpring.isSettled(0, rotEps, rotVelEps);
        const timedOut = elapsedMS >= cfg.maxDurationMS;

        if (settled || timedOut) {
          finish();
        }
      };
    });
  },
};
