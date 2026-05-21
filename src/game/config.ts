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

export const CONFIG_VERSION = 2;

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
  cardVisuals: {
    // 1. 常态呼吸晃动
    breathingEnabled: boolean;
    breathingSpeed: number;
    breathingAmplitude: number;
    wobbleSpeed: number;
    wobbleAmplitude: number;

    // 2. 鼠标触碰小弹性缩放
    hoverScaleEnabled: boolean;
    hoverScaleFactor: number;
    hoverScaleSpeed: number;

    // 3. 鼠标在单牌移动时的偏移
    mouseOffsetEnabled: boolean;
    mouseOffsetFactorX: number;
    mouseOffsetFactorY: number;
    mouseOffsetLimit: number;

    // 4. 卡牌操作逻辑参数
    clickThresholdMS: number;
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
  cardVisuals: Object.freeze({
    breathingEnabled: true,
    breathingSpeed: 0.002,
    breathingAmplitude: 3,
    wobbleSpeed: 0.001,
    wobbleAmplitude: 0.04,

    hoverScaleEnabled: true,
    hoverScaleFactor: 1.05,
    hoverScaleSpeed: 0.15,

    mouseOffsetEnabled: true,
    mouseOffsetFactorX: 0.08,
    mouseOffsetFactorY: 0.08,
    mouseOffsetLimit: 8,

    clickThresholdMS: 250,
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
    cardShadow: {
      ...src.cardShadow,
    },
    dragShadow: {
      ...src.dragShadow,
    },
    cardVisuals: {
      ...src.cardVisuals,
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
  if (incoming.cardVisuals) {
    merged.cardVisuals = {
      ...merged.cardVisuals,
      ...incoming.cardVisuals,
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
  CONFIG.cardShadow = merged.cardShadow;
  CONFIG.dragShadow = merged.dragShadow;
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
  if (incoming.cardVisuals) {
    activeDefaultConfig.cardVisuals = {
      ...activeDefaultConfig.cardVisuals,
      ...incoming.cardVisuals,
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
