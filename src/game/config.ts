/**
 * 游戏参数（运行时可调）
 *
 * 设计原则（参考 control-panel-capsule）：
 *   - DEFAULT_CONFIG 是出厂默认值，永远不变；用于"恢复默认 / 加载旧 preset 时填空缺字段"。
 *   - CONFIG 是真正的运行时单源（Single Source of Truth）。
 *     业务代码（GameController、main、fx 等）每次需要读参数时都直接读 CONFIG。
 *   - GameConfig 作为兼容入口，依然导出，但它现在就是 CONFIG 自身的引用，
 *     这样既不打破老调用点，又让 ControlPanel 改值后立刻生效。
 *   - 想新增参数 = 在 DEFAULT_CONFIG 里加一项，再在面板 HTML + bind 一行即可。
 */

export const CONFIG_VERSION = 3;

/**
 * 单个 UI 节点的可持久化数据。
 * UIHierarchy 序列化后写到 CONFIG.uiNodes[id] 上。
 */
export interface UINodeSerialized {
  /** 父节点 id；null = 直接挂在 worldRoot 上。 */
  parentId: string | null;
  /** 在父下的兄弟顺序（PIXI children 数组下标）。 */
  siblingIndex: number;
  /** 节点上的所有组件序列化数据（含 transform）。 */
  components: Array<{ type: string; data: Record<string, unknown> }>;
}

export interface BezierCurveConfig {
  enabled: boolean;
  startScale: number;
  endScale: number;
  p1: { x: number; y: number };
  p2: { x: number; y: number };
}

export interface RuntimeConfig {
  world: {
    width: number;
    height: number;
    /** 背景色（PixiJS 数字色）。运行中改这个值需要业务侧主动 apply。 */
    backgroundColor: number;
  };
  rules: {
    /** 满手牌数量 */
    handSize: number;
    /** 最多选几张 */
    maxSelected: number;
    /** 每回合出牌次数 */
    plays: number;
    /** 每回合弃牌次数 */
    discards: number;
    /** 目标分（盲注） */
    targetScore: number;
  };
  animation: {
    /** 摆位 / 选中升降动画时长（毫秒） */
    moveDurationMS: number;
    /** 出牌飞出动画时长（毫秒） */
    flyOutDurationMS: number;
    /** 悬停抬升像素（CardFx hoverIn 用） */
    hoverLiftPx: number;
  };
  debug: {
    /** 控制面板透明度（0.1 - 1） */
    panelOpacity: number;
    /** 在 HUD 上显示一些调试文字（保留扩展位） */
    showDebugOverlay: boolean;
  };
  /**
   * 卡牌美术参数。
   *   - useSprites: true 时 CardView/DeckView 走精灵图渲染；false 时退回程序化绘制。
   *   - back.row/back.col: 选用 Enhancers.png 中第几行第几列作为牌背（0 基）。
   */
  cardArt: {
    useSprites: boolean;
    /** 卡牌可见外缘圆角半径（世界坐标）。改值后需要重绘 CardView + DeckView。 */
    cornerRadius: number;
    /** 卡面底色（PixiJS 数字色）。改值后需要 refreshHandArt + refreshDeckArt。 */
    faceColor: number;
    /** 卡牌外缘 1 像素描边颜色（PixiJS 数字色）。改值后需要 refreshHandArt + refreshDeckArt。 */
    outlineColor: number;
    back: {
      row: number;
      col: number;
    };
  };
  /**
   * 手牌摆放参数（spacing / 弧形 / 扇形旋转）。
   * 由 computeHandLayout 读取，改值后 GameController 需要重新 layoutHand。
   */
  handLayout: {
    /** 相邻两张手牌中心点的水平间距（像素）。 */
    cardSpacing: number;
    /** 是否启用手牌弧形摆放（边缘的牌往下沉一些，模拟手持弧度）。 */
    arcEnabled: boolean;
    /** 弧形最大下沉幅度（像素）：最外两张牌相对中心牌的 Y 偏移。正值往下沉，负值往上拱。 */
    arcHeight: number;
    /** 每张牌相对中心牌的旋转角度系数（度/张）。0 = 不旋转。 */
    fanAnglePerCardDeg: number;
  };
  cardShadow: {
    color: number;
    alpha: number;
    lightX: number;
    lightY: number;
    distanceRatio: number;
    scaleRatio: number;
  };
  dragShadow: {
    color: number;
    alpha: number;
    lightX: number;
    lightY: number;
    distanceRatio: number;
    scaleRatio: number;
  };
  /** 拖拽手牌相关参数 */
  dragHandCard: {
    /** 追踪速度上限 (像素/秒) */
    maxSpeed: number;
    /** 追踪插值系数 (0-1) */
    lerpFactor: number;
    /** 拖拽时的目标缩放 (>=1 通常) */
    dragScaleTarget: number;
    /** 进入拖拽时的缩放过渡时长 (毫秒) */
    dragScaleInDurationMS: number;
    /** 退出拖拽时的缩放回弹时长 (毫秒) */
    dragScaleOutDurationMS: number;
    /** 进入拖拽缩放曲线 */
    dragScaleInCurve: BezierCurveConfig;
    /** 退出拖拽缩放曲线 */
    dragScaleOutCurve: BezierCurveConfig;
  };
  cardVisuals: {
    expandedSections: {
      shadow: boolean;
      dragShadow: boolean;
      breathing: boolean;
      idleTilt: boolean;
      hoverScale: boolean;
      hoverBreathing: boolean;
      mouse3DTilt: boolean;
      dragHandCard: boolean;
      hoverHit: boolean;
      selectMove: boolean;
      cardOps: boolean;
    };

    /**
     * 选中与取消卡牌的位移效果（两段补间：到位 → 过弹 → 阻尼回弹）
     *
     * 触发：toggleSelection 翻转 view.selected 时（仅对那张牌）。
     * 模型：
     *   第一段 rise/fall：当前 y → (基准 y - rise ∓ overshoot)，用 selectMoveCurve 作为缓动，
     *                    时长 = selectMoveDurationMS。
     *   第二段 spring：上一段终点 → 基准 y，用 cubicOut 收敛，时长 = round(1000 / selectMoveStiffness)。
     *
     * 注：动画期间该牌会被 layoutHand 跳过 tween 写入（仅写 layoutX/Y/Rotation 元数据），
     * 直到两段动画都结束后才解除标记，避免普通重排 tween 把过弹动画踢掉。
     */
    selectMoveEnabled: boolean;
    /** 选中弹起高度（像素，世界坐标）。替代旧的 CardSkin.selectedRiseY。 */
    selectRiseY: number;
    /**
     * 第一段位移时长（毫秒）。决定"到达目标高度（含过弹）"的速率：
     * 时长越短，鼓起越爆裂；越长越温吞。
     */
    selectMoveDurationMS: number;
    /**
     * 第一段速率曲线（贝塞尔）。曲线 y(t) 直接作为 ease：
     * y(0)=0、y(1)=1 之间的形状决定 rise/fall 的加速感觉。
     * enabled=false 时退化为 cubicOut。
     */
    selectMoveCurve: BezierCurveConfig;
    /**
     * 过弹幅度（像素）：第一段的终点会越过最终目标 selectMoveOvershoot 像素。
     *   选中 rise：终点 y = (基准 y - selectRiseY) - selectMoveOvershoot（向上多走）
     *   取消 fall：终点 y = (基准 y)               + selectMoveOvershoot（向下多走）
     * 设为 0 等同于关掉过弹（不过仍会有第二段、瞬时完成）。
     */
    selectMoveOvershoot: number;
    /**
     * 过弹回弹刚度（无单位，建议 3~30）。
     * 用法：回弹段时长（ms）= round(1000 / selectMoveStiffness)。
     * stiffness=10 → 100ms；stiffness=5 → 200ms；stiffness=20 → 50ms。
     * 数值越大，从过弹点拉回目标越"硬"。
     */
    selectMoveStiffness: number;
    // 1. 常态呼吸晃动
    breathingEnabled: boolean;
    breathingSpeed: number;
    breathingAmplitude: number;
    wobbleSpeed: number;
    wobbleAmplitude: number;

    // 1b. 常态伪3D倾斜呼吸晃动（与鼠标悬停伪3D倾斜共用相同投影模型，
    //     仅由时间驱动一个"虚拟鼠标"在卡牌内做缓慢圆周运动；
    //     真实鼠标悬停时该效果自动让位给 mouse3DTilt）
    idleTiltEnabled: boolean;
    /** 倾斜呼吸周期速度（rad/ms，建议 0.0005~0.002） */
    idleTiltSpeed: number;
    /** 倾斜强度（与 mouse3DTiltStrength 同量纲；建议 0.3~1.5） */
    idleTiltStrength: number;
    /** 虚拟鼠标在卡牌内的运动半径（0~1，相对卡牌半对角） */
    idleTiltRadius: number;

    // 2. 鼠标触碰小弹性缩放
    hoverScaleEnabled: boolean;
    hoverOvershootScale: number;
    hoverSettleScale: number;
    /**
     * 过弹次数：sin 阻尼振荡的极值点数量。
     * 1 = 经典一次过弹（1.0 → overshoot → settle）。
     * 2 = 一峰一谷（1.0 → overshoot → 谷 → settle）。
     * 3 = 两峰一谷或一峰两谷，依次类推。
     * 谷/次峰的幅度由 hoverOvershootDamping 控制。
     */
    hoverOvershootCount: number;
    /**
     * 过弹阻尼衰减：每经过一个极值点，振幅乘以此因子。范围 (0, 1]，越小衰减越快。
     * 仅当 hoverOvershootCount >= 2 时生效。
     */
    hoverOvershootDamping: number;
    hoverScaleDurationMS: number;
    hoverScaleCurve: BezierCurveConfig;
    hoverScaleOutDurationMS: number;
    /**
     * 未正常完结动画的回缩过弹次数：
     * 当入场弹性动画尚未播完（hoverScaleProgress < 1）鼠标就离开时，
     * 回缩过程在 1.0 附近做阻尼正弦振荡的极值点数量。
     * 1 = 一次过冲（先穿过 1.0 再回到 1.0）。
     * 2 = 一峰一谷。3 = 两峰一谷或一峰两峰，依次类推。
     * 振幅基准取离开瞬间 |currentScale - 1.0|，被打断越早幅度越小。
     * 设为 0 或 1 之下时退化为原平滑回缩（即不做过弹）。
     * 仅在入场动画被打断时生效，正常停留后离开仍走平滑回缩。
     */
    hoverScaleOutOvershootCount: number;
    /**
     * 首次过缩的目标 scale 绝对值（穿过 1.0 后到达的极值）。
     * 一般 < 1.0，例如 0.95 表示从被打断时的 scale（通常 > 1）
     * 首次穿过 1.0 后达到 0.95，再继续振荡回 1.0。
     * 该值不依赖入场的 overshootScale/settleScale，独立可控。
     */
    hoverScaleOutOvershootFirstScale: number;
    /**
     * 回缩过弹阻尼衰减：从首次过缩极值起，每经过一个后续极值振幅乘以此因子，
     * 范围 (0, 1]。仅当 hoverScaleOutOvershootCount >= 2 时影响后续峰谷的振幅。
     */
    hoverScaleOutOvershootDamping: number;
    hoverScaleOutSpeed: number;

    /**
     * 2b. 鼠标呼吸晃动（触碰与回落） —— hover breathing
     *
     * 一个完全独立于"常态手牌呼吸晃动"的脱手式动画：在下列任一时机被触发，
     * 播一段独立的呼吸 + 晃动包络，其输出值会与常态呼吸晃动 **相加叠加** 到
     * 卡牌的 Y 位移与 Z 旋转上，两者互不干扰。
     *
     * 触发点（共两处，共用同一组参数）：
     *   1. 鼠标 pointerover 进入卡牌时；
     *   2. 鼠标在卡上按下后导致的"拖拽缩放退出动画"完成时——即卡牌从放大态
     *      完全回落到原始尺寸的瞬间（既包括快速点击切换选中，也包括长按/拖拽松手）。
     *
     * 模型：
     *   speedEnv(p)  = exp(-hoverBreathingSpeedDecay     * p)        // 速率衰减包络
     *   ampEnv(p)    = exp(-hoverBreathingAmplitudeDecay * p)        // 幅度衰减包络
     *   progress     = elapsedMS / hoverBreathingDurationMS          // 0 → 1 线性推进
     *
     *   // 相位累加器内部速率也按 speedEnv 衰减（积分形式），所以振荡频率
     *   // 会随时间逐渐变慢，而不是恒速振荡 + 幅度被生硬压扁。
     *   phase' = phase + dt * baseSpeed * speedEnv(progress)
     *   hoverBreathY = sin(phaseBreath) * hoverBreathingAmplitude * ampEnv(progress)
     *   hoverWobbleR = cos(phaseWobble) * hoverWobbleAmplitude    * ampEnv(progress)
     *
     * 触发时 progress 与内部相位均重置为 0，每次都是"满速率 + 满幅度起跳、
     * 随时间逐渐放慢并减小到接近 0"。progress 到 1 时整段动画结束，
     * hover 通道完全归零（此时卡牌只剩下常态呼吸晃动）。
     */
    hoverBreathingEnabled: boolean;
    /** 整段触碰呼吸晃动的总时长（毫秒）。从触发到完全归零的时间。 */
    hoverBreathingDurationMS: number;
    /** Y 位移呼吸速率（rad/ms，与常态 breathingSpeed 同量纲）。 */
    hoverBreathingSpeed: number;
    /** Y 位移呼吸初始幅度（像素，触发瞬间的峰值）。 */
    hoverBreathingAmplitude: number;
    /** Z 旋转晃动速率（rad/ms，与常态 wobbleSpeed 同量纲）。 */
    hoverWobbleSpeed: number;
    /** Z 旋转晃动初始幅度（弧度，触发瞬间的峰值）。 */
    hoverWobbleAmplitude: number;
    /**
     * 速率衰减率：speedEnv(p) = exp(-hoverBreathingSpeedDecay * p)，p ∈ [0,1]。
     * 控制 sin/cos 内部相位的累加速度按时间比例衰减——数值越大，振荡频率
     * 越快变慢（开头剧烈快速、结尾慢悠悠几乎不动）。0 = 不衰减（全程匀速）。
     *   2 时结尾保留约 14% 速率，4 时约 1.8%，6 时约 0.25%。
     */
    hoverBreathingSpeedDecay: number;
    /**
     * 幅度衰减率：ampEnv(p) = exp(-hoverBreathingAmplitudeDecay * p)，p ∈ [0,1]。
     * 控制每帧 sin/cos 输出的幅度按时间比例衰减——数值越大，整体振幅
     * 越快变小（开头大幅、结尾几乎看不到）。0 = 不衰减（全程满幅）。
     *   2 时结尾保留约 14% 幅度，4 时约 1.8%，6 时约 0.25%。
     */
    hoverBreathingAmplitudeDecay: number;

    // 3. 卡牌鼠标悬停伪3D倾斜效果
    mouse3DTiltEnabled: boolean;
    mouse3DTiltStrength: number;
    mouse3DTiltInvertTL: boolean;
    mouse3DTiltInvertTR: boolean;
    mouse3DTiltInvertBL: boolean;
    mouse3DTiltInvertBR: boolean;
    /**
     * 是否启用"从左到右倾斜幅度梯度"。
     * - true：根据卡牌在手牌中的位置（最左=0，最右=1）对 mouse3DTiltStrength 做线性插值；
     *   最终强度 = mouse3DTiltStrength × lerp(mouse3DTiltStrengthLeftMul, mouse3DTiltStrengthRightMul, t)。
     * - false：所有卡牌共用同一个 mouse3DTiltStrength。
     * 仅作用于真实鼠标悬停的伪 3D 倾斜，不影响 idleTilt 呼吸晃动。
     */
    mouse3DTiltGradientEnabled: boolean;
    /**
     * 最左端卡牌（手牌索引 0）的强度倍率。范围建议 0~2。0 表示最左完全不倾斜。
     * 仅当 mouse3DTiltGradientEnabled=true 时生效。
     */
    mouse3DTiltStrengthLeftMul: number;
    /**
     * 最右端卡牌（手牌索引 n-1）的强度倍率。范围建议 0~2。
     * 仅当 mouse3DTiltGradientEnabled=true 时生效。
     */
    mouse3DTiltStrengthRightMul: number;
    /**
     * 是否启用倾斜角度过渡平滑。
     * - true（默认）：从当前角度按 mouse3DTiltSmoothing 速率逐帧逼近目标角度（与 idle tilt 共用）。
     * - false：鼠标位置变化时卡牌角度瞬时切换，无过渡。
     */
    mouse3DTiltSmoothEnabled: boolean;
    /**
     * 倾斜角度平滑速率（帧率无关的指数 lerp 因子，0~1）。
     * 含义：每 16.67ms（约 60fps 的一帧）当前角度向目标角度拉近 mouse3DTiltSmoothing 比例。
     * 建议范围 0.05~0.5；越大越"硬"，越小越"软"。仅在 mouse3DTiltSmoothEnabled=true 时生效。
     */
    mouse3DTiltSmoothing: number;

    // 4. 卡牌操作 logic 参数（注：此处保持注释/格式）
    clickThresholdMS: number;
    clickDistanceThreshold: number;

    /**
     * 5. 鼠标触碰碰撞范围（迟滞 hit area）
     *
     * 为了避免卡牌在边缘晃动时鼠标反复进入/离开导致缩放抖动，
     * 把"进入"和"离开"用两套不同大小的矩形判定：
     *   - 鼠标尚未悬停时：使用较小的 enter 矩形，鼠标需移入更内侧才会触发进入；
     *   - 鼠标已悬停时：使用较大的 leave 矩形，鼠标要移出更外侧才会触发离开。
     *
     * Scale 为相对卡牌名义尺寸 (CardSkin.width × CardSkin.height) 的倍率。
     *   1.0 = 与卡面完全等大；<1 收缩、>1 外扩。
     * 建议 hoverHitEnterScale < 1.0 < hoverHitLeaveScale。
     */
    hoverHitEnabled: boolean;
    hoverHitEnterScale: number;
    hoverHitLeaveScale: number;
  };
  /** 可选：示例语义曲线，留作扩展（如未来按 combo 数缩放某个倍率） */
  scoreCurve: BezierCurveConfig;
  /**
   * UI 节点持久化表。键是 UINode.nodeId。
   * 由 UIHierarchy 维护：任何 transform 变化、组件增删、父子重排都会回写这里。
   * 老 preset 没这字段是合法的——首次启动后会被 hierarchy 自动填充。
   */
  uiNodes?: Record<string, UINodeSerialized>;
}

/**
 * 出厂默认值。用 freeze 防止有人误改。
 * 读取时永远走 CONFIG。
 */
export const DEFAULT_CONFIG: RuntimeConfig = Object.freeze({
  world: Object.freeze({
    width: 1280,
    height: 720,
    backgroundColor: 0x4a8b66,
  }),
  rules: Object.freeze({
    handSize: 8,
    maxSelected: 5,
    plays: 4,
    discards: 3,
    targetScore: 450,
  }),
  animation: Object.freeze({
    moveDurationMS: 280,
    flyOutDurationMS: 320,
    hoverLiftPx: 10,
  }),
  debug: Object.freeze({
    panelOpacity: 1,
    showDebugOverlay: false,
  }),
  cardArt: Object.freeze({
    useSprites: true,
    cornerRadius: 6,
    faceColor: 0xffffff,
    outlineColor: 0x000000,
    back: Object.freeze({
      // 默认：Enhancers 第三行第一列（0 基为 row=2, col=0）。
      row: 2,
      col: 0,
    }),
  }),
  handLayout: Object.freeze({
    cardSpacing: 65,
    arcEnabled: true,
    arcHeight: 18,
    fanAnglePerCardDeg: 1.5,
  }),
  cardShadow: Object.freeze({
    color: 0x000000,
    alpha: 0.35,
    lightX: 640,
    lightY: 360,
    distanceRatio: 0.05,
    scaleRatio: 0.95,
  }),
  dragShadow: Object.freeze({
    color: 0x000000,
    alpha: 0.25,
    lightX: 640,
    lightY: 360,
    distanceRatio: 0.12,
    scaleRatio: 0.88,
  }),
  dragHandCard: Object.freeze({
    maxSpeed: 3000,
    lerpFactor: 0.15,
    dragScaleTarget: 1.15,
    dragScaleInDurationMS: 180,
    dragScaleOutDurationMS: 180,
    dragScaleInCurve: Object.freeze({
      enabled: true,
      startScale: 0,
      endScale: 1,
      p1: { x: 0.22, y: 1.0 },
      p2: { x: 0.36, y: 1.0 },
    }) as BezierCurveConfig,
    dragScaleOutCurve: Object.freeze({
      enabled: true,
      startScale: 0,
      endScale: 1,
      p1: { x: 0.4, y: 0.0 },
      p2: { x: 0.6, y: 1.0 },
    }) as BezierCurveConfig,
  }),
  cardVisuals: Object.freeze({
    expandedSections: Object.freeze({
      shadow: true,
      dragShadow: true,
      breathing: true,
      idleTilt: true,
      hoverScale: true,
      hoverBreathing: true,
      mouse3DTilt: true,
      dragHandCard: true,
      hoverHit: true,
      selectMove: true,
      cardOps: true,
    }),
    selectMoveEnabled: true,
    selectRiseY: 30,
    selectMoveDurationMS: 180,
    selectMoveCurve: Object.freeze({
      enabled: true,
      startScale: 0,
      endScale: 1,
      // 类似 cubicOut 的"先快后慢"形状，第一段以较高初速度冲到过弹点。
      p1: { x: 0.18, y: 0.85 },
      p2: { x: 0.32, y: 1.0 },
    }) as BezierCurveConfig,
    selectMoveOvershoot: 8,
    selectMoveStiffness: 10,
    breathingEnabled: true,
    breathingSpeed: 0.002,
    breathingAmplitude: 3,
    wobbleSpeed: 0.001,
    wobbleAmplitude: 0.04,

    idleTiltEnabled: true,
    idleTiltSpeed: 0.0008,
    idleTiltStrength: 0.6,
    idleTiltRadius: 0.55,

    hoverScaleEnabled: true,
    hoverOvershootScale: 1.10,
    hoverSettleScale: 1.05,
    hoverOvershootCount: 1,
    hoverOvershootDamping: 0.5,
    hoverScaleDurationMS: 250,
    hoverScaleCurve: Object.freeze({
      enabled: true,
      startScale: 0,
      endScale: 1,
      p1: { x: 0.12, y: 0.45 },
      p2: { x: 0.16, y: 1.0 },
    }) as BezierCurveConfig,
    hoverScaleOutDurationMS: 150,
    hoverScaleOutOvershootCount: 1,
    hoverScaleOutOvershootFirstScale: 0.97,
    hoverScaleOutOvershootDamping: 0.5,
    hoverScaleOutSpeed: 0.15,

    hoverBreathingEnabled: true,
    hoverBreathingDurationMS: 800,
    hoverBreathingSpeed: 0.006,
    hoverBreathingAmplitude: 4,
    hoverWobbleSpeed: 0.003,
    hoverWobbleAmplitude: 0.06,
    hoverBreathingSpeedDecay: 3.0,
    hoverBreathingAmplitudeDecay: 4.0,

    mouse3DTiltEnabled: true,
    mouse3DTiltStrength: 2.0,
    mouse3DTiltInvertTL: true,
    mouse3DTiltInvertTR: true,
    mouse3DTiltInvertBL: true,
    mouse3DTiltInvertBR: true,
    mouse3DTiltGradientEnabled: false,
    mouse3DTiltStrengthLeftMul: 0.3,
    mouse3DTiltStrengthRightMul: 1.0,
    mouse3DTiltSmoothEnabled: true,
    mouse3DTiltSmoothing: 0.15,

    clickThresholdMS: 250,
    clickDistanceThreshold: 10,

    hoverHitEnabled: true,
    hoverHitEnterScale: 0.9,
    hoverHitLeaveScale: 1.0,
  }),
  scoreCurve: Object.freeze({
    enabled: false,
    startScale: 1,
    endScale: 1.5,
    p1: { x: 0.42, y: 0 },
    p2: { x: 0.58, y: 1 },
  }),
  uiNodes: {},
}) as RuntimeConfig;

/**
 * 激活状态的默认配置，初始为出厂设置 DEFAULT_CONFIG 的深拷贝。
 * 如果后续成功加载了 presets/shipping.json，则将被更新为该 shipping 默认参数，
 * 从而使“恢复出厂默认参数”等操作能正确恢复至项目的 shipping 默认状态。
 */
export const activeDefaultConfig: RuntimeConfig = cloneConfig(DEFAULT_CONFIG);

/**
 * 运行时可写副本。所有业务读这个对象。
 * 用深拷贝避免共享 frozen 引用。
 */
export const CONFIG: RuntimeConfig = cloneConfig(activeDefaultConfig);

/**
 * GameConfig 是老代码的入口名。
 * 现在它指向同一个 CONFIG 引用，做到"老代码零改动 + 面板改值立即生效"。
 */
export const GameConfig: RuntimeConfig = CONFIG;

/** 深拷贝 RuntimeConfig（保证不与 frozen DEFAULT_CONFIG 共享引用）。 */
export function cloneConfig(src: RuntimeConfig): RuntimeConfig {
  return {
    world: { ...src.world },
    rules: { ...src.rules },
    animation: { ...src.animation },
    debug: { ...src.debug },
    cardArt: {
      ...src.cardArt,
      back: { ...src.cardArt.back },
    },
    handLayout: { ...src.handLayout },
    cardShadow: {
      ...src.cardShadow,
    },
    dragShadow: {
      ...src.dragShadow,
    },
    dragHandCard: {
      ...src.dragHandCard,
      dragScaleInCurve: src.dragHandCard.dragScaleInCurve ? {
        ...src.dragHandCard.dragScaleInCurve,
        p1: { ...src.dragHandCard.dragScaleInCurve.p1 },
        p2: { ...src.dragHandCard.dragScaleInCurve.p2 },
      } : undefined as any,
      dragScaleOutCurve: src.dragHandCard.dragScaleOutCurve ? {
        ...src.dragHandCard.dragScaleOutCurve,
        p1: { ...src.dragHandCard.dragScaleOutCurve.p1 },
        p2: { ...src.dragHandCard.dragScaleOutCurve.p2 },
      } : undefined as any,
    },
    cardVisuals: {
      ...src.cardVisuals,
      expandedSections: src.cardVisuals.expandedSections ? {
        ...src.cardVisuals.expandedSections,
      } : undefined as any,
      hoverScaleCurve: src.cardVisuals.hoverScaleCurve ? {
        ...src.cardVisuals.hoverScaleCurve,
        p1: { ...src.cardVisuals.hoverScaleCurve.p1 },
        p2: { ...src.cardVisuals.hoverScaleCurve.p2 },
      } : undefined as any,
      selectMoveCurve: src.cardVisuals.selectMoveCurve ? {
        ...src.cardVisuals.selectMoveCurve,
        p1: { ...src.cardVisuals.selectMoveCurve.p1 },
        p2: { ...src.cardVisuals.selectMoveCurve.p2 },
      } : undefined as any,
    },
    scoreCurve: {
      ...src.scoreCurve,
      p1: { ...src.scoreCurve.p1 },
      p2: { ...src.scoreCurve.p2 },
    },
    uiNodes: cloneUINodes(src.uiNodes),
  };
}

/** 深拷贝 uiNodes 表（避免外部对运行时 CONFIG.uiNodes 的引用污染默认值）。 */
function cloneUINodes(
  src: RuntimeConfig["uiNodes"],
): RuntimeConfig["uiNodes"] {
  if (!src) return {};
  const out: NonNullable<RuntimeConfig["uiNodes"]> = {};
  for (const [id, node] of Object.entries(src)) {
    out[id] = {
      parentId: node.parentId,
      siblingIndex: node.siblingIndex,
      components: node.components.map((c) => ({
        type: c.type,
        data: { ...c.data },
      })),
    };
  }
  return out;
}

/**
 * 把外部数据（旧 preset / 旧 localStorage）按字段名迁移到当前结构。
 * 留作演化兼容钩子，目前保持 no-op，但保留接口以便未来重命名/搬移字段。
 */
export function migrateConfig(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  // 示例：未来若把 rules.handSize 重命名为 rules.maxHand，可以在此就地搬迁。
  // const obj = input as Record<string, any>;
  return input;
}

/**
 * 把任意来源（preset / localStorage / 用户导入）的数据合并进 CONFIG。
 * 用 activeDefaultConfig 兜底缺失字段，保证旧 preset 升级后不丢字段。
 */
export function applyConfig(source: unknown): void {
  const migrated = migrateConfig(source);
  const incoming = (migrated && typeof migrated === "object")
    ? (migrated as Partial<RuntimeConfig>)
    : {};

  const merged = cloneConfig(activeDefaultConfig);
  if (incoming.world) Object.assign(merged.world, incoming.world);
  if (incoming.rules) Object.assign(merged.rules, incoming.rules);
  if (incoming.animation) Object.assign(merged.animation, incoming.animation);
  if (incoming.debug) Object.assign(merged.debug, incoming.debug);
  if (incoming.cardArt) {
    merged.cardArt = {
      ...merged.cardArt,
      ...incoming.cardArt,
      back: { ...merged.cardArt.back, ...(incoming.cardArt.back ?? {}) },
    };
  }
  if (incoming.handLayout) {
    merged.handLayout = {
      ...merged.handLayout,
      ...incoming.handLayout,
    };
  }
  if (incoming.cardShadow) {
    merged.cardShadow = {
      ...merged.cardShadow,
      ...incoming.cardShadow,
    };
  }
  if (incoming.dragShadow) {
    merged.dragShadow = {
      ...merged.dragShadow,
      ...incoming.dragShadow,
    };
  }
  if (incoming.dragHandCard) {
    merged.dragHandCard = {
      ...merged.dragHandCard,
      ...incoming.dragHandCard,
      dragScaleInCurve: incoming.dragHandCard.dragScaleInCurve
        ? {
            ...merged.dragHandCard.dragScaleInCurve,
            ...incoming.dragHandCard.dragScaleInCurve,
            p1: { ...(merged.dragHandCard.dragScaleInCurve?.p1 ?? {}), ...(incoming.dragHandCard.dragScaleInCurve.p1 ?? {}) },
            p2: { ...(merged.dragHandCard.dragScaleInCurve?.p2 ?? {}), ...(incoming.dragHandCard.dragScaleInCurve.p2 ?? {}) },
          }
        : merged.dragHandCard.dragScaleInCurve,
      dragScaleOutCurve: incoming.dragHandCard.dragScaleOutCurve
        ? {
            ...merged.dragHandCard.dragScaleOutCurve,
            ...incoming.dragHandCard.dragScaleOutCurve,
            p1: { ...(merged.dragHandCard.dragScaleOutCurve?.p1 ?? {}), ...(incoming.dragHandCard.dragScaleOutCurve.p1 ?? {}) },
            p2: { ...(merged.dragHandCard.dragScaleOutCurve?.p2 ?? {}), ...(incoming.dragHandCard.dragScaleOutCurve.p2 ?? {}) },
          }
        : merged.dragHandCard.dragScaleOutCurve,
    };
  }
  if (incoming.cardVisuals) {
    merged.cardVisuals = {
      ...merged.cardVisuals,
      ...incoming.cardVisuals,
      expandedSections: incoming.cardVisuals.expandedSections
        ? {
            ...merged.cardVisuals.expandedSections,
            ...incoming.cardVisuals.expandedSections,
          }
        : merged.cardVisuals.expandedSections,
      hoverScaleCurve: incoming.cardVisuals.hoverScaleCurve
        ? {
            ...merged.cardVisuals.hoverScaleCurve,
            ...incoming.cardVisuals.hoverScaleCurve,
            p1: { ...(merged.cardVisuals.hoverScaleCurve?.p1 ?? {}), ...(incoming.cardVisuals.hoverScaleCurve.p1 ?? {}) },
            p2: { ...(merged.cardVisuals.hoverScaleCurve?.p2 ?? {}), ...(incoming.cardVisuals.hoverScaleCurve.p2 ?? {}) },
          }
        : merged.cardVisuals.hoverScaleCurve,
      selectMoveCurve: incoming.cardVisuals.selectMoveCurve
        ? {
            ...merged.cardVisuals.selectMoveCurve,
            ...incoming.cardVisuals.selectMoveCurve,
            p1: { ...(merged.cardVisuals.selectMoveCurve?.p1 ?? {}), ...(incoming.cardVisuals.selectMoveCurve.p1 ?? {}) },
            p2: { ...(merged.cardVisuals.selectMoveCurve?.p2 ?? {}), ...(incoming.cardVisuals.selectMoveCurve.p2 ?? {}) },
          }
        : merged.cardVisuals.selectMoveCurve,
    };
  }
  if (incoming.scoreCurve) {
    merged.scoreCurve = {
      ...merged.scoreCurve,
      ...incoming.scoreCurve,
      p1: { ...merged.scoreCurve.p1, ...(incoming.scoreCurve.p1 ?? {}) },
      p2: { ...merged.scoreCurve.p2, ...(incoming.scoreCurve.p2 ?? {}) },
    };
  }
  // uiNodes：preset 里没带就清空（让 hierarchy 自己重新捕获默认值），
  // 带了就整张表替换（这一表内部条目相互依赖，不适合按字段合并）。
  merged.uiNodes = cloneUINodes(incoming.uiNodes ?? {});

  // 就地写回，保留外部对 CONFIG 的引用稳定。
  CONFIG.world = merged.world;
  CONFIG.rules = merged.rules;
  CONFIG.animation = merged.animation;
  CONFIG.debug = merged.debug;
  CONFIG.cardArt = merged.cardArt;
  CONFIG.handLayout = merged.handLayout;
  CONFIG.cardShadow = merged.cardShadow;
  CONFIG.dragShadow = merged.dragShadow;
  CONFIG.dragHandCard = merged.dragHandCard;
  CONFIG.cardVisuals = merged.cardVisuals;
  CONFIG.scoreCurve = merged.scoreCurve;
  CONFIG.uiNodes = merged.uiNodes;
}

/** 把 CONFIG 重置为当前激活的默认配置。 */
export function resetConfigToDefaults(): void {
  applyConfig(activeDefaultConfig);
}

/**
 * 将载入的 shipping 默认配置数据合并进 activeDefaultConfig
 */
export function applyShippingDefaults(source: unknown): void {
  const migrated = migrateConfig(source);
  const incoming = (migrated && typeof migrated === "object")
    ? (migrated as Partial<RuntimeConfig>)
    : {};

  if (incoming.world) Object.assign(activeDefaultConfig.world, incoming.world);
  if (incoming.rules) Object.assign(activeDefaultConfig.rules, incoming.rules);
  if (incoming.animation) Object.assign(activeDefaultConfig.animation, incoming.animation);
  if (incoming.debug) Object.assign(activeDefaultConfig.debug, incoming.debug);
  if (incoming.cardArt) {
    activeDefaultConfig.cardArt = {
      ...activeDefaultConfig.cardArt,
      ...incoming.cardArt,
      back: { ...activeDefaultConfig.cardArt.back, ...(incoming.cardArt.back ?? {}) },
    };
  }
  if (incoming.handLayout) {
    activeDefaultConfig.handLayout = {
      ...activeDefaultConfig.handLayout,
      ...incoming.handLayout,
    };
  }
  if (incoming.cardShadow) {
    activeDefaultConfig.cardShadow = {
      ...activeDefaultConfig.cardShadow,
      ...incoming.cardShadow,
    };
  }
  if (incoming.dragShadow) {
    activeDefaultConfig.dragShadow = {
      ...activeDefaultConfig.dragShadow,
      ...incoming.dragShadow,
    };
  }
  if (incoming.dragHandCard) {
    activeDefaultConfig.dragHandCard = {
      ...activeDefaultConfig.dragHandCard,
      ...incoming.dragHandCard,
      dragScaleInCurve: incoming.dragHandCard.dragScaleInCurve
        ? {
            ...activeDefaultConfig.dragHandCard.dragScaleInCurve,
            ...incoming.dragHandCard.dragScaleInCurve,
            p1: { ...(activeDefaultConfig.dragHandCard.dragScaleInCurve?.p1 ?? {}), ...(incoming.dragHandCard.dragScaleInCurve.p1 ?? {}) },
            p2: { ...(activeDefaultConfig.dragHandCard.dragScaleInCurve?.p2 ?? {}), ...(incoming.dragHandCard.dragScaleInCurve.p2 ?? {}) },
          }
        : activeDefaultConfig.dragHandCard.dragScaleInCurve,
      dragScaleOutCurve: incoming.dragHandCard.dragScaleOutCurve
        ? {
            ...activeDefaultConfig.dragHandCard.dragScaleOutCurve,
            ...incoming.dragHandCard.dragScaleOutCurve,
            p1: { ...(activeDefaultConfig.dragHandCard.dragScaleOutCurve?.p1 ?? {}), ...(incoming.dragHandCard.dragScaleOutCurve.p1 ?? {}) },
            p2: { ...(activeDefaultConfig.dragHandCard.dragScaleOutCurve?.p2 ?? {}), ...(incoming.dragHandCard.dragScaleOutCurve.p2 ?? {}) },
          }
        : activeDefaultConfig.dragHandCard.dragScaleOutCurve,
    };
  }
  if (incoming.cardVisuals) {
    activeDefaultConfig.cardVisuals = {
      ...activeDefaultConfig.cardVisuals,
      ...incoming.cardVisuals,
      expandedSections: incoming.cardVisuals.expandedSections
        ? {
            ...activeDefaultConfig.cardVisuals.expandedSections,
            ...incoming.cardVisuals.expandedSections,
          }
        : activeDefaultConfig.cardVisuals.expandedSections,
      hoverScaleCurve: incoming.cardVisuals.hoverScaleCurve
        ? {
            ...activeDefaultConfig.cardVisuals.hoverScaleCurve,
            ...incoming.cardVisuals.hoverScaleCurve,
            p1: { ...(activeDefaultConfig.cardVisuals.hoverScaleCurve?.p1 ?? {}), ...(incoming.cardVisuals.hoverScaleCurve.p1 ?? {}) },
            p2: { ...(activeDefaultConfig.cardVisuals.hoverScaleCurve?.p2 ?? {}), ...(incoming.cardVisuals.hoverScaleCurve.p2 ?? {}) },
          }
        : activeDefaultConfig.cardVisuals.hoverScaleCurve,
      selectMoveCurve: incoming.cardVisuals.selectMoveCurve
        ? {
            ...activeDefaultConfig.cardVisuals.selectMoveCurve,
            ...incoming.cardVisuals.selectMoveCurve,
            p1: { ...(activeDefaultConfig.cardVisuals.selectMoveCurve?.p1 ?? {}), ...(incoming.cardVisuals.selectMoveCurve.p1 ?? {}) },
            p2: { ...(activeDefaultConfig.cardVisuals.selectMoveCurve?.p2 ?? {}), ...(incoming.cardVisuals.selectMoveCurve.p2 ?? {}) },
          }
        : activeDefaultConfig.cardVisuals.selectMoveCurve,
    };
  }
  if (incoming.scoreCurve) {
    activeDefaultConfig.scoreCurve = {
      ...activeDefaultConfig.scoreCurve,
      ...incoming.scoreCurve,
      p1: { ...activeDefaultConfig.scoreCurve.p1, ...(incoming.scoreCurve.p1 ?? {}) },
      p2: { ...activeDefaultConfig.scoreCurve.p2, ...(incoming.scoreCurve.p2 ?? {}) },
    };
  }
  if (incoming.uiNodes) {
    activeDefaultConfig.uiNodes = cloneUINodes(incoming.uiNodes);
  }

  // 更新底层 activeDefaultConfig 后，同时将其应用到当前的运行状态 CONFIG 之中
  applyConfig(activeDefaultConfig);
}

/**
 * 异步从 presets/shipping.json 载入 shipping 参数
 */
export async function loadShippingConfig(): Promise<void> {
  try {
    const response = await fetch("presets/shipping.json");
    if (!response.ok) {
      // 没找到 shipping 属于正常情况（开发阶段还未放置），直接返回
      return;
    }
    const data = await response.json();
    if (!data || typeof data !== "object") {
      console.warn("[config] presets/shipping.json 格式错误，忽略加载。");
      return;
    }

    // 支持标准的预设封装格式与直接的 CONFIG 格式
    const configToApply = data.type === "runtime-control-preset" && data.config
      ? data.config
      : data;

    applyShippingDefaults(configToApply);
    console.log("[config] 成功载入默认 Shipping 预设配置:", configToApply);
  } catch (err) {
    // 可能是网络原因或本地文件不存在，记录 debug 级别的日志即可
    console.debug("[config] presets/shipping.json 未载入或不存在:", err);
  }
}

const CONFIG_STORAGE_KEY = "balatroRuntimeConfig";

export function loadSavedConfig(storageKey: string = CONFIG_STORAGE_KEY): void {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return;

    // UI 序列化布局结构（uiNodes）跨版本不兼容时直接丢弃，让 hierarchy
    // 自己用默认结构重建；其余参数仍然合并进 CONFIG。
    const savedVersion = typeof parsed["__version"] === "number"
      ? (parsed["__version"] as number)
      : 0;
    if (savedVersion !== CONFIG_VERSION) {
      delete parsed["uiNodes"];
    }

    applyConfig(parsed);
  } catch (err) {
    console.error("[config] 读取本地保存配置失败：", err);
  }
}

export function saveCurrentConfig(
  storageKey: string = CONFIG_STORAGE_KEY,
): void {
  try {
    const payload = { __version: CONFIG_VERSION, ...CONFIG };
    localStorage.setItem(storageKey, JSON.stringify(payload));
  } catch (err) {
    console.error("[config] 保存配置失败：", err);
  }
}

export const STORAGE_KEYS = {
  config: CONFIG_STORAGE_KEY,
  presets: "balatroRuntimeControlPresets",
};
