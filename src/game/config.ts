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
    /** 无限出牌/弃牌次数：开启后出牌、弃牌都不扣减计数，按钮也不会因次数耗尽而禁用 */
    unlimitedActions: boolean;
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
  /**
   * 卡牌换位（手动理牌）
   *
   * 触发场景：玩家拖拽手牌时，拖拽牌中心 x 越过相邻牌当前槽位中线 →
   * GameController.reorderHandWhileDragging 在 hand 数组中 splice 互换位置 →
   * 被让位的相邻牌走此动画到新槽位。
   *
   * 与「归位/发牌（cardOvershoot 组 1）」和「拖拽急停（cardOvershoot 组 2）」完全独立：
   * 换位距离总是 ≈ handLayout.cardSpacing（小且固定），无需距离/速度自适应——
   * 固定时长 + 固定过冲幅度即可达到"利落 + 过冲 + 回弹"的视觉反馈。
   *
   * 动画形态（与 selectMove 同构，仅作用轴向不同）：
   *   rise   ：当前位置 → 沿目标方向越过 overshootPx 的"过冲点"（rotation 也在此段做到位）
   *   spring ：过冲点 → 真正落点（只动 x/y）
   *
   * 缓动曲线复用 cardOvershoot.tweenRiseCurve / tweenSpringCurve，
   * 保持与归位/发牌的曲线观感一致；如果未来需要独立调整，再升级为独立曲线字段。
   */
  handSwap: {
    /** 总开关。关闭后让位走单段补间，无过冲。 */
    enabled: boolean;
    /** rise 段时长（ms）：从当前位置加速越过目标到过冲点。建议 80~140。 */
    riseDurationMS: number;
    /** spring 段时长（ms）：从过冲点回弹到 target。建议 80~140。 */
    springDurationMS: number;
    /**
     * 过冲幅度（像素，沿运动方向投影）。
     * 建议不超过 handLayout.cardSpacing 的 25%（默认 spacing=65 → 不超过 16），
     * 否则视觉上会撞到下一张牌的位置造成穿插错觉。
     */
    overshootPx: number;
  };
  /** 【出牌】手牌换位 */
  playHandSwap: {
    enabled: boolean;
    riseDurationMS: number;
    springDurationMS: number;
    overshootPx: number;
  };
  /** 【出牌】出牌堆的位移 */
  playPileDisplacement: {
    enabled: boolean;
    cardSpacing: number;
    riseDurationMS: number;
    springDurationMS: number;
    overshootPx: number;
    firstIntervalMS: number;
    intervalReductionMS: number;
    lastIntervalMS: number;
  };
  /**
   * 卡牌移动旋转（velocity-based tilt）
   *
   * 物理直觉：想象一根钉子垂直于牌面插进卡牌的中上部（轴点）。当钉子带动卡牌移动时，
   * 卡牌会以"穿孔点"为旋转中心产生轻微的拖尾旋转——水平移动越快、卡牌偏移越明显，
   * 而垂直移动（沿轴点-质心方向）几乎不会产生旋转（无力臂）。
   *
   * 适用范围：所有卡牌移动场景统一生效——鼠标拖拽、松手归位、未来的理牌/发牌/弃牌等。
   *
   * 模型：
   *   1. 每帧采样位移：vx = (curX - prevX) / dtMS，单位 px/ms。
   *   2. 方向投影：旋转目标只取与"轴点→中心"垂直方向上的速度分量。
   *      轴点放在卡牌中上部时，该方向就是水平方向，所以垂直拖动几乎不产生旋转目标。
   *   3. 目标旋转角 = clamp(vEffective * rotationPerSpeed, ±maxRot)，
   *      其中 maxRot = (dragHandCard.maxSpeed / 1000) * rotationPerSpeed
   *      ——即"卡牌能达到的最高速度下产生的旋转角"，作为派生上限自动同步，
   *      无需手动设置（也避免手动值与速度上限不匹配造成的死区或溢出）。
   *   4. 平滑跟随：velocityRotation 以 followLerp 的速率追目标，
   *      同时受 friction（摩擦力）的恒定拉回，最终静止时回到 0。
   *   5. 绕轴点效果：通过对 displayWrapper.position 做反向补偿，
   *      使最终视觉效果等价于"以 pivotOffset 处为不动点旋转 velocityRotation"。
   */
  /**
   * 卡牌过冲反弹（overshoot / spring-back）
   *
   * 把"快速移动 → 抵达最终落点"的场景统一加上"略微越过落点再回弹"的视觉细节。
   * 适用三类运动：
   *   1. 归位（拖拽松手后回到 layout 位置）
   *   2. 发牌（牌从屏幕外飞到手牌位置）
   *   3. 拖拽急停（鼠标快速移动后骤停，卡牌冲过手指位置再拉回）
   *
   * 分两组参数：
   *   - tween*：作用于"归位"和"发牌"两类 Tween 路径，由 CardFx.moveToWithOvershoot 消费。
   *   - drag* ：作用于拖拽中（CardView.updateDragging）的速度模型，让急停时自然过冲。
   *
   * 归位/发牌触发条件：最近一帧实际速度低于最小速度比例时不触发；达到最小速度比例后，
   *                   过冲幅度随速度线性增长，最高速度使用最大过冲幅度。
   */
  cardOvershoot: {
    /** 总开关 */
    enabled: boolean;

    // ── 组 1：归位 / 发牌（Tween 路径） ──────────────────────────
    //
    // 【模型】距离驱动的过冲幅度 + 目标平均速度自适应时长。
    //
    // 过去版本以"释放瞬间卡牌速度"作为过冲幅度的输入，但快速甩牌时
    // 卡牌实际位置滞后于鼠标，"卡牌位置→layout 目标"距离一定很大；
    // 而定住释放时距离很小。距离差异天然区分了"重弹/轻弹/不弹"语义，
    // 比速度更稳定（速度受 lerp、ticker 节流、ease 形状影响）且更符合
    // 物理直觉：远距离归位 = 弹簧拉得远 = 弹回来的过冲也大。
    //
    // 时长（rise 段）则按"目标平均速度 + 上下限"自适应——保证不同
    // 释放距离下"该牌归位的速度感"始终一致，避免远距离归位"嗖"地
    // 飞回去、近距离归位拖拖拉拉的体验失衡。

    /** 距离 ≥ tweenFullOvershootDistancePx 时使用的最大过冲幅度（像素，沿运动方向投影）。建议 8~30。 */
    tweenOvershootPx: number;
    /** 距离 = tweenMinOvershootDistancePx 时使用的最小过冲幅度（像素）。建议 2~10。 */
    tweenMinOvershootPx: number;
    /**
     * 触发过冲所需的最小起点距离（像素）。
     * 释放瞬间 |card → layoutTarget| < 此值时，认为是"轻微归位"，不触发过冲，
     * 直接走单段 moveTo。建议 16~60。
     */
    tweenMinOvershootDistancePx: number;
    /**
     * 过冲幅度饱和距离（像素）：距离 ≥ 此值时使用 tweenOvershootPx 满额过冲。
     * tweenMinOvershootDistancePx ~ 此值之间，过冲幅度从 tweenMinOvershootPx
     * 线性插值到 tweenOvershootPx。建议 180~400（≈ 卡牌甩到屏幕半幅的距离）。
     * 必须 > tweenMinOvershootDistancePx，否则插值退化。
     */
    tweenFullOvershootDistancePx: number;
    /**
     * 归位目标平均速度（px/s）：rise 段时长 = 距离 / 此值，从而无论
     * 释放距离远近，视觉"归位速度"都接近该值。
     * 建议 800~2000。值越大，归位越急；越小越温吞。
     */
    tweenReturnAvgSpeed: number;
    /** rise 段时长下限（ms）：自适应时长被 clamp 到这个下限，避免极短距离瞬移。建议 100~180。 */
    tweenReturnMinMS: number;
    /** rise 段时长上限（ms）：自适应时长被 clamp 到这个上限，避免极远距离拖沓。建议 360~600。 */
    tweenReturnMaxMS: number;
    /**
     * 【已弃用】最小触发速度比例（0~1）。
     * 组 1（归位/发牌）已迁移到"距离驱动"模型，不再读取此值。
     * 仍保留是因为组 2（拖拽急停）共用此字段作为"高速判定阈值"。
     */
    tweenSpeedRatioThreshold: number;
    /**
     * 【已弃用】rise 段时长占比。
     * 组 1 改为按"目标平均速度+上下限"自适应 riseMS，不再读取此值。
     * 保留以兼容 UI 输入框；可在后续版本中彻底移除。
     */
    tweenRiseRatio: number;
    /** 第一段（start → 过冲点）缓动曲线（贝塞尔）。建议偏减速形状，便于和过冲衔接。 */
    tweenRiseCurve: BezierCurveConfig;
    /** 弹簧回弹刚度（无量纲）：第二段时长 = round(1000 / 此值)。建议 5~30。 */
    tweenSpringStiffness: number;
    /** 第二段（过冲点 → 终点）缓动曲线（贝塞尔）。建议类似 cubicOut，柔和回拉。 */
    tweenSpringCurve: BezierCurveConfig;

    // ── 组 2：拖拽中急停（一次性过冲） ──────────────────────────
    /**
     * 是否启用拖拽急停过冲。
     * 开启后，鼠标在拖拽中急停时（基于"速度突降"信号判定，详见 dragLowSpeedRatio），
     * 触发一次性"rise + spring"两段补间：
     *   rise   : 卡牌当前位置 → 沿运动方向越过 dragTarget tweenOvershootPx 像素的过冲点
     *   spring : 过冲点 → dragTarget
     * 整个过程只过冲一次，不振荡。
     *
     * 关闭后退化为原始朝目标 lerp，急停时卡牌瞬间停在 dragTarget 附近。
     *
     * 注：rise / spring 段的过冲幅度、时长占比、缓动曲线、回弹刚度
     * 直接复用上面"组 1"里 tween* 系列参数，保证两条路径的过冲手感一致；
     * 拖拽总时长固定为 animation.moveDurationMS / 2（拖拽急停比归位更"急"）。
     */
    dragInertiaEnabled: boolean;
    /**
     * 拖拽急停【最大】过冲幅度（像素）。
     * 当急停触发瞬间「高速段速度」达到 maxSpeed 时使用此幅度。
     * 与 dragMinOvershootPx + dragOvershootMinSpeedRatio 一起线性映射。
     */
    dragOvershootPx: number;
    /**
     * 拖拽急停【最小】过冲幅度（像素）。
     * 当急停触发瞬间「高速段速度」刚好达到 dragOvershootMinSpeedRatio × maxSpeed 时
     * 使用此幅度；速度更低也不会更低（但本来低于 tweenSpeedRatioThreshold 就不会触发急停）。
     * 建议 2~8，明显小于 dragOvershootPx。
     */
    dragMinOvershootPx: number;
    /**
     * 拖拽急停过冲幅度的「最小速度比例」（0~1）：
     * 急停触发瞬间，prev pointermove 采样的瞬时速度 / maxSpeed 若 ≤ 此比例，
     * 使用 dragMinOvershootPx；若 ≥ 1.0（达到 maxSpeed），使用 dragOvershootPx；
     * 中间按线性插值。
     *
     * 与 tweenSpeedRatioThreshold 解耦：tweenSpeedRatioThreshold 决定「是否触发急停」，
     * 而本字段只决定「触发后过冲幅度的线性映射下界」。建议 ≥ tweenSpeedRatioThreshold，
     * 否则下半段映射区间不会被实际使用。建议 0.5~0.7。
     */
    dragOvershootMinSpeedRatio: number;
    /** 拖拽急停第一段（当前位置 → 过冲点）时长。 */
    dragRiseDurationMS: number;
    /** 拖拽急停第二段（过冲点 → 手指落点）时长。 */
    dragSpringDurationMS: number;
    /** 拖拽急停第一段缓动曲线。 */
    dragRiseCurve: BezierCurveConfig;
    /** 拖拽急停第二段回弹曲线。 */
    dragSpringCurve: BezierCurveConfig;
    /**
     * 急停静默兜底时长（ms）：如果最后一次 pointermove 已经达到高速阈值，
     * 之后超过这段时间没有新的 pointermove，也视为急停。
     * 设为 0 时禁用静默兜底，只使用"高速 → 低速"速度突降信号。
     */
    dragQuietTriggerMS: number;
    /** 触发冷却（ms）：一次拖拽急停过冲请求后，至少间隔这段时间才允许下一次。 */
    dragTriggerCooldownMS: number;
    /**
     * 急停触发的"低速比例"阈值（0~1）：
     * 触发判定 = 上一次 pointermove 采样的瞬时速度 ≥ maxSpeed × tweenSpeedRatioThreshold
     *           && 本次采样的瞬时速度 ≤ maxSpeed × dragLowSpeedRatio。
     *
     * 物理语义：手指曾经处于"快速移动"状态，最新一次采样突然降到"明显慢"——
     * 这就是"急停"。原来基于"30ms 静默"的判定在浏览器 pointermove 节流（每帧都发）
     * 下永远无法满足，所以改成这套"速度突降"信号。
     *
     * 建议 0.2~0.4：太低（如 0.05）需要鼠标几乎完全静止才触发，错过半急停；
     * 太高（如 0.6）容易把正常减速也当作急停反复触发。默认 0.3。
     */
    dragLowSpeedRatio: number;
    /**
     * 过冲取消阈值（像素）：在 rise/spring 进行期间，
     * 如果 dragTarget 相对触发时锚定的目标偏移超过此值（意味着用户重新挪动了鼠标），
     * 立刻取消过冲、回到普通 lerp 跟随。建议 12~40。
     */
    dragCancelDistancePx: number;
    /**
     * 鼠标速度上限（px/s）——所有「速度 / maxSpeed」计算的统一分母。
     * 注意与 dragHandCard.maxSpeed 区分：后者是「卡牌跟手能被推到的最大速度」，
     * 而鼠标本身的瞬时速度（pointermove 采样）可以远超那个值（甩动时 6000~10000 px/s）。
     * 若混用同一分母会导致 ratio 长期撞顶到 1.0，线性映射区间形同虚设。
     * 建议 5000~8000（屏幕分辨率/玩家习惯而异）。
     */
    dragPointerMaxSpeed: number;
    /**
     * 鼠标速度采样的 EMA 平滑时间常数（ms）。
     * 0 = 禁用平滑，直接用 raw = 位移 / dt。值越大越平滑但越滞后。
     * 主要作用：抑制 pointermove dt 抖动（8ms vs 24ms）导致的伪突降/伪峰值。
     * 建议 16~32（约 1~2 帧）。
     */
    dragSpeedSmoothingMS: number;
    /**
     * 峰值速度衰减率（1/s）。pointerPeakSpeed 在没有更高速度刷新时按
     * peak *= exp(-rate * dt) 衰减，避免一次甩动后的峰值永久驻留导致后续
     * 慢速急停也用满档过冲幅度。
     * 0 = 不衰减（峰值始终保持）。建议 3~8。
     */
    dragPeakDecayPerSec: number;
  };
  cardMoveRotation: {
    /** 总开关 */
    enabled: boolean;
    /**
     * 调试开关：在每张卡牌上叠加一个红色十字小点，标记当前 pivotOffset 在卡面上的位置。
     * 该标记不跟随 velocityRotation 旋转，因此可以用作"轴点应不动"的视觉参考——
     * 拖拽时若补偿数学正确，卡面上原本在标记下的图案点应当始终被标记盖住。
     * 正式构建时保持 false。
     */
    showPivot: boolean;
    /**
     * 旋转轴点相对于卡牌几何中心 (W/2, H/2) 的偏移（卡牌本地坐标，像素）。
     * 默认中上部：pivotOffsetX = 0, pivotOffsetY < 0（向上偏）。
     * 例如 H = 180 时，pivotOffsetY = -60 表示轴点位于卡牌顶端往下约 1/3 处。
     */
    pivotOffsetX: number;
    pivotOffsetY: number;
    /**
     * 每单位有效速度（px/ms）映射到多少弧度的目标旋转角。
     * 数值越大，相同速度下旋转越明显。建议范围 0.02 ~ 0.15。
     * 注：vx 为 px/ms，所以速度 1 px/ms = 1000 px/s 是相当快的拖拽。
     */
    rotationPerSpeed: number;
    /**
     * 速度→旋转目标的跟随插值系数 (0~1，按 16.67ms 标准帧计算)。
     * 越大跟得越快、越灵敏；越小越钝。建议 0.15 ~ 0.45。
     */
    followLerp: number;
    /**
     * 穿孔摩擦力 (0~1)：每帧把 velocityRotation 向 0 衰减的比例（按标准帧）。
     * 摩擦力越大，旋转越快回正，速度变化产生的旋转越被压制；
     * 摩擦力越小，旋转更持久、更"自由"。建议 0.05 ~ 0.30。
     * 设为 0 时只靠 followLerp 回正（速度恢复 0 后旋转才衰减）。
     */
    friction: number;
    /**
     * 极小速度阈值 (px/ms)：|vEffective| 低于此值时直接视为 0,
     * 避免微抖动造成持续小幅旋转。建议 0.01 ~ 0.05。
     */
    minSpeed: number;
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
      cardMoveRotation: boolean;
      cardOvershoot: boolean;
      handSwap: boolean;
      playHandSwap: boolean;
      playPileDisplacement: boolean;
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
  /**
   * 出牌堆（PlayPile）参数
   *
   * 出牌流程分 5 阶段，每个阶段都用最简 tween 占位实现"位移正确"，
   * 复杂视效（过冲曲线/阴影抬起/内缩双弹/爆字等）作为未来 TODO 钩子。
   *
   * 阶段说明：
   *   1. 逐张出牌：选中牌按 handIndex 从左到右依次飞往出牌堆，每张错开
   *      = flyDurationMS * ejectIntervalRatio；同时 layoutHand 让剩余手牌挤位。
   *   2. 出牌堆排布：第一张居中，之后每张沿 +x 偏移 cardSpacing；
   *      过冲幅度按位置插值（首尾大、中间小，留 TODO）。
   *      整堆"中位"对齐手牌堆中位。
   *   3. 上抬：整堆 y -= liftPx 做一次过冲（钩子：未来加阴影抬起）。
   *   4. 结算：内缩 → 过大弹两次（钩子：每次弹出"+"号、爆字）。
   *   5. 下移 + 丢牌：整堆下移收阴影 → 从左到右逐张 flyOut。
   */
  playPile: {
    /** 出牌堆基准 Y 相对手牌堆 baseY 的偏移（负值在手牌堆上方）。 */
    baseYOffset: number;
    /** 是否让出牌堆中位对齐手牌堆中位。false 时使用世界 X 中线。 */
    centerAlignsHand: boolean;
    /** 出牌堆相邻牌中心点 X 间距（像素）。 */
    cardSpacing: number;
    // —— 阶段 1：发车节奏 ——
    /** 单张牌从手牌位置飞到出牌堆槽位的时长（ms）。 */
    flyDurationMS: number;
    /**
     * 错开比例：下一张牌在上一张飞行进度达到此比例时出发。
     * 0.0 = 完全同时；1.0 = 上一张完全落定才出发。
     * 你描述的"位移完全结束的前一瞬间"≈ 0.7~0.85。
     */
    ejectIntervalRatio: number;
    // —— 阶段 2：每张牌的落位过冲（钩子位，先用简单参数占位） ——
    /** 第一张牌的过冲幅度（像素）。 */
    overshootFirstPx: number;
    /** 中间张牌的过冲幅度（像素）。 */
    overshootMidPx: number;
    /** 最后一张牌的过冲幅度（像素）。 */
    overshootLastPx: number;
    // —— 阶段 3：整堆上抬 ——
    /** 上抬距离（像素，向上为正）。 */
    liftPx: number;
    /** 上抬时长（ms）。 */
    liftDurationMS: number;
    /** 上抬过冲幅度（像素，先占位）。 */
    liftOvershootPx: number;
    // —— 阶段 4：结算（内缩 → 过大弹两次） ——
    /** 内缩 scale 目标。 */
    squashScale: number;
    /** 内缩时长（ms）。 */
    squashDurationMS: number;
    /** 过大弹峰值 scale。 */
    bouncePeakScale: number;
    /** 过大弹次数（先实现 1~2 次）。 */
    bounceCount: number;
    /** 单次过大弹时长（ms）。 */
    bounceDurationMS: number;
    // —— 阶段 5：下移 + 丢牌 ——
    /** 整堆下移时长（ms）。 */
    dropDurationMS: number;
    /** 丢牌发车间隔（ms，从左到右逐张）。 */
    discardIntervalMS: number;
    /** 单张丢牌飞出时长（ms）。 */
    discardFlyDurationMS: number;
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
    unlimitedActions: false,
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
  handSwap: Object.freeze({
    enabled: true,
    riseDurationMS: 110,
    springDurationMS: 110,
    overshootPx: 12,
  }),
  playHandSwap: Object.freeze({
    enabled: true,
    riseDurationMS: 60,
    springDurationMS: 50,
    overshootPx: 12,
  }),
  playPileDisplacement: Object.freeze({
    enabled: true,
    cardSpacing: 70,
    riseDurationMS: 60,
    springDurationMS: 50,
    overshootPx: 12,
    firstIntervalMS: 400,
    intervalReductionMS: 80,
    lastIntervalMS: 160,
  }),
  cardOvershoot: Object.freeze({
    enabled: true,
    // 归位/发牌（Tween 路径，距离驱动）：
    //   距离 < 30px：不过冲
    //   距离 30~280px：过冲幅度 6 → 14 像素线性插值
    //   距离 ≥ 280px：14 像素满额
    // rise 时长：距离 / 1400 px/s，clamp 到 [140, 420] ms
    tweenOvershootPx: 14,
    tweenMinOvershootPx: 6,
    tweenMinOvershootDistancePx: 30,
    tweenFullOvershootDistancePx: 280,
    tweenReturnAvgSpeed: 1400,
    tweenReturnMinMS: 140,
    tweenReturnMaxMS: 420,
    tweenSpeedRatioThreshold: 0.5,
    tweenRiseRatio: 0.75,
    tweenRiseCurve: Object.freeze({
      enabled: true,
      startScale: 0,
      endScale: 1,
      // 类似 cubicOut 的减速形状：开头快、末尾接近水平，便于和过冲点衔接。
      p1: { x: 0.18, y: 0.85 },
      p2: { x: 0.32, y: 1.0 },
    }) as BezierCurveConfig,
    tweenSpringStiffness: 10, // → 第二段约 100ms
    tweenSpringCurve: Object.freeze({
      enabled: true,
      startScale: 0,
      endScale: 1,
      // cubicOut 风格：从过冲点柔和回拉到终点。
      p1: { x: 0.22, y: 1.0 },
      p2: { x: 0.36, y: 1.0 },
    }) as BezierCurveConfig,
    // 拖拽中急停一次性过冲
    dragInertiaEnabled: true,
    // 过冲幅度按急停触发瞬间「高速段速度」在 [dragOvershootMinSpeedRatio×maxSpeed, maxSpeed]
    // 之间线性插值到 [dragMinOvershootPx, dragOvershootPx]。
    dragOvershootPx: 14,
    dragMinOvershootPx: 4,
    dragOvershootMinSpeedRatio: 0.5,
    dragRiseDurationMS: 112,
    dragSpringDurationMS: 100,
    dragRiseCurve: Object.freeze({
      enabled: true,
      startScale: 0,
      endScale: 1,
      p1: { x: 0.18, y: 0.85 },
      p2: { x: 0.32, y: 1.0 },
    }) as BezierCurveConfig,
    dragSpringCurve: Object.freeze({
      enabled: true,
      startScale: 0,
      endScale: 1,
      p1: { x: 0.22, y: 1.0 },
      p2: { x: 0.36, y: 1.0 },
    }) as BezierCurveConfig,
    dragQuietTriggerMS: 45,
    dragTriggerCooldownMS: 180,
    // 急停信号：上一次采样高速 (>= 0.5×maxSpeed) 且本次采样降到 (<= 0.3×maxSpeed)
    dragLowSpeedRatio: 0.3,
    dragCancelDistancePx: 24,
    // 鼠标速度上限（独立于 dragHandCard.maxSpeed）。
    dragPointerMaxSpeed: 6000,
    // 鼠标速度 EMA 平滑窗口（≈1.5 帧）。
    dragSpeedSmoothingMS: 24,
    // 峰值速度衰减率：≈250ms 衰减到约 1/e，足以保留单次甩动的峰值但不会跨次驻留。
    dragPeakDecayPerSec: 4,
  }),
  cardMoveRotation: Object.freeze({
    enabled: true,
    // 默认不显示轴点（仅调参时打开）。
    showPivot: false,
    // 轴点：卡牌几何中心向上偏 35 像素（卡牌 H ≈ 180，此值落在"中上部"区间）。
    pivotOffsetX: 0,
    pivotOffsetY: -35,
    // 1 px/ms ≈ 1000 px/s（正常拖拽速度）× 0.06 ≈ 0.06 rad ≈ 3.4°
    // 注：旋转上限 maxRot 由 (dragHandCard.maxSpeed/1000) × rotationPerSpeed 派生，
    //     不再作为独立配置项存储。默认 (3000/1000)*0.06 = 0.18 rad ≈ 10.3°。
    rotationPerSpeed: 0.06,
    followLerp: 0.25,
    friction: 0.12,
    minSpeed: 0.02,
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
      cardMoveRotation: true,
      cardOvershoot: true,
      handSwap: true,
      playHandSwap: true,
      playPileDisplacement: true,
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
  playPile: Object.freeze({
    baseYOffset: -220,
    centerAlignsHand: true,
    cardSpacing: 70,
    flyDurationMS: 260,
    ejectIntervalRatio: 0.75,
    overshootFirstPx: 18,
    overshootMidPx: 8,
    overshootLastPx: 18,
    liftPx: 30,
    liftDurationMS: 220,
    liftOvershootPx: 10,
    squashScale: 0.9,
    squashDurationMS: 140,
    bouncePeakScale: 1.12,
    bounceCount: 2,
    bounceDurationMS: 160,
    dropDurationMS: 220,
    discardIntervalMS: 80,
    discardFlyDurationMS: 320,
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
    cardOvershoot: {
      ...src.cardOvershoot,
      tweenRiseCurve: src.cardOvershoot.tweenRiseCurve ? {
        ...src.cardOvershoot.tweenRiseCurve,
        p1: { ...src.cardOvershoot.tweenRiseCurve.p1 },
        p2: { ...src.cardOvershoot.tweenRiseCurve.p2 },
      } : undefined as any,
      tweenSpringCurve: src.cardOvershoot.tweenSpringCurve ? {
        ...src.cardOvershoot.tweenSpringCurve,
        p1: { ...src.cardOvershoot.tweenSpringCurve.p1 },
        p2: { ...src.cardOvershoot.tweenSpringCurve.p2 },
      } : undefined as any,
      dragRiseCurve: src.cardOvershoot.dragRiseCurve ? {
        ...src.cardOvershoot.dragRiseCurve,
        p1: { ...src.cardOvershoot.dragRiseCurve.p1 },
        p2: { ...src.cardOvershoot.dragRiseCurve.p2 },
      } : undefined as any,
      dragSpringCurve: src.cardOvershoot.dragSpringCurve ? {
        ...src.cardOvershoot.dragSpringCurve,
        p1: { ...src.cardOvershoot.dragSpringCurve.p1 },
        p2: { ...src.cardOvershoot.dragSpringCurve.p2 },
      } : undefined as any,
    },
    handSwap: { ...src.handSwap },
    playHandSwap: { ...src.playHandSwap },
    playPileDisplacement: { ...src.playPileDisplacement },
    cardMoveRotation: { ...src.cardMoveRotation },
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
    playPile: { ...src.playPile },
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
  if (incoming.cardMoveRotation) {
    merged.cardMoveRotation = {
      ...merged.cardMoveRotation,
      ...incoming.cardMoveRotation,
    };
  }
  if (incoming.cardOvershoot) {
    merged.cardOvershoot = {
      ...merged.cardOvershoot,
      ...incoming.cardOvershoot,
      tweenRiseCurve: incoming.cardOvershoot.tweenRiseCurve
        ? {
            ...merged.cardOvershoot.tweenRiseCurve,
            ...incoming.cardOvershoot.tweenRiseCurve,
            p1: { ...(merged.cardOvershoot.tweenRiseCurve?.p1 ?? {}), ...(incoming.cardOvershoot.tweenRiseCurve.p1 ?? {}) },
            p2: { ...(merged.cardOvershoot.tweenRiseCurve?.p2 ?? {}), ...(incoming.cardOvershoot.tweenRiseCurve.p2 ?? {}) },
          }
        : merged.cardOvershoot.tweenRiseCurve,
      tweenSpringCurve: incoming.cardOvershoot.tweenSpringCurve
        ? {
            ...merged.cardOvershoot.tweenSpringCurve,
            ...incoming.cardOvershoot.tweenSpringCurve,
            p1: { ...(merged.cardOvershoot.tweenSpringCurve?.p1 ?? {}), ...(incoming.cardOvershoot.tweenSpringCurve.p1 ?? {}) },
            p2: { ...(merged.cardOvershoot.tweenSpringCurve?.p2 ?? {}), ...(incoming.cardOvershoot.tweenSpringCurve.p2 ?? {}) },
          }
        : merged.cardOvershoot.tweenSpringCurve,
      dragRiseCurve: incoming.cardOvershoot.dragRiseCurve
        ? {
            ...merged.cardOvershoot.dragRiseCurve,
            ...incoming.cardOvershoot.dragRiseCurve,
            p1: { ...(merged.cardOvershoot.dragRiseCurve?.p1 ?? {}), ...(incoming.cardOvershoot.dragRiseCurve.p1 ?? {}) },
            p2: { ...(merged.cardOvershoot.dragRiseCurve?.p2 ?? {}), ...(incoming.cardOvershoot.dragRiseCurve.p2 ?? {}) },
          }
        : merged.cardOvershoot.dragRiseCurve,
      dragSpringCurve: incoming.cardOvershoot.dragSpringCurve
        ? {
            ...merged.cardOvershoot.dragSpringCurve,
            ...incoming.cardOvershoot.dragSpringCurve,
            p1: { ...(merged.cardOvershoot.dragSpringCurve?.p1 ?? {}), ...(incoming.cardOvershoot.dragSpringCurve.p1 ?? {}) },
            p2: { ...(merged.cardOvershoot.dragSpringCurve?.p2 ?? {}), ...(incoming.cardOvershoot.dragSpringCurve.p2 ?? {}) },
          }
        : merged.cardOvershoot.dragSpringCurve,
    };
  }
  if (incoming.handSwap) {
    merged.handSwap = {
      ...merged.handSwap,
      ...incoming.handSwap,
    };
  }
  if (incoming.playHandSwap) {
    merged.playHandSwap = {
      ...merged.playHandSwap,
      ...incoming.playHandSwap,
    };
  }
  if (incoming.playPileDisplacement) {
    merged.playPileDisplacement = {
      ...merged.playPileDisplacement,
      ...incoming.playPileDisplacement,
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
  if (incoming.playPile) {
    merged.playPile = {
      ...merged.playPile,
      ...incoming.playPile,
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
  CONFIG.cardMoveRotation = merged.cardMoveRotation;
  CONFIG.cardOvershoot = merged.cardOvershoot;
  CONFIG.handSwap = merged.handSwap;
  CONFIG.playHandSwap = merged.playHandSwap;
  CONFIG.playPileDisplacement = merged.playPileDisplacement;
  CONFIG.cardVisuals = merged.cardVisuals;
  CONFIG.playPile = merged.playPile;
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
  if (incoming.cardMoveRotation) {
    activeDefaultConfig.cardMoveRotation = {
      ...activeDefaultConfig.cardMoveRotation,
      ...incoming.cardMoveRotation,
    };
  }
  if (incoming.cardOvershoot) {
    activeDefaultConfig.cardOvershoot = {
      ...activeDefaultConfig.cardOvershoot,
      ...incoming.cardOvershoot,
      tweenRiseCurve: incoming.cardOvershoot.tweenRiseCurve
        ? {
            ...activeDefaultConfig.cardOvershoot.tweenRiseCurve,
            ...incoming.cardOvershoot.tweenRiseCurve,
            p1: { ...(activeDefaultConfig.cardOvershoot.tweenRiseCurve?.p1 ?? {}), ...(incoming.cardOvershoot.tweenRiseCurve.p1 ?? {}) },
            p2: { ...(activeDefaultConfig.cardOvershoot.tweenRiseCurve?.p2 ?? {}), ...(incoming.cardOvershoot.tweenRiseCurve.p2 ?? {}) },
          }
        : activeDefaultConfig.cardOvershoot.tweenRiseCurve,
      tweenSpringCurve: incoming.cardOvershoot.tweenSpringCurve
        ? {
            ...activeDefaultConfig.cardOvershoot.tweenSpringCurve,
            ...incoming.cardOvershoot.tweenSpringCurve,
            p1: { ...(activeDefaultConfig.cardOvershoot.tweenSpringCurve?.p1 ?? {}), ...(incoming.cardOvershoot.tweenSpringCurve.p1 ?? {}) },
            p2: { ...(activeDefaultConfig.cardOvershoot.tweenSpringCurve?.p2 ?? {}), ...(incoming.cardOvershoot.tweenSpringCurve.p2 ?? {}) },
          }
        : activeDefaultConfig.cardOvershoot.tweenSpringCurve,
      dragRiseCurve: incoming.cardOvershoot.dragRiseCurve
        ? {
            ...activeDefaultConfig.cardOvershoot.dragRiseCurve,
            ...incoming.cardOvershoot.dragRiseCurve,
            p1: { ...(activeDefaultConfig.cardOvershoot.dragRiseCurve?.p1 ?? {}), ...(incoming.cardOvershoot.dragRiseCurve.p1 ?? {}) },
            p2: { ...(activeDefaultConfig.cardOvershoot.dragRiseCurve?.p2 ?? {}), ...(incoming.cardOvershoot.dragRiseCurve.p2 ?? {}) },
          }
        : activeDefaultConfig.cardOvershoot.dragRiseCurve,
      dragSpringCurve: incoming.cardOvershoot.dragSpringCurve
        ? {
            ...activeDefaultConfig.cardOvershoot.dragSpringCurve,
            ...incoming.cardOvershoot.dragSpringCurve,
            p1: { ...(activeDefaultConfig.cardOvershoot.dragSpringCurve?.p1 ?? {}), ...(incoming.cardOvershoot.dragSpringCurve.p1 ?? {}) },
            p2: { ...(activeDefaultConfig.cardOvershoot.dragSpringCurve?.p2 ?? {}), ...(incoming.cardOvershoot.dragSpringCurve.p2 ?? {}) },
          }
        : activeDefaultConfig.cardOvershoot.dragSpringCurve,
    };
  }
  if (incoming.handSwap) {
    activeDefaultConfig.handSwap = {
      ...activeDefaultConfig.handSwap,
      ...incoming.handSwap,
    };
  }
  if (incoming.playHandSwap) {
    activeDefaultConfig.playHandSwap = {
      ...activeDefaultConfig.playHandSwap,
      ...incoming.playHandSwap,
    };
  }
  if (incoming.playPileDisplacement) {
    activeDefaultConfig.playPileDisplacement = {
      ...activeDefaultConfig.playPileDisplacement,
      ...incoming.playPileDisplacement,
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
  if (incoming.playPile) {
    activeDefaultConfig.playPile = {
      ...activeDefaultConfig.playPile,
      ...incoming.playPile,
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
