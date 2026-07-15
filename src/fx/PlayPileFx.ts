import type { CardView } from "@render/CardView";
import type { TweenManager } from "@tween/TweenManager";
import { Easing } from "@tween/Easing";
import { CardFx } from "./CardFx";

/**
 * 出牌堆视效集合 — 位移统一走弹性绳（setMoveTarget / waitSettled）。
 * 结算缩放/旋转通道仍可用 Tween（scoringScaleMul / scoringRotOffset）。
 */

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
   * 计分卡牌结算时的弹性往复（大小 + 旋转）— scoring 通道 Tween，不写 x/y。
   */
  animateCardSettle(
    tm: TweenManager,
    card: CardView,
    cfg: {
      t1: number; t2: number; t3: number; t4: number; t5: number;
      s1: number; s2: number; s3: number; s4: number; s5: number;
      r1: number; r2: number; r3: number; r4: number;
    },
    onStage2?: () => void
  ): Promise<void> {
    const toRad = (deg: number) => (deg * Math.PI) / 180;

    const r1Rad = toRad(cfg.r1);
    const r2Rad = toRad(cfg.r2);
    const r3Rad = toRad(cfg.r3);
    const r4Rad = toRad(cfg.r4);

    return new Promise<void>((resolve) => {
      const stopCleanup = () => {
        card.scoringScaleMul = 1.0;
        card.scoringRotOffset = 0.0;
        resolve();
      };

      tm.add(
        tm
          .create(card)
          .to({ scoringScaleMul: cfg.s1, scoringRotOffset: r1Rad }, cfg.t1)
          .easing(Easing.cubicOut)
          .onStop(stopCleanup)
          .onComplete(() => {
            onStage2?.();
            tm.add(
              tm
                .create(card)
                .to({ scoringScaleMul: cfg.s2, scoringRotOffset: r2Rad }, cfg.t2)
                .easing(Easing.quadInOut)
                .onStop(stopCleanup)
                .onComplete(() => {
                  tm.add(
                    tm
                      .create(card)
                      .to({ scoringScaleMul: cfg.s3, scoringRotOffset: r3Rad }, cfg.t3)
                      .easing(Easing.quadInOut)
                      .onStop(stopCleanup)
                      .onComplete(() => {
                        tm.add(
                          tm
                            .create(card)
                            .to({ scoringScaleMul: cfg.s4, scoringRotOffset: r4Rad }, cfg.t4)
                            .easing(Easing.quadInOut)
                            .onStop(stopCleanup)
                            .onComplete(() => {
                              tm.add(
                                tm
                                  .create(card)
                                  .to(
                                    { scoringScaleMul: cfg.s5, scoringRotOffset: 0.0 },
                                    cfg.t5
                                  )
                                  .easing(Easing.cubicOut)
                                  .onStop(stopCleanup)
                                  .onComplete(() => resolve())
                              );
                            })
                        );
                      })
                  );
                })
            );
          })
      );
    });
  },
};
