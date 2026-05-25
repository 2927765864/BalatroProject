import type { CardView } from "@render/CardView";
import type { TweenManager } from "@tween/TweenManager";
import { Easing, type EaseFn } from "@tween/Easing";
import { CONFIG, type BezierCurveConfig } from "@game/config";

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

  /**
   * 带过冲反弹的"平滑移动到目标位姿"——moveTo 的进阶版。
   *
   * 仅当 currentSpeed ≥ dragHandCard.maxSpeed × cardOvershoot.tweenSpeedRatioThreshold
   * （或显式 forceOvershoot=true）时启用两段动画：
   *   第一段（rise）：起点 → 沿运动方向越过终点 overshootPx 像素的过冲点，
   *                   时长 = totalMS × tweenRiseRatio，缓动 = tweenRiseCurve（贝塞尔）。
   *   第二段（spring）：过冲点 → 真正终点，时长 = round(1000 / tweenSpringStiffness)，
   *                   缓动 = tweenSpringCurve（贝塞尔）。
   *
   * 不满足触发条件时直接降级为普通 moveTo（cubicOut），保证低速归位/普通重排不抖。
   *
   * 与 selectMove 同构：两段补间用 TweenManager 同对象-同字段互斥即可衔接，
   * 第一段 onComplete 时若 view 已经再次被拖拽（isDragging=true）则不调度第二段。
   *
   * @param tm           TweenManager
   * @param card         目标 CardView
   * @param target       最终落点位姿（layoutX/Y/Rotation）
   * @param totalMS      总时长（与原 moveTo 同义；第一段会按 tweenRiseRatio 占其一部分）
   * @param currentSpeed 触发判定用的当前速度，单位 px/s（由调用方传入，
   *                     通常取 view.getLastSpeed()）
   * @param forceOvershoot 强制走过冲路径（如发牌：此时 view 速度可能尚未稳定，
   *                       但语义上是"从远处快速进场"，应当过冲）。默认 false。
   */
  moveToWithOvershoot(
    tm: TweenManager,
    card: CardView,
    target: { x: number; y: number; rotation: number },
    totalMS = 280,
    currentSpeed = 0,
    forceOvershoot = false
  ): Promise<void> {
    const cfg = CONFIG.cardOvershoot;
    const drag = CONFIG.dragHandCard;
    const maxSpeed = drag?.maxSpeed ?? 3000;

    // 触发判定：禁用 / 速度未达阈值且未强制 → 降级为普通 moveTo。
    const threshold = (cfg?.tweenSpeedRatioThreshold ?? 0.5) * maxSpeed;
    const trigger =
      !!cfg?.enabled && (forceOvershoot || currentSpeed >= threshold);

    if (!trigger) {
      return CardFx.moveTo(tm, card, target, totalMS);
    }

    const dx = target.x - card.x;
    const dy = target.y - card.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // 起点与终点几乎重合：直接置到位即可，过冲没有意义。
    if (dist < 1e-3) {
      card.x = target.x;
      card.y = target.y;
      card.rotation = target.rotation;
      return Promise.resolve();
    }

    const overshootPx = Math.max(0, cfg.tweenOvershootPx ?? 0);
    // 过冲点 = 终点 + 单位方向向量 × overshoot
    const nx = dx / dist;
    const ny = dy / dist;
    const overX = target.x + nx * overshootPx;
    const overY = target.y + ny * overshootPx;

    const riseRatio = Math.min(1, Math.max(0, cfg.tweenRiseRatio ?? 0.75));
    const riseMS = Math.max(1, Math.round(totalMS * riseRatio));

    // 弹簧回弹时长 = round(1000 / stiffness)，与 selectMove 同公式。
    const stiffness = Math.max(0.001, cfg.tweenSpringStiffness ?? 10);
    const springMS = Math.min(2000, Math.max(1, Math.round(1000 / stiffness)));

    // 缓动：曲线 disabled 时分别用 cubicOut（rise 偏减速）和 cubicOut（spring 柔和）兜底。
    const riseCurveEnabled =
      cfg.tweenRiseCurve && cfg.tweenRiseCurve.enabled !== false;
    const riseEase: EaseFn = riseCurveEnabled
      ? curveToEase(cfg.tweenRiseCurve)
      : Easing.cubicOut;
    const springCurveEnabled =
      cfg.tweenSpringCurve && cfg.tweenSpringCurve.enabled !== false;
    const springEase: EaseFn = springCurveEnabled
      ? curveToEase(cfg.tweenSpringCurve)
      : Easing.cubicOut;

    // 过冲幅度为 0：直接走单段补间，省一次 tween。
    if (overshootPx <= 0) {
      return new Promise((resolve) => {
        tm.add(
          tm
            .create(card)
            .to({ x: target.x, y: target.y, rotation: target.rotation }, totalMS)
            .easing(riseEase)
            .onComplete(resolve)
        );
      });
    }

    return new Promise((resolve) => {
      // 第一段：start → overshootPoint。rotation 也在第一段做到位（不参与回弹）。
      tm.add(
        tm
          .create(card)
          .to({ x: overX, y: overY, rotation: target.rotation }, riseMS)
          .easing(riseEase)
          .onComplete(() => {
            // 防御：第一段播放期间用户可能又抓住卡牌再次拖拽——
            // 此时 onDragStart 已经 killOf(view)，第一段会被 stop 而不触发 onComplete。
            // 但 stop 不调 onComplete（见 Tween.stop），所以这里仅做兜底：
            // 如果不知怎么 onComplete 触发了又恰好 isDragging=true，跳过第二段。
            if (card.isDragging) {
              resolve();
              return;
            }
            tm.add(
              tm
                .create(card)
                .to({ x: target.x, y: target.y }, springMS)
                .easing(springEase)
                .onComplete(resolve)
            );
          })
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
