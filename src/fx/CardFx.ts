import type { CardView } from "@render/CardView";
import type { TweenManager } from "@tween/TweenManager";
import { Easing, type EaseFn } from "@tween/Easing";
import type { BezierCurveConfig } from "@game/config";

/**
 * 把 BezierCurveConfig 当成"自定义缓动函数"采样。
 * 端点固定 (0,0)→(1,1)，curve.p1/p2.y 决定形状。
 * 这里只用 y 通道（startScale/endScale 不掺合，t→eased(t) 的语义）。
 */
function curveToEase(curve: BezierCurveConfig): EaseFn {
  const p1y = curve.p1.y;
  const p2y = curve.p2.y;
  return (t: number): number => {
    const tt = t < 0 ? 0 : t > 1 ? 1 : t;
    const it = 1 - tt;
    // 三次贝塞尔 y(t)，端点 y0=0, y3=1
    return 3 * it * it * tt * p1y + 3 * it * tt * tt * p2y + tt * tt * tt;
  };
}

/**
 * 卡牌视效集合
 *
 * 当前暴露：
 *   - moveTo  ：平滑移动到目标位姿（通用重排）。
 *   - flyOut  ：飞出回收。
 *   - selectMove：选中/取消选中的"上升/下降 + 过弹 + 阻尼回弹"两段补间，
 *               配合 CardView.isSelectAnimating 标志使用，由 GameController 调度。
 *
 * 所有动画都返回 Promise，便于上层串成动画序列。
 */
export const CardFx = {
  /** 平滑移动到目标位姿。原型里手写的 lerp 替代品。 */
  moveTo(
    tm: TweenManager,
    card: CardView,
    target: { x: number; y: number; rotation: number },
    durationMS = 280
  ): Promise<void> {
    return new Promise((resolve) => {
      tm.add(
        tm
          .create(card)
          .to(target, durationMS)
          .easing(Easing.cubicOut)
          .onComplete(resolve)
      );
    });
  },

  /** 飞出屏幕的回收动画（终点在世界右上方外）。 */
  flyOut(
    tm: TweenManager,
    card: CardView,
    worldWidth: number,
    durationMS = 320
  ): Promise<void> {
    return new Promise((resolve) => {
      tm.add(
        tm
          .create(card)
          .to(
            {
              x: worldWidth + 200,
              y: -200,
              rotation: Math.PI,
            },
            durationMS
          )
          .easing(Easing.cubicIn)
          .onComplete(resolve)
      );
    });
  },

  /**
   * 选中 / 取消选中的两段位移动画。
   *
   * 第一段（rise/fall）：当前 y → 过弹点 y（最终 y 沿位移方向再多走 overshoot 像素），
   *                     时长 durationMS，用 curve 作为缓动（curve 关闭时退化为 cubicOut）。
   * 第二段（spring）   ：过弹点 y → 最终 y，时长 = round(1000 / stiffness)，用 cubicOut 收敛。
   *
   * 同时把 x/rotation 也作为第一段的目标值（它们不参与过弹，第二段不再写）。
   *
   * 该动画期间，调用方应：
   *   - 把 card.isSelectAnimating 置 true，并在 onSettle 回调中清零；
   *   - 在 layoutHand 中跳过对该牌的 moveTo（避免 TweenManager 同字段冲突踢掉过弹段）。
   *
   * 注意：在 TweenManager 中"同对象同字段新 tween 会停掉旧 tween"。
   * 第二段对 y 字段的新 tween 会自动停掉第一段（此时第一段已 onComplete，无副作用）。
   *
   * @param tm           TweenManager 实例
   * @param card         目标 CardView
   * @param target       最终落点位姿（基于 HandLayout 计算后的 slot）
   * @param direction    "rise" = 选中向上、过弹点在 target.y 上方；
   *                     "fall" = 取消向下、过弹点在 target.y 下方。
   * @param opts         { durationMS, curve, overshoot, stiffness }
   * @param opts.onSettle 两段都结束时回调（用于业务侧清 isSelectAnimating）。
   */
  selectMove(
    tm: TweenManager,
    card: CardView,
    target: { x: number; y: number; rotation: number },
    direction: "rise" | "fall",
    opts: {
      durationMS: number;
      curve: BezierCurveConfig;
      overshoot: number;
      stiffness: number;
      onSettle?: () => void;
    }
  ): Promise<void> {
    const durationMS = Math.max(0, opts.durationMS);
    const overshoot = Math.max(0, opts.overshoot);
    // 防止 stiffness 太小导致回弹时长爆炸；最低 1，最高 1000ms 回弹时长。
    const stiffness = Math.max(0.001, opts.stiffness);
    const reboundMS = Math.min(2000, Math.round(1000 / stiffness));

    // 选中时向上越过目标 → y 减 overshoot；取消时向下越过原位 → y 加 overshoot。
    const overshootY =
      direction === "rise" ? target.y - overshoot : target.y + overshoot;

    // 第一段的速率曲线：贝塞尔 -> EaseFn；若曲线 disabled 用 cubicOut 兜底。
    const curveEnabled = opts.curve && opts.curve.enabled !== false;
    const stage1Ease: EaseFn = curveEnabled
      ? curveToEase(opts.curve)
      : Easing.cubicOut;

    return new Promise((resolve) => {
      // 第一段：x / y / rotation 同时驱动；y 到过弹点。
      tm.add(
        tm
          .create(card)
          .to(
            { x: target.x, y: overshootY, rotation: target.rotation },
            durationMS
          )
          .easing(stage1Ease)
          .onComplete(() => {
            // 第二段：只回弹 y。
            if (overshoot <= 0 || reboundMS <= 0) {
              // 没有过弹幅度/回弹时长为 0 时，直接置到位并结束。
              card.y = target.y;
              opts.onSettle?.();
              resolve();
              return;
            }
            tm.add(
              tm
                .create(card)
                .to({ y: target.y }, reboundMS)
                .easing(Easing.cubicOut)
                .onComplete(() => {
                  opts.onSettle?.();
                  resolve();
                })
            );
          })
      );
    });
  },
};
