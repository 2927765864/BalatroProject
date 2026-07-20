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

/**
 * 配置 schema 版本。
 * 升级时 loadSavedConfig 会：
 *   1) 把旧 localStorage 整包备份到 `balatroRuntimeConfig.bak.v{old}`；
 *   2) 丢弃本地 uiNodes，回退到 shipping / activeDefaultConfig（避免结构漂移 + 历史 bug
 *      把空表/硬编码默认写进 localStorage 后永久盖住调好的界面布局）。
 * 其余数值参数仍按字段合并，用户本地调参不会整表丢失。
 *
 * v5：修复 v4 升级时 shipping.uiNodes 被硬编码默认覆盖、以及 applyConfig
 * 在 uiNodes 缺失时写成 {} 导致界面 UI 全部回退的问题。
 * v6：修复 hydrate 完成前 persist 会把"代码临时父子关系"写进 localStorage
 *     （新增 UI 节点时构造期 setTransform / addComponent 触发），导致布局混乱。
 *     丢弃本地 uiNodes，回退 shipping；UIHierarchy.persist 已加 hydratedOnce 守卫。
 * v7：左侧得分面板按参考图重建（盲注区 / 回合分 / 筹码倍率 / 比赛信息），
 *     节点 id 与父子结构变更，丢弃本地 uiNodes 回退 shipping。
 * v8：补侧栏蓝边/灰底、各子区底框与正确底色（对照参考图红箭头）。
 * v9：去掉子面板多余描边；出牌/弃牌等改为「暗黑底 + 灰数字底」分层。
 * v10：补盲注外底 / 回合分区外底 / 金钱暗黑+灰双层底。
 * v11：盲注区拆出深蓝内容卡（contentCard），外底改为近黑；节点父子变更。
 * v12：盲注徽章改为圆心位姿 + 手牌级拖拽交互；去掉 badge.background/border/label 子节点。
 * v13：卡牌层高于 UI；盲注徽章伪3D/阴影；badgeHome 锚点节点。
 */
export const CONFIG_VERSION = 13;

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

export interface BounceAnimationConfig {
  initScale: number;
  maxScale: number;
  stableScale: number;
  scanSpeed: number;
  scaleStrength: number;
  speedRatio: number;
  /** 旧版解析旋转（仅非弹簧弹弹路径；倍率已改用弹簧）。 */
  rotAngle1?: number;
  rotAngle2?: number;
  rotDamping?: number;
  rotFreq?: number;
}

/**
 * 【弹弹动画】倍率数字 — 弹簧阻尼双通道（对齐 playPileSettleEffect / SpringDamper1D）。
 * scale 目标 1，rot 目标 0；逐字扫描仍由 scanSpeed 控制。
 * 见 docs/play-pile-settle-spring-damper-plan.md 公式与积分约定。
 */
export interface SpringBounceAnimationConfig {
  /** 从左到右逐字触发间隔（ms/字，受 gameSpeed 缩放） */
  scanSpeed: number;
  /** 播放速度倍率（叠乘 gameSpeed 影响积分有效 dt） */
  speedRatio: number;
  mass: number;
  /** 自然频率 ωn (rad/s) */
  angularFreq: number;
  /** 阻尼比 ζ */
  dampingRatio: number;
  /** 初始缩放偏离：xS0 = 1 + impulseScale */
  impulseScale: number;
  /** 初始缩放速度 (1/s) */
  impulseScaleVel: number;
  /** 初始旋转偏离 (度) */
  impulseRotDeg: number;
  /** 初始角速度 (deg/s) */
  impulseRotVelDeg: number;
  settleEpsScale: number;
  settleVelScale: number;
  settleEpsRotDeg: number;
  settleVelRotDeg: number;
  /** 单字最长逻辑时长 ms（受 gameSpeed 缩放） */
  maxDurationMS: number;
  maxDtSec: number;
  substeps: number;
}

export interface EvalScoreTextConfig {
  delayMS: number;
  decreaseDurationMS: number;
  /** 预期得分文字数字减少完并消失后，停留时间 (ms) */
  stayDurationMS: number;
}

/**
 * 【弹弹动画】文字抖动 — 常态逐字角摆动（筹码数字等）。
 * 位数分级：n < minDigits → 0；n == minDigits → baseAngleDeg；
 * n > minDigits → baseAngleDeg * digitGrowth^(n - minDigits)。
 */
export interface TextJitterConfig {
  /** 总开关 */
  enabled: boolean;
  /**
   * minDigits 位时的最大摆角（度，单侧峰值）。
   * 实际 θ ∈ [-A, +A]。
   */
  baseAngleDeg: number;
  /** 角频率（Hz），越大越「快」 */
  frequencyHz: number;
  /** 相邻字相位差（度），避免整串同步 */
  phaseStaggerDeg: number;
  /** 位数增长底数，默认 1.2 */
  digitGrowth: number;
  /**
   * 开始抖动的最小位数（默认 2）。
   * n < minDigits → 幅度 0。
   */
  minDigits: number;
  /** 时间倍率（叠在 wall-clock 上；一般 1） */
  speedRatio: number;
  /**
   * 单字旋转轴点 X（归一化 0–1）。
   * 0 = 字左缘，0.5 = 水平中心（默认），1 = 字右缘。
   * 不改 CharLayer 的 display anchor（缩放仍绕中心），仅对抖动角位移做枢轴补偿。
   */
  pivotX: number;
  /**
   * 单字旋转轴点 Y（归一化 0–1）。
   * 0 = 字顶，0.5 = 垂直中心（默认），1 = 字底。
   */
  pivotY: number;
}

/** 全屏 paint-mix 背景质量档（见 BackgroundView / BalatroBackgroundFilter）。 */
export type BackgroundQuality = "off" | "low" | "med" | "high";

/** 预设主题名；custom 表示三色由面板直接控制。 */
export type BackgroundThemeId =
  | "feltGreen"
  | "smallBlind"
  | "bigBlind"
  | "boss"
  | "custom";

/**
 * 全屏 CRT 后处理档位（见 CrtFilter）。
 * off / subtle（对齐参考图）/ hard。
 */
export type CrtPresetId = "off" | "subtle" | "hard";

/**
 * 全屏 CRT 后处理参数。
 * 算法：CRT-Easymode 扫描线 + 亮度回混思想；挂 stage（含 BackgroundView）。
 */
export interface CrtConfig {
  /** 总开关；preset=off 时为 false */
  enabled: boolean;
  /** 产品档；切换时由 applyCrtPreset 写入数值 */
  preset: CrtPresetId;
  /** 扫描线强度 0–1 → uIntensity */
  intensity: number;
  /**
   * 垂直方向完整扫描周期数 → uScanlineCount。
   * 设计分辨率语义（非物理像素）。默认 720。
   */
  scanlineCount: number;
  /** 暗部噪点 0–0.1 → uNoiseAmount */
  noiseAmount: number;
  /** 扫描前对比度，1=不变 → uContrast */
  contrast: number;
  /**
   * Filter.resolution，1=全分辨率。
   * 移动端可 0.5–0.75（对齐 BackgroundView low 档）。
   */
  resolution: number;
}

/**
 * 程序化背景参数。
 * 算法对齐开源再实现 Azkun/balatroShader + Hammster balatro.hlsl（非游戏包内源码）。
 */
export interface BackgroundConfig {
  enabled: boolean;
  quality: BackgroundQuality;
  theme: BackgroundThemeId;
  /** Azkun speed：时间倍率 */
  speed: number;
  /** 0–1，shader spin_amount */
  spinAmount: number;
  /** Azkun spinEase / hlsl SPIN_EASE */
  spinEase: number;
  /** 对比度；局内建议 <2 */
  contrast: number;
  /** 像素因子，越大越细（Azkun pixelSizeFac） */
  pixelSizeFac: number;
  /** Azkun zoom，默认 30 */
  zoom: number;
  offsetX: number;
  offsetY: number;
  enableSpin: boolean;
  /** hlsl LIGTHING 项 */
  lighting: number;
  /** 加到 uTime 上的相位 */
  seedPhase: number;
  /** 背景 uniform 更新上限 Hz（对齐 Azkun maxFPS 思想） */
  maxUpdateHz: number;
  /** 0xRRGGBB → colour_1/2/3 */
  colour1: number;
  colour2: number;
  colour3: number;
}

/** 主题三色表（写入 colour1/2/3）。 */
export const BACKGROUND_THEMES: Record<
  Exclude<BackgroundThemeId, "custom">,
  { colour1: number; colour2: number; colour3: number }
> = {
  feltGreen: {
    colour1: 0x5aaf7a,
    colour2: 0x4a8b66,
    colour3: 0x1a3d2e,
  },
  smallBlind: {
    colour1: 0x4a9fd4,
    colour2: 0x2a5a8a,
    colour3: 0x0f2438,
  },
  bigBlind: {
    colour1: 0xe8a040,
    colour2: 0x8a5520,
    colour3: 0x2a1808,
  },
  boss: {
    colour1: 0xe05070,
    colour2: 0x6a2040,
    colour3: 0x1a0810,
  },
};

/**
 * 拖拽缩放弹簧参数（按下放大 / 松手缩小可各自独立）。
 * 对齐 playPileSettleEffect / SpringDamper1D。
 */
export interface DragHandCardScaleSpring {
  mass: number;
  /** 自然频率 ωn (rad/s) */
  angularFreq: number;
  /** 阻尼比 ζ；&lt;1 欠阻尼会过冲 */
  dampingRatio: number;
  /**
   * 阶段切入时的位置冲量：x0 = current + impulseScale（无量纲）。
   * 0 = 从当前值连续起步；负值可先略缩小再弹向目标。
   * 按下进入用 scaleIn；松手可选用 scaleOut（默认松手不额外 reset 冲量）。
   */
  impulseScale: number;
  /** 阶段切入时的初速度 (1/s) */
  impulseScaleVel: number;
  settleEpsScale: number;
  settleVelScale: number;
  maxDtSec: number;
  substeps: number;
}

/** 旧 preset 扁平字段 → 复制到 scaleIn/scaleOut 时的可识别键。 */
const DRAG_HAND_CARD_SPRING_KEYS: ReadonlyArray<keyof DragHandCardScaleSpring> = [
  "mass",
  "angularFreq",
  "dampingRatio",
  "impulseScale",
  "impulseScaleVel",
  "settleEpsScale",
  "settleVelScale",
  "maxDtSec",
  "substeps",
];

/**
 * 合并 dragHandCard：支持新结构 scaleIn/scaleOut，以及旧 preset 顶层扁平弹簧字段。
 * 扁平字段（mass 等）会同时作为 scaleIn / scaleOut 的缺省基底，再被嵌套对象覆盖。
 */
export function mergeDragHandCard(
  base: RuntimeConfig["dragHandCard"],
  incoming: Partial<RuntimeConfig["dragHandCard"]> & Record<string, unknown>,
): RuntimeConfig["dragHandCard"] {
  const flat: Partial<DragHandCardScaleSpring> = {};
  for (const key of DRAG_HAND_CARD_SPRING_KEYS) {
    const v = incoming[key as string];
    if (typeof v === "number" && Number.isFinite(v)) {
      flat[key] = v;
    }
  }
  const hasFlat = Object.keys(flat).length > 0;
  const inPatch =
    incoming.scaleIn && typeof incoming.scaleIn === "object"
      ? (incoming.scaleIn as Partial<DragHandCardScaleSpring>)
      : undefined;
  const outPatch =
    incoming.scaleOut && typeof incoming.scaleOut === "object"
      ? (incoming.scaleOut as Partial<DragHandCardScaleSpring>)
      : undefined;

  return {
    dragScaleTarget:
      typeof incoming.dragScaleTarget === "number" &&
      Number.isFinite(incoming.dragScaleTarget)
        ? incoming.dragScaleTarget
        : base.dragScaleTarget,
    scaleIn: {
      ...base.scaleIn,
      ...(hasFlat ? flat : {}),
      ...(inPatch ?? {}),
    },
    scaleOut: {
      ...base.scaleOut,
      ...(hasFlat ? flat : {}),
      ...(outPatch ?? {}),
    },
  };
}

export interface RuntimeConfig {
  /**
   * 游戏倍速（基础参数面板可调：0.5 / 1 / 2 / 4）。
   * 仅缩放「卡牌逻辑」「文字视效」中标注为 ms 的时间参数：
   *   effectiveMS = baseMS / gameSpeed
   * 面板仍显示 1 倍基准值，不改写存储。
   * 不缩放：卡牌操作逻辑专区（点击判定等）、结算阶段 1–3 时间 (t1–t3)、
   * 卡牌视效、单位为 px/ms 的速度系数、弹性绳物理、背景 shader 等。
   * 小丑结算效果与出牌堆结算同规则；小丑结算数字 *MS 全量缩放。
   */
  gameSpeed: number;
  world: {
    width: number;
    height: number;
    /** 背景色（PixiJS 数字色）。Off 档清屏 / 无 shader 时使用。运行中改需要主动 apply。 */
    backgroundColor: number;
    /** 程序化 paint-mix 背景；enabled+quality 控制是否跑 shader。 */
    background: BackgroundConfig;
    /** 全屏 CRT 后处理（CrtFilter，挂 stage）。 */
    crt: CrtConfig;
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
    /**
     * 卡面底色（PixiJS 数字色）。手牌与小丑共用：
     * 手牌 8BitDeck 透明底直接透出；小丑图集加载时已把纯白底打成透明。
     * 改值后需要 refreshHandArt + refreshDeckArt。
     */
    faceColor: number;
    /** 卡牌外缘 1 像素描边颜色（PixiJS 数字色）。改值后需要 refreshHandArt + refreshDeckArt。 */
    outlineColor: number;
    back: {
      row: number;
      col: number;
    };
    /**
     * 盲注徽章硬币动画（BlindChips 第一行 21 帧）。
     * fps：每秒播放的精灵帧数；ScorePanel 每帧同步到 AnimatedSprite.animationSpeed。
     */
    blindChipAnim: {
      /** 播放帧率（帧/秒）。0 = 停在当前帧。 */
      fps: number;
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
  /**
   * 玩法区世界坐标布局（手牌整体 + 牌堆）。
   *
   * 手牌「整体」包含：
   *   - 底部手牌扇形（handBaseY / handOffsetX）；
   *   - 打出后的出牌结算堆（相对 handBaseY 的 playPile.baseYOffset + 中位对齐手牌中线）。
   * 因此只调 handBaseY / handOffsetX 即可连带移动结算区，无需再调 playPile 的绝对坐标。
   *
   * 默认值对齐原 HUD 硬编码（1280×720）：
   *   handBaseY = height-250=470，handOffsetX=0，deck = (width-120, height-180)=(1160,540)。
   */
  playfield: {
    /** 手牌基准 Y（世界坐标）。未选中时牌心 y≈此值（弧形另加下沉）。 */
    handBaseY: number;
    /**
     * 手牌水平区域整体偏移（像素，正值向右）。
     * 不改变区域宽度：normal 默认 [sidebar, W-40]、minimal 默认 [200, W-200] 整体平移。
     */
    handOffsetX: number;
    /** 牌堆左上角世界 X。 */
    deckX: number;
    /** 牌堆左上角世界 Y。 */
    deckY: number;
  };
  cardShadow: {
    color: number;
    alpha: number;
    lightX: number;
    lightY: number;
    distanceRatio: number;
    scaleRatio: number;
    /**
     * 阴影 Y 向拉长上限锚点（世界坐标 Y，越小越靠上）。
     * 当卡牌视觉中心 Y 小于该值（卡牌更靠上）时，计算阴影纵向偏移时
     * 仍按该 Y 取值，阴影不再继续往下拉长。
     */
    stretchLimitY: number;
  };
  dragShadow: {
    color: number;
    alpha: number;
    lightX: number;
    lightY: number;
    distanceRatio: number;
    scaleRatio: number;
    /**
     * 拖拽阴影 Y 向拉长上限锚点（世界坐标 Y），语义同 cardShadow.stretchLimitY。
     */
    stretchLimitY: number;
  };
  /**
   * 盲注筹码（BlindChipBadge）常态阴影。
   * 字段语义与 cardShadow 相同，独立参数，不与手牌/小丑共用。
   * 调参面板：「牌的绘制 → 盲注筹码阴影效果」。
   */
  blindChipShadow: {
    color: number;
    alpha: number;
    lightX: number;
    lightY: number;
    distanceRatio: number;
    scaleRatio: number;
    stretchLimitY: number;
  };
  /**
   * 盲注筹码拖拽中阴影。语义同 dragShadow，独立参数。
   * 同属「盲注筹码阴影效果」专区。
   */
  blindChipDragShadow: {
    color: number;
    alpha: number;
    lightX: number;
    lightY: number;
    distanceRatio: number;
    scaleRatio: number;
    stretchLimitY: number;
  };
  /**
   * 拖拽手牌相关参数（缩放视效；位移跟手由弹性绳）
   * 缩放通道：弹簧阻尼（对齐 playPileSettleEffect / SpringDamper1D）。
   * 进入拖拽 target=dragScaleTarget + scaleIn；松手 target=1 + scaleOut。
   */
  dragHandCard: {
    /** 拖拽时的目标缩放 (>=1 通常) */
    dragScaleTarget: number;
    /** 按下 / 按住放大弹簧 */
    scaleIn: DragHandCardScaleSpring;
    /** 松手缩小回落弹簧 */
    scaleOut: DragHandCardScaleSpring;
  };
  /**
   * 【多牌统一间隔时间】
   *
   * 相邻两张牌「发车/触发」的统一错开间隔（ms），作用于：
   *   1) 出牌：手牌飞向出牌堆；
   *   2) 出牌堆上移 / 下移；
   *   3) 出牌结束后飞向弃牌堆；
   *   4) 主动弃牌飞向弃牌堆；
   *   5) 抓牌飞向手牌堆。
   * 仅统一「触发间隔」；各阶段进入/结束后的停留时间仍由各自专区控制。
   * 受 gameSpeed 缩放（scaleTimeMS）；弃牌/抓牌另可叠各自 speedRatio。
   */
  multiCardInterval: {
    /** 多牌触发间隔（ms，相邻两张错开） */
    intervalMS: number;
  };
  /** 【抓牌】抓牌相关参数 */
  drawCard: {
    /** 抽牌数>=4时，最后一张牌提前的时间 (ms)；基准值，不直接乘倍速 */
    lastCardAdvanceMS: number;
    /**
     * 整体抽牌动画的速度比例（1× 基准，面板可调）。
     * 倍速生效方式：effectiveSpeedRatio = speedRatio * gameSpeed（如 1.4 × 2 = 2.8）。
     * 飞行估时与发牌错开间隔都会除以 effectiveSpeedRatio。
     * 触发间隔见 multiCardInterval.intervalMS。
     */
    speedRatio: number;
    /** 是否启用初始旋转角度 */
    useInitialRotation: boolean;
    /** 初始旋转角度 (度) */
    initialRotationDeg: number;
  };
  /**
   * 【抓牌】卡牌翻面效果
   *
   * 卡牌从发牌堆发出时背面朝上，沿竖中轴线（绕 Y 轴）翻面，最终正面朝上。
   * 翻面分两段：
   *   第一段：在飞向目标位置的过程中翻约 90°（此时卡面压成"一条线"，刚好背面消失）；
   *   第二段：到达目标位置后继续翻约 90°，最终正好正面朝上。
   *
   * 两段都各带一个随机抖动量（below）。视觉表现：
   *   有效翻面总角度 = 180°（固定，保证最终正面水平朝上）；
   *   "90° 临界点"出现的时机 = 飞行时长的某个随机比例附近；
   *   第二段时长 = 第一段（飞行）时长 × 随机比例。
   */
  drawFlip: {
    /** 总开关：关闭则发牌直接正面朝上、无翻面动画。 */
    enabled: boolean;
    /**
     * 第一段（飞行中翻面）到达"90°一条线"临界点的时机，
     * 表示为"飞行时长的比例"基准值（0~1）。1.0 = 恰好在落点完成第一段 90°。
     */
    firstHalfRatio: number;
    /**
     * 第一段时机的随机抖动量（±，0~1）。每次发牌从
     * [firstHalfRatio - jitter, firstHalfRatio + jitter] 中随机取值。
     * 这是你要求的第一个"大概"。
     */
    firstHalfJitter: number;
    /**
     * 第二段（到位后继续翻面）的时长基准值，
     * 表示为"第一段飞行时长的比例"。0.5 = 第二段用一半飞行时长完成后 90°。
     */
    secondHalfRatio: number;
    /**
     * 第二段时长的随机抖动量（±，比例）。每次发牌从
     * [secondHalfRatio - jitter, secondHalfRatio + jitter] 中随机取值。
     * 这是你要求的第二个"大概"。
     */
    secondHalfJitter: number;
  };
  /**
   * 【弃牌/出牌结束】弃牌相关参数
   *
   * 同时作用于两类弃牌：
   *   1) 主动弃牌：选中若干手牌后点击「弃牌」键，被选中的牌从左到右依次飞向弃牌堆；
   *   2) 出牌结束弃牌：出牌堆所有牌结算并下移后，从左到右依次丢弃到弃牌堆。
   * （弃牌堆位于屏幕大正右方、出屏一点、垂直居中。）
   */
  discard: {
    /**
     * 整体弃牌动画的速度比例。
     * 同时缩放单张飞出时长与弃牌触发间隔：>1 更快（时长/间隔变短），<1 更慢。
     * 与 animation.flyOutDurationMS 联动（实际飞行时长 = flyOutDurationMS / speedRatio）。
     * 触发间隔见 multiCardInterval.intervalMS。
     */
    speedRatio: number;
    /**
     * 最后一张牌弃牌后等待时间（ms）。
     * 在最后一张牌飞出动画结束后、进入后续流程（补牌 / 出牌管线结束）之前额外等待。
     * 同时作用于「主动弃牌」与「出牌结束弃牌」；受 speedRatio 缩放。
     */
    lastCardWaitMS: number;
  };
  /**
   * 【弃牌/出牌结束】卡牌翻面效果
   *
   * 同时控制两类丢弃：
   *   1) 手牌弃牌（点击弃牌键后选中牌飞向弃牌堆）；
   *   2) 出牌结算结束后，卡牌从出牌堆丢弃到弃牌堆。
   *
   * 翻面逻辑：以卡牌几何中心的竖直线为轴（绕牌本地 Y，用 displayWrapper.scale.x =
   * |cos(θ)| 模拟），正面朝上起翻。
   *   - 约 90°：压成一条线；
   *   - 越过 90°：切换背面贴图，继续翻到最多 180°（满幅背面）。
   * 目标角 = clamp(flipAngleDeg ± flipAngleJitterDeg, 0~180)；
   * 翻转角速度在 [flipRateMinDegPerSec, flipRateMaxDegPerSec] 内每张牌独立随机。
   * 时长与弹性绳位移解耦（绳 settle 不再充当翻面时钟）。
   */
  discardFlip: {
    /** 总开关：关闭则弃牌/丢弃时正面朝上、无翻面压线效果。 */
    enabled: boolean;
    /**
     * 累计翻面角度的基准值（度）。
     * 取值 0~180：0=不翻面（满幅正面），90=压成一条线，180=完全翻到背面。
     * 超过 90° 时会在临界点切换背面贴图；若背面纹理不可用则自动封顶到 90°。
     */
    flipAngleDeg: number;
    /**
     * 翻面角度的随机抖动量（±度）。每张牌从
     * [flipAngleDeg - jitter, flipAngleDeg + jitter] 中随机取值，再 clamp 到 0~180。
     */
    flipAngleJitterDeg: number;
    /**
     * 翻面角速度下限（度/秒）。每张牌在 [min, max] 内均匀随机取速率；
     * 实际时长 = 目标角(度) / 速率 * 1000 ms。min/max 会自动校正顺序。
     */
    flipRateMinDegPerSec: number;
    /**
     * 翻面角速度上限（度/秒）。与 min 组成随机区间；应 > 0。
     */
    flipRateMaxDegPerSec: number;
    /**
     * 飞出后施加的随机旋转角度范围（±度）。牌飞出瞬间从 [-deg, +deg] 取一个随机角，
     * 在飞行途中旋转到该角度，让丢入弃牌堆的牌呈现散乱姿态。0 = 不旋转。
     * （这是牌面 Z 轴姿态散乱，与绕竖中轴的翻面通道独立。）
     */
    randomRotationDeg: number;
  };
  /**
   * 卡牌换位【理牌】
   * 触发：点数/花色按钮。位移由弹性绳；enabled=false 时瞬移。
   */
  handSort: {
    /** 总开关。关闭后理牌瞬移到目标位。 */
    enabled: boolean;
  };
  /**
   * 【出牌】卡牌整体位移效果
   *
   * 出牌键按下后：四按钮瞬间隐藏 → 等待 → 手牌整体下移 → 等待 → 进入打出流程；
   * 预期分全部累加到回合分后、发新牌前：等待 → 手牌整体上移回原位 → 等待 → 发牌；
   * 所有新牌到达布局目标位置（不必等过冲/回弹播完）时四按钮瞬间出现。
   */
  playHandGroupShift: {
    enabled: boolean;
    /** 手牌整体下移距离（px，正值向下）。上移距离与此相同。 */
    distancePx: number;
    /** 按钮隐藏后、开始下移前的等待（ms）。 */
    preDownWaitMS: number;
    /** 下移完成后、进入手牌打出流程前的等待（ms）。 */
    postDownWaitMS: number;
    /** 分数迁移完成后、开始上移前的等待（ms）。 */
    preUpWaitMS: number;
    /** 上移完成后、开始发新牌前的等待（ms）。 */
    postUpWaitMS: number;
  };
  /** 【出牌】出牌堆的位移（触发间隔见 multiCardInterval.intervalMS） */
  playPileDisplacement: {
    enabled: boolean;
    cardSpacing: number;
    /**
     * 全部牌落定后、进入上移前的停留（ms，受 gameSpeed 缩放）。
     * 多牌发车触发间隔已统一到 multiCardInterval.intervalMS。
     */
    lastIntervalMS: number;
  };
  /** 【出牌】出牌堆上移效果（目标 y 上移 distancePx；运动由弹性绳完成） */
  playPileLiftEffect: {
    enabled: boolean;
    /**
     * 上移距离（px，正值向上）。
     * 仅决定目标抬升量；位移曲线 / 过冲由全局弹性绳子牵引模型决定。
     */
    distancePx: number;
    /**
     * 所有应该上移的牌上移后，停留时间，用来延迟进入结算的时机 (ms)。
     * 上移/下移触发间隔见 multiCardInterval.intervalMS。
     */
    stayDuration: number;
    /** 上移阴影颜色 */
    shadowColor: number;
    /** 上移阴影透明度 */
    shadowAlpha: number;
    /** 上移阴影光源 X */
    shadowLightX: number;
    /** 上移阴影光源 Y */
    shadowLightY: number;
    /** 上移阴影距离比例 */
    shadowDistanceRatio: number;
    /** 上移阴影大小比例 */
    shadowScaleRatio: number;
  };
  /**
   * 【出牌】出牌堆的结算效果 — 弹簧阻尼变化（docs/play-pile-settle-spring-damper-plan.md）
   * 保留三个间隔；缩放/旋转由 ωn·ζ 二阶弹簧驱动 scoring 通道。
   */
  playPileSettleEffect: {
    enabled: boolean;
    /** 第一张结算动画结束后的停留间隔（受 gameSpeed 缩放） */
    firstIntervalMS: number;
    /** 之后每张牌减少的时间间隔（受 gameSpeed 缩放） */
    intervalReductionMS: number;
    /** 最后一张牌动画结束后的停留间隔（受 gameSpeed 缩放） */
    lastIntervalMS: number;
    mass: number;
    /** 自然频率 ωn (rad/s) */
    angularFreq: number;
    /** 阻尼比 ζ */
    dampingRatio: number;
    /** 初始缩放偏离：xS0 = 1 + impulseScale */
    impulseScale: number;
    /** 初始缩放速度 (1/s) */
    impulseScaleVel: number;
    /** 初始旋转偏离 (度) */
    impulseRotDeg: number;
    /** 初始角速度 (deg/s) */
    impulseRotVelDeg: number;
    settleEpsScale: number;
    settleVelScale: number;
    settleEpsRotDeg: number;
    settleVelRotDeg: number;
    /** 最长逻辑时长 ms（受 gameSpeed 缩放） */
    maxDurationMS: number;
    maxDtSec: number;
    substeps: number;
    /** 结算数字触发延迟 ms（受 gameSpeed 缩放） */
    textTriggerMS: number;
  };
  /**
   * 【出牌】出牌堆的结算数字效果
   * - 单字 scale：弹簧阻尼（对齐 playPileSettleEffect / SpringDamper1D）
   * - 整串左右摆动：不独立驱动，每帧跟随对应卡牌视觉中心与 displayWrapper 旋转
   *   （含 scoringRotOffset，与卡牌结算同源）
   */
  playPileSettleTextEffect: {
    enabled: boolean;
    fontSize: number;
    letterSpacing: number;
    color: number;
    /** 相对卡牌视觉中心的 local Y 偏移（负值在上方；随卡牌旋转一起转） */
    offsetY: number;
    /** 下列 *MS 时间参数均在 TextFx 内受 gameSpeed 缩放 */
    firstCharDelayMS: number;
    charIntervalMS: number;
    charIntervalReductionMS: number;
    /** 单字 scale 弹簧：质量 m */
    mass: number;
    /** 单字 scale 弹簧：自然频率 ωn (rad/s) */
    angularFreq: number;
    /** 单字 scale 弹簧：阻尼比 ζ */
    dampingRatio: number;
    /** 单字缩放初值偏离：xS0 = 1 + impulseScale（常用 -1 → 从 0 弹出） */
    impulseScale: number;
    /** 单字缩放初速度 (1/s) */
    impulseScaleVel: number;
    settleEpsScale: number;
    settleVelScale: number;
    /** 单字 scale 弹簧最长逻辑时长 ms（受 gameSpeed 缩放）；超时强制进入停留/淡出 */
    maxDurationMS: number;
    maxDtSec: number;
    substeps: number;
    stayDurationMS: number;
    fadeDurationMS: number;
    shrinkAnchorY: number;
    shadowEnabled: boolean;
    shadowColor: number;
    shadowAlpha: number;
    shadowDistance: number;
    shadowAngleDeg: number;
    shadowBlur: number;
    bgBlockEnabled: boolean;
    bgBlockColor: number;
    bgBlockInitAngleDeg: number;
    bgBlockEndAngleDeg: number;
    bgBlockDurationMS: number;
    /** 蓝色方块透明度变化曲线（横轴=时间进度 0→1，纵轴=透明度从 1→0 的进度映射）。 */
    bgBlockFadeCurve: BezierCurveConfig;
    /** 蓝色方块大小缩放变化曲线（横轴=时间进度 0→1，纵轴=缩放大小从 startScale→endScale 映射）。 */
    bgBlockScaleCurve: BezierCurveConfig;
  };
  /**
   * 【小丑】小丑牌的结算数字效果（含红色背景小方块）
   * 与 playPileSettleTextEffect 同构（单字 scale 弹簧 + 跟随卡牌摆动），默认红底；
   * 额外提供 defaultMultBonus（默认 +10）与 textSuffix（默认 "倍率"）。
   * 卡牌本体弹簧结算不设独立专区，直接复用 playPileSettleEffect。
   */
  jokerSettleTextEffect: {
    enabled: boolean;
    /** 每张小丑结算时增加的倍率（弹字显示为 "+N" + textSuffix）。 */
    defaultMultBonus: number;
    /** 弹字数字后缀，默认 "倍率"，最终显示如 "+10倍率"。 */
    textSuffix: string;
    fontSize: number;
    letterSpacing: number;
    color: number;
    offsetY: number;
    /** 下列 *MS 时间参数均在 TextFx 内受 gameSpeed 缩放 */
    firstCharDelayMS: number;
    charIntervalMS: number;
    charIntervalReductionMS: number;
    mass: number;
    angularFreq: number;
    dampingRatio: number;
    impulseScale: number;
    impulseScaleVel: number;
    settleEpsScale: number;
    settleVelScale: number;
    maxDurationMS: number;
    maxDtSec: number;
    substeps: number;
    stayDurationMS: number;
    fadeDurationMS: number;
    shrinkAnchorY: number;
    shadowEnabled: boolean;
    shadowColor: number;
    shadowAlpha: number;
    shadowDistance: number;
    shadowAngleDeg: number;
    shadowBlur: number;
    bgBlockEnabled: boolean;
    bgBlockColor: number;
    bgBlockInitAngleDeg: number;
    bgBlockEndAngleDeg: number;
    bgBlockDurationMS: number;
    bgBlockFadeCurve: BezierCurveConfig;
    bgBlockScaleCurve: BezierCurveConfig;
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
   *      其中 maxRot = (3000 / 1000) * rotationPerSpeed（参考速度常量）
   *      ——即"卡牌能达到的最高速度下产生的旋转角"，作为派生上限自动同步，
   *      无需手动设置（也避免手动值与速度上限不匹配造成的死区或溢出）。
   *   4. 平滑跟随：velocityRotation 以 followLerp 的速率追目标，
   *      同时受 friction（摩擦力）的恒定拉回，最终静止时回到 0。
   *   5. 绕轴点效果：通过对 displayWrapper.position 做反向补偿，
   *      使最终视觉效果等价于"以 pivotOffset 处为不动点旋转 velocityRotation"。
   */
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
     * 【抓牌】每单位有效速度（px/ms）映射到多少弧度的目标旋转角。
     */
    drawRotationPerSpeed: number;
    /**
     * 速度→旋转目标的跟随插值系数 (0~1，按 16.67ms 标准帧计算)。
     * 越大跟得越快、越灵敏；越小越钝。建议 0.15 ~ 0.45。
     */
    followLerp: number;
    /**
     * 旋转用速度采样的 EMA 时间常数（ms）。
     * 仅平滑 targetRot 所用的速度，不影响 lastSpeedPxPerSec / 过冲触发。
     * 用于抑制 rAF dt 抖动、pointer 节流与 drag lerp 台阶造成的旋转角闪抖。
     * 0 = 禁用平滑。建议 24~48。
     */
    velocitySmoothMS: number;
    /**
     * 穿孔摩擦力 (0~1)：每帧把 velocityRotation 向 0 衰减的比例（按标准帧）。
     * 摩擦力越大，旋转越快回正，速度变化产生的旋转越被压制；
     * 摩擦力越小，旋转更持久、更"自由"。建议 0.05 ~ 0.30。
     * 设为 0 时只靠 followLerp 回正（速度恢复 0 后旋转才衰减）。
     *
     * 实现说明：摩擦只在「已停住 / spring 回弹」时施加；匀速拖动时只 follow，
     * 避免 follow+friction 每帧互搏把稳态角压低并放大速度噪声。
     */
    friction: number;
    /**
     * 极小速度阈值 (px/ms)：|vEffective| 低于此值时直接视为 0,
     * 避免微抖动造成持续小幅旋转。建议 0.01 ~ 0.05。
     */
    minSpeed: number;
  };
  /**
   * 弹性绳子牵引卡牌模型（隔离沙盒 / 未来统一移动核）
   * 规格：docs/elastic-rope-traction-card-model.md
   */
  elasticRopeCard: {
    enabled: boolean;
    spring: {
      maxElasticLength: number;
      stiffness: number;
    };
    airDrag: {
      mode: "linear" | "quadratic";
      linearCoeff: number;
      quadraticCoeff: number;
    };
    integration: {
      mass: number;
      maxDtSec: number;
      substeps: number;
    };
    settle: {
      distancePx: number;
      speedPxPerSec: number;
    };
    rotation: {
      enabled: boolean;
      forceToAngle: number;
      maxAngleDeg: number;
      angleFollow: number;
      rotationAffectsAnchor: boolean;
      /** instant | follow | springDamper — 见 docs/elastic-rope-rotation-damping-plan.md */
      dynamics: "instant" | "follow" | "springDamper";
      mapMode: "linear" | "power";
      responseGamma: number;
      inertia: number;
      /** 角自然频率 ωn (rad/s) */
      angularFreq: number;
      /** 阻尼比 ζ，1=临界 */
      dampingRatio: number;
    };
    anchor: {
      anchorY: number;
      anchorXMin: number;
      anchorXMax: number;
      mapMode: "continuous" | "leftRightHalf";
    };
    debug: {
      drawRope: boolean;
      drawAnchor: boolean;
      showHudReadouts: boolean;
      elasticColor: number;
      rigidColor: number;
    };
    sandbox: {
      followPointerWhileDown: boolean;
      freezeTargetOnRelease: boolean;
    };
    expandedSections: {
      spring: boolean;
      airDrag: boolean;
      integration: boolean;
      settle: boolean;
      rotation: boolean;
      anchor: boolean;
      debug: boolean;
    };
  };
  cardVisuals: {
    expandedSections: {
      shadow: boolean;
      dragShadow: boolean;
      /** 「牌的绘制 → 盲注筹码阴影效果」专区展开状态。 */
      blindChipShadow: boolean;
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
      multiCardInterval: boolean;
      drawCard: boolean;
      drawFlip: boolean;
      discard: boolean;
      discardFlip: boolean;
      handSort: boolean;
      playHandGroupShift: boolean;
      playPileDisplacement: boolean;
      playPileLiftEffect: boolean;
      playPileSettleEffect: boolean;
      playPileSettleText: boolean;
      playPileSettleBgBlock: boolean;
      jokerEffects: boolean;
      jokerLayout: boolean;
      jokerSettleText: boolean;
      jokerSettleBgBlock: boolean;
      chipsBounce: boolean;
      multBounce: boolean;
      evalScoreBounce: boolean;
      evalScoreText: boolean;
      /** 「文字视效 → 【弹弹动画】文字抖动」专区展开状态。 */
      textJitter: boolean;
    };

    /**
     * 选中与取消卡牌的位移效果（弹性绳飞向 layout 目标；过冲由绳自然产生）
     *
     * 触发：快速点击手牌 → toggleSelection 翻转 view.selected（仅对那张牌）。
     * 模型：setMoveTarget 到 layout 目标；位移/过冲由弹性绳完成。
     * 上移（选中 rise）与下移（取消 fall）参数完全独立，可分别调手感。
     *
     * 注：动画期间该牌 isSelectAnimating=true，layoutHand 跳过对其下发 moveTo，
     * 直到两段动画 onSettle 后才解除，避免普通重排 tween 把过弹动画踢掉。
     */
    selectMoveEnabled: boolean;
    /** 选中弹起高度（像素，世界坐标）。替代旧的 CardSkin.selectedRiseY。 */
    selectRiseY: number;

    // ── 上移（选中 rise）────────────────────────────────

    // ── 下移（取消选中 fall）────────────────────────────
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

    /**
     * 2. 鼠标触碰小弹性缩放 — 弹簧阻尼（对齐 playPileSettleEffect / SpringDamper1D）
     *
     * 悬停时 target = hoverSettleScale；离开 target = 1。
     * 欠阻尼 ζ&lt;1 时自然过冲后回落；进入/重播时可施加 impulse 初值。
     * 积分：半隐式欧拉 + maxDtSec + substeps；有效 dt 乘 gameSpeed。
     */
    hoverScaleEnabled: boolean;
    /** 悬停稳态目标缩放（>1 通常） */
    hoverSettleScale: number;
    hoverScaleMass: number;
    /** 自然频率 ωn (rad/s) */
    hoverScaleAngularFreq: number;
    /** 阻尼比 ζ */
    hoverScaleDampingRatio: number;
    /**
     * 进入/重播时的位置冲量：x0 = 1 + impulseScale（硬重播）或 current + impulseScale（自然进入）。
     * 负值先缩小再弹向 settle；0 表示不额外偏移位置。
     */
    hoverScaleImpulseScale: number;
    /** 进入/重播时的初速度 (1/s) */
    hoverScaleImpulseScaleVel: number;
    hoverScaleSettleEpsScale: number;
    hoverScaleSettleVelScale: number;
    hoverScaleMaxDtSec: number;
    hoverScaleSubsteps: number;

    /**
     * 2b. 鼠标呼吸晃动（触碰与回落） —— hover breathing
     *
     * 完全独立于"常态手牌呼吸晃动"的脱手式动画：触发后对 Y 位移与 Z 旋转
     * 各跑一条 1D 弹簧阻尼（对齐出牌堆结算 playPileSettleEffect / SpringDamper1D
     * 的缩放通道公式：k=m·ωn²，c=2ζmωn，半隐式欧拉子步），输出与常态
     * breathingY / wobbleRot **相加叠加**。
     *
     * 触发点（共两处，共用同一组参数）：
     *   1. 鼠标 pointerover 进入卡牌时；
     *   2. 拖拽缩放退出动画 settle 到 1.0 时。
     *
     * 模型（双通道，共享 mass / angularFreq / dampingRatio）：
     *   触发：y0 = impulseY，vy0 = impulseYVel；θ0 = impulseRotDeg→rad，ω0 = impulseRotVelDeg→rad/s
     *   目标：y* = 0，θ* = 0
     *   结束：双通道均 isSettled 或 elapsed ≥ maxDurationMS（逻辑时间，含 gameSpeed）
     *
     * ζ&lt;1 欠阻尼时自然过冲回落，形成"触碰弹一下再归位"的弹性观感。
     */
    hoverBreathingEnabled: boolean;
    /** 无量纲质量 m（Y / rot 通道共享） */
    hoverBreathingMass: number;
    /** 自然频率 ωn (rad/s) */
    hoverBreathingAngularFreq: number;
    /** 阻尼比 ζ（&lt;1 过冲，=1 临界，&gt;1 过阻尼） */
    hoverBreathingDampingRatio: number;
    /** 触发时 Y 位置冲量（像素，相对静止 0；正值向下） */
    hoverBreathingImpulseY: number;
    /** 触发时 Y 初速度 (px/s) */
    hoverBreathingImpulseYVel: number;
    /** 触发时 Z 旋转位置冲量（度） */
    hoverBreathingImpulseRotDeg: number;
    /** 触发时 Z 旋转初速度 (deg/s) */
    hoverBreathingImpulseRotVelDeg: number;
    /** Y 位置收敛阈值（像素） */
    hoverBreathingSettleEpsY: number;
    /** Y 速度收敛阈值 (px/s) */
    hoverBreathingSettleVelY: number;
    /** 旋转位置收敛阈值（度） */
    hoverBreathingSettleEpsRotDeg: number;
    /** 旋转速度收敛阈值 (deg/s) */
    hoverBreathingSettleVelRotDeg: number;
    /** 最长逻辑时长 ms（硬帽，受 gameSpeed 缩放） */
    hoverBreathingMaxDurationMS: number;
    /** 单帧最大积分 dt (s) */
    hoverBreathingMaxDtSec: number;
    /** 半隐式欧拉子步数 */
    hoverBreathingSubsteps: number;

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
   * 筹码数字弹弹（经典解析路径）。
   * 牌型文字复用本配置（ScorePanel BounceTextComponent configKey = "chipsBounce"）。
   */
  chipsBounce: BounceAnimationConfig;
  /**
   * 倍率数字弹弹：弹簧阻尼（同出牌堆结算动力学）。
   * 牌型等级文字复用本配置（configKey = "multBounce"）。
   */
  multBounce: SpringBounceAnimationConfig;
  evalScoreBounce: BounceAnimationConfig;
  evalScoreText: EvalScoreTextConfig;
  /**
   * 【弹弹动画】文字抖动 — 常态逐字角摆动。
   * 调参面板：「文字视效 → 【弹弹动画】文字抖动」。
   */
  textJitter: TextJitterConfig;
  /**
   * 小丑牌系统
   *
   * 设计原则：小丑牌 ≈ 可拖拽排序 / 可选中弹起、但无法出牌 / 弃牌 / 点数花色理牌 的「手牌」。
   * 所有数值与手感参数完全复用手牌专区（cardVisuals / cardShadow / elasticRopeCard 等），
   * 本节点只负责：
   *   1) 布局（顶部槽位）；
   *   2) 对「复用的手牌效果专区」再套一层总开关（effects.*）。
   * 改手牌参数 → 小丑同步变化；关 effects.xxx → 仅小丑侧停用该效果。
   */
  joker: {
    /** 顶部同时显示的槽位数（默认 5，对应图集前 5 张）。 */
    slotCount: number;
    /**
     * 相邻小丑中心水平间距（像素）。
     * 独立于 handLayout.cardSpacing：顶部一条直线排布，间距通常比手牌更宽。
     */
    cardSpacing: number;
    /**
     * 小丑行整体中心的世界 X。
     * 槽位以该值为中线左右对称排布（默认 640 = 1280 宽屏中线）。
     */
    baseX: number;
    /** 小丑中心的世界 Y（屏幕上方）。 */
    baseY: number;
    /**
     * 可复用手牌效果的分项开关。
     * true 时再与对应手牌专区自身的 enabled 做 AND（两边都开才真正生效）。
     * 参数值一律读手牌配置，不在此处重复。
     */
    effects: {
      /** 对应「卡牌常态阴影」专区（CONFIG.cardShadow）。 */
      shadow: boolean;
      /** 对应「常态呼吸晃动」专区（cardVisuals.breathing*）。 */
      breathing: boolean;
      /** 对应「常态伪3D倾斜呼吸晃动」专区（cardVisuals.idleTilt*）。 */
      idleTilt: boolean;
      /** 对应「鼠标触碰碰撞范围」专区（cardVisuals.hoverHit*）。 */
      hoverHit: boolean;
      /** 对应「鼠标触碰小弹性缩放」专区（cardVisuals.hoverScale*）。 */
      hoverScale: boolean;
      /** 对应「鼠标呼吸晃动（触碰与回落）」专区（cardVisuals.hoverBreathing*）。 */
      hoverBreathing: boolean;
      /** 对应「卡牌鼠标悬停伪3D倾斜」专区（cardVisuals.mouse3DTilt*）。 */
      mouse3DTilt: boolean;
    };
  };
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
  gameSpeed: 1,
  world: Object.freeze({
    width: 1280,
    height: 720,
    backgroundColor: 0x4a8b66,
    background: Object.freeze({
      enabled: true,
      quality: "med" as BackgroundQuality,
      theme: "feltGreen" as BackgroundThemeId,
      speed: 0.85,
      spinAmount: 0.3,
      spinEase: 0.5,
      contrast: 1.4,
      pixelSizeFac: 900,
      zoom: 30,
      offsetX: 0,
      offsetY: 0,
      enableSpin: true,
      lighting: 0.25,
      seedPhase: 0,
      maxUpdateHz: 30,
      colour1: BACKGROUND_THEMES.feltGreen.colour1,
      colour2: BACKGROUND_THEMES.feltGreen.colour2,
      colour3: BACKGROUND_THEMES.feltGreen.colour3,
    }),
    crt: Object.freeze({
      enabled: true,
      preset: "subtle" as CrtPresetId,
      intensity: 0.35,
      scanlineCount: 720,
      noiseAmount: 0.02,
      contrast: 1.05,
      resolution: 1,
    }),
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
    blindChipAnim: Object.freeze({
      // 约半秒转一圈（21 帧 / 12fps ≈ 1.75s/圈），可在参数面板「盲注硬币动画」调节。
      fps: 12,
    }),
  }),
  handLayout: Object.freeze({
    cardSpacing: 65,
    arcEnabled: true,
    arcHeight: 18,
    fanAnglePerCardDeg: 1.5,
  }),
  playfield: Object.freeze({
    handBaseY: 470,
    handOffsetX: 0,
    deckX: 1160,
    deckY: 540,
  }),
  cardShadow: Object.freeze({
    color: 0x000000,
    alpha: 0.35,
    lightX: 640,
    lightY: 360,
    distanceRatio: 0.05,
    scaleRatio: 0.95,
    // 中间偏下：卡牌再往上时阴影纵向拉长不再增加
    stretchLimitY: 400,
  }),
  dragShadow: Object.freeze({
    color: 0x000000,
    alpha: 0.25,
    lightX: 640,
    lightY: 360,
    distanceRatio: 0.12,
    scaleRatio: 0.88,
    stretchLimitY: 400,
  }),
  // 盲注筹码默认略贴侧栏（光源偏右下、距离稍小），与手牌阴影解耦可单独调。
  blindChipShadow: Object.freeze({
    color: 0x000000,
    alpha: 0.4,
    lightX: 640,
    lightY: 360,
    distanceRatio: 0.04,
    scaleRatio: 0.92,
    stretchLimitY: 400,
  }),
  blindChipDragShadow: Object.freeze({
    color: 0x000000,
    alpha: 0.3,
    lightX: 640,
    lightY: 360,
    distanceRatio: 0.1,
    scaleRatio: 0.88,
    stretchLimitY: 400,
  }),
  dragHandCard: Object.freeze({
    dragScaleTarget: 1.15,
    // 按下放大 / 松手缩小默认同参，保证旧手感；面板可分开调。
    scaleIn: Object.freeze({
      mass: 1,
      angularFreq: 14,
      dampingRatio: 0.45,
      impulseScale: 0,
      impulseScaleVel: 0,
      settleEpsScale: 0.004,
      settleVelScale: 0.05,
      maxDtSec: 1 / 30,
      substeps: 2,
    }),
    scaleOut: Object.freeze({
      mass: 1,
      angularFreq: 14,
      dampingRatio: 0.45,
      impulseScale: 0,
      impulseScaleVel: 0,
      settleEpsScale: 0.004,
      settleVelScale: 0.05,
      maxDtSec: 1 / 30,
      substeps: 2,
    }),
  }),
  multiCardInterval: Object.freeze({
    intervalMS: 150,
  }),
  drawCard: Object.freeze({
    lastCardAdvanceMS: 150,
    speedRatio: 1.0,
    useInitialRotation: false,
    initialRotationDeg: -15,
  }),
  drawFlip: Object.freeze({
    enabled: true,
    firstHalfRatio: 1.0,
    firstHalfJitter: 0.15,
    secondHalfRatio: 0.5,
    secondHalfJitter: 0.15,
  }),
  discard: Object.freeze({
    speedRatio: 1.0,
    lastCardWaitMS: 0,
  }),
  discardFlip: Object.freeze({
    enabled: true,
    flipAngleDeg: 90,
    flipAngleJitterDeg: 15,
    // 约 90° 在 150~300ms 内翻完，适配弹性绳高速飞出时仍在屏内可见
    flipRateMinDegPerSec: 300,
    flipRateMaxDegPerSec: 600,
    randomRotationDeg: 20,
  }),
  handSort: Object.freeze({
    enabled: true,
  }),
  playHandGroupShift: Object.freeze({
    enabled: true,
    distancePx: 40,
    preDownWaitMS: 80,
    postDownWaitMS: 60,
    preUpWaitMS: 80,
    postUpWaitMS: 60,
  }),
  playPileDisplacement: Object.freeze({
    enabled: true,
    cardSpacing: 70,
    lastIntervalMS: 160,
  }),
  playPileLiftEffect: Object.freeze({
    enabled: true,
    /** 默认 ≈ 旧 peakDist = 400 * 0.35 / 2 */
    distancePx: 70,
    stayDuration: 0,
    shadowColor: 0x000000,
    shadowAlpha: 0.35,
    shadowLightX: 720,
    shadowLightY: 800,
    shadowDistanceRatio: 0.08,
    shadowScaleRatio: 0.92,
  }),
  playPileSettleEffect: Object.freeze({
    enabled: true,
    firstIntervalMS: 300,
    intervalReductionMS: 60,
    lastIntervalMS: 150,
    mass: 1,
    angularFreq: 14,
    dampingRatio: 0.45,
    impulseScale: -0.08,
    impulseScaleVel: 0,
    impulseRotDeg: 0.5,
    impulseRotVelDeg: -40,
    settleEpsScale: 0.004,
    settleVelScale: 0.05,
    settleEpsRotDeg: 0.15,
    settleVelRotDeg: 2,
    maxDurationMS: 1200,
    maxDtSec: 1 / 30,
    substeps: 2,
    textTriggerMS: 120,
  }),
  playPileSettleTextEffect: Object.freeze({
    enabled: true,
    fontSize: 36,
    letterSpacing: 2,
    color: 0xffd700, // gold / orange-yellow
    offsetY: -110,
    firstCharDelayMS: 0,
    charIntervalMS: 120,
    charIntervalReductionMS: 20,
    // 单字 scale 弹簧（整串左右摆动跟随卡牌 scoringRotOffset，无独立 rot）
    mass: 1,
    angularFreq: 16,
    dampingRatio: 0.4,
    impulseScale: -1,
    impulseScaleVel: 0,
    settleEpsScale: 0.004,
    settleVelScale: 0.05,
    maxDurationMS: 1200,
    maxDtSec: 1 / 30,
    substeps: 2,
    stayDurationMS: 500,
    fadeDurationMS: 300,
    shrinkAnchorY: 0.2,
    shadowEnabled: true,
    shadowColor: 0x000000,
    shadowAlpha: 0.4,
    shadowDistance: 4,
    shadowAngleDeg: 45,
    shadowBlur: 2,
    bgBlockEnabled: true,
    bgBlockColor: 0x00a2ff,
    bgBlockInitAngleDeg: -15,
    bgBlockEndAngleDeg: 15,
    bgBlockDurationMS: 600,
    bgBlockFadeCurve: Object.freeze({
      enabled: true,
      startScale: 0,
      endScale: 1,
      // 默认：开头透明度保持得久一些，末尾快速消失（ease-in 风格）。
      p1: { x: 0.4, y: 0.05 },
      p2: { x: 0.8, y: 0.4 },
    }) as BezierCurveConfig,
    bgBlockScaleCurve: Object.freeze({
      enabled: true,
      startScale: 0,
      endScale: 1.5,
      // 默认：快起、平缓收尾（cubicOut 风格）。
      p1: { x: 0.1, y: 0.85 },
      p2: { x: 0.25, y: 1.0 },
    }) as BezierCurveConfig,
  }),
  // 小丑弹字与出牌堆结算数字同构（弹簧）；卡牌本体弹簧仍复用 playPileSettleEffect。
  jokerSettleTextEffect: Object.freeze({
    enabled: true,
    defaultMultBonus: 10,
    textSuffix: "倍率",
    fontSize: 36,
    letterSpacing: 2,
    color: 0xffd700,
    offsetY: -110,
    firstCharDelayMS: 0,
    charIntervalMS: 120,
    charIntervalReductionMS: 20,
    mass: 1,
    angularFreq: 16,
    dampingRatio: 0.4,
    impulseScale: -1,
    impulseScaleVel: 0,
    settleEpsScale: 0.004,
    settleVelScale: 0.05,
    maxDurationMS: 1200,
    maxDtSec: 1 / 30,
    substeps: 2,
    stayDurationMS: 500,
    fadeDurationMS: 300,
    shrinkAnchorY: 0.2,
    shadowEnabled: true,
    shadowColor: 0x000000,
    shadowAlpha: 0.4,
    shadowDistance: 4,
    shadowAngleDeg: 45,
    shadowBlur: 2,
    bgBlockEnabled: true,
    bgBlockColor: 0xff3333, // 红色背景小方块（对应倍率红）
    bgBlockInitAngleDeg: -15,
    bgBlockEndAngleDeg: 15,
    bgBlockDurationMS: 600,
    bgBlockFadeCurve: Object.freeze({
      enabled: true,
      startScale: 0,
      endScale: 1,
      p1: { x: 0.4, y: 0.05 },
      p2: { x: 0.8, y: 0.4 },
    }) as BezierCurveConfig,
    bgBlockScaleCurve: Object.freeze({
      enabled: true,
      startScale: 0,
      endScale: 1.5,
      p1: { x: 0.1, y: 0.85 },
      p2: { x: 0.25, y: 1.0 },
    }) as BezierCurveConfig,
  }),
  cardMoveRotation: Object.freeze({
    enabled: true,
    // 默认不显示轴点（仅调参时打开）。
    showPivot: false,
    // 轴点：卡牌几何中心向上偏 35 像素（卡牌 H ≈ 180，此值落在"中上部"区间）。
    pivotOffsetX: 0,
    pivotOffsetY: -35,
    // 1 px/ms ≈ 1000 px/s（正常拖拽速度）× 0.06 ≈ 0.06 rad ≈ 3.4°
    // 注：旋转上限 maxRot 由 (3000/1000) × rotationPerSpeed 派生（参考速度常量），
    //     不再作为独立配置项存储。默认 (3000/1000)*0.06 = 0.18 rad ≈ 10.3°。
    rotationPerSpeed: 0.06,
    drawRotationPerSpeed: 0.15,
    followLerp: 0.25,
    // 约 2 帧的速度 EMA，抑制拖拽中旋转角闪抖。
    velocitySmoothMS: 36,
    friction: 0.12,
    minSpeed: 0.02,
  }),
  // forceToAngle ≈ maxAngleRad / (k * Lmax) = (20°→0.349) / (100*120) ≈ 2.9e-5
  elasticRopeCard: Object.freeze({
    enabled: true,
    spring: Object.freeze({
      maxElasticLength: 120,
      stiffness: 100,
    }),
    airDrag: Object.freeze({
      mode: "linear" as const,
      linearCoeff: 10,
      quadraticCoeff: 0.002,
    }),
    integration: Object.freeze({
      mass: 1,
      maxDtSec: 1 / 30,
      substeps: 2,
    }),
    settle: Object.freeze({
      distancePx: 3,
      speedPxPerSec: 30,
    }),
    rotation: Object.freeze({
      enabled: true,
      forceToAngle: 0.000029,
      maxAngleDeg: 20,
      angleFollow: 0.35,
      rotationAffectsAnchor: false,
      dynamics: "springDamper" as const,
      mapMode: "linear" as const,
      responseGamma: 1.5,
      inertia: 1,
      angularFreq: 12,
      dampingRatio: 1.0,
    }),
    anchor: Object.freeze({
      anchorY: -45,
      anchorXMin: -25,
      anchorXMax: 25,
      mapMode: "continuous" as const,
    }),
    debug: Object.freeze({
      drawRope: true,
      drawAnchor: true,
      showHudReadouts: true,
      elasticColor: 0x66eeaa,
      rigidColor: 0x88aaff,
    }),
    sandbox: Object.freeze({
      followPointerWhileDown: true,
      freezeTargetOnRelease: true,
    }),
    expandedSections: Object.freeze({
      spring: true,
      airDrag: true,
      integration: true,
      settle: true,
      rotation: true,
      anchor: true,
      debug: true,
    }),
  }),
  cardVisuals: Object.freeze({
    expandedSections: Object.freeze({
      shadow: true,
      dragShadow: true,
      blindChipShadow: true,
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
      multiCardInterval: true,
      drawCard: true,
      drawFlip: true,
      discard: true,
      discardFlip: true,
      handSort: true,
      playHandGroupShift: true,
      playPileDisplacement: true,
      playPileLiftEffect: true,
      playPileSettleEffect: true,
      playPileSettleText: true,
      playPileSettleBgBlock: true,
      jokerEffects: true,
      jokerLayout: true,
      jokerSettleText: true,
      jokerSettleBgBlock: true,
      chipsBounce: true,
      multBounce: true,
      evalScoreBounce: true,
      evalScoreText: true,
      textJitter: true,
    }),
    selectMoveEnabled: true,
    selectRiseY: 30,
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
    hoverSettleScale: 1.05,
    hoverScaleMass: 1,
    hoverScaleAngularFreq: 16,
    hoverScaleDampingRatio: 0.45,
    hoverScaleImpulseScale: 0,
    hoverScaleImpulseScaleVel: 0,
    hoverScaleSettleEpsScale: 0.004,
    hoverScaleSettleVelScale: 0.05,
    hoverScaleMaxDtSec: 1 / 30,
    hoverScaleSubsteps: 2,

    hoverBreathingEnabled: true,
    hoverBreathingMass: 1,
    hoverBreathingAngularFreq: 14,
    hoverBreathingDampingRatio: 0.45,
    hoverBreathingImpulseY: 4,
    hoverBreathingImpulseYVel: 0,
    hoverBreathingImpulseRotDeg: 3.5,
    hoverBreathingImpulseRotVelDeg: 0,
    hoverBreathingSettleEpsY: 0.15,
    hoverBreathingSettleVelY: 2,
    hoverBreathingSettleEpsRotDeg: 0.15,
    hoverBreathingSettleVelRotDeg: 2,
    hoverBreathingMaxDurationMS: 1200,
    hoverBreathingMaxDtSec: 1 / 30,
    hoverBreathingSubsteps: 2,

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
  chipsBounce: Object.freeze({
    initScale: 1.5,
    maxScale: 2.0,
    stableScale: 1.0,
    scanSpeed: 40,
    scaleStrength: 12.0,
    speedRatio: 1.0,
  }),
  textJitter: Object.freeze({
    enabled: true,
    baseAngleDeg: 5,
    frequencyHz: 8,
    phaseStaggerDeg: 55,
    digitGrowth: 1.2,
    minDigits: 2,
    speedRatio: 1,
    // 默认绕单字几何中心摆动（与 CharLayer anchor 中心一致）。
    pivotX: 0.5,
    pivotY: 0.5,
  }),
  multBounce: Object.freeze({
    // 扫描节奏沿用旧弹弹；动力学对齐 playPileSettleEffect（略偏 UI 字更脆）。
    scanSpeed: 40,
    speedRatio: 1.6,
    mass: 1,
    angularFreq: 16,
    dampingRatio: 0.42,
    // 扫到时从放大态弹回 1，带轻微过冲（欠阻尼）。
    impulseScale: 0.55,
    impulseScaleVel: 0,
    // 角度阶跃 + 角速度冲量 → 弹簧角震荡，替代旧 cos/sin 伪相位。
    impulseRotDeg: -10,
    impulseRotVelDeg: 180,
    settleEpsScale: 0.004,
    settleVelScale: 0.05,
    settleEpsRotDeg: 0.15,
    settleVelRotDeg: 2,
    maxDurationMS: 900,
    maxDtSec: 1 / 30,
    substeps: 2,
  }),
  evalScoreBounce: Object.freeze({
    initScale: 1.5,
    maxScale: 1.8,
    stableScale: 1.0,
    scanSpeed: 30,
    scaleStrength: 15.0,
    speedRatio: 1.0,
  }),
  evalScoreText: Object.freeze({
    delayMS: 500,
    decreaseDurationMS: 500,
    stayDurationMS: 0,
  }),
  joker: Object.freeze({
    slotCount: 5,
    // 比手牌 spacing 略宽，顶部 5 张并排更透气。
    cardSpacing: 120,
    // 默认世界宽度 1280 的水平中线。
    baseX: 640,
    baseY: 90,
    effects: Object.freeze({
      shadow: true,
      breathing: true,
      idleTilt: true,
      hoverHit: true,
      hoverScale: true,
      hoverBreathing: true,
      mouse3DTilt: true,
    }),
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

/**
 * 将「卡牌逻辑 / 文字视效」中的 ms 时间参数按 gameSpeed 缩放。
 * gameSpeed>1 → 时长变短（加速）；0.5 → 时长变长（慢放）。
 */
export function scaleTimeMS(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  const speed = CONFIG.gameSpeed;
  if (!Number.isFinite(speed) || speed <= 0) return ms;
  return ms / speed;
}

/**
 * 按产品档写入 crt 数值字段。
 * subtle/hard 的默认值对齐执行方案验收表。
 */
export function applyCrtPreset(
  preset: CrtPresetId,
  crt: CrtConfig = CONFIG.world.crt,
): void {
  crt.preset = preset;
  if (preset === "off") {
    crt.enabled = false;
    return;
  }
  crt.enabled = true;
  if (preset === "subtle") {
    crt.intensity = 0.35;
    crt.scanlineCount = 720;
    crt.noiseAmount = 0.02;
    crt.contrast = 1.05;
    crt.resolution = 1;
  } else {
    crt.intensity = 0.55;
    crt.scanlineCount = 540;
    crt.noiseAmount = 0.04;
    crt.contrast = 1.12;
    crt.resolution = 1;
  }
}

/** 深拷贝 RuntimeConfig（保证不与 frozen DEFAULT_CONFIG 共享引用）。 */
export function cloneConfig(src: RuntimeConfig): RuntimeConfig {
  return {
    gameSpeed: src.gameSpeed ?? 1,
    world: {
      ...src.world,
      background: { ...src.world.background },
      crt: { ...src.world.crt },
    },
    rules: { ...src.rules },
    animation: { ...src.animation },
    debug: { ...src.debug },
    cardArt: {
      ...src.cardArt,
      back: { ...src.cardArt.back },
      blindChipAnim: { ...src.cardArt.blindChipAnim },
    },
    handLayout: { ...src.handLayout },
    playfield: { ...src.playfield },
    cardShadow: {
      ...src.cardShadow,
    },
    dragShadow: {
      ...src.dragShadow,
    },
    blindChipShadow: {
      ...src.blindChipShadow,
    },
    blindChipDragShadow: {
      ...src.blindChipDragShadow,
    },
    dragHandCard: {
      ...src.dragHandCard,
      scaleIn: { ...src.dragHandCard.scaleIn },
      scaleOut: { ...src.dragHandCard.scaleOut },
    },
    multiCardInterval: { ...src.multiCardInterval },
    drawCard: { ...src.drawCard },
    drawFlip: { ...src.drawFlip },
    discard: { ...src.discard },
    discardFlip: { ...src.discardFlip },
    handSort: { ...src.handSort },
    playHandGroupShift: { ...src.playHandGroupShift },
    playPileDisplacement: { ...src.playPileDisplacement },
    playPileLiftEffect: { ...src.playPileLiftEffect },
    playPileSettleEffect: { ...src.playPileSettleEffect },
    playPileSettleTextEffect: {
      ...src.playPileSettleTextEffect,
      bgBlockFadeCurve: src.playPileSettleTextEffect.bgBlockFadeCurve ? {
        ...src.playPileSettleTextEffect.bgBlockFadeCurve,
        p1: { ...src.playPileSettleTextEffect.bgBlockFadeCurve.p1 },
        p2: { ...src.playPileSettleTextEffect.bgBlockFadeCurve.p2 },
      } : undefined as any,
      bgBlockScaleCurve: src.playPileSettleTextEffect.bgBlockScaleCurve ? {
        ...src.playPileSettleTextEffect.bgBlockScaleCurve,
        p1: { ...src.playPileSettleTextEffect.bgBlockScaleCurve.p1 },
        p2: { ...src.playPileSettleTextEffect.bgBlockScaleCurve.p2 },
      } : undefined as any,
    },
    jokerSettleTextEffect: {
      ...src.jokerSettleTextEffect,
      bgBlockFadeCurve: src.jokerSettleTextEffect.bgBlockFadeCurve ? {
        ...src.jokerSettleTextEffect.bgBlockFadeCurve,
        p1: { ...src.jokerSettleTextEffect.bgBlockFadeCurve.p1 },
        p2: { ...src.jokerSettleTextEffect.bgBlockFadeCurve.p2 },
      } : undefined as any,
      bgBlockScaleCurve: src.jokerSettleTextEffect.bgBlockScaleCurve ? {
        ...src.jokerSettleTextEffect.bgBlockScaleCurve,
        p1: { ...src.jokerSettleTextEffect.bgBlockScaleCurve.p1 },
        p2: { ...src.jokerSettleTextEffect.bgBlockScaleCurve.p2 },
      } : undefined as any,
    },
    cardMoveRotation: { ...src.cardMoveRotation },
    elasticRopeCard: {
      ...src.elasticRopeCard,
      spring: { ...src.elasticRopeCard.spring },
      airDrag: { ...src.elasticRopeCard.airDrag },
      integration: { ...src.elasticRopeCard.integration },
      settle: { ...src.elasticRopeCard.settle },
      rotation: { ...src.elasticRopeCard.rotation },
      anchor: { ...src.elasticRopeCard.anchor },
      debug: { ...src.elasticRopeCard.debug },
      sandbox: { ...src.elasticRopeCard.sandbox },
      expandedSections: { ...src.elasticRopeCard.expandedSections },
    },
    cardVisuals: {
      ...src.cardVisuals,
      expandedSections: src.cardVisuals.expandedSections ? {
        ...src.cardVisuals.expandedSections,
      } : undefined as any,
    },
    playPile: { ...src.playPile },
    scoreCurve: {
      ...src.scoreCurve,
      p1: { ...src.scoreCurve.p1 },
      p2: { ...src.scoreCurve.p2 },
    },
    chipsBounce: { ...src.chipsBounce },
    multBounce: { ...src.multBounce },
    evalScoreBounce: { ...src.evalScoreBounce },
    evalScoreText: { ...src.evalScoreText },
    textJitter: { ...src.textJitter },
    joker: {
      ...src.joker,
      effects: { ...src.joker.effects },
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
 */
export function migrateConfig(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const obj = input as Record<string, unknown>;

  // 弹弹 configKey 合并：牌型文字 → chipsBounce，牌型等级 → multBounce。
  // 若 uiNodes 里 bounceText 仍写旧 key，hydrate 后读 CONFIG 会得到 undefined，动画立刻结束。
  const bounceKeyAliases: Record<string, string> = {
    handNameBounce: "chipsBounce",
    handLevelBounce: "multBounce",
  };
  const uiNodes = obj["uiNodes"];
  if (uiNodes && typeof uiNodes === "object") {
    for (const node of Object.values(
      uiNodes as Record<string, UINodeSerialized>,
    )) {
      if (!node?.components) continue;
      for (const comp of node.components) {
        if (comp?.type !== "bounceText" || !comp.data) continue;
        const key = comp.data["configKey"];
        if (typeof key === "string" && bounceKeyAliases[key]) {
          comp.data["configKey"] = bounceKeyAliases[key];
        }
      }
    }
  }

  // 旧 preset：把分散的多牌触发间隔收敛到 multiCardInterval.intervalMS。
  // 优先 discard.intervalMS（弃牌/出牌结束共用），其次抬牌 interval、出牌位移 firstIntervalMS。
  if (!obj["multiCardInterval"] || typeof obj["multiCardInterval"] !== "object") {
    const discard = obj["discard"] as Record<string, unknown> | undefined;
    const lift = obj["playPileLiftEffect"] as Record<string, unknown> | undefined;
    const disp = obj["playPileDisplacement"] as Record<string, unknown> | undefined;
    const seed =
      (typeof discard?.["intervalMS"] === "number" ? discard["intervalMS"] : undefined) ??
      (typeof lift?.["interval"] === "number" ? lift["interval"] : undefined) ??
      (typeof disp?.["firstIntervalMS"] === "number" ? disp["firstIntervalMS"] : undefined);
    if (typeof seed === "number" && Number.isFinite(seed)) {
      obj["multiCardInterval"] = { intervalMS: seed };
    }
  }

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
  if (typeof incoming.gameSpeed === "number" && Number.isFinite(incoming.gameSpeed) && incoming.gameSpeed > 0) {
    merged.gameSpeed = incoming.gameSpeed;
  }
  if (incoming.world) {
    merged.world = {
      ...merged.world,
      ...incoming.world,
      background: {
        ...merged.world.background,
        ...(incoming.world.background ?? {}),
      },
      crt: {
        ...merged.world.crt,
        ...(incoming.world.crt ?? {}),
      },
    };
  }
  if (incoming.rules) Object.assign(merged.rules, incoming.rules);
  if (incoming.animation) Object.assign(merged.animation, incoming.animation);
  if (incoming.debug) Object.assign(merged.debug, incoming.debug);
  if (incoming.cardArt) {
    merged.cardArt = {
      ...merged.cardArt,
      ...incoming.cardArt,
      back: { ...merged.cardArt.back, ...(incoming.cardArt.back ?? {}) },
      blindChipAnim: {
        ...merged.cardArt.blindChipAnim,
        ...(incoming.cardArt.blindChipAnim ?? {}),
      },
    };
  }
  if (incoming.handLayout) {
    merged.handLayout = {
      ...merged.handLayout,
      ...incoming.handLayout,
    };
  }
  if (incoming.playfield) {
    merged.playfield = {
      ...merged.playfield,
      ...incoming.playfield,
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
  if (incoming.blindChipShadow) {
    merged.blindChipShadow = {
      ...merged.blindChipShadow,
      ...incoming.blindChipShadow,
    };
  }
  if (incoming.blindChipDragShadow) {
    merged.blindChipDragShadow = {
      ...merged.blindChipDragShadow,
      ...incoming.blindChipDragShadow,
    };
  }
  if (incoming.dragHandCard) {
    merged.dragHandCard = mergeDragHandCard(
      merged.dragHandCard,
      incoming.dragHandCard as Partial<RuntimeConfig["dragHandCard"]> &
        Record<string, unknown>,
    );
  }
  if (incoming.cardMoveRotation) {
    merged.cardMoveRotation = {
      ...merged.cardMoveRotation,
      ...incoming.cardMoveRotation,
    };
  }
  if (incoming.elasticRopeCard) {
    const er = incoming.elasticRopeCard;
    merged.elasticRopeCard = {
      ...merged.elasticRopeCard,
      ...er,
      spring: { ...merged.elasticRopeCard.spring, ...(er.spring ?? {}) },
      airDrag: { ...merged.elasticRopeCard.airDrag, ...(er.airDrag ?? {}) },
      integration: {
        ...merged.elasticRopeCard.integration,
        ...(er.integration ?? {}),
      },
      settle: { ...merged.elasticRopeCard.settle, ...(er.settle ?? {}) },
      rotation: { ...merged.elasticRopeCard.rotation, ...(er.rotation ?? {}) },
      anchor: { ...merged.elasticRopeCard.anchor, ...(er.anchor ?? {}) },
      debug: { ...merged.elasticRopeCard.debug, ...(er.debug ?? {}) },
      sandbox: { ...merged.elasticRopeCard.sandbox, ...(er.sandbox ?? {}) },
      expandedSections: {
        ...merged.elasticRopeCard.expandedSections,
        ...(er.expandedSections ?? {}),
      },
    };
  }
  if (incoming.multiCardInterval) {
    merged.multiCardInterval = {
      ...merged.multiCardInterval,
      ...incoming.multiCardInterval,
    };
  }
  if (incoming.drawCard) {
    merged.drawCard = {
      ...merged.drawCard,
      ...incoming.drawCard,
    };
  }
  if (incoming.drawFlip) {
    merged.drawFlip = {
      ...merged.drawFlip,
      ...incoming.drawFlip,
    };
  }
  if (incoming.discard) {
    merged.discard = {
      ...merged.discard,
      ...incoming.discard,
    };
  }
  if (incoming.discardFlip) {
    merged.discardFlip = {
      ...merged.discardFlip,
      ...incoming.discardFlip,
    };
  }
  if (incoming.handSort) {
    merged.handSort = {
      ...merged.handSort,
      ...incoming.handSort,
    };
  }
  if (incoming.playHandGroupShift) {
    merged.playHandGroupShift = {
      ...merged.playHandGroupShift,
      ...incoming.playHandGroupShift,
    };
  }
  if (incoming.playPileDisplacement) {
    merged.playPileDisplacement = {
      ...merged.playPileDisplacement,
      ...incoming.playPileDisplacement,
    };
  }
  if (incoming.playPileLiftEffect) {
    const liftIn = incoming.playPileLiftEffect as Partial<
      typeof merged.playPileLiftEffect
    > & {
      /** @deprecated 旧抬升高度系数，迁移为 distancePx = startSpeed * decelerateTime / 2 */
      startSpeed?: number;
      decelerateTime?: number;
    };
    const { startSpeed: legacyStart, decelerateTime: legacyDecel, ...liftRest } =
      liftIn;
    merged.playPileLiftEffect = {
      ...merged.playPileLiftEffect,
      ...liftRest,
    };
    // 旧预设只有 startSpeed/decelerateTime 时换算为上移距离
    if (
      liftRest.distancePx === undefined &&
      typeof legacyStart === "number" &&
      typeof legacyDecel === "number"
    ) {
      merged.playPileLiftEffect.distancePx = (legacyStart * legacyDecel) / 2;
    }
  }
  if (incoming.playPileSettleEffect) {
    merged.playPileSettleEffect = {
      ...merged.playPileSettleEffect,
      ...incoming.playPileSettleEffect,
    };
  }
  if (incoming.playPileSettleTextEffect) {
    merged.playPileSettleTextEffect = {
      ...merged.playPileSettleTextEffect,
      ...incoming.playPileSettleTextEffect,
      bgBlockFadeCurve: incoming.playPileSettleTextEffect.bgBlockFadeCurve
        ? {
            ...merged.playPileSettleTextEffect.bgBlockFadeCurve,
            ...incoming.playPileSettleTextEffect.bgBlockFadeCurve,
            p1: { ...(merged.playPileSettleTextEffect.bgBlockFadeCurve?.p1 ?? {}), ...(incoming.playPileSettleTextEffect.bgBlockFadeCurve.p1 ?? {}) },
            p2: { ...(merged.playPileSettleTextEffect.bgBlockFadeCurve?.p2 ?? {}), ...(incoming.playPileSettleTextEffect.bgBlockFadeCurve.p2 ?? {}) },
          }
        : merged.playPileSettleTextEffect.bgBlockFadeCurve,
      bgBlockScaleCurve: incoming.playPileSettleTextEffect.bgBlockScaleCurve
        ? {
            ...merged.playPileSettleTextEffect.bgBlockScaleCurve,
            ...incoming.playPileSettleTextEffect.bgBlockScaleCurve,
            p1: { ...(merged.playPileSettleTextEffect.bgBlockScaleCurve?.p1 ?? {}), ...(incoming.playPileSettleTextEffect.bgBlockScaleCurve.p1 ?? {}) },
            p2: { ...(merged.playPileSettleTextEffect.bgBlockScaleCurve?.p2 ?? {}), ...(incoming.playPileSettleTextEffect.bgBlockScaleCurve.p2 ?? {}) },
          }
        : merged.playPileSettleTextEffect.bgBlockScaleCurve,
    };
  }
  if (incoming.jokerSettleTextEffect) {
    merged.jokerSettleTextEffect = {
      ...merged.jokerSettleTextEffect,
      ...incoming.jokerSettleTextEffect,
      bgBlockFadeCurve: incoming.jokerSettleTextEffect.bgBlockFadeCurve
        ? {
            ...merged.jokerSettleTextEffect.bgBlockFadeCurve,
            ...incoming.jokerSettleTextEffect.bgBlockFadeCurve,
            p1: { ...(merged.jokerSettleTextEffect.bgBlockFadeCurve?.p1 ?? {}), ...(incoming.jokerSettleTextEffect.bgBlockFadeCurve.p1 ?? {}) },
            p2: { ...(merged.jokerSettleTextEffect.bgBlockFadeCurve?.p2 ?? {}), ...(incoming.jokerSettleTextEffect.bgBlockFadeCurve.p2 ?? {}) },
          }
        : merged.jokerSettleTextEffect.bgBlockFadeCurve,
      bgBlockScaleCurve: incoming.jokerSettleTextEffect.bgBlockScaleCurve
        ? {
            ...merged.jokerSettleTextEffect.bgBlockScaleCurve,
            ...incoming.jokerSettleTextEffect.bgBlockScaleCurve,
            p1: { ...(merged.jokerSettleTextEffect.bgBlockScaleCurve?.p1 ?? {}), ...(incoming.jokerSettleTextEffect.bgBlockScaleCurve.p1 ?? {}) },
            p2: { ...(merged.jokerSettleTextEffect.bgBlockScaleCurve?.p2 ?? {}), ...(incoming.jokerSettleTextEffect.bgBlockScaleCurve.p2 ?? {}) },
          }
        : merged.jokerSettleTextEffect.bgBlockScaleCurve,
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
  if (incoming.chipsBounce) {
    merged.chipsBounce = {
      ...merged.chipsBounce,
      ...incoming.chipsBounce,
    };
  }
  if (incoming.multBounce) {
    merged.multBounce = {
      ...merged.multBounce,
      ...incoming.multBounce,
    };
  }
  // 旧 shipping 中的 handNameBounce / handLevelBounce 已废弃：
  // 牌型文字 → chipsBounce，牌型等级 → multBounce，此处忽略以免污染类型。
  if (incoming.evalScoreBounce) {
    merged.evalScoreBounce = {
      ...merged.evalScoreBounce,
      ...incoming.evalScoreBounce,
    };
  }
  if (incoming.evalScoreText) {
    merged.evalScoreText = {
      ...merged.evalScoreText,
      ...incoming.evalScoreText,
    };
  }
  if (incoming.textJitter) {
    merged.textJitter = {
      ...merged.textJitter,
      ...incoming.textJitter,
    };
  }
  if (incoming.joker) {
    merged.joker = {
      ...merged.joker,
      ...incoming.joker,
      effects: incoming.joker.effects
        ? {
            ...merged.joker.effects,
            ...incoming.joker.effects,
          }
        : merged.joker.effects,
    };
  }
  // uiNodes：整张表内部条目相互依赖（parentId / siblingIndex），不适合按字段合并。
  // 关键规则：
  //   - 来源**显式携带** uiNodes（含空对象）→ 整表替换；
  //   - 来源**未携带** uiNodes → 保留 activeDefaultConfig 里已有的（通常是 shipping），
  //     绝不能写成 {}，否则会把刚载入的 shipping 布局冲掉，界面 UI 全部回退到代码硬编码。
  if (Object.prototype.hasOwnProperty.call(incoming, "uiNodes")) {
    merged.uiNodes = cloneUINodes(incoming.uiNodes ?? {});
  }

  // 就地写回，保留外部对 CONFIG 的引用稳定。
  CONFIG.gameSpeed = merged.gameSpeed;
  CONFIG.world = merged.world;
  CONFIG.rules = merged.rules;
  CONFIG.animation = merged.animation;
  CONFIG.debug = merged.debug;
  CONFIG.cardArt = merged.cardArt;
  CONFIG.handLayout = merged.handLayout;
  CONFIG.playfield = merged.playfield;
  CONFIG.cardShadow = merged.cardShadow;
  CONFIG.dragShadow = merged.dragShadow;
  CONFIG.blindChipShadow = merged.blindChipShadow;
  CONFIG.blindChipDragShadow = merged.blindChipDragShadow;
  CONFIG.dragHandCard = merged.dragHandCard;
  CONFIG.cardMoveRotation = merged.cardMoveRotation;
  CONFIG.elasticRopeCard = merged.elasticRopeCard;
  CONFIG.multiCardInterval = merged.multiCardInterval;
  CONFIG.drawCard = merged.drawCard;
  CONFIG.drawFlip = merged.drawFlip;
  CONFIG.discard = merged.discard;
  CONFIG.discardFlip = merged.discardFlip;
  CONFIG.handSort = merged.handSort;
  CONFIG.playHandGroupShift = merged.playHandGroupShift;
  CONFIG.playPileDisplacement = merged.playPileDisplacement;
  CONFIG.playPileLiftEffect = merged.playPileLiftEffect;
  CONFIG.playPileSettleEffect = merged.playPileSettleEffect;
  CONFIG.playPileSettleTextEffect = merged.playPileSettleTextEffect;
  CONFIG.jokerSettleTextEffect = merged.jokerSettleTextEffect;
  CONFIG.cardVisuals = merged.cardVisuals;
  CONFIG.playPile = merged.playPile;
  CONFIG.scoreCurve = merged.scoreCurve;
  CONFIG.chipsBounce = merged.chipsBounce;
  CONFIG.multBounce = merged.multBounce;
  CONFIG.evalScoreBounce = merged.evalScoreBounce;
  CONFIG.evalScoreText = merged.evalScoreText;
  CONFIG.textJitter = merged.textJitter;
  CONFIG.joker = merged.joker;
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

  if (typeof incoming.gameSpeed === "number" && Number.isFinite(incoming.gameSpeed) && incoming.gameSpeed > 0) {
    activeDefaultConfig.gameSpeed = incoming.gameSpeed;
  }
  if (incoming.world) {
    activeDefaultConfig.world = {
      ...activeDefaultConfig.world,
      ...incoming.world,
      background: {
        ...activeDefaultConfig.world.background,
        ...(incoming.world.background ?? {}),
      },
    };
  }
  if (incoming.rules) Object.assign(activeDefaultConfig.rules, incoming.rules);
  if (incoming.animation) Object.assign(activeDefaultConfig.animation, incoming.animation);
  if (incoming.debug) Object.assign(activeDefaultConfig.debug, incoming.debug);
  if (incoming.cardArt) {
    activeDefaultConfig.cardArt = {
      ...activeDefaultConfig.cardArt,
      ...incoming.cardArt,
      back: { ...activeDefaultConfig.cardArt.back, ...(incoming.cardArt.back ?? {}) },
      blindChipAnim: {
        ...activeDefaultConfig.cardArt.blindChipAnim,
        ...(incoming.cardArt.blindChipAnim ?? {}),
      },
    };
  }
  if (incoming.handLayout) {
    activeDefaultConfig.handLayout = {
      ...activeDefaultConfig.handLayout,
      ...incoming.handLayout,
    };
  }
  if (incoming.playfield) {
    activeDefaultConfig.playfield = {
      ...activeDefaultConfig.playfield,
      ...incoming.playfield,
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
  if (incoming.blindChipShadow) {
    activeDefaultConfig.blindChipShadow = {
      ...activeDefaultConfig.blindChipShadow,
      ...incoming.blindChipShadow,
    };
  }
  if (incoming.blindChipDragShadow) {
    activeDefaultConfig.blindChipDragShadow = {
      ...activeDefaultConfig.blindChipDragShadow,
      ...incoming.blindChipDragShadow,
    };
  }
  if (incoming.dragHandCard) {
    activeDefaultConfig.dragHandCard = mergeDragHandCard(
      activeDefaultConfig.dragHandCard,
      incoming.dragHandCard as Partial<RuntimeConfig["dragHandCard"]> &
        Record<string, unknown>,
    );
  }
  if (incoming.elasticRopeCard) {
    const er = incoming.elasticRopeCard;
    activeDefaultConfig.elasticRopeCard = {
      ...activeDefaultConfig.elasticRopeCard,
      ...er,
      spring: { ...activeDefaultConfig.elasticRopeCard.spring, ...(er.spring ?? {}) },
      airDrag: { ...activeDefaultConfig.elasticRopeCard.airDrag, ...(er.airDrag ?? {}) },
      integration: {
        ...activeDefaultConfig.elasticRopeCard.integration,
        ...(er.integration ?? {}),
      },
      settle: { ...activeDefaultConfig.elasticRopeCard.settle, ...(er.settle ?? {}) },
      rotation: {
        ...activeDefaultConfig.elasticRopeCard.rotation,
        ...(er.rotation ?? {}),
      },
      anchor: { ...activeDefaultConfig.elasticRopeCard.anchor, ...(er.anchor ?? {}) },
      debug: { ...activeDefaultConfig.elasticRopeCard.debug, ...(er.debug ?? {}) },
      sandbox: { ...activeDefaultConfig.elasticRopeCard.sandbox, ...(er.sandbox ?? {}) },
      expandedSections: {
        ...activeDefaultConfig.elasticRopeCard.expandedSections,
        ...(er.expandedSections ?? {}),
      },
    };
  }
  if (incoming.cardMoveRotation) {
    activeDefaultConfig.cardMoveRotation = {
      ...activeDefaultConfig.cardMoveRotation,
      ...incoming.cardMoveRotation,
    };
  }
  if (incoming.multiCardInterval) {
    activeDefaultConfig.multiCardInterval = {
      ...activeDefaultConfig.multiCardInterval,
      ...incoming.multiCardInterval,
    };
  }
  if (incoming.drawCard) {
    activeDefaultConfig.drawCard = {
      ...activeDefaultConfig.drawCard,
      ...incoming.drawCard,
    };
  }
  if (incoming.drawFlip) {
    activeDefaultConfig.drawFlip = {
      ...activeDefaultConfig.drawFlip,
      ...incoming.drawFlip,
    };
  }
  if (incoming.discard) {
    activeDefaultConfig.discard = {
      ...activeDefaultConfig.discard,
      ...incoming.discard,
    };
  }
  if (incoming.discardFlip) {
    activeDefaultConfig.discardFlip = {
      ...activeDefaultConfig.discardFlip,
      ...incoming.discardFlip,
    };
  }
  if (incoming.handSort) {
    activeDefaultConfig.handSort = {
      ...activeDefaultConfig.handSort,
      ...incoming.handSort,
    };
  }
  if (incoming.playHandGroupShift) {
    activeDefaultConfig.playHandGroupShift = {
      ...activeDefaultConfig.playHandGroupShift,
      ...incoming.playHandGroupShift,
    };
  }
  if (incoming.playPileDisplacement) {
    activeDefaultConfig.playPileDisplacement = {
      ...activeDefaultConfig.playPileDisplacement,
      ...incoming.playPileDisplacement,
    };
  }
  if (incoming.playPileLiftEffect) {
    const liftIn = incoming.playPileLiftEffect as Partial<
      typeof activeDefaultConfig.playPileLiftEffect
    > & {
      startSpeed?: number;
      decelerateTime?: number;
    };
    const { startSpeed: legacyStart, decelerateTime: legacyDecel, ...liftRest } =
      liftIn;
    activeDefaultConfig.playPileLiftEffect = {
      ...activeDefaultConfig.playPileLiftEffect,
      ...liftRest,
    };
    if (
      liftRest.distancePx === undefined &&
      typeof legacyStart === "number" &&
      typeof legacyDecel === "number"
    ) {
      activeDefaultConfig.playPileLiftEffect.distancePx =
        (legacyStart * legacyDecel) / 2;
    }
  }
  if (incoming.playPileSettleEffect) {
    activeDefaultConfig.playPileSettleEffect = {
      ...activeDefaultConfig.playPileSettleEffect,
      ...incoming.playPileSettleEffect,
    };
  }
  if (incoming.playPileSettleTextEffect) {
    activeDefaultConfig.playPileSettleTextEffect = {
      ...activeDefaultConfig.playPileSettleTextEffect,
      ...incoming.playPileSettleTextEffect,
      bgBlockFadeCurve: incoming.playPileSettleTextEffect.bgBlockFadeCurve
        ? {
            ...activeDefaultConfig.playPileSettleTextEffect.bgBlockFadeCurve,
            ...incoming.playPileSettleTextEffect.bgBlockFadeCurve,
            p1: { ...(activeDefaultConfig.playPileSettleTextEffect.bgBlockFadeCurve?.p1 ?? {}), ...(incoming.playPileSettleTextEffect.bgBlockFadeCurve.p1 ?? {}) },
            p2: { ...(activeDefaultConfig.playPileSettleTextEffect.bgBlockFadeCurve?.p2 ?? {}), ...(incoming.playPileSettleTextEffect.bgBlockFadeCurve.p2 ?? {}) },
          }
        : activeDefaultConfig.playPileSettleTextEffect.bgBlockFadeCurve,
      bgBlockScaleCurve: incoming.playPileSettleTextEffect.bgBlockScaleCurve
        ? {
            ...activeDefaultConfig.playPileSettleTextEffect.bgBlockScaleCurve,
            ...incoming.playPileSettleTextEffect.bgBlockScaleCurve,
            p1: { ...(activeDefaultConfig.playPileSettleTextEffect.bgBlockScaleCurve?.p1 ?? {}), ...(incoming.playPileSettleTextEffect.bgBlockScaleCurve.p1 ?? {}) },
            p2: { ...(activeDefaultConfig.playPileSettleTextEffect.bgBlockScaleCurve?.p2 ?? {}), ...(incoming.playPileSettleTextEffect.bgBlockScaleCurve.p2 ?? {}) },
          }
        : activeDefaultConfig.playPileSettleTextEffect.bgBlockScaleCurve,
    };
  }
  if (incoming.jokerSettleTextEffect) {
    activeDefaultConfig.jokerSettleTextEffect = {
      ...activeDefaultConfig.jokerSettleTextEffect,
      ...incoming.jokerSettleTextEffect,
      bgBlockFadeCurve: incoming.jokerSettleTextEffect.bgBlockFadeCurve
        ? {
            ...activeDefaultConfig.jokerSettleTextEffect.bgBlockFadeCurve,
            ...incoming.jokerSettleTextEffect.bgBlockFadeCurve,
            p1: { ...(activeDefaultConfig.jokerSettleTextEffect.bgBlockFadeCurve?.p1 ?? {}), ...(incoming.jokerSettleTextEffect.bgBlockFadeCurve.p1 ?? {}) },
            p2: { ...(activeDefaultConfig.jokerSettleTextEffect.bgBlockFadeCurve?.p2 ?? {}), ...(incoming.jokerSettleTextEffect.bgBlockFadeCurve.p2 ?? {}) },
          }
        : activeDefaultConfig.jokerSettleTextEffect.bgBlockFadeCurve,
      bgBlockScaleCurve: incoming.jokerSettleTextEffect.bgBlockScaleCurve
        ? {
            ...activeDefaultConfig.jokerSettleTextEffect.bgBlockScaleCurve,
            ...incoming.jokerSettleTextEffect.bgBlockScaleCurve,
            p1: { ...(activeDefaultConfig.jokerSettleTextEffect.bgBlockScaleCurve?.p1 ?? {}), ...(incoming.jokerSettleTextEffect.bgBlockScaleCurve.p1 ?? {}) },
            p2: { ...(activeDefaultConfig.jokerSettleTextEffect.bgBlockScaleCurve?.p2 ?? {}), ...(incoming.jokerSettleTextEffect.bgBlockScaleCurve.p2 ?? {}) },
          }
        : activeDefaultConfig.jokerSettleTextEffect.bgBlockScaleCurve,
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
  if (incoming.chipsBounce) {
    activeDefaultConfig.chipsBounce = {
      ...activeDefaultConfig.chipsBounce,
      ...incoming.chipsBounce,
    };
  }
  if (incoming.multBounce) {
    activeDefaultConfig.multBounce = {
      ...activeDefaultConfig.multBounce,
      ...incoming.multBounce,
    };
  }
  if (incoming.evalScoreBounce) {
    activeDefaultConfig.evalScoreBounce = {
      ...activeDefaultConfig.evalScoreBounce,
      ...incoming.evalScoreBounce,
    };
  }
  if (incoming.evalScoreText) {
    activeDefaultConfig.evalScoreText = {
      ...activeDefaultConfig.evalScoreText,
      ...incoming.evalScoreText,
    };
  }
  if (incoming.textJitter) {
    activeDefaultConfig.textJitter = {
      ...activeDefaultConfig.textJitter,
      ...incoming.textJitter,
    };
  }
  if (incoming.joker) {
    activeDefaultConfig.joker = {
      ...activeDefaultConfig.joker,
      ...incoming.joker,
      effects: incoming.joker.effects
        ? {
            ...activeDefaultConfig.joker.effects,
            ...incoming.joker.effects,
          }
        : activeDefaultConfig.joker.effects,
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

/**
 * 跨版本升级时备份旧 localStorage，便于手工找回被丢弃的 uiNodes / 参数。
 * 失败（配额满等）只打日志，不阻断启动。
 */
function backupSavedConfig(
  storageKey: string,
  raw: string,
  savedVersion: number,
): void {
  try {
    const bakKey = `${storageKey}.bak.v${savedVersion}`;
    // 同版本备份已存在则保留最早一份，避免反复覆盖真正有用的旧档。
    if (localStorage.getItem(bakKey) == null) {
      localStorage.setItem(bakKey, raw);
      console.info(`[config] 已备份旧配置到 localStorage["${bakKey}"]`);
    }
  } catch (err) {
    console.warn("[config] 备份旧配置失败（可忽略）：", err);
  }
}

export function loadSavedConfig(storageKey: string = CONFIG_STORAGE_KEY): void {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return;

    const savedVersion = typeof parsed["__version"] === "number"
      ? (parsed["__version"] as number)
      : 0;

    let migrated = false;
    if (savedVersion !== CONFIG_VERSION) {
      backupSavedConfig(storageKey, raw, savedVersion);
      // 跨版本：丢弃本地 uiNodes，让 applyConfig 保留 activeDefaultConfig
      // （即 shipping）中的界面布局。其余数值参数继续合并。
      // 注意：绝不能在 applyConfig 里把缺失的 uiNodes 写成 {}——那会清空 shipping。
      delete parsed["uiNodes"];
      migrated = true;
      console.warn(
        `[config] 本地配置版本 ${savedVersion} ≠ 当前 ${CONFIG_VERSION}，` +
          "已回退界面 UI（uiNodes）到 shipping/出厂默认，其它参数仍合并本地值。",
      );
    }

    applyConfig(parsed);

    // 把迁移后的结果写回，避免每次刷新都重复告警 / 重复丢弃 uiNodes。
    if (migrated) {
      saveCurrentConfig(storageKey);
    }
  } catch (err) {
    console.error("[config] 读取本地保存配置失败：", err);
  }
}

export function saveCurrentConfig(
  storageKey: string = CONFIG_STORAGE_KEY,
): void {
  try {
    // 保存前若 uiNodes 意外为空而 shipping 默认非空，拒绝把空表持久化，
    // 避免下次启动用空表盖住调好的布局。
    if (
      (!CONFIG.uiNodes || Object.keys(CONFIG.uiNodes).length === 0) &&
      activeDefaultConfig.uiNodes &&
      Object.keys(activeDefaultConfig.uiNodes).length > 0
    ) {
      CONFIG.uiNodes = cloneUINodes(activeDefaultConfig.uiNodes);
      console.warn(
        "[config] 保存时 CONFIG.uiNodes 为空，已用 activeDefaultConfig 回填后再写入。",
      );
    }
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

export let isDrawingCards = false;
export function setDrawingCards(val: boolean) {
  isDrawingCards = val;
}
