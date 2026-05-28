import type { CardView } from "@render/CardView";
import type { TweenManager } from "@tween/TweenManager";
import { Easing } from "@tween/Easing";
import { CONFIG } from "@game/config";
import { CardFx } from "./CardFx";

/**
 * 出牌堆视效集合（骨架占位）
 *
 * 这里的每一个方法都对应 PlayPipeline 的一个阶段子动作。
 * 当前实现走最简 tween 把"位移正确性"先做出来，复杂视觉细节（过冲曲线、
 * 阴影抬起、内缩双弹爆字、阴影收回等）作为 TODO 钩子留给未来。
 *
 * 替换升级路径：
 *   - 改成贝塞尔曲线驱动的过冲：在 landOnPile 内部把 CardFx.moveTo 换成
 *     一个新写的两段补间（参考 CardFx.moveToWithOvershoot）。
 *   - 阴影抬起：让 liftPile / dropPile 同时对 CardView 的阴影距离参数做 tween。
 *   - 内缩 + 双弹：用一个包装 Container 把出牌堆当作整体做 scale 动画。
 *
 * 现阶段保持"不动 CardView 内部状态、不引入新 Container"的克制原则，
 * 仅写 x/y 字段；这样不会与现有 hover/tilt/shadow 系统冲突。
 */

/** 等待若干毫秒（基于 setTimeout，与 tween 时长一致即可对齐）。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const PlayPileFx = {
  /**
   * 把一张牌从当前位置飞到出牌堆槽位。
   *
   * 当前实现：复用 CardFx.moveTo（单段缓动）。
   * TODO(future visual)：
   *   - 加"过冲反弹"两段补间，过冲幅度 = overshootPx（已经由调用方按位置插值）。
   *   - 加微旋转 / 微缩放，表达"摔到桌面"的力量感。
   *
   * @param overshootPx 过冲幅度（像素，沿运动方向）。当前未消费，留给未来视觉。
   */
  landOnPile(
    tm: TweenManager,
    card: CardView,
    slot: { x: number; y: number; rotation: number },
    overshootPx: number,
    durationMS: number
  ): Promise<void> {
    void overshootPx;
    const playCfg = CONFIG.playCardMove;
    if (!playCfg || !playCfg.enabled) {
      return CardFx.moveTo(tm, card, slot, durationMS);
    }

    const dx = slot.x - card.x;
    const dy = slot.y - card.y;
    const dist = Math.hypot(dx, dy);

    if (dist < 1e-3) {
      card.x = slot.x;
      card.y = slot.y;
      card.rotation = slot.rotation;
      return Promise.resolve();
    }

    const nx = dx / dist;
    const ny = dy / dist;

    const { overshoot1Px, overshoot2Px, stiffness } = playCfg;

    const p1x = slot.x + nx * overshoot1Px;
    const p1y = slot.y + ny * overshoot1Px;

    const p2x = slot.x - nx * overshoot2Px;
    const p2y = slot.y - ny * overshoot2Px;

    const p3x = slot.x;
    const p3y = slot.y;

    const rebound1MS = Math.max(1, Math.round(1000 / stiffness));
    const rebound2MS = Math.max(1, Math.round(1000 / stiffness));

    return new Promise<void>((resolve) => {
      tm.add(
        tm
          .create(card)
          .to({ x: p1x, y: p1y, rotation: slot.rotation }, durationMS)
          .easing(Easing.cubicOut)
          .onStop(resolve)
          .onComplete(() => {
            if (card.isDragging) {
              resolve();
              return;
            }
            tm.add(
              tm
                .create(card)
                .to({ x: p2x, y: p2y }, rebound1MS)
                .easing(Easing.quadInOut)
                .onStop(resolve)
                .onComplete(() => {
                  if (card.isDragging) {
                    resolve();
                    return;
                  }
                  tm.add(
                    tm
                      .create(card)
                      .to({ x: p3x, y: p3y }, rebound2MS)
                      .easing(Easing.cubicOut)
                      .onStop(resolve)
                      .onComplete(resolve)
                  );
                })
            );
          })
      );
    });
  },

  /**
   * 整堆上抬一次。
   *
   * 当前实现：对每张牌的 y 做同步 tween（y -= liftPx）。
   * TODO(future visual)：
   *   - 加阴影抬起（同时对 shadow 距离/scale 做 tween）。
   *   - 加过冲（lift 到 -liftPx - liftOvershootPx 再回弹 +liftOvershootPx）。
   */
  liftPile(
    tm: TweenManager,
    views: readonly CardView[],
    liftPx: number,
    durationMS: number,
    _overshootPx: number = 0
  ): Promise<void> {
    void _overshootPx; // TODO: 未来过冲段
    const promises = views.map(
      (v) =>
        new Promise<void>((resolve) => {
          tm.add(
            tm
              .create(v)
              .to({ y: v.y - liftPx }, durationMS)
              .easing(Easing.cubicOut)
              .onComplete(resolve)
          );
        })
    );
    return Promise.all(promises).then(() => undefined);
  },

  /**
   * 结算"内缩 → 过大弹两次"。
   *
   * 当前实现（占位）：用 y 微抖动作为占位，确保时序正确即可。
   * TODO(future visual)：
   *   - 把每张牌或整堆容器 scale 从 1 → squashScale → bouncePeakScale → 1
   *     做 (1 + bounceCount × 2) 段补间。
   *   - 在每次峰值瞬间触发 "+xxx" 弹字（订阅 play:settled 后由 TextFx 实现）。
   *
   * 参数预留给未来：
   * @param squashScale       内缩 scale 目标（如 0.9）
   * @param bouncePeakScale   过大弹峰值 scale（如 1.12）
   * @param bounceCount       过大弹次数
   * @param squashDurationMS  内缩时长
   * @param bounceDurationMS  单次过大弹时长
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
    // 占位实现：用 y 上下微抖动模拟"先压缩、再弹起两次"的节奏。
    // 振幅取 bouncePeakScale 衍生的视觉量（很小，仅用于让流程可见）。
    void params.squashScale; // TODO(future visual)
    const peak = (params.bouncePeakScale - 1) * 80; // 像素，占位经验值
    const squash = (1 - params.squashScale) * 50; // 像素，占位经验值

    const seq: Promise<void> = (async () => {
      // 内缩：整堆 y += squash（视觉上像被压扁）
      await Promise.all(
        views.map(
          (v) =>
            new Promise<void>((resolve) => {
              tm.add(
                tm
                  .create(v)
                  .to({ y: v.y + squash }, params.squashDurationMS)
                  .easing(Easing.cubicOut)
                  .onComplete(resolve)
              );
            })
        )
      );
      // 过大弹若干次：y -= peak → y += 0
      for (let b = 0; b < Math.max(1, params.bounceCount); b++) {
        await Promise.all(
          views.map(
            (v) =>
              new Promise<void>((resolve) => {
                const back = v.y - squash; // 回到内缩前的位置
                tm.add(
                  tm
                    .create(v)
                    .to({ y: back - peak }, params.bounceDurationMS / 2)
                    .easing(Easing.cubicOut)
                    .onComplete(resolve)
                );
              })
          )
        );
        await Promise.all(
          views.map(
            (v) =>
              new Promise<void>((resolve) => {
                const back = v.y + peak; // 从过大弹峰回到基准
                tm.add(
                  tm
                    .create(v)
                    .to({ y: back }, params.bounceDurationMS / 2)
                    .easing(Easing.cubicOut)
                    .onComplete(resolve)
                );
              })
          )
        );
      }
    })();
    return seq;
  },

  /**
   * 整堆下移。
   *
   * 当前实现：每张牌 y += liftPx（与 lift 对称）。
   * TODO(future visual)：收回阴影、加过冲。
   */
  dropPile(
    tm: TweenManager,
    views: readonly CardView[],
    liftPx: number,
    durationMS: number
  ): Promise<void> {
    const promises = views.map(
      (v) =>
        new Promise<void>((resolve) => {
          tm.add(
            tm
              .create(v)
              .to({ y: v.y + liftPx }, durationMS)
              .easing(Easing.cubicOut)
              .onComplete(resolve)
          );
        })
    );
    return Promise.all(promises).then(() => undefined);
  },

  /**
   * 单张丢牌：直接复用 CardFx.flyOut（飞到屏幕右上方外）。
   * TODO(future visual)：未来引入 DiscardView 后改为飞向 discard 锚点。
   */
  flyToDiscard(
    tm: TweenManager,
    card: CardView,
    worldWidth: number,
    durationMS: number
  ): Promise<void> {
    return CardFx.flyOut(tm, card, worldWidth, durationMS);
  },
};
