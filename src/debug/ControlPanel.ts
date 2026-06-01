/**
 * ControlPanel
 * ------------------------------------------------------------------
 * 项目通用的运行时调参面板（参考 docs/wheels/control-panel-capsule）。
 *
 * 设计要点：
 *   1. CONFIG 是单源（src/game/config.ts）。本文件只做 UI 绑定与持久化，
 *      不参与"业务怎么使用参数"。
 *   2. 控件用 bindSlider / bindNumber / bindToggle / bindColor / bindCycleButton
 *      统一绑定。新加参数 = HTML 一行 + JS 一行。
 *   3. .panel-group 自动生成左侧 tab，永远只展开一个分组。
 *   4. 触发器 (#panel-trigger) 默认显示；连点 3 次 (600ms 内) 才弹出面板，
 *      避免普通用户误打开调试面板。
 *   5. preset 用 localStorage 存，导入/导出走 JSON 文件，
 *      preset 加载用 DEFAULT_CONFIG 兜底 → 旧 preset 不丢字段。
 */

import "./control-panel.css";
import { attachDragScrub } from "./dragScrub";
import {
  CONFIG,
  CONFIG_VERSION,
  DEFAULT_CONFIG,
  STORAGE_KEYS,
  applyConfig,
  cloneConfig,
  resetConfigToDefaults,
  saveCurrentConfig,
  type RuntimeConfig,
} from "@game/config";
import { assets } from "@core/AssetManager";
import { CardAtlas } from "@render/CardSkin";
import { computeMaxRot } from "@render/CardView";
import { HierarchyView } from "./HierarchyView";
import { buildCurvePanel, type BezierCurvePanel } from "./BezierCurveEditor";
import { uiHierarchy } from "@ui/hierarchy";
import type { Container } from "pixi.js";

// ===== 类型 =========================================================

export type ConfigChangeHandler = (
  key: string,
  value: unknown,
  config: RuntimeConfig,
) => void;

export interface SetupControlPanelOptions {
  /**
   * 任意控件被修改时回调。
   * key 是控件绑定的点分路径（如 "rules.handSize"）。
   * 当 preset 整体载入时会以 key = "*" 触发，value = CONFIG。
   */
  onChange?: ConfigChangeHandler;
  /**
   * 世界根 Container。
   * "界面UI"分组里的 Hierarchy 视图需要它来处理"拖到空白处"的 reparent 操作。
   */
  worldRoot?: Container;
}

export interface ControlPanelHandle {
  /** 强制刷新所有控件（在外部修改 CONFIG 后调用）。 */
  refresh(): void;
  /** 销毁面板事件监听（一般不需要，仅用于热重载场景）。 */
  destroy(): void;
}

// ===== 工具：点分路径读写 ============================================

/** 按点分路径读 CONFIG 的某个字段，比如 "rules.handSize"。 */
function getByPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((cur, seg) => {
    if (cur && typeof cur === "object" && seg in (cur as object)) {
      return (cur as Record<string, unknown>)[seg];
    }
    return undefined;
  }, obj);
}

/** 按点分路径写 CONFIG 的某个字段。 */
function setByPath(obj: unknown, path: string, value: unknown): void {
  const segs = path.split(".");
  let cur: Record<string, unknown> = obj as Record<string, unknown>;
  for (let i = 0; i < segs.length - 1; i += 1) {
    const seg = segs[i]!;
    const next = cur[seg];
    if (!next || typeof next !== "object") {
      cur[seg] = {};
    }
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]!] = value;
}

function formatNumber(value: number, digits: number): string {
  return Number(value).toFixed(digits);
}

/** PIXI 数值色 ↔ CSS 颜色字符串。 */
function numberToHexColor(n: number): string {
  return "#" + (n & 0xffffff).toString(16).padStart(6, "0");
}
function hexColorToNumber(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  return parseInt(m[1]!, 16);
}

// ===== 主入口 =======================================================

export function setupControlPanel(
  options: SetupControlPanelOptions = {},
): ControlPanelHandle {
  const { onChange = () => {}, worldRoot } = options;

  const panelEl = document.getElementById("control-panel") as HTMLElement | null;
  const trigger = document.getElementById("panel-trigger");
  const tabsEl = document.getElementById("panel-tabs");
  if (!panelEl || !tabsEl) {
    return { refresh() {}, destroy() {} };
  }
  // 重新固化为非空局部变量，便于 TS 在嵌套闭包里进行控制流分析。
  const panel: HTMLElement = panelEl;
  const tabs: HTMLElement = tabsEl;

  const groups = Array.from(
    document.querySelectorAll<HTMLDetailsElement>(".panel-group"),
  );

  // ---- 阻止面板内事件冒泡到底下的 PIXI 画布 ----
  const stopEvent = (event: Event) => event.stopPropagation();
  const eventsToStop = [
    "pointerdown",
    "pointermove",
    "pointerup",
    "touchstart",
    "touchmove",
    "touchend",
    "wheel",
  ] as const;
  for (const name of eventsToStop) {
    panel.addEventListener(name, stopEvent, { passive: false });
  }

  function notify(key: string, value: unknown): void {
    try {
      onChange(key, value, CONFIG);
    } catch (err) {
      console.error("[ControlPanel] onChange 抛错：", err);
    }
    recordHistory(key);
  }

  let hoverScaleCurvePanel: BezierCurvePanel | null = null;
  let dragScaleInCurvePanel: BezierCurvePanel | null = null;
  let dragScaleOutCurvePanel: BezierCurvePanel | null = null;
  let selectMoveCurvePanel: BezierCurvePanel | null = null;
  let tweenRiseCurvePanel: BezierCurvePanel | null = null;
  let tweenSpringCurvePanel: BezierCurvePanel | null = null;
  let dragRiseCurvePanel: BezierCurvePanel | null = null;
  let dragSpringCurvePanel: BezierCurvePanel | null = null;
  let bgBlockFadeCurvePanel: BezierCurvePanel | null = null;
  let bgBlockScaleCurvePanel: BezierCurvePanel | null = null;

  // 收集所有"按 CONFIG 当前值刷新自身"的回调，preset 加载后批量重跑。
  const syncers: Array<() => void> = [];

  // ---- 参数历史：撤回 / 反撤回 -------------------------------

  interface HistoryEntry {
    key: string;
    before: RuntimeConfig;
    after: RuntimeConfig;
    time: number;
  }

  const HISTORY_LIMIT = 100;
  const HISTORY_MERGE_WINDOW_MS = 1000;
  const undoStack: HistoryEntry[] = [];
  const redoStack: HistoryEntry[] = [];
  let lastHistorySnapshot = cloneConfig(CONFIG);
  let applyingHistory = false;
  let uiHistoryQueued = false;

  function configFingerprint(config: RuntimeConfig): string {
    return JSON.stringify(config);
  }

  function configsEqual(a: RuntimeConfig, b: RuntimeConfig): boolean {
    return configFingerprint(a) === configFingerprint(b);
  }

  function recordHistory(key: string): void {
    if (applyingHistory) return;

    const after = cloneConfig(CONFIG);
    if (configsEqual(lastHistorySnapshot, after)) return;

    const now = performance.now();
    const last = undoStack[undoStack.length - 1];
    if (
      last &&
      key !== "*" &&
      last.key === key &&
      now - last.time <= HISTORY_MERGE_WINDOW_MS
    ) {
      last.after = after;
      last.time = now;
    } else {
      undoStack.push({
        key,
        before: lastHistorySnapshot,
        after,
        time: now,
      });
      if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    }

    redoStack.length = 0;
    lastHistorySnapshot = after;
  }

  function applyHistorySnapshot(snapshot: RuntimeConfig, message: string): void {
    applyingHistory = true;
    try {
      applyConfig(snapshot);
      refreshAllControls();
      notify("*", CONFIG);
      lastHistorySnapshot = cloneConfig(CONFIG);
      flashMessage(message);
    } finally {
      applyingHistory = false;
    }
  }

  function undoConfigChange(): void {
    const entry = undoStack.pop();
    if (!entry) {
      flashMessage("没有可撤回的参数调整");
      return;
    }
    redoStack.push(entry);
    applyHistorySnapshot(entry.before, "已撤回参数调整");
  }

  function redoConfigChange(): void {
    const entry = redoStack.pop();
    if (!entry) {
      flashMessage("没有可反撤回的参数调整");
      return;
    }
    undoStack.push(entry);
    applyHistorySnapshot(entry.after, "已反撤回参数调整");
  }

  function setupHistoryShortcuts(): () => void {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key !== "z" && key !== "y") return;
      if (getComputedStyle(panel).display === "none") return;

      event.preventDefault();
      event.stopPropagation();
      if (key === "z") undoConfigChange();
      else redoConfigChange();
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }

  function setupHierarchyHistory(): () => void {
    return uiHierarchy.subscribe((type) => {
      if (
        type !== "componentsChanged" &&
        type !== "transformChanged" &&
        type !== "nodeReparented" &&
        type !== "nodeReordered"
      ) {
        return;
      }
      if (uiHistoryQueued) return;
      uiHistoryQueued = true;
      queueMicrotask(() => {
        uiHistoryQueued = false;
        recordHistory("uiNodes");
      });
    });
  }

  // ---- 绑定助手 ----

  /** 标记某个元素已被绑定过，避免 refreshAllControls 重复加监听。 */
  function alreadyBound(el: HTMLElement, path: string): boolean {
    if (el.dataset["panelBound"] === path) return true;
    el.dataset["panelBound"] = path;
    return false;
  }

  function bindSlider(
    inputId: string,
    valueId: string,
    path: string,
    opts: { digits?: number; parse?: (v: string) => number } = {},
  ): void {
    const input = document.getElementById(inputId) as HTMLInputElement | null;
    const valueEl = document.getElementById(valueId);
    if (!input || !valueEl) return;

    const digits = opts.digits ?? 0;
    const parse = opts.parse ?? Number;

    const sync = (): void => {
      const v = getByPath(CONFIG, path);
      if (typeof v === "number") {
        input.value = String(v);
        valueEl.textContent = formatNumber(v, digits);
      }
    };
    sync();
    if (alreadyBound(input, path)) return;
    syncers.push(sync);

    input.addEventListener("input", (event) => {
      const value = parse((event.target as HTMLInputElement).value);
      if (!Number.isFinite(value)) return;
      setByPath(CONFIG, path, value);
      valueEl.textContent = formatNumber(value, digits);
      notify(path, value);
    });
  }

  function bindNumber(
    inputId: string,
    valueId: string | null,
    path: string,
    opts: { digits?: number; clamp?: boolean; integer?: boolean } = {},
  ): void {
    const input = document.getElementById(inputId) as HTMLInputElement | null;
    const valueEl = valueId ? document.getElementById(valueId) : null;
    if (!input) return;

    const digits = opts.digits ?? (opts.integer ? 0 : 2);
    const clamp = opts.clamp ?? true;

    const sync = (): void => {
      const v = getByPath(CONFIG, path);
      if (typeof v === "number") {
        input.value = opts.integer ? String(Math.round(v)) : formatNumber(v, digits);
        if (valueEl) valueEl.textContent = formatNumber(v, digits);
      }
    };
    sync();
    if (alreadyBound(input, path)) return;
    syncers.push(sync);
    attachDragScrub(input, { digits, integer: opts.integer });

    input.addEventListener("input", (event) => {
      const raw = (event.target as HTMLInputElement).value;
      // 允许中间态：空字符串、单独的负号
      if (raw === "" || raw === "-") return;
      const value = Number(raw);
      if (!Number.isFinite(value)) return;
      setByPath(CONFIG, path, opts.integer ? Math.round(value) : value);
      if (valueEl) valueEl.textContent = formatNumber(value, digits);
      notify(path, value);
    });

    const finalize = (): void => {
      let value = Number(input.value);
      if (!Number.isFinite(value)) {
        const fallback = getByPath(DEFAULT_CONFIG, path);
        value = typeof fallback === "number" ? fallback : 0;
      }
      if (clamp) {
        if (input.hasAttribute("min")) {
          const min = Number(input.min);
          if (Number.isFinite(min)) value = Math.max(min, value);
        }
        if (input.hasAttribute("max")) {
          const max = Number(input.max);
          if (Number.isFinite(max)) value = Math.min(max, value);
        }
      }
      if (opts.integer) value = Math.round(value);
      setByPath(CONFIG, path, value);
      input.value = opts.integer ? String(value) : formatNumber(value, digits);
      if (valueEl) valueEl.textContent = formatNumber(value, digits);
      notify(path, value);
    };
    input.addEventListener("change", finalize);
    input.addEventListener("blur", finalize);
  }

  function bindToggle(
    inputId: string,
    valueId: string,
    path: string,
    labels: [string, string] = ["关", "开"],
  ): void {
    const input = document.getElementById(inputId) as HTMLInputElement | null;
    const valueEl = document.getElementById(valueId);
    if (!input || !valueEl) return;

    const sync = (): void => {
      const v = !!getByPath(CONFIG, path);
      input.checked = v;
      valueEl.textContent = v ? labels[1] : labels[0];
    };
    sync();
    if (alreadyBound(input, path)) return;
    syncers.push(sync);

    input.addEventListener("change", () => {
      setByPath(CONFIG, path, input.checked);
      valueEl.textContent = input.checked ? labels[1] : labels[0];
      notify(path, input.checked);
    });
  }

  function bindSectionExpand(
    inputId: string,
    valueId: string,
    path: string,
    containerId: string,
  ): void {
    bindToggle(inputId, valueId, path, ["收起", "展开"]);
    const input = document.getElementById(inputId) as HTMLInputElement | null;
    const container = document.getElementById(containerId);
    if (!input || !container) return;

    const updateVisibility = () => {
      container.style.display = input.checked ? "" : "none";
    };

    input.addEventListener("change", updateVisibility);
    syncers.push(updateVisibility);
    updateVisibility();
  }

  function bindColor(inputId: string, valueId: string, path: string): void {
    const input = document.getElementById(inputId) as HTMLInputElement | null;
    const valueEl = document.getElementById(valueId);
    if (!input || !valueEl) return;

    const sync = (): void => {
      const v = getByPath(CONFIG, path);
      if (typeof v === "number") {
        const hex = numberToHexColor(v);
        input.value = hex;
        valueEl.textContent = hex;
      }
    };
    sync();
    if (alreadyBound(input, path)) return;
    syncers.push(sync);

    input.addEventListener("input", () => {
      const num = hexColorToNumber(input.value);
      setByPath(CONFIG, path, num);
      valueEl.textContent = input.value;
      notify(path, num);
    });
  }

  function bindCycleButton<T>(
    buttonId: string,
    valueId: string,
    path: string,
    choices: Array<{ value: T; label: string }>,
  ): void {
    const button = document.getElementById(buttonId) as HTMLButtonElement | null;
    const valueEl = document.getElementById(valueId);
    if (!button || !valueEl || choices.length === 0) return;

    const sync = (): void => {
      const v = getByPath(CONFIG, path) as T;
      const cur = choices.find((c) => c.value === v) ?? choices[0]!;
      valueEl.textContent = cur.label;
    };
    sync();
    if (alreadyBound(button, path)) return;
    syncers.push(sync);

    button.addEventListener("click", () => {
      const v = getByPath(CONFIG, path) as T;
      const idx = Math.max(
        0,
        choices.findIndex((c) => c.value === v),
      );
      const next = choices[(idx + 1) % choices.length]!;
      setByPath(CONFIG, path, next.value);
      valueEl.textContent = next.label;
      notify(path, next.value);
    });
  }

  /**
   * 牌背选择器：渲染一个 rows×cols 的网格，每个格子用 Enhancers.png 整图当背景，
   * 通过 background-position 让每个按钮精确显示一个子图。
   * 点击即写入 CONFIG.cardArt.back 并触发 onChange。
   */
  function bindCardBackPicker(containerId: string, valueLabelId: string): void {
    const container = document.getElementById(containerId) as HTMLElement | null;
    const valueEl = document.getElementById(valueLabelId);
    if (!container) return;

    const { rows, cols } = CardAtlas.back;
    container.style.setProperty("--cb-cols", String(cols));
    container.style.setProperty("--cb-rows", String(rows));
    // 用单引号包裹 url，规避 hash 文件名里偶尔出现的特殊字符
    container.style.setProperty("--cb-image", `url('${assets.backSrc}')`);

    // 仅初始化一次：建格子；之后 sync 只更新 is-active 与 label。
    const buildOnce = (): void => {
      if (container.dataset["built"] === "1") return;
      container.dataset["built"] = "1";
      container.innerHTML = "";

      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "card-back-cell";
          btn.dataset["row"] = String(r);
          btn.dataset["col"] = String(c);
          // 把整图作为背景，用负偏移把对应格子推到可视区。
          // 每个格子的宽高都由 CSS 变量给出 → 这里只算偏移量。
          btn.style.backgroundPosition = `calc(var(--cb-cell-w) * -${c}) calc(var(--cb-cell-h) * -${r})`;
          btn.title = `行 ${r + 1} · 列 ${c + 1}`;
          btn.addEventListener("click", () => {
            setByPath(CONFIG, "cardArt.back.row", r);
            setByPath(CONFIG, "cardArt.back.col", c);
            sync();
            notify("cardArt.back", CONFIG.cardArt.back);
          });
          container.appendChild(btn);
        }
      }
    };

    const sync = (): void => {
      buildOnce();
      const { row, col } = CONFIG.cardArt.back;
      container.querySelectorAll<HTMLButtonElement>(".card-back-cell").forEach((btn) => {
        const br = Number(btn.dataset["row"]);
        const bc = Number(btn.dataset["col"]);
        btn.classList.toggle("is-active", br === row && bc === col);
      });
      if (valueEl) valueEl.textContent = `行 ${row + 1} · 列 ${col + 1}`;
    };

    sync();
    syncers.push(sync);
  }

  // ---- Tab 生成 ----

  function setupTabs(): void {
    const setActiveGroup = (active: HTMLDetailsElement): void => {
      groups.forEach((g) => {
        g.open = g === active;
      });
      tabs.querySelectorAll<HTMLButtonElement>(".panel-tab").forEach((tab) => {
        tab.classList.toggle("is-active", tab.dataset.target === active.dataset.panelKey);
      });
      active.scrollIntoView({ block: "nearest" });
    };

    tabs.innerHTML = "";
    groups.forEach((group, index) => {
      const summary = group.querySelector("summary");
      const label = summary?.textContent?.trim() || `分组 ${index + 1}`;
      const key = `panel-group-${index}`;
      group.dataset.panelKey = key;

      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "panel-tab";
      tab.dataset.target = key;
      tab.textContent = label;
      tab.addEventListener("click", () => setActiveGroup(group));
      tabs.appendChild(tab);
    });

    const initial = groups.find((g) => g.open) ?? groups[0];
    if (initial) setActiveGroup(initial);
  }

  // ---- 隐藏触发器：3 击呼出 ----

  function setupHiddenTrigger(): void {
    const hideButton = document.getElementById("toggle-panel");
    hideButton?.addEventListener("click", () => {
      panel.style.display = "none";
    });

    if (!trigger) return;

    let tapCount = 0;
    let tapTimer: number | null = null;
    const tapWindowMs = 600;
    const requiredTaps = 3;

    const reset = (): void => {
      tapCount = 0;
      if (tapTimer !== null) {
        window.clearTimeout(tapTimer);
        tapTimer = null;
      }
      trigger.classList.remove("is-hit");
    };

    const hit = (): void => {
      tapCount += 1;
      trigger.classList.add("is-hit");
      window.setTimeout(() => trigger.classList.remove("is-hit"), 120);
      if (tapTimer !== null) window.clearTimeout(tapTimer);
      tapTimer = window.setTimeout(reset, tapWindowMs);
      if (tapCount >= requiredTaps) {
        reset();
        panel.style.display = "flex";
        clampPanelToViewport();
      }
    };

    trigger.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      hit();
    });

    trigger.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        hit();
      }
    });
  }

  // ---- 面板拖动 ----

  let dragState: {
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startLeft: number;
    startTop: number;
    nextLeft: number;
    nextTop: number;
    width: number;
    height: number;
    frameId: number | null;
  } | null = null;
  let dragHeader: HTMLElement | null = null;

  function schedulePanelMove(): void {
    if (!dragState) return;
    if (dragState.frameId !== null) return;

    dragState.frameId = window.requestAnimationFrame(() => {
      if (!dragState) return;
      dragState.frameId = null;
      const x = dragState.nextLeft - dragState.startLeft;
      const y = dragState.nextTop - dragState.startTop;
      panel.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    });
  }

  function clampPanelToViewport(): void {
    if (panel.style.display === "none") return;

    const rect = panel.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - rect.width);
    const maxTop = Math.max(0, window.innerHeight - rect.height);
    const left = Math.min(Math.max(0, rect.left), maxLeft);
    const top = Math.min(Math.max(0, rect.top), maxTop);

    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  const onPanelDragMove = (event: PointerEvent): void => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    event.preventDefault();

    const maxLeft = Math.max(0, window.innerWidth - dragState.width);
    const maxTop = Math.max(0, window.innerHeight - dragState.height);
    dragState.nextLeft = Math.min(
      Math.max(0, dragState.startLeft + event.clientX - dragState.startClientX),
      maxLeft,
    );
    dragState.nextTop = Math.min(
      Math.max(0, dragState.startTop + event.clientY - dragState.startClientY),
      maxTop,
    );
    schedulePanelMove();
  };

  const stopPanelDrag = (event?: PointerEvent): void => {
    if (!dragState) return;
    if (event && event.pointerId !== dragState.pointerId) return;

    const { pointerId, nextLeft, nextTop, frameId } = dragState;
    if (frameId !== null) window.cancelAnimationFrame(frameId);
    dragState = null;
    panel.style.left = `${nextLeft}px`;
    panel.style.top = `${nextTop}px`;
    panel.style.transform = "";
    panel.classList.remove("is-dragging");
    if (dragHeader?.hasPointerCapture?.(pointerId)) {
      dragHeader.releasePointerCapture(pointerId);
    }
  };

  const onPanelDragStart = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement | null)?.closest("button, input, select, textarea, a")) {
      return;
    }

    const rect = panel.getBoundingClientRect();
    dragState = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      nextLeft: rect.left,
      nextTop: rect.top,
      width: rect.width,
      height: rect.height,
      frameId: null,
    };
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.transform = "";
    panel.classList.add("is-dragging");
    event.preventDefault();
    dragHeader?.setPointerCapture?.(event.pointerId);
  };

  function setupPanelDrag(): void {
    const header = document.getElementById("panel-header");
    if (!header) return;

    dragHeader = header;
    header.addEventListener("pointerdown", onPanelDragStart);
    header.addEventListener("pointermove", onPanelDragMove, { passive: false });
    header.addEventListener("pointerup", stopPanelDrag);
    header.addEventListener("pointercancel", stopPanelDrag);

    window.addEventListener("resize", clampPanelToViewport);
  }

  // ---- Preset 系统 ----

  interface PresetMap {
    [name: string]: RuntimeConfig;
  }

  function getPresets(): PresetMap {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.presets);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null ? (parsed as PresetMap) : {};
    } catch (err) {
      console.error("[ControlPanel] 读取 preset 失败：", err);
      return {};
    }
  }

  function savePresets(presets: PresetMap): void {
    try {
      localStorage.setItem(STORAGE_KEYS.presets, JSON.stringify(presets));
    } catch (err) {
      console.error("[ControlPanel] 写入 preset 失败：", err);
    }
  }

  function refreshPresetList(): void {
    const select = document.getElementById("sel-preset-list") as HTMLSelectElement | null;
    if (!select) return;
    const presets = getPresets();
    const prev = select.value;
    select.innerHTML = '<option value="">-- 选择预设 --</option>';
    Object.keys(presets)
      .sort()
      .forEach((name) => {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
      });
    if (prev && presets[prev]) select.value = prev;
  }

  function setupPresets(): void {
    const nameInput = document.getElementById("inp-preset-name") as HTMLInputElement | null;
    const select = document.getElementById("sel-preset-list") as HTMLSelectElement | null;
    const importInput = document.getElementById("inp-import-preset") as HTMLInputElement | null;

    document.getElementById("btn-save-config")?.addEventListener("click", () => {
      // 主动 persist 一次，确保 hierarchy 当前最新状态被同步到 CONFIG.uiNodes
      // 再写入 localStorage，避免“某些 hierarchy 变更没及时回写 CONFIG”导致丢失。
      uiHierarchy.persist();
      saveCurrentConfig();
      flashMessage("已保存当前参数为本地默认");
    });

    document.getElementById("btn-reset-config")?.addEventListener("click", () => {
      if (!confirm("确定要恢复出厂默认参数吗？")) return;
      resetConfigToDefaults();
      refreshAllControls();
      notify("*", CONFIG);
    });

    document.getElementById("btn-export-shipping")?.addEventListener("click", () => {
      // 主动 persist 一次，确保 hierarchy 当前最新状态被同步到 CONFIG.uiNodes
      uiHierarchy.persist();
      const data = {
        type: "runtime-control-preset",
        version: CONFIG_VERSION,
        name: "shipping",
        config: cloneConfig(CONFIG),
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "shipping.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      flashMessage("已导出当前配置为 shipping.json！请放至 presets 目录下。");
    });

    document.getElementById("btn-save-preset")?.addEventListener("click", () => {
      const name = nameInput?.value.trim();
      if (!name) {
        alert("请输入预设名");
        return;
      }
      const presets = getPresets();
      presets[name] = cloneConfig(CONFIG);
      savePresets(presets);
      refreshPresetList();
      if (select) select.value = name;
      if (nameInput) nameInput.value = "";
    });

    document.getElementById("btn-load-preset")?.addEventListener("click", () => {
      const name = select?.value;
      if (!name) return;
      const preset = getPresets()[name];
      if (!preset) return;
      applyConfig(preset);
      saveCurrentConfig();
      refreshAllControls();
      notify("*", CONFIG);
    });

    document.getElementById("btn-delete-preset")?.addEventListener("click", () => {
      const name = select?.value;
      if (!name) return;
      if (!confirm(`删除预设「${name}」？`)) return;
      const presets = getPresets();
      delete presets[name];
      savePresets(presets);
      refreshPresetList();
    });

    document.getElementById("btn-export-preset")?.addEventListener("click", () => {
      const name = select?.value;
      if (!name) {
        alert("请先在下拉框选择一个预设");
        return;
      }
      const preset = getPresets()[name];
      if (!preset) return;
      const data = {
        type: "runtime-control-preset",
        version: CONFIG_VERSION,
        name,
        config: preset,
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `balatro_preset_${name.replace(/[^a-z0-9_-]/gi, "_")}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    });

    document.getElementById("btn-import-preset")?.addEventListener("click", () => {
      importInput?.click();
    });

    importInput?.addEventListener("change", (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const imported = JSON.parse(String(reader.result));
          const config =
            imported && imported.type === "runtime-control-preset"
              ? imported.config
              : imported;
          if (!config || typeof config !== "object") {
            throw new Error("Invalid preset");
          }
          const fallback = imported?.name || file.name.replace(/\.json$/i, "");
          const promptName = prompt("预设名：", fallback);
          if (promptName === null) return;
          const finalName = promptName.trim() || fallback;
          const presets = getPresets();
          presets[finalName] = config as RuntimeConfig;
          savePresets(presets);
          refreshPresetList();
          if (select) select.value = finalName;
        } catch (err) {
          console.error("[ControlPanel] 导入 preset 失败：", err);
          alert("导入失败：不是合法的 JSON 预设");
        }
      };
      reader.readAsText(file);
      (event.target as HTMLInputElement).value = "";
    });

    refreshPresetList();
  }

  // ---- 简易提示 ----
  let flashTimer: number | null = null;
  function flashMessage(msg: string): void {
    let el = document.getElementById("panel-flash");
    if (!el) {
      el = document.createElement("div");
      el.id = "panel-flash";
      el.style.cssText =
        "position:absolute;left:12px;right:12px;bottom:8px;padding:6px 10px;border-radius:6px;background:rgba(145,197,58,0.2);color:#cbe88b;font-size:11px;text-align:center;pointer-events:none;";
      panel.appendChild(el);
    }
    el.textContent = msg;
    el.style.display = "block";
    if (flashTimer !== null) window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => {
      if (el) el.style.display = "none";
    }, 1500);
  }

  // ---- 应用面板透明度 ----
  // 即使 HTML 没暴露 panelOpacity slider，也要在启动时把 CSS 变量初始化一次，
  // 保证 preset 里带的 panelOpacity 能立刻生效。
  function applyPanelOpacity(): void {
    const v = Math.max(0.1, Math.min(1, CONFIG.debug.panelOpacity));
    document.documentElement.style.setProperty("--panel-opacity", String(v));
  }

  /**
   * 把所有控件按当前 CONFIG 重新同步一次。
   *
   * 目前面板按"存档专项 / 牌的绘制 / 界面UI / 卡牌逻辑 / 卡牌视效 / 文字视效"
   * 分类骨架先行，业务控件留空。日后在 HTML 里加 .panel-row 之后，把
   * bindSlider / bindNumber / bindToggle / bindColor / bindCycleButton
   * 的对应调用放到这里即可（找不到 DOM 会直接 return，安全）。
   */
  function refreshAllControls(): void {
    // 例：未来加规则参数时，把下面这种调用补回来：
    //   bindSlider("inp-handSize", "val-handSize", "rules.handSize", { digits: 0 });
    //   bindNumber("inp-targetScore", "val-targetScore", "rules.targetScore", { integer: true });
    //   bindColor("inp-backgroundColor", "val-backgroundColor", "world.backgroundColor");
    //   bindCycleButton("btn-quality", "val-quality", "debug.quality", [...]);
    applyPanelOpacity();

    // === 基础参数 ===
    bindToggle("inp-unlimitedActions", "val-unlimitedActions", "rules.unlimitedActions");

    // === 牌的绘制 / 单牌样式 ===
    bindToggle("inp-useSprites", "val-useSprites", "cardArt.useSprites");
    bindNumber("inp-cardCornerRadius", "val-cardCornerRadius", "cardArt.cornerRadius", { digits: 1 });
    bindColor("inp-faceColor", "val-faceColor", "cardArt.faceColor");
    bindColor("inp-outlineColor", "val-outlineColor", "cardArt.outlineColor");
    bindCardBackPicker("card-back-picker", "val-cardBack");

    // === 牌的绘制 / 手牌摆放 ===
    bindNumber("inp-cardSpacing", "val-cardSpacing", "handLayout.cardSpacing", { digits: 1 });
    bindToggle("inp-arcEnabled", "val-arcEnabled", "handLayout.arcEnabled");
    bindNumber("inp-arcHeight", "val-arcHeight", "handLayout.arcHeight", { digits: 1 });
    bindNumber("inp-fanAnglePerCardDeg", "val-fanAnglePerCardDeg", "handLayout.fanAnglePerCardDeg", { digits: 2 });

    // === 卡牌视效 ===
    bindSectionExpand("inp-expandShadow", "val-expandShadow", "cardVisuals.expandedSections.shadow", "sect-shadow-params");
    bindColor("inp-shadowColor", "val-shadowColor", "cardShadow.color");
    bindNumber("inp-shadowAlpha", "val-shadowAlpha", "cardShadow.alpha", { digits: 2 });
    bindNumber("inp-shadowLightX", "val-shadowLightX", "cardShadow.lightX", { digits: 1 });
    bindNumber("inp-shadowLightY", "val-shadowLightY", "cardShadow.lightY", { digits: 1 });
    bindNumber("inp-shadowDistanceRatio", "val-shadowDistanceRatio", "cardShadow.distanceRatio", { digits: 5 });
    bindNumber("inp-shadowScaleRatio", "val-shadowScaleRatio", "cardShadow.scaleRatio", { digits: 2 });

    bindSectionExpand("inp-expandDragShadow", "val-expandDragShadow", "cardVisuals.expandedSections.dragShadow", "sect-dragShadow-params");
    bindColor("inp-dragShadowColor", "val-dragShadowColor", "dragShadow.color");
    bindNumber("inp-dragShadowAlpha", "val-dragShadowAlpha", "dragShadow.alpha", { digits: 2 });
    bindNumber("inp-dragShadowLightX", "val-dragShadowLightX", "dragShadow.lightX", { digits: 1 });
    bindNumber("inp-dragShadowLightY", "val-dragShadowLightY", "dragShadow.lightY", { digits: 1 });
    bindNumber("inp-dragShadowDistanceRatio", "val-dragShadowDistanceRatio", "dragShadow.distanceRatio", { digits: 5 });
    bindNumber("inp-dragShadowScaleRatio", "val-dragShadowScaleRatio", "dragShadow.scaleRatio", { digits: 2 });

    // === 新增卡牌视效与逻辑参数 ===
    bindSectionExpand("inp-expandBreathing", "val-expandBreathing", "cardVisuals.expandedSections.breathing", "sect-breathing-params");
    bindToggle("inp-breathingEnabled", "val-breathingEnabled", "cardVisuals.breathingEnabled");
    bindNumber("inp-breathingSpeed", "val-breathingSpeed", "cardVisuals.breathingSpeed", { digits: 4 });
    bindNumber("inp-breathingAmplitude", "val-breathingAmplitude", "cardVisuals.breathingAmplitude", { digits: 1 });
    bindNumber("inp-wobbleSpeed", "val-wobbleSpeed", "cardVisuals.wobbleSpeed", { digits: 4 });
    bindNumber("inp-wobbleAmplitude", "val-wobbleAmplitude", "cardVisuals.wobbleAmplitude", { digits: 3 });

    // 常态伪3D倾斜呼吸晃动（与 mouse3DTilt 共用投影模型，由时间驱动的虚拟鼠标产生倾斜，
    // 真实鼠标悬停时该效果自动让位）
    bindSectionExpand("inp-expandIdleTilt", "val-expandIdleTilt", "cardVisuals.expandedSections.idleTilt", "sect-idleTilt-params");
    bindToggle("inp-idleTiltEnabled", "val-idleTiltEnabled", "cardVisuals.idleTiltEnabled");
    bindNumber("inp-idleTiltSpeed", "val-idleTiltSpeed", "cardVisuals.idleTiltSpeed", { digits: 4 });
    bindNumber("inp-idleTiltStrength", "val-idleTiltStrength", "cardVisuals.idleTiltStrength", { digits: 2 });
    bindNumber("inp-idleTiltRadius", "val-idleTiltRadius", "cardVisuals.idleTiltRadius", { digits: 2 });

    // 鼠标触碰碰撞范围（迟滞 hit area）
    bindSectionExpand("inp-expandHoverHit", "val-expandHoverHit", "cardVisuals.expandedSections.hoverHit", "sect-hoverHit-params");
    bindToggle("inp-hoverHitEnabled", "val-hoverHitEnabled", "cardVisuals.hoverHitEnabled");
    bindNumber("inp-hoverHitEnterScale", "val-hoverHitEnterScale", "cardVisuals.hoverHitEnterScale", { digits: 2 });
    bindNumber("inp-hoverHitLeaveScale", "val-hoverHitLeaveScale", "cardVisuals.hoverHitLeaveScale", { digits: 2 });

    bindSectionExpand("inp-expandHoverScale", "val-expandHoverScale", "cardVisuals.expandedSections.hoverScale", "sect-hoverScale-params");
    bindToggle("inp-hoverScaleEnabled", "val-hoverScaleEnabled", "cardVisuals.hoverScaleEnabled");
    bindNumber("inp-hoverOvershootScale", "val-hoverOvershootScale", "cardVisuals.hoverOvershootScale", { digits: 2 });
    bindNumber("inp-hoverSettleScale", "val-hoverSettleScale", "cardVisuals.hoverSettleScale", { digits: 2 });
    bindNumber("inp-hoverOvershootCount", "val-hoverOvershootCount", "cardVisuals.hoverOvershootCount", { integer: true });
    bindNumber("inp-hoverOvershootDamping", "val-hoverOvershootDamping", "cardVisuals.hoverOvershootDamping", { digits: 2 });
    bindNumber("inp-hoverScaleDurationMS", "val-hoverScaleDurationMS", "cardVisuals.hoverScaleDurationMS", { integer: true });
    bindNumber("inp-hoverScaleOutDurationMS", "val-hoverScaleOutDurationMS", "cardVisuals.hoverScaleOutDurationMS", { integer: true });
    bindNumber("inp-hoverScaleOutOvershootCount", "val-hoverScaleOutOvershootCount", "cardVisuals.hoverScaleOutOvershootCount", { integer: true });
    bindNumber("inp-hoverScaleOutOvershootFirstScale", "val-hoverScaleOutOvershootFirstScale", "cardVisuals.hoverScaleOutOvershootFirstScale", { digits: 2 });
    bindNumber("inp-hoverScaleOutOvershootDamping", "val-hoverScaleOutOvershootDamping", "cardVisuals.hoverScaleOutOvershootDamping", { digits: 2 });
    bindNumber("inp-hoverScaleOutSpeed", "val-hoverScaleOutSpeed", "cardVisuals.hoverScaleOutSpeed", { digits: 2 });

    // === 曲线面板 ===
    const hoverScaleCurveMount = document.getElementById("mount-hoverScaleCurve");
    if (hoverScaleCurveMount && !hoverScaleCurvePanel) {
      hoverScaleCurvePanel = buildCurvePanel(hoverScaleCurveMount, CONFIG.cardVisuals.hoverScaleCurve, {
        label: "悬停弹性缩放曲线",
        onChange: () => {
          notify("cardVisuals.hoverScaleCurve", CONFIG.cardVisuals.hoverScaleCurve);
        }
      });

      syncers.push(() => {
        if (hoverScaleCurvePanel) {
          hoverScaleCurvePanel.setCurve(CONFIG.cardVisuals.hoverScaleCurve);
        }
      });
    }

    // 鼠标呼吸晃动（触碰与回落）：独立于常态呼吸晃动，叠加应用。
    // 触发时机：(1) 鼠标 pointerover 进入卡牌；(2) 卡牌拖拽缩放退出动画完成（完全回落到 1.0）。
    bindSectionExpand("inp-expandHoverBreathing", "val-expandHoverBreathing", "cardVisuals.expandedSections.hoverBreathing", "sect-hoverBreathing-params");
    bindToggle("inp-hoverBreathingEnabled", "val-hoverBreathingEnabled", "cardVisuals.hoverBreathingEnabled");
    bindNumber("inp-hoverBreathingDurationMS", "val-hoverBreathingDurationMS", "cardVisuals.hoverBreathingDurationMS", { integer: true });
    bindNumber("inp-hoverBreathingSpeed", "val-hoverBreathingSpeed", "cardVisuals.hoverBreathingSpeed", { digits: 4 });
    bindNumber("inp-hoverBreathingAmplitude", "val-hoverBreathingAmplitude", "cardVisuals.hoverBreathingAmplitude", { digits: 1 });
    bindNumber("inp-hoverWobbleSpeed", "val-hoverWobbleSpeed", "cardVisuals.hoverWobbleSpeed", { digits: 4 });
    bindNumber("inp-hoverWobbleAmplitude", "val-hoverWobbleAmplitude", "cardVisuals.hoverWobbleAmplitude", { digits: 3 });
    bindNumber("inp-hoverBreathingSpeedDecay", "val-hoverBreathingSpeedDecay", "cardVisuals.hoverBreathingSpeedDecay", { digits: 2 });
    bindNumber("inp-hoverBreathingAmplitudeDecay", "val-hoverBreathingAmplitudeDecay", "cardVisuals.hoverBreathingAmplitudeDecay", { digits: 2 });

    bindSectionExpand("inp-expandMouse3DTilt", "val-expandMouse3DTilt", "cardVisuals.expandedSections.mouse3DTilt", "sect-mouse3DTilt-params");
    bindToggle("inp-mouse3DTiltEnabled", "val-mouse3DTiltEnabled", "cardVisuals.mouse3DTiltEnabled");
    bindNumber("inp-mouse3DTiltStrength", "val-mouse3DTiltStrength", "cardVisuals.mouse3DTiltStrength", { digits: 1 });
    bindToggle("inp-mouse3DTiltGradientEnabled", "val-mouse3DTiltGradientEnabled", "cardVisuals.mouse3DTiltGradientEnabled");
    bindNumber("inp-mouse3DTiltStrengthLeftMul", "val-mouse3DTiltStrengthLeftMul", "cardVisuals.mouse3DTiltStrengthLeftMul", { digits: 2 });
    bindNumber("inp-mouse3DTiltStrengthRightMul", "val-mouse3DTiltStrengthRightMul", "cardVisuals.mouse3DTiltStrengthRightMul", { digits: 2 });
    bindToggle("inp-mouse3DTiltInvertTL", "val-mouse3DTiltInvertTL", "cardVisuals.mouse3DTiltInvertTL");
    bindToggle("inp-mouse3DTiltInvertTR", "val-mouse3DTiltInvertTR", "cardVisuals.mouse3DTiltInvertTR");
    bindToggle("inp-mouse3DTiltInvertBL", "val-mouse3DTiltInvertBL", "cardVisuals.mouse3DTiltInvertBL");
    bindToggle("inp-mouse3DTiltInvertBR", "val-mouse3DTiltInvertBR", "cardVisuals.mouse3DTiltInvertBR");
    bindToggle("inp-mouse3DTiltSmoothEnabled", "val-mouse3DTiltSmoothEnabled", "cardVisuals.mouse3DTiltSmoothEnabled");
    bindNumber("inp-mouse3DTiltSmoothing", "val-mouse3DTiltSmoothing", "cardVisuals.mouse3DTiltSmoothing", { digits: 2 });

    // === 卡牌操作逻辑 ===
    bindSectionExpand("inp-expandCardOps", "val-expandCardOps", "cardVisuals.expandedSections.cardOps", "sect-cardOps-params");
    bindNumber("inp-clickThresholdMS", "val-clickThresholdMS", "cardVisuals.clickThresholdMS", { integer: true });
    bindNumber("inp-clickDistanceThreshold", "val-clickDistanceThreshold", "cardVisuals.clickDistanceThreshold", { integer: true });

    // === 选中与取消卡牌的位移效果 ===
    bindSectionExpand("inp-expandSelectMove", "val-expandSelectMove", "cardVisuals.expandedSections.selectMove", "sect-selectMove-params");
    bindToggle("inp-selectMoveEnabled", "val-selectMoveEnabled", "cardVisuals.selectMoveEnabled");
    bindNumber("inp-selectRiseY", "val-selectRiseY", "cardVisuals.selectRiseY", { digits: 1 });
    bindNumber("inp-selectMoveDurationMS", "val-selectMoveDurationMS", "cardVisuals.selectMoveDurationMS", { integer: true });
    bindNumber("inp-selectMoveOvershoot", "val-selectMoveOvershoot", "cardVisuals.selectMoveOvershoot", { digits: 1 });
    bindNumber("inp-selectMoveStiffness", "val-selectMoveStiffness", "cardVisuals.selectMoveStiffness", { digits: 2 });

    const selectMoveCurveMount = document.getElementById("mount-selectMoveCurve");
    if (selectMoveCurveMount && !selectMoveCurvePanel) {
      selectMoveCurvePanel = buildCurvePanel(selectMoveCurveMount, CONFIG.cardVisuals.selectMoveCurve, {
        label: "选中位移速率曲线",
        onChange: () => {
          notify("cardVisuals.selectMoveCurve", CONFIG.cardVisuals.selectMoveCurve);
        }
      });

      syncers.push(() => {
        if (selectMoveCurvePanel) {
          selectMoveCurvePanel.setCurve(CONFIG.cardVisuals.selectMoveCurve);
        }
      });
    }

    bindSectionExpand("inp-expandDragHandCard", "val-expandDragHandCard", "cardVisuals.expandedSections.dragHandCard", "sect-dragHandCard-params");
    bindNumber("inp-dragMaxSpeed", "val-dragMaxSpeed", "dragHandCard.maxSpeed", { integer: true });
    bindNumber("inp-dragLerpFactor", "val-dragLerpFactor", "dragHandCard.lerpFactor", { digits: 2 });
    bindNumber("inp-dragScaleTarget", "val-dragScaleTarget", "dragHandCard.dragScaleTarget", { digits: 2 });
    bindNumber("inp-dragScaleInDurationMS", "val-dragScaleInDurationMS", "dragHandCard.dragScaleInDurationMS", { integer: true });
    bindNumber("inp-dragScaleOutDurationMS", "val-dragScaleOutDurationMS", "dragHandCard.dragScaleOutDurationMS", { integer: true });

    const dragScaleInCurveMount = document.getElementById("mount-dragScaleInCurve");
    if (dragScaleInCurveMount && !dragScaleInCurvePanel) {
      dragScaleInCurvePanel = buildCurvePanel(dragScaleInCurveMount, CONFIG.dragHandCard.dragScaleInCurve, {
        label: "进入拖拽缩放曲线",
        onChange: () => {
          notify("dragHandCard.dragScaleInCurve", CONFIG.dragHandCard.dragScaleInCurve);
        }
      });

      syncers.push(() => {
        if (dragScaleInCurvePanel) {
          dragScaleInCurvePanel.setCurve(CONFIG.dragHandCard.dragScaleInCurve);
        }
      });
    }

    const dragScaleOutCurveMount = document.getElementById("mount-dragScaleOutCurve");
    if (dragScaleOutCurveMount && !dragScaleOutCurvePanel) {
      dragScaleOutCurvePanel = buildCurvePanel(dragScaleOutCurveMount, CONFIG.dragHandCard.dragScaleOutCurve, {
        label: "退出拖拽缩放曲线",
        onChange: () => {
          notify("dragHandCard.dragScaleOutCurve", CONFIG.dragHandCard.dragScaleOutCurve);
        }
      });

      syncers.push(() => {
        if (dragScaleOutCurvePanel) {
          dragScaleOutCurvePanel.setCurve(CONFIG.dragHandCard.dragScaleOutCurve);
        }
      });
    }

    // === 【抓牌】抓牌相关参数 ===
    bindSectionExpand("inp-expandDrawCard", "val-expandDrawCard", "cardVisuals.expandedSections.drawCard", "sect-drawCard-params");
    bindNumber("inp-lastCardAdvanceMS", "val-lastCardAdvanceMS", "drawCard.lastCardAdvanceMS", { integer: true });

    // === 卡牌换位（手动理牌）===
    // 让位牌走 CardFx.swapMove（rise → 过冲 → spring）。与 cardOvershoot 完全独立，
    // 因为换位距离固定 ≈ cardSpacing，无需距离/速度自适应。
    bindSectionExpand("inp-expandHandSwap", "val-expandHandSwap", "cardVisuals.expandedSections.handSwap", "sect-handSwap-params");
    bindToggle("inp-handSwapEnabled", "val-handSwapEnabled", "handSwap.enabled");
    bindNumber("inp-handSwapRiseDurationMS", "val-handSwapRiseDurationMS", "handSwap.riseDurationMS", { integer: true });
    bindNumber("inp-handSwapSpringDurationMS", "val-handSwapSpringDurationMS", "handSwap.springDurationMS", { integer: true });
    bindNumber("inp-handSwapOvershootPx", "val-handSwapOvershootPx", "handSwap.overshootPx", { digits: 1 });

    // === 【出牌】手牌换位 ===
    bindSectionExpand("inp-expandPlayHandSwap", "val-expandPlayHandSwap", "cardVisuals.expandedSections.playHandSwap", "sect-playHandSwap-params");
    bindToggle("inp-playHandSwapEnabled", "val-playHandSwapEnabled", "playHandSwap.enabled");
    bindNumber("inp-playHandSwapRiseDurationMS", "val-playHandSwapRiseDurationMS", "playHandSwap.riseDurationMS", { integer: true });
    bindNumber("inp-playHandSwapSpringDurationMS", "val-playHandSwapSpringDurationMS", "playHandSwap.springDurationMS", { integer: true });
    bindNumber("inp-playHandSwapOvershootPx", "val-playHandSwapOvershootPx", "playHandSwap.overshootPx", { digits: 1 });

    // === 【出牌】出牌堆的位移 ===
    bindSectionExpand("inp-expandPlayPileDisplacement", "val-expandPlayPileDisplacement", "cardVisuals.expandedSections.playPileDisplacement", "sect-playPileDisplacement-params");
    bindToggle("inp-playPileDisplacementEnabled", "val-playPileDisplacementEnabled", "playPileDisplacement.enabled");
    bindNumber("inp-playPileDisplacementCardSpacing", "val-playPileDisplacementCardSpacing", "playPileDisplacement.cardSpacing", { integer: true });
    bindNumber("inp-playPileDisplacementRiseDurationMS", "val-playPileDisplacementRiseDurationMS", "playPileDisplacement.riseDurationMS", { integer: true });
    bindNumber("inp-playPileDisplacementSpringDurationMS", "val-playPileDisplacementSpringDurationMS", "playPileDisplacement.springDurationMS", { integer: true });
    bindNumber("inp-playPileDisplacementOvershootPx", "val-playPileDisplacementOvershootPx", "playPileDisplacement.overshootPx", { digits: 1 });
    bindNumber("inp-playPileDisplacementFirstIntervalMS", "val-playPileDisplacementFirstIntervalMS", "playPileDisplacement.firstIntervalMS", { integer: true });
    bindNumber("inp-playPileDisplacementIntervalReductionMS", "val-playPileDisplacementIntervalReductionMS", "playPileDisplacement.intervalReductionMS", { integer: true });
    bindNumber("inp-playPileDisplacementLastIntervalMS", "val-playPileDisplacementLastIntervalMS", "playPileDisplacement.lastIntervalMS", { integer: true });

    // === 【出牌】出牌移动控制 ===
    bindSectionExpand("inp-expandPlayCardMove", "val-expandPlayCardMove", "cardVisuals.expandedSections.playCardMove", "sect-playCardMove-params");
    bindToggle("inp-playCardMoveEnabled", "val-playCardMoveEnabled", "playCardMove.enabled");
    bindNumber("inp-playCardMoveOvershoot1Px", "val-playCardMoveOvershoot1Px", "playCardMove.overshoot1Px", { digits: 1 });
    bindNumber("inp-playCardMoveOvershoot2Px", "val-playCardMoveOvershoot2Px", "playCardMove.overshoot2Px", { digits: 1 });
    bindNumber("inp-playCardMoveStiffness", "val-playCardMoveStiffness", "playCardMove.stiffness", { digits: 1 });

    // === 【出牌】出牌堆上移效果 ===
    bindSectionExpand("inp-expandPlayPileLiftEffect", "val-expandPlayPileLiftEffect", "cardVisuals.expandedSections.playPileLiftEffect", "sect-playPileLiftEffect-params");
    bindToggle("inp-playPileLiftEffectEnabled", "val-playPileLiftEffectEnabled", "playPileLiftEffect.enabled");
    bindNumber("inp-playPileLiftEffectStartSpeed", "val-playPileLiftEffectStartSpeed", "playPileLiftEffect.startSpeed", { integer: true });
    bindNumber("inp-playPileLiftEffectDecelerateTime", "val-playPileLiftEffectDecelerateTime", "playPileLiftEffect.decelerateTime", { digits: 2 });
    bindNumber("inp-playPileLiftEffectOvershoot", "val-playPileLiftEffectOvershoot", "playPileLiftEffect.overshoot", { digits: 1 });
    bindNumber("inp-playPileLiftEffectSpringStiffness", "val-playPileLiftEffectSpringStiffness", "playPileLiftEffect.springStiffness", { digits: 1 });
    bindNumber("inp-playPileLiftEffectInterval", "val-playPileLiftEffectInterval", "playPileLiftEffect.interval", { integer: true });
    bindNumber("inp-playPileLiftEffectDropStartSpeed", "val-playPileLiftEffectDropStartSpeed", "playPileLiftEffect.dropStartSpeed", { integer: true });
    bindNumber("inp-playPileLiftEffectDropOvershoot", "val-playPileLiftEffectDropOvershoot", "playPileLiftEffect.dropOvershoot", { digits: 1 });
    bindNumber("inp-playPileLiftEffectDropSpringStiffness", "val-playPileLiftEffectDropSpringStiffness", "playPileLiftEffect.dropSpringStiffness", { digits: 1 });
    bindColor("inp-playPileLiftEffectShadowColor", "val-playPileLiftEffectShadowColor", "playPileLiftEffect.shadowColor");
    bindNumber("inp-playPileLiftEffectShadowAlpha", "val-playPileLiftEffectShadowAlpha", "playPileLiftEffect.shadowAlpha", { digits: 2 });
    bindNumber("inp-playPileLiftEffectShadowLightX", "val-playPileLiftEffectShadowLightX", "playPileLiftEffect.shadowLightX", { digits: 1 });
    bindNumber("inp-playPileLiftEffectShadowLightY", "val-playPileLiftEffectShadowLightY", "playPileLiftEffect.shadowLightY", { digits: 1 });
    bindNumber("inp-playPileLiftEffectShadowDistanceRatio", "val-playPileLiftEffectShadowDistanceRatio", "playPileLiftEffect.shadowDistanceRatio", { digits: 5 });
    bindNumber("inp-playPileLiftEffectShadowScaleRatio", "val-playPileLiftEffectShadowScaleRatio", "playPileLiftEffect.shadowScaleRatio", { digits: 2 });

    // === 【出牌】出牌堆的结算效果 ===
    bindSectionExpand("inp-expandPlayPileSettleEffect", "val-expandPlayPileSettleEffect", "cardVisuals.expandedSections.playPileSettleEffect", "sect-playPileSettleEffect-params");
    bindToggle("inp-playPileSettleEffectEnabled", "val-playPileSettleEffectEnabled", "playPileSettleEffect.enabled");
    bindNumber("inp-playPileSettleEffectFirstIntervalMS", "val-playPileSettleEffectFirstIntervalMS", "playPileSettleEffect.firstIntervalMS", { integer: true });
    bindNumber("inp-playPileSettleEffectIntervalReductionMS", "val-playPileSettleEffectIntervalReductionMS", "playPileSettleEffect.intervalReductionMS", { integer: true });
    bindNumber("inp-playPileSettleEffectLastIntervalMS", "val-playPileSettleEffectLastIntervalMS", "playPileSettleEffect.lastIntervalMS", { integer: true });
    bindNumber("inp-playPileSettleEffectS1", "val-playPileSettleEffectS1", "playPileSettleEffect.s1", { digits: 2 });
    bindNumber("inp-playPileSettleEffectT1", "val-playPileSettleEffectT1", "playPileSettleEffect.t1", { integer: true });
    bindNumber("inp-playPileSettleEffectS2", "val-playPileSettleEffectS2", "playPileSettleEffect.s2", { digits: 2 });
    bindNumber("inp-playPileSettleEffectT2", "val-playPileSettleEffectT2", "playPileSettleEffect.t2", { integer: true });
    bindNumber("inp-playPileSettleEffectS3", "val-playPileSettleEffectS3", "playPileSettleEffect.s3", { digits: 2 });
    bindNumber("inp-playPileSettleEffectT3", "val-playPileSettleEffectT3", "playPileSettleEffect.t3", { integer: true });
    bindNumber("inp-playPileSettleEffectS4", "val-playPileSettleEffectS4", "playPileSettleEffect.s4", { digits: 2 });
    bindNumber("inp-playPileSettleEffectT4", "val-playPileSettleEffectT4", "playPileSettleEffect.t4", { integer: true });
    bindNumber("inp-playPileSettleEffectS5", "val-playPileSettleEffectS5", "playPileSettleEffect.s5", { digits: 2 });
    bindNumber("inp-playPileSettleEffectT5", "val-playPileSettleEffectT5", "playPileSettleEffect.t5", { integer: true });
    bindNumber("inp-playPileSettleEffectR1", "val-playPileSettleEffectR1", "playPileSettleEffect.r1", { digits: 2 });
    bindNumber("inp-playPileSettleEffectR2", "val-playPileSettleEffectR2", "playPileSettleEffect.r2", { digits: 2 });
    bindNumber("inp-playPileSettleEffectR3", "val-playPileSettleEffectR3", "playPileSettleEffect.r3", { digits: 2 });
    bindNumber("inp-playPileSettleEffectR4", "val-playPileSettleEffectR4", "playPileSettleEffect.r4", { digits: 2 });

    // 卡牌移动旋转（velocity-based tilt）：与 dragHandCard 同属"卡牌逻辑"专区。
    bindSectionExpand("inp-expandCardMoveRotation", "val-expandCardMoveRotation", "cardVisuals.expandedSections.cardMoveRotation", "sect-cardMoveRotation-params");
    bindToggle("inp-cardMoveRotationEnabled", "val-cardMoveRotationEnabled", "cardMoveRotation.enabled");
    bindToggle("inp-cardMoveRotationShowPivot", "val-cardMoveRotationShowPivot", "cardMoveRotation.showPivot");
    bindNumber("inp-cardMoveRotationPivotX", "val-cardMoveRotationPivotX", "cardMoveRotation.pivotOffsetX", { integer: true });
    bindNumber("inp-cardMoveRotationPivotY", "val-cardMoveRotationPivotY", "cardMoveRotation.pivotOffsetY", { integer: true });
    bindNumber("inp-cardMoveRotationPerSpeed", "val-cardMoveRotationPerSpeed", "cardMoveRotation.rotationPerSpeed", { digits: 3 });

    // 最大旋转角是派生量（dragHandCard.maxSpeed × cardMoveRotation.rotationPerSpeed / 1000），
    // input 在 HTML 中已经标了 readonly+disabled，所以这里不挂 change 监听，
    // 只做"只读 sync"。两条更新路径：
    //   (a) 挂在 syncers 里 —— refreshAllControls / preset 加载 / 撤回反撤回 时触发；
    //   (b) 在两个上游 input（追踪速度上限、单位速度→旋转角系数）上各加一个 input/change
    //       监听，用户实时拖动时也能让派生值跟着变（普通 bindNumber 的 input 事件只
    //       notify、不触发 syncers，所以必须手动挂）。
    //
    //   防重复：用独立的 dataset 键 derivedMaxRotHook，不与 bindNumber 的 panelBound 冲突。
    {
      const input = document.getElementById("inp-cardMoveRotationMaxRad") as HTMLInputElement | null;
      const valueEl = document.getElementById("val-cardMoveRotationMaxRad");
      if (input && valueEl) {
        const sync = (): void => {
          const v = computeMaxRot();
          input.value = formatNumber(v, 3);
          valueEl.textContent = formatNumber(v, 3);
        };
        sync();
        if (input.dataset["derivedMaxRotHook"] !== "1") {
          input.dataset["derivedMaxRotHook"] = "1";
          syncers.push(sync);

          // 上游输入实时联动。两个上游 id：inp-dragMaxSpeed / inp-cardMoveRotationPerSpeed。
          for (const upstreamId of ["inp-dragMaxSpeed", "inp-cardMoveRotationPerSpeed"]) {
            const up = document.getElementById(upstreamId) as HTMLInputElement | null;
            if (up && up.dataset["derivedMaxRotHook"] !== "1") {
              up.dataset["derivedMaxRotHook"] = "1";
              up.addEventListener("input", sync);
              up.addEventListener("change", sync);
            }
          }
        }
      }
    }

    bindNumber("inp-cardMoveRotationFollowLerp", "val-cardMoveRotationFollowLerp", "cardMoveRotation.followLerp", { digits: 2 });
    bindNumber("inp-cardMoveRotationFriction", "val-cardMoveRotationFriction", "cardMoveRotation.friction", { digits: 2 });
    bindNumber("inp-cardMoveRotationMinSpeed", "val-cardMoveRotationMinSpeed", "cardMoveRotation.minSpeed", { digits: 3 });

    // === 卡牌过冲反弹（overshoot / spring-back）===
    bindSectionExpand("inp-expandCardOvershoot", "val-expandCardOvershoot", "cardVisuals.expandedSections.cardOvershoot", "sect-cardOvershoot-params");
    bindToggle("inp-cardOvershootEnabled", "val-cardOvershootEnabled", "cardOvershoot.enabled");
    // 组 1：归位 / 发牌
    bindNumber("inp-tweenOvershootPx", "val-tweenOvershootPx", "cardOvershoot.tweenOvershootPx", { digits: 1 });
    bindNumber("inp-tweenMinOvershootPx", "val-tweenMinOvershootPx", "cardOvershoot.tweenMinOvershootPx", { digits: 1 });
    // v2：距离驱动的过冲幅度 + 目标平均速度自适应 rise 时长
    bindNumber("inp-tweenMinOvershootDistancePx", "val-tweenMinOvershootDistancePx", "cardOvershoot.tweenMinOvershootDistancePx", { digits: 1 });
    bindNumber("inp-tweenFullOvershootDistancePx", "val-tweenFullOvershootDistancePx", "cardOvershoot.tweenFullOvershootDistancePx", { digits: 1 });
    bindNumber("inp-tweenReturnAvgSpeed", "val-tweenReturnAvgSpeed", "cardOvershoot.tweenReturnAvgSpeed", { digits: 0 });
    bindNumber("inp-tweenReturnMinMS", "val-tweenReturnMinMS", "cardOvershoot.tweenReturnMinMS", { digits: 0 });
    bindNumber("inp-tweenReturnMaxMS", "val-tweenReturnMaxMS", "cardOvershoot.tweenReturnMaxMS", { digits: 0 });
    // 兼容字段：tweenSpeedRatioThreshold 仍被组 2 急停消费；tweenRiseRatio 已弃用（仅供旧 preset 加载，不再生效）
    bindNumber("inp-tweenSpeedRatioThreshold", "val-tweenSpeedRatioThreshold", "cardOvershoot.tweenSpeedRatioThreshold", { digits: 2 });
    bindNumber("inp-tweenRiseRatio", "val-tweenRiseRatio", "cardOvershoot.tweenRiseRatio", { digits: 2 });
    bindNumber("inp-tweenSpringStiffness", "val-tweenSpringStiffness", "cardOvershoot.tweenSpringStiffness", { digits: 1 });

    const tweenRiseCurveMount = document.getElementById("mount-tweenRiseCurve");
    if (tweenRiseCurveMount && !tweenRiseCurvePanel) {
      tweenRiseCurvePanel = buildCurvePanel(tweenRiseCurveMount, CONFIG.cardOvershoot.tweenRiseCurve, {
        label: "第一段（rise）缓动曲线",
        onChange: () => {
          notify("cardOvershoot.tweenRiseCurve", CONFIG.cardOvershoot.tweenRiseCurve);
        }
      });

      syncers.push(() => {
        if (tweenRiseCurvePanel) {
          tweenRiseCurvePanel.setCurve(CONFIG.cardOvershoot.tweenRiseCurve);
        }
      });
    }

    const tweenSpringCurveMount = document.getElementById("mount-tweenSpringCurve");
    if (tweenSpringCurveMount && !tweenSpringCurvePanel) {
      tweenSpringCurvePanel = buildCurvePanel(tweenSpringCurveMount, CONFIG.cardOvershoot.tweenSpringCurve, {
        label: "第二段（spring）缓动曲线",
        onChange: () => {
          notify("cardOvershoot.tweenSpringCurve", CONFIG.cardOvershoot.tweenSpringCurve);
        }
      });

      syncers.push(() => {
        if (tweenSpringCurvePanel) {
          tweenSpringCurvePanel.setCurve(CONFIG.cardOvershoot.tweenSpringCurve);
        }
      });
    }

    // 组 2：拖拽中急停（一次性过冲，独立曲线 / 幅度 / 时长）
    bindToggle("inp-dragInertiaEnabled", "val-dragInertiaEnabled", "cardOvershoot.dragInertiaEnabled");
    bindNumber("inp-dragLowSpeedRatio", "val-dragLowSpeedRatio", "cardOvershoot.dragLowSpeedRatio", { digits: 2 });
    bindNumber("inp-dragQuietTriggerMS", "val-dragQuietTriggerMS", "cardOvershoot.dragQuietTriggerMS", { digits: 0 });
    bindNumber("inp-dragTriggerCooldownMS", "val-dragTriggerCooldownMS", "cardOvershoot.dragTriggerCooldownMS", { digits: 0 });
    bindNumber("inp-dragOvershootPx", "val-dragOvershootPx", "cardOvershoot.dragOvershootPx", { digits: 1 });
    bindNumber("inp-dragMinOvershootPx", "val-dragMinOvershootPx", "cardOvershoot.dragMinOvershootPx", { digits: 1 });
    bindNumber("inp-dragOvershootMinSpeedRatio", "val-dragOvershootMinSpeedRatio", "cardOvershoot.dragOvershootMinSpeedRatio", { digits: 2 });
    bindNumber("inp-dragRiseDurationMS", "val-dragRiseDurationMS", "cardOvershoot.dragRiseDurationMS", { digits: 0 });
    bindNumber("inp-dragSpringDurationMS", "val-dragSpringDurationMS", "cardOvershoot.dragSpringDurationMS", { digits: 0 });
    bindNumber("inp-dragCancelDistancePx", "val-dragCancelDistancePx", "cardOvershoot.dragCancelDistancePx", { digits: 1 });
    bindNumber("inp-dragPointerMaxSpeed", "val-dragPointerMaxSpeed", "cardOvershoot.dragPointerMaxSpeed", { digits: 0 });
    bindNumber("inp-dragSpeedSmoothingMS", "val-dragSpeedSmoothingMS", "cardOvershoot.dragSpeedSmoothingMS", { digits: 0 });
    bindNumber("inp-dragPeakDecayPerSec", "val-dragPeakDecayPerSec", "cardOvershoot.dragPeakDecayPerSec", { digits: 1 });

    const dragRiseCurveMount = document.getElementById("mount-dragRiseCurve");
    if (dragRiseCurveMount && !dragRiseCurvePanel) {
      dragRiseCurvePanel = buildCurvePanel(dragRiseCurveMount, CONFIG.cardOvershoot.dragRiseCurve, {
        label: "拖拽第一段（rise）缓动曲线",
        onChange: () => {
          notify("cardOvershoot.dragRiseCurve", CONFIG.cardOvershoot.dragRiseCurve);
        }
      });

      syncers.push(() => {
        if (dragRiseCurvePanel) {
          dragRiseCurvePanel.setCurve(CONFIG.cardOvershoot.dragRiseCurve);
        }
      });
    }

    const dragSpringCurveMount = document.getElementById("mount-dragSpringCurve");
    if (dragSpringCurveMount && !dragSpringCurvePanel) {
      dragSpringCurvePanel = buildCurvePanel(dragSpringCurveMount, CONFIG.cardOvershoot.dragSpringCurve, {
        label: "拖拽回弹（spring）缓动曲线",
        onChange: () => {
          notify("cardOvershoot.dragSpringCurve", CONFIG.cardOvershoot.dragSpringCurve);
        }
      });

      syncers.push(() => {
        if (dragSpringCurvePanel) {
          dragSpringCurvePanel.setCurve(CONFIG.cardOvershoot.dragSpringCurve);
        }
      });
    }

    // === 6. 文字视效专项 ===
    bindSectionExpand("inp-expandPlayPileSettleText", "val-expandPlayPileSettleText", "cardVisuals.expandedSections.playPileSettleText", "sect-playPileSettleText-params");
    bindSectionExpand("inp-expandPlayPileSettleBgBlock", "val-expandPlayPileSettleBgBlock", "cardVisuals.expandedSections.playPileSettleBgBlock", "sect-playPileSettleBgBlock-params");

    bindToggle("inp-playPileSettleTextEffectEnabled", "val-playPileSettleTextEffectEnabled", "playPileSettleTextEffect.enabled");
    bindNumber("inp-playPileSettleTextEffectFontSize", "val-playPileSettleTextEffectFontSize", "playPileSettleTextEffect.fontSize", { integer: true });
    bindNumber("inp-playPileSettleTextEffectLetterSpacing", "val-playPileSettleTextEffectLetterSpacing", "playPileSettleTextEffect.letterSpacing", { digits: 1 });
    bindColor("inp-playPileSettleTextEffectColor", "val-playPileSettleTextEffectColor", "playPileSettleTextEffect.color");
    bindNumber("inp-playPileSettleTextEffectOffsetY", "val-playPileSettleTextEffectOffsetY", "playPileSettleTextEffect.offsetY", { digits: 1 });
    
    bindNumber("inp-playPileSettleTextEffectFirstCharDelayMS", "val-playPileSettleTextEffectFirstCharDelayMS", "playPileSettleTextEffect.firstCharDelayMS", { integer: true });
    bindNumber("inp-playPileSettleTextEffectCharIntervalMS", "val-playPileSettleTextEffectCharIntervalMS", "playPileSettleTextEffect.charIntervalMS", { integer: true });
    bindNumber("inp-playPileSettleTextEffectCharIntervalReductionMS", "val-playPileSettleTextEffectCharIntervalReductionMS", "playPileSettleTextEffect.charIntervalReductionMS", { integer: true });
    
    bindNumber("inp-playPileSettleTextEffectCharScaleDurationMS", "val-playPileSettleTextEffectCharScaleDurationMS", "playPileSettleTextEffect.charScaleDurationMS", { integer: true });
    bindNumber("inp-playPileSettleTextEffectCharMaxScale", "val-playPileSettleTextEffectCharMaxScale", "playPileSettleTextEffect.charMaxScale", { digits: 2 });
    bindNumber("inp-playPileSettleTextEffectCharStableScale", "val-playPileSettleTextEffectCharStableScale", "playPileSettleTextEffect.charStableScale", { digits: 2 });
    
    bindNumber("inp-playPileSettleTextEffectSwingPivotY", "val-playPileSettleTextEffectSwingPivotY", "playPileSettleTextEffect.swingPivotY", { digits: 1 });
    bindNumber("inp-playPileSettleTextEffectSwingMaxAngleDeg", "val-playPileSettleTextEffectSwingMaxAngleDeg", "playPileSettleTextEffect.swingMaxAngleDeg", { digits: 1 });
    bindNumber("inp-playPileSettleTextEffectSwingFrequency", "val-playPileSettleTextEffectSwingFrequency", "playPileSettleTextEffect.swingFrequency", { digits: 2 });
    bindNumber("inp-playPileSettleTextEffectSwingDamping", "val-playPileSettleTextEffectSwingDamping", "playPileSettleTextEffect.swingDamping", { digits: 2 });
    bindNumber("inp-playPileSettleTextEffectSwingDurationMS", "val-playPileSettleTextEffectSwingDurationMS", "playPileSettleTextEffect.swingDurationMS", { integer: true });
    
    bindNumber("inp-playPileSettleTextEffectStayDurationMS", "val-playPileSettleTextEffectStayDurationMS", "playPileSettleTextEffect.stayDurationMS", { integer: true });
    bindNumber("inp-playPileSettleTextEffectFadeDurationMS", "val-playPileSettleTextEffectFadeDurationMS", "playPileSettleTextEffect.fadeDurationMS", { integer: true });
    bindNumber("inp-playPileSettleTextEffectShrinkAnchorY", "val-playPileSettleTextEffectShrinkAnchorY", "playPileSettleTextEffect.shrinkAnchorY", { digits: 2 });
    
    bindToggle("inp-playPileSettleTextEffectShadowEnabled", "val-playPileSettleTextEffectShadowEnabled", "playPileSettleTextEffect.shadowEnabled");
    bindColor("inp-playPileSettleTextEffectShadowColor", "val-playPileSettleTextEffectShadowColor", "playPileSettleTextEffect.shadowColor");
    bindNumber("inp-playPileSettleTextEffectShadowAlpha", "val-playPileSettleTextEffectShadowAlpha", "playPileSettleTextEffect.shadowAlpha", { digits: 2 });
    bindNumber("inp-playPileSettleTextEffectShadowDistance", "val-playPileSettleTextEffectShadowDistance", "playPileSettleTextEffect.shadowDistance", { digits: 1 });
    bindNumber("inp-playPileSettleTextEffectShadowAngleDeg", "val-playPileSettleTextEffectShadowAngleDeg", "playPileSettleTextEffect.shadowAngleDeg", { digits: 1 });
    bindNumber("inp-playPileSettleTextEffectShadowBlur", "val-playPileSettleTextEffectShadowBlur", "playPileSettleTextEffect.shadowBlur", { digits: 1 });

    bindToggle("inp-playPileSettleTextEffectBgBlockEnabled", "val-playPileSettleTextEffectBgBlockEnabled", "playPileSettleTextEffect.bgBlockEnabled");
    bindColor("inp-playPileSettleTextEffectBgBlockColor", "val-playPileSettleTextEffectBgBlockColor", "playPileSettleTextEffect.bgBlockColor");
    bindNumber("inp-playPileSettleTextEffectBgBlockInitAngleDeg", "val-playPileSettleTextEffectBgBlockInitAngleDeg", "playPileSettleTextEffect.bgBlockInitAngleDeg", { digits: 1 });
    bindNumber("inp-playPileSettleTextEffectBgBlockEndAngleDeg", "val-playPileSettleTextEffectBgBlockEndAngleDeg", "playPileSettleTextEffect.bgBlockEndAngleDeg", { digits: 1 });
    bindNumber("inp-playPileSettleTextEffectBgBlockDurationMS", "val-playPileSettleTextEffectBgBlockDurationMS", "playPileSettleTextEffect.bgBlockDurationMS", { integer: true });

    const bgBlockScaleCurveMount = document.getElementById("mount-bgBlockScaleCurve");
    if (bgBlockScaleCurveMount && !bgBlockScaleCurvePanel) {
      bgBlockScaleCurvePanel = buildCurvePanel(bgBlockScaleCurveMount, CONFIG.playPileSettleTextEffect.bgBlockScaleCurve, {
        label: "蓝色方块大小缩放曲线",
        onChange: () => {
          notify("playPileSettleTextEffect.bgBlockScaleCurve", CONFIG.playPileSettleTextEffect.bgBlockScaleCurve);
        }
      });

      syncers.push(() => {
        if (bgBlockScaleCurvePanel) {
          bgBlockScaleCurvePanel.setCurve(CONFIG.playPileSettleTextEffect.bgBlockScaleCurve);
        }
      });
    }

    const bgBlockFadeCurveMount = document.getElementById("mount-bgBlockFadeCurve");
    if (bgBlockFadeCurveMount && !bgBlockFadeCurvePanel) {
      bgBlockFadeCurvePanel = buildCurvePanel(bgBlockFadeCurveMount, CONFIG.playPileSettleTextEffect.bgBlockFadeCurve, {
        label: "蓝色方块透明度淡出曲线",
        onChange: () => {
          notify("playPileSettleTextEffect.bgBlockFadeCurve", CONFIG.playPileSettleTextEffect.bgBlockFadeCurve);
        }
      });

      syncers.push(() => {
        if (bgBlockFadeCurvePanel) {
          bgBlockFadeCurvePanel.setCurve(CONFIG.playPileSettleTextEffect.bgBlockFadeCurve);
        }
      });
    }

    // === 【弹弹动画】筹码数字 ===
    bindSectionExpand("inp-expandChipsBounce", "val-expandChipsBounce", "cardVisuals.expandedSections.chipsBounce", "sect-chipsBounce-params");
    bindNumber("inp-chipsBounceInitScale", "val-chipsBounceInitScale", "chipsBounce.initScale", { digits: 2 });
    bindNumber("inp-chipsBounceMaxScale", "val-chipsBounceMaxScale", "chipsBounce.maxScale", { digits: 2 });
    bindNumber("inp-chipsBounceStableScale", "val-chipsBounceStableScale", "chipsBounce.stableScale", { digits: 2 });
    bindNumber("inp-chipsBounceScanSpeed", "val-chipsBounceScanSpeed", "chipsBounce.scanSpeed", { integer: true });
    bindNumber("inp-chipsBounceScaleStrength", "val-chipsBounceScaleStrength", "chipsBounce.scaleStrength", { digits: 2 });
    bindNumber("inp-chipsBounceSpeedRatio", "val-chipsBounceSpeedRatio", "chipsBounce.speedRatio", { digits: 2 });

    // === 【弹弹动画】倍率数字 ===
    bindSectionExpand("inp-expandMultBounce", "val-expandMultBounce", "cardVisuals.expandedSections.multBounce", "sect-multBounce-params");
    bindNumber("inp-multBounceInitScale", "val-multBounceInitScale", "multBounce.initScale", { digits: 2 });
    bindNumber("inp-multBounceMaxScale", "val-multBounceMaxScale", "multBounce.maxScale", { digits: 2 });
    bindNumber("inp-multBounceStableScale", "val-multBounceStableScale", "multBounce.stableScale", { digits: 2 });
    bindNumber("inp-multBounceScanSpeed", "val-multBounceScanSpeed", "multBounce.scanSpeed", { integer: true });
    bindNumber("inp-multBounceScaleStrength", "val-multBounceScaleStrength", "multBounce.scaleStrength", { digits: 2 });
    bindNumber("inp-multBounceSpeedRatio", "val-multBounceSpeedRatio", "multBounce.speedRatio", { digits: 2 });
    bindNumber("inp-multBounceRotAngle1", "val-multBounceRotAngle1", "multBounce.rotAngle1", { digits: 2 });
    bindNumber("inp-multBounceRotAngle2", "val-multBounceRotAngle2", "multBounce.rotAngle2", { digits: 2 });
    bindNumber("inp-multBounceRotDamping", "val-multBounceRotDamping", "multBounce.rotDamping", { digits: 2 });
    bindNumber("inp-multBounceRotFreq", "val-multBounceRotFreq", "multBounce.rotFreq", { digits: 2 });

    // === 【弹弹动画】牌型文字 ===
    bindSectionExpand("inp-expandHandNameBounce", "val-expandHandNameBounce", "cardVisuals.expandedSections.handNameBounce", "sect-handNameBounce-params");
    bindNumber("inp-handNameBounceInitScale", "val-handNameBounceInitScale", "handNameBounce.initScale", { digits: 2 });
    bindNumber("inp-handNameBounceMaxScale", "val-handNameBounceMaxScale", "handNameBounce.maxScale", { digits: 2 });
    bindNumber("inp-handNameBounceStableScale", "val-handNameBounceStableScale", "handNameBounce.stableScale", { digits: 2 });
    bindNumber("inp-handNameBounceScanSpeed", "val-handNameBounceScanSpeed", "handNameBounce.scanSpeed", { integer: true });
    bindNumber("inp-handNameBounceScaleStrength", "val-handNameBounceScaleStrength", "handNameBounce.scaleStrength", { digits: 2 });
    bindNumber("inp-handNameBounceSpeedRatio", "val-handNameBounceSpeedRatio", "handNameBounce.speedRatio", { digits: 2 });

    // === 【弹弹动画】预期得分文字 ===
    bindSectionExpand("inp-expandEvalScoreBounce", "val-expandEvalScoreBounce", "cardVisuals.expandedSections.evalScoreBounce", "sect-evalScoreBounce-params");
    bindNumber("inp-evalScoreBounceInitScale", "val-evalScoreBounceInitScale", "evalScoreBounce.initScale", { digits: 2 });
    bindNumber("inp-evalScoreBounceMaxScale", "val-evalScoreBounceMaxScale", "evalScoreBounce.maxScale", { digits: 2 });
    bindNumber("inp-evalScoreBounceStableScale", "val-evalScoreBounceStableScale", "evalScoreBounce.stableScale", { digits: 2 });
    bindNumber("inp-evalScoreBounceScanSpeed", "val-evalScoreBounceScanSpeed", "evalScoreBounce.scanSpeed", { integer: true });
    bindNumber("inp-evalScoreBounceScaleStrength", "val-evalScoreBounceScaleStrength", "evalScoreBounce.scaleStrength", { digits: 2 });
    bindNumber("inp-evalScoreBounceSpeedRatio", "val-evalScoreBounceSpeedRatio", "evalScoreBounce.speedRatio", { digits: 2 });

    // === 【结算分数】预期得分文字 ===
    bindSectionExpand("inp-expandEvalScoreText", "val-expandEvalScoreText", "cardVisuals.expandedSections.evalScoreText", "sect-evalScoreText-params");
    bindNumber("inp-evalScoreTextDelayMS", "val-evalScoreTextDelayMS", "evalScoreText.delayMS", { integer: true });
    bindNumber("inp-evalScoreTextDecreaseDurationMS", "val-evalScoreTextDecreaseDurationMS", "evalScoreText.decreaseDurationMS", { integer: true });

    // 已经绑定过的控件只重跑 sync，避免重复挂监听
    syncers.forEach((fn) => fn());
  }

  // 把面板暂时未使用、但作为公共助手保留的绑定函数"标记一下"，
  // 避免 noUnusedLocals 报错。日后 HTML 加了对应 DOM 直接调用即可。
  void bindSlider;
  void bindNumber;
  void bindToggle;
  void bindColor;
  void bindCycleButton;

  // === 基础参数 / 切换模式 ===
  // 该按钮不绑定任何 CONFIG 字段，而是通过 onChange 上报一个动作型 key
  // ("action:toggleMode")，由外部（main.ts）派发到 GameController.toggleMode。
  document.getElementById("btn-toggle-mode")?.addEventListener("click", () => {
    try {
      onChange("action:toggleMode", null, CONFIG);
    } catch (err) {
      console.error("[ControlPanel] toggle mode 派发失败：", err);
    }
  });

  setupTabs();
  setupHiddenTrigger();
  setupPanelDrag();
  setupPresets();
  refreshAllControls();
  const removeHistoryShortcuts = setupHistoryShortcuts();
  const removeHierarchyHistory = setupHierarchyHistory();

  // 界面UI 分组：渲染 Hierarchy 树（依赖 worldRoot）。
  let hierarchyView: HierarchyView | null = null;
  const treeMount = document.getElementById("ui-hierarchy-tree");
  if (treeMount && worldRoot) {
    hierarchyView = new HierarchyView({ mount: treeMount, worldRoot });
  } else if (treeMount && !worldRoot) {
    treeMount.textContent = "（未注入 worldRoot，Hierarchy 视图不可用）";
  }

  return {
    refresh(): void {
      refreshAllControls();
      lastHistorySnapshot = cloneConfig(CONFIG);
    },
    destroy(): void {
      hierarchyView?.destroy();
      hoverScaleCurvePanel?.destroy();
      dragScaleInCurvePanel?.destroy();
      dragScaleOutCurvePanel?.destroy();
      selectMoveCurvePanel?.destroy();
      tweenRiseCurvePanel?.destroy();
      tweenSpringCurvePanel?.destroy();
      dragRiseCurvePanel?.destroy();
      dragSpringCurvePanel?.destroy();
      bgBlockFadeCurvePanel?.destroy();
      bgBlockScaleCurvePanel?.destroy();
      removeHistoryShortcuts();
      removeHierarchyHistory();
      for (const name of eventsToStop) {
        panel.removeEventListener(name, stopEvent);
      }
      dragHeader?.removeEventListener("pointerdown", onPanelDragStart);
      dragHeader?.removeEventListener("pointermove", onPanelDragMove);
      dragHeader?.removeEventListener("pointerup", stopPanelDrag);
      dragHeader?.removeEventListener("pointercancel", stopPanelDrag);
      window.removeEventListener("resize", clampPanelToViewport);
      stopPanelDrag();
    },
  };
}
