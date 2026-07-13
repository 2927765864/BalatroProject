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
 *   - selectMove：选中上移 / 取消下移的"启动速度过冲 + 刚度回弹"两段补间，
 *               配合 CardView.isSelectAnimating 标志使用，由 GameController 调度；
 *               上移与下移参数独立（selectMove* / selectFall*）。
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
          .onStop(resolve)
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
    forceOvershoot = false,
    speedRatio = 1.0
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
      return CardFx.moveTo(tm, card, target, adaptiveMS / speedRatio);
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
    const riseMS = Math.min(maxMS, Math.max(minMS, naturalMS)) / speedRatio;

    // 过冲点 = 终点 + 单位方向向量 × overshoot
    const nx = dx / dist;
    const ny = dy / dist;
    const overX = target.x + nx * overshootPx;
    const overY = target.y + ny * overshootPx;

    // 弹簧回弹时长 = round(1000 / stiffness)，与 selectMove 同公式。
    const stiffness = Math.max(0.001, cfg.tweenSpringStiffness ?? 10);
    const springMS = Math.min(2000, Math.max(1, Math.round(1000 / stiffness))) / speedRatio;

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
            .onStop(resolve)
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
          .onStop(resolve)
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
                .onStop(resolve)
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
   * 飞向弃牌堆的动画：终点在世界「正右方」外一点、垂直居中。
   * 配合 CardView.startDiscardFlip 在飞行途中沿竖中轴线翻约 90°（压成一条线）。
   * 翻面压线由 flipScaleX 通道负责；可选 targetRotation 用于飞出后的随机旋转姿态。
   */
  flyToDiscardPile(
    tm: TweenManager,
    card: CardView,
    worldWidth: number,
    worldHeight: number,
    durationMS = 320,
    targetRotation?: number
  ): Promise<void> {
    return new Promise((resolve) => {
      const target: { x: number; y: number; rotation?: number } = {
        x: worldWidth + 200,
        y: worldHeight / 2,
      };
      if (targetRotation !== undefined) {
        target.rotation = targetRotation;
      }
      tm.add(
        tm
          .create(card)
          .to(target, durationMS)
          .easing(Easing.cubicIn)
          .onComplete(resolve)
      );
    });
  },

  /**
   * 卡牌换位动画（手动理牌让位）。
   *
   * 触发场景：玩家拖拽手牌越过相邻牌中线 → GameController 在 hand 数组中互换位置 →
   * 被让位的相邻牌走此动画到新槽位。
   *
   * 与 moveToWithOvershoot 的区别：
   *   - 后者按距离驱动过冲幅度、按目标平均速度自适应时长——为「归位/发牌」这类
   *     起点距离差异巨大的场景设计；
   *   - 让位场景的距离总是 ≈ cardSpacing（小且固定），用固定时长 + 固定过冲幅度
   *     更利落直接，避免被 tweenReturnMinMS 下限拖沓、也避免短距离被
   *     tweenMinOvershootDistancePx 阈值短路为单段补间没有过冲。
   *
   * 与 selectMove 的形态同构：
   *   rise   : 当前位置 → 沿目标方向越过 overshootPx 的过冲点（rotation 在此段做到位）
   *   spring : 过冲点 → 真正落点（只动 x/y，rotation 不参与回弹）
   *
   * 缓动复用 cardOvershoot.tweenRiseCurve / tweenSpringCurve，保持视觉风格一致。
   *
   * 退化路径（任一条件命中走单段补间）：
   *   - CONFIG.handSwap.enabled === false
   *   - overshootPx <= 0
   *   - 起点终点几乎重合（< 1e-3）
   *
   * 同对象同字段被 TweenManager 自动互斥：如果用户连续左右换位，旧 swap 动画
   * 会被新一次 swap 打断；视觉是「从当前所在位置（可能是过冲点）出发再次 swap」，
   * 这是想要的连贯感。
   *
   * 配合 CardView.isSwapAnimating 标志：函数入口设为 true，最终落位（spring 完成、
   * 或退化路径完成）时清零。GameController.layoutHand 会跳过 isSwapAnimating=true
   * 且本帧不在 swapFor 的牌，避免后续 onDragging 帧用 moveToWithOvershoot 打断
   * rise，导致 spring 阶段（在 rise 的 onComplete 内 lazy 调度）永远排不上。
   * 这是修复"一次跨越多张牌时弹性丢失"的关键。
   */
  swapMove(
    tm: TweenManager,
    card: CardView,
    target: { x: number; y: number; rotation: number },
    customCfg?: { enabled: boolean; riseDurationMS: number; springDurationMS: number; overshootPx: number }
  ): Promise<void> {
    const cfg = customCfg || CONFIG.handSwap;
    const riseMS = Math.max(1, cfg?.riseDurationMS ?? 110);
    const springMS = Math.max(1, cfg?.springDurationMS ?? 110);
    const overshootPx = Math.max(0, cfg?.overshootPx ?? 0);
    return CardFx.runSwapStyleMove(tm, card, target, {
      enabled: cfg?.enabled !== false,
      riseMS,
      springMS,
      overshootPx,
    });
  },

  /**
   * 理牌动画（按点数/花色重排）。
   *
   * 与 swapMove 同构（rise → 过冲 → spring + isSwapAnimating），但 rise 时长按
   * 移动距离自适应：距离越大速度越大（durationPower < 1 时速度 ∝ dist^(1-p)）。
   * spring 段固定时长，保证回弹手感一致。
   *
   * 参数来自 CONFIG.handSort。
   */
  sortMove(
    tm: TweenManager,
    card: CardView,
    target: { x: number; y: number; rotation: number }
  ): Promise<void> {
    const cfg = CONFIG.handSort;
    const dx = target.x - card.x;
    const dy = target.y - card.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    const baseRise = Math.max(1, cfg?.riseDurationMS ?? 130);
    const springMS = Math.max(1, cfg?.springDurationMS ?? 110);
    const overshootPx = Math.max(0, cfg?.overshootPx ?? 0);
    const refDist = Math.max(1, cfg?.refDistancePx ?? 65);
    const power = Math.min(1, Math.max(0, cfg?.durationPower ?? 0.2));
    const minRise = Math.max(1, cfg?.minRiseDurationMS ?? 60);
    const maxRise = Math.max(minRise, cfg?.maxRiseDurationMS ?? 220);

    // riseMS = baseRise * (dist/ref)^power，再 clamp 到 [min, max]。
    // power=0 → 固定 baseRise；power=1 → 时长随距离线性（恒速）。
    const t = dist / refDist;
    const scaled = baseRise * Math.pow(Math.max(t, 1e-6), power);
    const riseMS = Math.min(maxRise, Math.max(minRise, scaled));

    return CardFx.runSwapStyleMove(tm, card, target, {
      enabled: cfg?.enabled !== false,
      riseMS,
      springMS,
      overshootPx,
    });
  },

  /**
   * swap / sort 共用的 rise→spring 实现。
   * 调用方负责算好 riseMS / springMS / overshootPx。
   */
  runSwapStyleMove(
    tm: TweenManager,
    card: CardView,
    target: { x: number; y: number; rotation: number },
    opts: { enabled: boolean; riseMS: number; springMS: number; overshootPx: number }
  ): Promise<void> {
    const overshootCfg = CONFIG.cardOvershoot;
    const riseMS = Math.max(1, opts.riseMS);
    const springMS = Math.max(1, opts.springMS);
    const overshootPx = Math.max(0, opts.overshootPx);

    // 缓动：复用归位/发牌的两条贝塞尔曲线，曲线 disabled 时用 cubicOut 兜底。
    const riseCurveEnabled =
      overshootCfg?.tweenRiseCurve && overshootCfg.tweenRiseCurve.enabled !== false;
    const riseEase: EaseFn = riseCurveEnabled
      ? curveToEase(overshootCfg!.tweenRiseCurve)
      : Easing.cubicOut;
    const springCurveEnabled =
      overshootCfg?.tweenSpringCurve && overshootCfg.tweenSpringCurve.enabled !== false;
    const springEase: EaseFn = springCurveEnabled
      ? curveToEase(overshootCfg!.tweenSpringCurve)
      : Easing.cubicOut;

    const dx = target.x - card.x;
    const dy = target.y - card.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // 入口标记：本函数所有返回路径都必须最终清零（无论是直接返回还是动画完成）。
    // 注意：如果在动画中途被另一次 swap/sort 接管（TweenManager 互斥停掉旧 rise），
    // 旧 rise 的 onComplete 不会被触发；但新一次入口会再次把它设为 true，
    // 最终由"最新一次"的 spring onComplete 负责清零，整体仍然平衡。
    card.isSwapAnimating = true;

    // 起点终点几乎重合：直接置位返回。
    if (dist < 1e-3) {
      card.x = target.x;
      card.y = target.y;
      card.rotation = target.rotation;
      card.isSwapAnimating = false;
      return Promise.resolve();
    }

    // 退化：开关关闭或过冲幅度为 0 → 单段补间。总时长 = rise + spring，
    // 这样总播放时间与开启时一致，调参时的"总时长"观感不会突变。
    if (!opts.enabled || overshootPx <= 0) {
      return CardFx.moveTo(tm, card, target, riseMS + springMS).then(() => {
        card.isSwapAnimating = false;
      });
    }

    // 过冲点 = target + 单位方向向量 × overshootPx
    const nx = dx / dist;
    const ny = dy / dist;
    const overX = target.x + nx * overshootPx;
    const overY = target.y + ny * overshootPx;

    return new Promise((resolve) => {
      // 第一段：rise 越过目标到过冲点；rotation 也在此段做到位。
      // 同时挂 onStop：rise 段被外部打断时（killOf 或被新 swap/归位 tween 互斥停掉），
      // 必须清零 isSwapAnimating，否则 spring 段不会被调度，标志会永久残留，
      // 导致后续无 force 的 layoutHand 永久豁免该牌而停在错位。
      tm.add(
        tm
          .create(card)
          .to({ x: overX, y: overY, rotation: target.rotation }, riseMS)
          .easing(riseEase)
          .onStop(() => {
            card.isSwapAnimating = false;
            resolve();
          })
          .onComplete(() => {
            // 防御：理论上让位牌不会同时被拖拽（拖拽牌是另一张），
            // 但保留与 moveToWithOvershoot 一致的守卫，避免极端竞态下跳到错位。
            if (card.isDragging) {
              card.isSwapAnimating = false;
              resolve();
              return;
            }
            // 第二段：spring 回弹到真正落点（rotation 不再动）。
            // 同样挂 onStop 兜底：spring 段被打断时也清零标志。
            tm.add(
              tm
                .create(card)
                .to({ x: target.x, y: target.y }, springMS)
                .easing(springEase)
                .onStop(() => {
                  card.isSwapAnimating = false;
                  resolve();
                })
                .onComplete(() => {
                  card.isSwapAnimating = false;
                  resolve();
                })
            );
          })
      );
    });
  },

  /**
   * 选中 / 取消选中的两段位移动画。
   *
   * 模型（与 PlayPileFx.dropCardScoring / liftCardScoring 同构）：
   *   第一段（rise/fall）：当前位置 → 过冲点
   *     - 过冲点：选中时 target.y - overshoot（向上多走）；取消时 target.y + overshoot
   *     - 初速度 startSpeed（px/s），Easing.quadOut 恒定减速到 0
   *     - 时长 T = 2 * D / startSpeed（D = 起点→过冲点欧氏距离）
   *     - 同时驱动 x / y / rotation（x/rotation 不参与第二段回弹）
   *   第二段（spring）：过冲点 y → target.y
   *     - 时长 = round(1000 / stiffness)，Easing.cubicOut 收敛
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
   * @param direction    "rise" = 选中向上、过冲点在 target.y 上方；
   *                     "fall" = 取消向下、过冲点在 target.y 下方。
   * @param opts         { startSpeed, overshoot, stiffness, onSettle }
   */
  selectMove(
    tm: TweenManager,
    card: CardView,
    target: { x: number; y: number; rotation: number },
    direction: "rise" | "fall",
    opts: {
      startSpeed: number;
      overshoot: number;
      stiffness: number;
      onSettle?: () => void;
    }
  ): Promise<void> {
    const overshoot = Math.max(0, opts.overshoot);
    // 防止 stiffness 太小导致回弹时长爆炸；最低 1ms，最高 2000ms。
    const stiffness = Math.max(0.001, opts.stiffness);
    const reboundMS = Math.min(2000, Math.round(1000 / stiffness));

    // 选中时向上越过目标 → y 减 overshoot；取消时向下越过原位 → y 加 overshoot。
    const overshootY =
      direction === "rise" ? target.y - overshoot : target.y + overshoot;

    // 第一段时长：基于"初速度恒定减速到 0"的运动学
    // D = (v0 * T) / 2  →  T = 2 * D / v0
    // 与 dropCardScoring / playCardMoveControl 的物理语义一致；quadOut 对应线性减速。
    const dx = target.x - card.x;
    const dy = overshootY - card.y;
    const dist = Math.hypot(dx, dy);
    const startSpeed = Math.max(1, opts.startSpeed);
    const riseMS =
      dist < 1e-3
        ? 0
        : Math.min(2000, Math.max(10, Math.round(((2 * dist) / startSpeed) * 1000)));

    return new Promise((resolve) => {
      // 防止 onSettle 在 onStop 和 onComplete 双路径下被重复触发。
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        opts.onSettle?.();
        resolve();
      };

      // 起点与过冲点几乎重合：直接置到位并结束。
      if (riseMS <= 0) {
        card.x = target.x;
        card.y = target.y;
        card.rotation = target.rotation;
        settle();
        return;
      }

      // 第一段：x / y / rotation 同时驱动；y 到过冲点。
      // 挂 onStop：被打断（如新 layoutHand/swap 互斥停掉本 tween）时，
      // 同样要清 isSelectAnimating（通过 opts.onSettle），避免标志残留导致
      // 后续 layoutHand 永久豁免该牌。
      tm.add(
        tm
          .create(card)
          .to(
            { x: target.x, y: overshootY, rotation: target.rotation },
            riseMS
          )
          .easing(Easing.quadOut)
          .onStop(settle)
          .onComplete(() => {
            // 第二段：只回弹 y。
            if (overshoot <= 0 || reboundMS <= 0) {
              card.y = target.y;
              settle();
              return;
            }
            tm.add(
              tm
                .create(card)
                .to({ y: target.y }, reboundMS)
                .easing(Easing.cubicOut)
                .onStop(settle)
                .onComplete(settle)
            );
          })
      );
    });
  },
};
