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

export const CONFIG_VERSION = 1;

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
  /** 可选：示例语义曲线，留作扩展（如未来按 combo 数缩放某个倍率） */
  scoreCurve: BezierCurveConfig;
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
  scoreCurve: Object.freeze({
    enabled: false,
    startScale: 1,
    endScale: 1.5,
    p1: { x: 0.42, y: 0 },
    p2: { x: 0.58, y: 1 },
  }),
}) as RuntimeConfig;

/**
 * 运行时可写副本。所有业务读这个对象。
 * 用深拷贝避免共享 frozen 引用。
 */
export const CONFIG: RuntimeConfig = cloneConfig(DEFAULT_CONFIG);

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
    scoreCurve: {
      ...src.scoreCurve,
      p1: { ...src.scoreCurve.p1 },
      p2: { ...src.scoreCurve.p2 },
    },
  };
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
 * 用 DEFAULT_CONFIG 兜底缺失字段，保证旧 preset 升级后不丢字段。
 */
export function applyConfig(source: unknown): void {
  const migrated = migrateConfig(source);
  const incoming = (migrated && typeof migrated === "object")
    ? (migrated as Partial<RuntimeConfig>)
    : {};

  const merged = cloneConfig(DEFAULT_CONFIG);
  if (incoming.world) Object.assign(merged.world, incoming.world);
  if (incoming.rules) Object.assign(merged.rules, incoming.rules);
  if (incoming.animation) Object.assign(merged.animation, incoming.animation);
  if (incoming.debug) Object.assign(merged.debug, incoming.debug);
  if (incoming.scoreCurve) {
    merged.scoreCurve = {
      ...merged.scoreCurve,
      ...incoming.scoreCurve,
      p1: { ...merged.scoreCurve.p1, ...(incoming.scoreCurve.p1 ?? {}) },
      p2: { ...merged.scoreCurve.p2, ...(incoming.scoreCurve.p2 ?? {}) },
    };
  }

  // 就地写回，保留外部对 CONFIG 的引用稳定。
  CONFIG.world = merged.world;
  CONFIG.rules = merged.rules;
  CONFIG.animation = merged.animation;
  CONFIG.debug = merged.debug;
  CONFIG.scoreCurve = merged.scoreCurve;
}

/** 把 CONFIG 重置为 DEFAULT_CONFIG。 */
export function resetConfigToDefaults(): void {
  applyConfig(DEFAULT_CONFIG);
}

const CONFIG_STORAGE_KEY = "balatroRuntimeConfig";

export function loadSavedConfig(storageKey: string = CONFIG_STORAGE_KEY): void {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return;
    applyConfig(JSON.parse(raw));
  } catch (err) {
    console.error("[config] 读取本地保存配置失败：", err);
  }
}

export function saveCurrentConfig(
  storageKey: string = CONFIG_STORAGE_KEY,
): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(CONFIG));
  } catch (err) {
    console.error("[config] 保存配置失败：", err);
  }
}

export const STORAGE_KEYS = {
  config: CONFIG_STORAGE_KEY,
  presets: "balatroRuntimeControlPresets",
};
