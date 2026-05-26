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
 * 距离驱动的过冲幅度计算。
 *
 * 物理直觉：把"卡牌当前位置 → layout 目标"这段距离视为一根被拉伸的弹簧的形变量。
 * 形变越大，松开后弹回去越过头；形变小到一定程度（< minDist），可以视为无弹性形变，
 * 不再过冲。形变达到/超过 fullDist 时，弹性能量已经"打到上限"，过冲幅度饱和。
 *
 * 该模型完全用"距离"作为输入，与速度无关——既泛用（不依赖采样链稳定性），
 * 又自然契合物理直觉（甩得远 → 弹得明显；微调 → 不弹）。
 *
 * forceOvershoot=true 时直接返回最大幅度（保留给"未来需要强制过冲"的场景；
 * 但新模型下发牌瞬移因距离极大也会自然得到满额，所以一般不再需要）。
 */
function computeTweenOvershootPx(
  cfg: NonNullable<typeof CONFIG.cardOvershoot>,
  distance: number,
  forceOvershoot: boolean
): number {
  const maxOvershoot = Math.max(0, cfg.tweenOvershootPx ?? 0);
  const minOvershoot = Math.min(
    maxOvershoot,
    Math.max(0, cfg.tweenMinOvershootPx ?? 0)
  );

  if (maxOvershoot <= 0) return 0;
  if (forceOvershoot) return maxOvershoot;

  const minDist = Math.max(0, cfg.tweenMinOvershootDistancePx ?? 30);
  const fullDist = Math.max(minDist + 1, cfg.tweenFullOvershootDistancePx ?? 280);

  if (distance < minDist) return 0;
  if (distance >= fullDist) return maxOvershoot;

  const t = (distance - minDist) / (fullDist - minDist);
  return minOvershoot + (maxOvershoot - minOvershoot) * t;
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
   * 【模型 v2：距离驱动的过冲 + 目标平均速度自适应时长】
   *
   * 过冲幅度（overshootPx）：
   *   仅由 dist = |card → target| 决定（不再用速度），与速度采样链彻底解耦：
   *     dist < tweenMinOvershootDistancePx：不过冲，走单段 moveTo
   *     dist 在 [minDist, fullDist] 之间：tweenMinOvershootPx → tweenOvershootPx 线性插值
   *     dist ≥ tweenFullOvershootDistancePx：tweenOvershootPx 满额
   *   forceOvershoot=true 仍能强制满额（兼容旧 API；但通常不再需要——发牌时
   *   "屏幕外瞬移过来"距离极大，自然会得到满额过冲）。
   *
   * rise 段时长（riseMS）：
   *   自适应：riseMS = clamp(dist / tweenReturnAvgSpeed * 1000, tweenReturnMinMS, tweenReturnMaxMS)
   *   语义：保持视觉"该牌归位的速度感"恒定（≈ tweenReturnAvgSpeed），与起点距离解耦——
   *   彻底解决"快速甩牌释放时归位速度过高 / 定住释放时归位速度正常"的体验落差。
   *   入参 totalMS 仅作为"调用方语义提示"，实际不参与 rise 时长计算（保留参数兼容签名）。
   *
   * 第二段（spring 弹簧回弹）：
   *   过冲点 → 真正终点。时长 = round(1000 / tweenSpringStiffness)（与 selectMove 同公式），
   *   缓动 = tweenSpringCurve；仅当 overshootPx > 0 时存在。
   *
   * 与 selectMove 同构：两段补间用 TweenManager 同对象-同字段互斥即可衔接，
   * 第一段 onComplete 时若 view 已经再次被拖拽（isDragging=true）则不调度第二段。
   *
   * @param tm           TweenManager
   * @param card         目标 CardView
   * @param target       最终落点位姿（layoutX/Y/Rotation）
   * @param totalMS      已废弃：保留以兼容旧调用方；新模型 rise 段时长由距离 + 目标平均速度自适应。
   * @param currentSpeed 已废弃：保留以兼容旧调用方；新模型不再消费速度。
   * @param forceOvershoot 强制满额过冲（如发牌：保留以兼容旧 API；通常不再需要）。默认 false。
   */
  moveToWithOvershoot(
    tm: TweenManager,
    card: CardView,
    target: { x: number; y: number; rotation: number },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _totalMS = 280,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _currentSpeed = 0,
    forceOvershoot = false
  ): Promise<void> {
    const cfg = CONFIG.cardOvershoot;

    if (!cfg?.enabled) {
      // 关闭过冲总开关时退化为普通 moveTo，但仍按"距离/目标速度"自适应时长，
      // 保证关闭过冲后的归位速度感与开启时一致。
      const fallbackDist = Math.hypot(target.x - card.x, target.y - card.y);
      const avgSpeed = Math.max(1, cfg?.tweenReturnAvgSpeed ?? 1400);
      const minMS = Math.max(1, cfg?.tweenReturnMinMS ?? 140);
      const maxMS = Math.max(minMS, cfg?.tweenReturnMaxMS ?? 420);
      const adaptiveMS = Math.min(maxMS, Math.max(minMS, (fallbackDist / avgSpeed) * 1000));
      return CardFx.moveTo(tm, card, target, adaptiveMS);
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

    const overshootPx = computeTweenOvershootPx(cfg, dist, forceOvershoot);

    // rise 时长：按"目标平均速度 + 上下限"自适应。
    // 理论意义：让任何距离的归位都呈现接近 tweenReturnAvgSpeed 的视觉速度感，
    // 既根除"远距离瞬移、近距离拖沓"的体验落差，又通过上下限 clamp 防止极端值。
    const avgSpeed = Math.max(1, cfg.tweenReturnAvgSpeed ?? 1400);
    const minMS = Math.max(1, cfg.tweenReturnMinMS ?? 140);
    const maxMS = Math.max(minMS, cfg.tweenReturnMaxMS ?? 420);
    const naturalMS = (dist / avgSpeed) * 1000;
    const riseMS = Math.min(maxMS, Math.max(minMS, naturalMS));

    // 过冲点 = 终点 + 单位方向向量 × overshoot
    const nx = dx / dist;
    const ny = dy / dist;
    const overX = target.x + nx * overshootPx;
    const overY = target.y + ny * overshootPx;

    // 弹簧回弹时长 = round(1000 / stiffness)，与 selectMove 同公式。
    const stiffness = Math.max(0.001, cfg.tweenSpringStiffness ?? 10);
    const springMS = Math.min(2000, Math.max(1, Math.round(1000 / stiffness)));

    const fallbackRiseEase: EaseFn =
      cfg.tweenRiseCurve && cfg.tweenRiseCurve.enabled !== false
        ? curveToEase(cfg.tweenRiseCurve)
        : Easing.cubicOut;
    const riseEase: EaseFn = fallbackRiseEase;
    const springCurveEnabled =
      cfg.tweenSpringCurve && cfg.tweenSpringCurve.enabled !== false;
    const springEase: EaseFn = springCurveEnabled
      ? curveToEase(cfg.tweenSpringCurve)
      : Easing.cubicOut;

    // 过冲幅度为 0（距离不足触发或配置为 0）：直接走单段补间，省一次 tween。
    if (overshootPx <= 0) {
      return new Promise((resolve) => {
        tm.add(
          tm
            .create(card)
            .to({ x: target.x, y: target.y, rotation: target.rotation }, riseMS)
            .easing(fallbackRiseEase)
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
