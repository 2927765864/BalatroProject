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
  BACKGROUND_THEMES,
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
import { UIEditModePicker } from "./UIEditModePicker";
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
    // CRT 预设会批量改 intensity/noise 等字段，需把滑条显示同步到 CONFIG。
    if (key === "world.crt.preset") {
      syncers.forEach((fn) => fn());
    }
    recordHistory(key);
  }


  let bgBlockFadeCurvePanel: BezierCurvePanel | null = null;
  let bgBlockScaleCurvePanel: BezierCurvePanel | null = null;
  let jokerBgBlockFadeCurvePanel: BezierCurvePanel | null = null;
  let jokerBgBlockScaleCurvePanel: BezierCurvePanel | null = null;

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

  /** 切换到指定分组（按 summary 文案精确匹配）。编辑模式选中节点后会跳到「界面UI」。 */
  function activateGroupByLabel(label: string): boolean {
    const target = groups.find((g) => {
      const summary = g.querySelector("summary");
      return summary?.textContent?.trim() === label;
    });
    if (!target) return false;
    setActiveGroup(target);
    return true;
  }

  function setActiveGroup(active: HTMLDetailsElement): void {
    groups.forEach((g) => {
      g.open = g === active;
    });
    tabs.querySelectorAll<HTMLButtonElement>(".panel-tab").forEach((tab) => {
      tab.classList.toggle("is-active", tab.dataset.target === active.dataset.panelKey);
    });
    active.scrollIntoView({ block: "nearest" });
  }

  function setupTabs(): void {
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
    bindCycleButton("btn-gameSpeed", "val-gameSpeed", "gameSpeed", [
      { value: 0.5, label: "0.5×" },
      { value: 1, label: "1×" },
      { value: 2, label: "2×" },
      { value: 4, label: "4×" },
    ]);
    bindToggle("inp-unlimitedActions", "val-unlimitedActions", "rules.unlimitedActions");
    bindNumber("inp-playfieldHandBaseY", "val-playfieldHandBaseY", "playfield.handBaseY", {
      integer: true,
    });
    bindNumber("inp-playfieldHandOffsetX", "val-playfieldHandOffsetX", "playfield.handOffsetX", {
      integer: true,
    });
    bindNumber("inp-playfieldDeckX", "val-playfieldDeckX", "playfield.deckX", { integer: true });
    bindNumber("inp-playfieldDeckY", "val-playfieldDeckY", "playfield.deckY", { integer: true });

    // === 背景 paint-mix ===
    bindToggle("inp-bgEnabled", "val-bgEnabled", "world.background.enabled");
    bindCycleButton("btn-bgQuality", "val-bgQuality", "world.background.quality", [
      { value: "off", label: "off" },
      { value: "low", label: "low" },
      { value: "med", label: "med" },
      { value: "high", label: "high" },
    ]);
    bindCycleButton("btn-bgTheme", "val-bgTheme", "world.background.theme", [
      { value: "feltGreen", label: "feltGreen" },
      { value: "smallBlind", label: "smallBlind" },
      { value: "bigBlind", label: "bigBlind" },
      { value: "boss", label: "boss" },
      { value: "custom", label: "custom" },
    ]);
    {
      const btn = document.getElementById("btn-bgTheme") as HTMLButtonElement | null;
      if (btn && btn.dataset["bgThemeExtra"] !== "1") {
        btn.dataset["bgThemeExtra"] = "1";
        btn.addEventListener("click", () => {
          const theme = CONFIG.world.background.theme;
          if (theme !== "custom") {
            const t = BACKGROUND_THEMES[theme];
            CONFIG.world.background.colour1 = t.colour1;
            CONFIG.world.background.colour2 = t.colour2;
            CONFIG.world.background.colour3 = t.colour3;
            for (const s of syncers) s();
            notify("world.background.theme", theme);
          }
        });
      }
    }
    bindColor("inp-backgroundColor", "val-backgroundColor", "world.backgroundColor");
    bindSlider("inp-bgSpeed", "val-bgSpeed", "world.background.speed", { digits: 2 });
    bindSlider("inp-bgSpinAmount", "val-bgSpinAmount", "world.background.spinAmount", {
      digits: 2,
    });
    bindNumber("inp-bgSpinEase", "val-bgSpinEase", "world.background.spinEase", { digits: 2 });
    bindSlider("inp-bgContrast", "val-bgContrast", "world.background.contrast", { digits: 2 });
    bindNumber("inp-bgPixelSizeFac", "val-bgPixelSizeFac", "world.background.pixelSizeFac", {
      integer: true,
    });
    bindNumber("inp-bgZoom", "val-bgZoom", "world.background.zoom", { digits: 1 });
    bindNumber("inp-bgOffsetX", "val-bgOffsetX", "world.background.offsetX", { digits: 2 });
    bindNumber("inp-bgOffsetY", "val-bgOffsetY", "world.background.offsetY", { digits: 2 });
    bindToggle("inp-bgEnableSpin", "val-bgEnableSpin", "world.background.enableSpin");
    bindSlider("inp-bgLighting", "val-bgLighting", "world.background.lighting", { digits: 2 });
    {
      const markCustomTheme = (): void => {
        CONFIG.world.background.theme = "custom";
      };
      const bindColorCustom = (inputId: string, valueId: string, path: string): void => {
        bindColor(inputId, valueId, path);
        const input = document.getElementById(inputId) as HTMLInputElement | null;
        if (!input || input.dataset["bgCustomMark"] === "1") return;
        input.dataset["bgCustomMark"] = "1";
        input.addEventListener("input", () => {
          markCustomTheme();
          notify("world.background.theme", "custom");
        });
      };
      bindColorCustom("inp-bgColour1", "val-bgColour1", "world.background.colour1");
      bindColorCustom("inp-bgColour2", "val-bgColour2", "world.background.colour2");
      bindColorCustom("inp-bgColour3", "val-bgColour3", "world.background.colour3");
    }
    bindNumber("inp-bgSeedPhase", "val-bgSeedPhase", "world.background.seedPhase", {
      digits: 1,
    });
    bindToggle("inp-crtEnabled", "val-crtEnabled", "world.crt.enabled");
    bindCycleButton("btn-crtPreset", "val-crtPreset", "world.crt.preset", [
      { value: "off", label: "off" },
      { value: "subtle", label: "subtle" },
      { value: "hard", label: "hard" },
    ]);
    bindSlider("inp-crtIntensity", "val-crtIntensity", "world.crt.intensity", { digits: 2 });
    bindNumber("inp-crtScanlineCount", "val-crtScanlineCount", "world.crt.scanlineCount", {
      digits: 0,
    });
    bindSlider("inp-crtNoise", "val-crtNoise", "world.crt.noiseAmount", { digits: 3 });
    bindSlider("inp-crtContrast", "val-crtContrast", "world.crt.contrast", { digits: 2 });
    bindSlider("inp-crtResolution", "val-crtResolution", "world.crt.resolution", { digits: 2 });

    bindNumber("inp-bgMaxUpdateHz", "val-bgMaxUpdateHz", "world.background.maxUpdateHz", {
      integer: true,
    });

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

    // === 牌的绘制 / 盲注硬币动画 ===
    bindNumber("inp-blindChipAnimFps", "val-blindChipAnimFps", "cardArt.blindChipAnim.fps", {
      digits: 1,
    });

    // === 牌的绘制 / 盲注筹码阴影效果（独立于 cardShadow / dragShadow） ===
    bindSectionExpand(
      "inp-expandBlindChipShadow",
      "val-expandBlindChipShadow",
      "cardVisuals.expandedSections.blindChipShadow",
      "sect-blindChipShadow-params",
    );
    bindColor("inp-blindChipShadowColor", "val-blindChipShadowColor", "blindChipShadow.color");
    bindNumber("inp-blindChipShadowAlpha", "val-blindChipShadowAlpha", "blindChipShadow.alpha", { digits: 2 });
    bindNumber("inp-blindChipShadowLightX", "val-blindChipShadowLightX", "blindChipShadow.lightX", { digits: 1 });
    bindNumber("inp-blindChipShadowLightY", "val-blindChipShadowLightY", "blindChipShadow.lightY", { digits: 1 });
    bindNumber("inp-blindChipShadowDistanceRatio", "val-blindChipShadowDistanceRatio", "blindChipShadow.distanceRatio", { digits: 5 });
    bindNumber("inp-blindChipShadowScaleRatio", "val-blindChipShadowScaleRatio", "blindChipShadow.scaleRatio", { digits: 2 });
    bindNumber("inp-blindChipShadowStretchLimitY", "val-blindChipShadowStretchLimitY", "blindChipShadow.stretchLimitY", { digits: 1 });
    bindColor("inp-blindChipDragShadowColor", "val-blindChipDragShadowColor", "blindChipDragShadow.color");
    bindNumber("inp-blindChipDragShadowAlpha", "val-blindChipDragShadowAlpha", "blindChipDragShadow.alpha", { digits: 2 });
    bindNumber("inp-blindChipDragShadowLightX", "val-blindChipDragShadowLightX", "blindChipDragShadow.lightX", { digits: 1 });
    bindNumber("inp-blindChipDragShadowLightY", "val-blindChipDragShadowLightY", "blindChipDragShadow.lightY", { digits: 1 });
    bindNumber("inp-blindChipDragShadowDistanceRatio", "val-blindChipDragShadowDistanceRatio", "blindChipDragShadow.distanceRatio", { digits: 5 });
    bindNumber("inp-blindChipDragShadowScaleRatio", "val-blindChipDragShadowScaleRatio", "blindChipDragShadow.scaleRatio", { digits: 2 });
    bindNumber("inp-blindChipDragShadowStretchLimitY", "val-blindChipDragShadowStretchLimitY", "blindChipDragShadow.stretchLimitY", { digits: 1 });

    // === 卡牌视效 ===
    bindSectionExpand("inp-expandShadow", "val-expandShadow", "cardVisuals.expandedSections.shadow", "sect-shadow-params");
    bindColor("inp-shadowColor", "val-shadowColor", "cardShadow.color");
    bindNumber("inp-shadowAlpha", "val-shadowAlpha", "cardShadow.alpha", { digits: 2 });
    bindNumber("inp-shadowLightX", "val-shadowLightX", "cardShadow.lightX", { digits: 1 });
    bindNumber("inp-shadowLightY", "val-shadowLightY", "cardShadow.lightY", { digits: 1 });
    bindNumber("inp-shadowDistanceRatio", "val-shadowDistanceRatio", "cardShadow.distanceRatio", { digits: 5 });
    bindNumber("inp-shadowScaleRatio", "val-shadowScaleRatio", "cardShadow.scaleRatio", { digits: 2 });
    bindNumber("inp-shadowStretchLimitY", "val-shadowStretchLimitY", "cardShadow.stretchLimitY", { digits: 1 });

    bindSectionExpand("inp-expandDragShadow", "val-expandDragShadow", "cardVisuals.expandedSections.dragShadow", "sect-dragShadow-params");
    bindColor("inp-dragShadowColor", "val-dragShadowColor", "dragShadow.color");
    bindNumber("inp-dragShadowAlpha", "val-dragShadowAlpha", "dragShadow.alpha", { digits: 2 });
    bindNumber("inp-dragShadowLightX", "val-dragShadowLightX", "dragShadow.lightX", { digits: 1 });
    bindNumber("inp-dragShadowLightY", "val-dragShadowLightY", "dragShadow.lightY", { digits: 1 });
    bindNumber("inp-dragShadowDistanceRatio", "val-dragShadowDistanceRatio", "dragShadow.distanceRatio", { digits: 5 });
    bindNumber("inp-dragShadowScaleRatio", "val-dragShadowScaleRatio", "dragShadow.scaleRatio", { digits: 2 });
    bindNumber("inp-dragShadowStretchLimitY", "val-dragShadowStretchLimitY", "dragShadow.stretchLimitY", { digits: 1 });

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
    bindNumber("inp-hoverSettleScale", "val-hoverSettleScale", "cardVisuals.hoverSettleScale", { digits: 2 });
    bindNumber("inp-hoverScaleAngularFreq", "val-hoverScaleAngularFreq", "cardVisuals.hoverScaleAngularFreq", { digits: 1 });
    bindNumber("inp-hoverScaleDampingRatio", "val-hoverScaleDampingRatio", "cardVisuals.hoverScaleDampingRatio", { digits: 2 });
    bindNumber("inp-hoverScaleMass", "val-hoverScaleMass", "cardVisuals.hoverScaleMass", { digits: 2 });
    bindNumber("inp-hoverScaleImpulseScale", "val-hoverScaleImpulseScale", "cardVisuals.hoverScaleImpulseScale", { digits: 2 });
    bindNumber("inp-hoverScaleImpulseScaleVel", "val-hoverScaleImpulseScaleVel", "cardVisuals.hoverScaleImpulseScaleVel", { digits: 2 });
    bindNumber("inp-hoverScaleSettleEpsScale", "val-hoverScaleSettleEpsScale", "cardVisuals.hoverScaleSettleEpsScale", { digits: 4 });
    bindNumber("inp-hoverScaleSettleVelScale", "val-hoverScaleSettleVelScale", "cardVisuals.hoverScaleSettleVelScale", { digits: 3 });
    bindNumber("inp-hoverScaleMaxDtSec", "val-hoverScaleMaxDtSec", "cardVisuals.hoverScaleMaxDtSec", { digits: 4 });
    bindNumber("inp-hoverScaleSubsteps", "val-hoverScaleSubsteps", "cardVisuals.hoverScaleSubsteps", { integer: true });

    // 鼠标呼吸晃动（触碰与回落）：SpringDamper1D 双通道（Y/rot），对齐出牌堆结算缩放通道。
    // 触发时机：(1) 鼠标 pointerover 进入卡牌；(2) 卡牌拖拽缩放退出动画完成（完全回落到 1.0）。
    bindSectionExpand("inp-expandHoverBreathing", "val-expandHoverBreathing", "cardVisuals.expandedSections.hoverBreathing", "sect-hoverBreathing-params");
    bindToggle("inp-hoverBreathingEnabled", "val-hoverBreathingEnabled", "cardVisuals.hoverBreathingEnabled");
    bindNumber("inp-hoverBreathingAngularFreq", "val-hoverBreathingAngularFreq", "cardVisuals.hoverBreathingAngularFreq", { digits: 1 });
    bindNumber("inp-hoverBreathingDampingRatio", "val-hoverBreathingDampingRatio", "cardVisuals.hoverBreathingDampingRatio", { digits: 2 });
    bindNumber("inp-hoverBreathingMass", "val-hoverBreathingMass", "cardVisuals.hoverBreathingMass", { digits: 2 });
    bindNumber("inp-hoverBreathingImpulseY", "val-hoverBreathingImpulseY", "cardVisuals.hoverBreathingImpulseY", { digits: 1 });
    bindNumber("inp-hoverBreathingImpulseYVel", "val-hoverBreathingImpulseYVel", "cardVisuals.hoverBreathingImpulseYVel", { digits: 1 });
    bindNumber("inp-hoverBreathingImpulseRotDeg", "val-hoverBreathingImpulseRotDeg", "cardVisuals.hoverBreathingImpulseRotDeg", { digits: 2 });
    bindNumber("inp-hoverBreathingImpulseRotVelDeg", "val-hoverBreathingImpulseRotVelDeg", "cardVisuals.hoverBreathingImpulseRotVelDeg", { digits: 1 });
    bindNumber("inp-hoverBreathingSettleEpsY", "val-hoverBreathingSettleEpsY", "cardVisuals.hoverBreathingSettleEpsY", { digits: 2 });
    bindNumber("inp-hoverBreathingSettleVelY", "val-hoverBreathingSettleVelY", "cardVisuals.hoverBreathingSettleVelY", { digits: 1 });
    bindNumber("inp-hoverBreathingSettleEpsRotDeg", "val-hoverBreathingSettleEpsRotDeg", "cardVisuals.hoverBreathingSettleEpsRotDeg", { digits: 2 });
    bindNumber("inp-hoverBreathingSettleVelRotDeg", "val-hoverBreathingSettleVelRotDeg", "cardVisuals.hoverBreathingSettleVelRotDeg", { digits: 1 });
    bindNumber("inp-hoverBreathingMaxDurationMS", "val-hoverBreathingMaxDurationMS", "cardVisuals.hoverBreathingMaxDurationMS", { integer: true });
    bindNumber("inp-hoverBreathingMaxDtSec", "val-hoverBreathingMaxDtSec", "cardVisuals.hoverBreathingMaxDtSec", { digits: 4 });
    bindNumber("inp-hoverBreathingSubsteps", "val-hoverBreathingSubsteps", "cardVisuals.hoverBreathingSubsteps", { integer: true });

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

    // === 卡牌操作逻辑（选中高度 + 开关；位移由弹性绳） ===
    bindSectionExpand("inp-expandCardOps", "val-expandCardOps", "cardVisuals.expandedSections.cardOps", "sect-cardOps-params");
    bindNumber("inp-clickThresholdMS", "val-clickThresholdMS", "cardVisuals.clickThresholdMS", { integer: true });
    bindNumber("inp-clickDistanceThreshold", "val-clickDistanceThreshold", "cardVisuals.clickDistanceThreshold", { integer: true });
    bindToggle("inp-selectMoveEnabled", "val-selectMoveEnabled", "cardVisuals.selectMoveEnabled");
    bindNumber("inp-selectRiseY", "val-selectRiseY", "cardVisuals.selectRiseY", { digits: 1 });

    bindSectionExpand("inp-expandDragHandCard", "val-expandDragHandCard", "cardVisuals.expandedSections.dragHandCard", "sect-dragHandCard-params");
    bindNumber("inp-dragScaleTarget", "val-dragScaleTarget", "dragHandCard.dragScaleTarget", { digits: 2 });
    // 按下放大（scaleIn）
    bindNumber("inp-dragScaleInAngularFreq", "val-dragScaleInAngularFreq", "dragHandCard.scaleIn.angularFreq", { digits: 1 });
    bindNumber("inp-dragScaleInDampingRatio", "val-dragScaleInDampingRatio", "dragHandCard.scaleIn.dampingRatio", { digits: 2 });
    bindNumber("inp-dragScaleInMass", "val-dragScaleInMass", "dragHandCard.scaleIn.mass", { digits: 2 });
    bindNumber("inp-dragScaleInImpulseScale", "val-dragScaleInImpulseScale", "dragHandCard.scaleIn.impulseScale", { digits: 2 });
    bindNumber("inp-dragScaleInImpulseScaleVel", "val-dragScaleInImpulseScaleVel", "dragHandCard.scaleIn.impulseScaleVel", { digits: 2 });
    bindNumber("inp-dragScaleInSettleEpsScale", "val-dragScaleInSettleEpsScale", "dragHandCard.scaleIn.settleEpsScale", { digits: 4 });
    bindNumber("inp-dragScaleInSettleVelScale", "val-dragScaleInSettleVelScale", "dragHandCard.scaleIn.settleVelScale", { digits: 3 });
    bindNumber("inp-dragScaleInMaxDtSec", "val-dragScaleInMaxDtSec", "dragHandCard.scaleIn.maxDtSec", { digits: 4 });
    bindNumber("inp-dragScaleInSubsteps", "val-dragScaleInSubsteps", "dragHandCard.scaleIn.substeps", { integer: true });
    // 松手缩小（scaleOut）
    bindNumber("inp-dragScaleOutAngularFreq", "val-dragScaleOutAngularFreq", "dragHandCard.scaleOut.angularFreq", { digits: 1 });
    bindNumber("inp-dragScaleOutDampingRatio", "val-dragScaleOutDampingRatio", "dragHandCard.scaleOut.dampingRatio", { digits: 2 });
    bindNumber("inp-dragScaleOutMass", "val-dragScaleOutMass", "dragHandCard.scaleOut.mass", { digits: 2 });
    bindNumber("inp-dragScaleOutImpulseScale", "val-dragScaleOutImpulseScale", "dragHandCard.scaleOut.impulseScale", { digits: 2 });
    bindNumber("inp-dragScaleOutImpulseScaleVel", "val-dragScaleOutImpulseScaleVel", "dragHandCard.scaleOut.impulseScaleVel", { digits: 2 });
    bindNumber("inp-dragScaleOutSettleEpsScale", "val-dragScaleOutSettleEpsScale", "dragHandCard.scaleOut.settleEpsScale", { digits: 4 });
    bindNumber("inp-dragScaleOutSettleVelScale", "val-dragScaleOutSettleVelScale", "dragHandCard.scaleOut.settleVelScale", { digits: 3 });
    bindNumber("inp-dragScaleOutMaxDtSec", "val-dragScaleOutMaxDtSec", "dragHandCard.scaleOut.maxDtSec", { digits: 4 });
    bindNumber("inp-dragScaleOutSubsteps", "val-dragScaleOutSubsteps", "dragHandCard.scaleOut.substeps", { integer: true });

    // === 【抓牌】抓牌相关参数 ===
    bindSectionExpand("inp-expandDrawCard", "val-expandDrawCard", "cardVisuals.expandedSections.drawCard", "sect-drawCard-params");
    bindNumber("inp-lastCardAdvanceMS", "val-lastCardAdvanceMS", "drawCard.lastCardAdvanceMS", { integer: true });
    bindNumber("inp-nextCardAdvanceMS", "val-nextCardAdvanceMS", "drawCard.nextCardAdvanceMS", { integer: true });
    bindNumber("inp-drawCardSpeedRatio", "val-drawCardSpeedRatio", "drawCard.speedRatio", { digits: 1 });
    bindToggle("inp-drawCardUseInitialRotation", "val-drawCardUseInitialRotation", "drawCard.useInitialRotation");
    bindNumber("inp-drawCardInitialRotationDeg", "val-drawCardInitialRotationDeg", "drawCard.initialRotationDeg", { integer: true });

    // === 【弃牌】弃牌相关参数 ===
    bindSectionExpand("inp-expandDiscard", "val-expandDiscard", "cardVisuals.expandedSections.discard", "sect-discard-params");
    bindNumber("inp-discardIntervalMS", "val-discardIntervalMS", "discard.intervalMS", { integer: true });
    bindNumber("inp-discardSpeedRatio", "val-discardSpeedRatio", "discard.speedRatio", { digits: 1 });
    bindNumber("inp-discardLastCardWaitMS", "val-discardLastCardWaitMS", "discard.lastCardWaitMS", { integer: true });

    // === 【抓牌】卡牌翻面效果 ===
    bindSectionExpand("inp-expandDrawFlip", "val-expandDrawFlip", "cardVisuals.expandedSections.drawFlip", "sect-drawFlip-params");
    bindToggle("inp-drawFlipEnabled", "val-drawFlipEnabled", "drawFlip.enabled");
    bindNumber("inp-drawFlipFirstHalfRatio", "val-drawFlipFirstHalfRatio", "drawFlip.firstHalfRatio", { digits: 2 });
    bindNumber("inp-drawFlipFirstHalfJitter", "val-drawFlipFirstHalfJitter", "drawFlip.firstHalfJitter", { digits: 2 });
    bindNumber("inp-drawFlipSecondHalfRatio", "val-drawFlipSecondHalfRatio", "drawFlip.secondHalfRatio", { digits: 2 });
    bindNumber("inp-drawFlipSecondHalfJitter", "val-drawFlipSecondHalfJitter", "drawFlip.secondHalfJitter", { digits: 2 });

    // === 【弃牌/出牌结束】卡牌翻面效果 ===
    bindSectionExpand("inp-expandDiscardFlip", "val-expandDiscardFlip", "cardVisuals.expandedSections.discardFlip", "sect-discardFlip-params");
    bindToggle("inp-discardFlipEnabled", "val-discardFlipEnabled", "discardFlip.enabled");
    bindNumber("inp-discardFlipAngleDeg", "val-discardFlipAngleDeg", "discardFlip.flipAngleDeg", { integer: true });
    bindNumber("inp-discardFlipAngleJitterDeg", "val-discardFlipAngleJitterDeg", "discardFlip.flipAngleJitterDeg", { integer: true });
    bindNumber("inp-discardFlipRandomRotationDeg", "val-discardFlipRandomRotationDeg", "discardFlip.randomRotationDeg", { integer: true });

    // === 卡牌换位【理牌】（点数/花色按钮）=== 位移由弹性绳；enabled 控制是否动画
    bindSectionExpand("inp-expandHandSort", "val-expandHandSort", "cardVisuals.expandedSections.handSort", "sect-handSort-params");
    bindToggle("inp-handSortEnabled", "val-handSortEnabled", "handSort.enabled");

    // === 【出牌】卡牌整体位移效果 ===
    bindSectionExpand("inp-expandPlayHandGroupShift", "val-expandPlayHandGroupShift", "cardVisuals.expandedSections.playHandGroupShift", "sect-playHandGroupShift-params");
    bindToggle("inp-playHandGroupShiftEnabled", "val-playHandGroupShiftEnabled", "playHandGroupShift.enabled");
    bindNumber("inp-playHandGroupShiftDistancePx", "val-playHandGroupShiftDistancePx", "playHandGroupShift.distancePx", { integer: true });
    bindNumber("inp-playHandGroupShiftPreDownWaitMS", "val-playHandGroupShiftPreDownWaitMS", "playHandGroupShift.preDownWaitMS", { integer: true });
    bindNumber("inp-playHandGroupShiftPostDownWaitMS", "val-playHandGroupShiftPostDownWaitMS", "playHandGroupShift.postDownWaitMS", { integer: true });
    bindNumber("inp-playHandGroupShiftPreUpWaitMS", "val-playHandGroupShiftPreUpWaitMS", "playHandGroupShift.preUpWaitMS", { integer: true });
    bindNumber("inp-playHandGroupShiftPostUpWaitMS", "val-playHandGroupShiftPostUpWaitMS", "playHandGroupShift.postUpWaitMS", { integer: true });

    // === 【出牌】出牌堆的位移（节奏 + 间距；运动由弹性绳） ===
    bindSectionExpand("inp-expandPlayPileDisplacement", "val-expandPlayPileDisplacement", "cardVisuals.expandedSections.playPileDisplacement", "sect-playPileDisplacement-params");
    bindToggle("inp-playPileDisplacementEnabled", "val-playPileDisplacementEnabled", "playPileDisplacement.enabled");
    bindNumber("inp-playPileDisplacementCardSpacing", "val-playPileDisplacementCardSpacing", "playPileDisplacement.cardSpacing", { integer: true });
    bindNumber("inp-playPileDisplacementFirstIntervalMS", "val-playPileDisplacementFirstIntervalMS", "playPileDisplacement.firstIntervalMS", { integer: true });
    bindNumber("inp-playPileDisplacementIntervalReductionMS", "val-playPileDisplacementIntervalReductionMS", "playPileDisplacement.intervalReductionMS", { integer: true });
    bindNumber("inp-playPileDisplacementLastIntervalMS", "val-playPileDisplacementLastIntervalMS", "playPileDisplacement.lastIntervalMS", { integer: true });

    // === 【出牌】出牌堆上移效果（抬升高度 peak≈v×t/2 + 节奏 + 阴影） ===
    bindSectionExpand("inp-expandPlayPileLiftEffect", "val-expandPlayPileLiftEffect", "cardVisuals.expandedSections.playPileLiftEffect", "sect-playPileLiftEffect-params");
    bindToggle("inp-playPileLiftEffectEnabled", "val-playPileLiftEffectEnabled", "playPileLiftEffect.enabled");
    bindNumber("inp-playPileLiftEffectStartSpeed", "val-playPileLiftEffectStartSpeed", "playPileLiftEffect.startSpeed", { integer: true });
    bindNumber("inp-playPileLiftEffectDecelerateTime", "val-playPileLiftEffectDecelerateTime", "playPileLiftEffect.decelerateTime", { digits: 2 });
    bindNumber("inp-playPileLiftEffectInterval", "val-playPileLiftEffectInterval", "playPileLiftEffect.interval", { integer: true });
    bindNumber("inp-playPileLiftEffectStayDuration", "val-playPileLiftEffectStayDuration", "playPileLiftEffect.stayDuration", { integer: true });
    bindColor("inp-playPileLiftEffectShadowColor", "val-playPileLiftEffectShadowColor", "playPileLiftEffect.shadowColor");
    bindNumber("inp-playPileLiftEffectShadowAlpha", "val-playPileLiftEffectShadowAlpha", "playPileLiftEffect.shadowAlpha", { digits: 2 });
    bindNumber("inp-playPileLiftEffectShadowLightX", "val-playPileLiftEffectShadowLightX", "playPileLiftEffect.shadowLightX", { digits: 1 });
    bindNumber("inp-playPileLiftEffectShadowLightY", "val-playPileLiftEffectShadowLightY", "playPileLiftEffect.shadowLightY", { digits: 1 });
    bindNumber("inp-playPileLiftEffectShadowDistanceRatio", "val-playPileLiftEffectShadowDistanceRatio", "playPileLiftEffect.shadowDistanceRatio", { digits: 5 });
    bindNumber("inp-playPileLiftEffectShadowScaleRatio", "val-playPileLiftEffectShadowScaleRatio", "playPileLiftEffect.shadowScaleRatio", { digits: 2 });

    // === 【出牌】出牌堆的结算效果（弹簧阻尼） ===
    bindSectionExpand("inp-expandPlayPileSettleEffect", "val-expandPlayPileSettleEffect", "cardVisuals.expandedSections.playPileSettleEffect", "sect-playPileSettleEffect-params");
    bindToggle("inp-playPileSettleEffectEnabled", "val-playPileSettleEffectEnabled", "playPileSettleEffect.enabled");
    bindNumber("inp-playPileSettleEffectFirstIntervalMS", "val-playPileSettleEffectFirstIntervalMS", "playPileSettleEffect.firstIntervalMS", { integer: true });
    bindNumber("inp-playPileSettleEffectIntervalReductionMS", "val-playPileSettleEffectIntervalReductionMS", "playPileSettleEffect.intervalReductionMS", { integer: true });
    bindNumber("inp-playPileSettleEffectLastIntervalMS", "val-playPileSettleEffectLastIntervalMS", "playPileSettleEffect.lastIntervalMS", { integer: true });
    bindNumber("inp-playPileSettleEffectAngularFreq", "val-playPileSettleEffectAngularFreq", "playPileSettleEffect.angularFreq", { digits: 1 });
    bindNumber("inp-playPileSettleEffectDampingRatio", "val-playPileSettleEffectDampingRatio", "playPileSettleEffect.dampingRatio", { digits: 2 });
    bindNumber("inp-playPileSettleEffectMass", "val-playPileSettleEffectMass", "playPileSettleEffect.mass", { digits: 2 });
    bindNumber("inp-playPileSettleEffectImpulseScale", "val-playPileSettleEffectImpulseScale", "playPileSettleEffect.impulseScale", { digits: 2 });
    bindNumber("inp-playPileSettleEffectImpulseRotDeg", "val-playPileSettleEffectImpulseRotDeg", "playPileSettleEffect.impulseRotDeg", { digits: 1 });
    bindNumber("inp-playPileSettleEffectTextTriggerMS", "val-playPileSettleEffectTextTriggerMS", "playPileSettleEffect.textTriggerMS", { integer: true });
    bindNumber("inp-playPileSettleEffectMaxDurationMS", "val-playPileSettleEffectMaxDurationMS", "playPileSettleEffect.maxDurationMS", { integer: true });
    bindNumber("inp-playPileSettleEffectImpulseScaleVel", "val-playPileSettleEffectImpulseScaleVel", "playPileSettleEffect.impulseScaleVel", { digits: 2 });
    bindNumber("inp-playPileSettleEffectImpulseRotVelDeg", "val-playPileSettleEffectImpulseRotVelDeg", "playPileSettleEffect.impulseRotVelDeg", { digits: 1 });
    bindNumber("inp-playPileSettleEffectSettleEpsScale", "val-playPileSettleEffectSettleEpsScale", "playPileSettleEffect.settleEpsScale", { digits: 4 });
    bindNumber("inp-playPileSettleEffectSettleVelScale", "val-playPileSettleEffectSettleVelScale", "playPileSettleEffect.settleVelScale", { digits: 3 });
    bindNumber("inp-playPileSettleEffectSettleEpsRotDeg", "val-playPileSettleEffectSettleEpsRotDeg", "playPileSettleEffect.settleEpsRotDeg", { digits: 2 });
    bindNumber("inp-playPileSettleEffectSettleVelRotDeg", "val-playPileSettleEffectSettleVelRotDeg", "playPileSettleEffect.settleVelRotDeg", { digits: 1 });
    bindNumber("inp-playPileSettleEffectMaxDtSec", "val-playPileSettleEffectMaxDtSec", "playPileSettleEffect.maxDtSec", { digits: 4 });
    bindNumber("inp-playPileSettleEffectSubsteps", "val-playPileSettleEffectSubsteps", "playPileSettleEffect.substeps", { integer: true });

    // 弹性绳子牵引卡牌模型（顶级分类；沙盒 ?scene=elastic-rope）
    bindToggle("inp-elasticRopeEnabled", "val-elasticRopeEnabled", "elasticRopeCard.enabled");
    bindSectionExpand(
      "inp-expandElasticSpring",
      "val-expandElasticSpring",
      "elasticRopeCard.expandedSections.spring",
      "sect-elasticRope-spring",
    );
    bindNumber("inp-elasticMaxLen", "val-elasticMaxLen", "elasticRopeCard.spring.maxElasticLength", {
      digits: 1,
    });
    bindNumber("inp-elasticStiffness", "val-elasticStiffness", "elasticRopeCard.spring.stiffness", {
      digits: 1,
    });
    bindSectionExpand(
      "inp-expandElasticAirDrag",
      "val-expandElasticAirDrag",
      "elasticRopeCard.expandedSections.airDrag",
      "sect-elasticRope-airDrag",
    );
    bindCycleButton("btn-elasticAirDragMode", "val-elasticAirDragMode", "elasticRopeCard.airDrag.mode", [
      { value: "linear" as const, label: "linear" },
      { value: "quadratic" as const, label: "quadratic" },
    ]);
    bindNumber("inp-elasticLinearCoeff", "val-elasticLinearCoeff", "elasticRopeCard.airDrag.linearCoeff", {
      digits: 2,
    });
    bindNumber(
      "inp-elasticQuadraticCoeff",
      "val-elasticQuadraticCoeff",
      "elasticRopeCard.airDrag.quadraticCoeff",
      { digits: 4 },
    );
    // Vterm 只读：Vterm = k * Lmax / c（linear）
    {
      const valueEl = document.getElementById("val-elasticVterm");
      if (valueEl) {
        const syncVterm = (): void => {
          const er = CONFIG.elasticRopeCard;
          const c = Math.max(1e-9, er.airDrag.linearCoeff);
          const v =
            er.airDrag.mode === "linear"
              ? (er.spring.stiffness * er.spring.maxElasticLength) / c
              : 0;
          valueEl.textContent = er.airDrag.mode === "linear" ? String(Math.round(v)) : "n/a";
        };
        syncVterm();
        syncers.push(syncVterm);
        for (const id of [
          "inp-elasticMaxLen",
          "inp-elasticStiffness",
          "inp-elasticLinearCoeff",
          "btn-elasticAirDragMode",
        ]) {
          document.getElementById(id)?.addEventListener("click", syncVterm);
          document.getElementById(id)?.addEventListener("input", syncVterm);
          document.getElementById(id)?.addEventListener("change", syncVterm);
        }
      }
    }
    bindSectionExpand(
      "inp-expandElasticIntegration",
      "val-expandElasticIntegration",
      "elasticRopeCard.expandedSections.integration",
      "sect-elasticRope-integration",
    );
    bindNumber("inp-elasticMass", "val-elasticMass", "elasticRopeCard.integration.mass", {
      digits: 2,
    });
    bindNumber("inp-elasticMaxDt", "val-elasticMaxDt", "elasticRopeCard.integration.maxDtSec", {
      digits: 3,
    });
    bindNumber("inp-elasticSubsteps", "val-elasticSubsteps", "elasticRopeCard.integration.substeps", {
      integer: true,
    });
    bindSectionExpand(
      "inp-expandElasticSettle",
      "val-expandElasticSettle",
      "elasticRopeCard.expandedSections.settle",
      "sect-elasticRope-settle",
    );
    bindNumber("inp-elasticSettleDist", "val-elasticSettleDist", "elasticRopeCard.settle.distancePx", {
      digits: 1,
    });
    bindNumber(
      "inp-elasticSettleSpeed",
      "val-elasticSettleSpeed",
      "elasticRopeCard.settle.speedPxPerSec",
      { digits: 1 },
    );
    bindSectionExpand(
      "inp-expandElasticRotation",
      "val-expandElasticRotation",
      "elasticRopeCard.expandedSections.rotation",
      "sect-elasticRope-rotation",
    );
    bindToggle("inp-elasticRotEnabled", "val-elasticRotEnabled", "elasticRopeCard.rotation.enabled");
    bindCycleButton(
      "btn-elasticRotDynamics",
      "val-elasticRotDynamics",
      "elasticRopeCard.rotation.dynamics",
      [
        { value: "springDamper" as const, label: "springDamper" },
        { value: "follow" as const, label: "follow" },
        { value: "instant" as const, label: "instant" },
      ],
    );
    bindCycleButton(
      "btn-elasticRotMapMode",
      "val-elasticRotMapMode",
      "elasticRopeCard.rotation.mapMode",
      [
        { value: "linear" as const, label: "linear" },
        { value: "power" as const, label: "power" },
      ],
    );
    bindNumber(
      "inp-elasticForceToAngle",
      "val-elasticForceToAngle",
      "elasticRopeCard.rotation.forceToAngle",
      { digits: 6 },
    );
    bindNumber(
      "inp-elasticResponseGamma",
      "val-elasticResponseGamma",
      "elasticRopeCard.rotation.responseGamma",
      { digits: 2 },
    );
    bindNumber(
      "inp-elasticMaxAngleDeg",
      "val-elasticMaxAngleDeg",
      "elasticRopeCard.rotation.maxAngleDeg",
      { digits: 1 },
    );
    bindNumber(
      "inp-elasticAngleFollow",
      "val-elasticAngleFollow",
      "elasticRopeCard.rotation.angleFollow",
      { digits: 2 },
    );
    bindNumber("inp-elasticInertia", "val-elasticInertia", "elasticRopeCard.rotation.inertia", {
      digits: 2,
    });
    bindNumber(
      "inp-elasticAngularFreq",
      "val-elasticAngularFreq",
      "elasticRopeCard.rotation.angularFreq",
      { digits: 2 },
    );
    bindNumber(
      "inp-elasticDampingRatio",
      "val-elasticDampingRatio",
      "elasticRopeCard.rotation.dampingRatio",
      { digits: 2 },
    );
    bindToggle(
      "inp-elasticRotAffectsAnchor",
      "val-elasticRotAffectsAnchor",
      "elasticRopeCard.rotation.rotationAffectsAnchor",
    );
    bindSectionExpand(
      "inp-expandElasticAnchor",
      "val-expandElasticAnchor",
      "elasticRopeCard.expandedSections.anchor",
      "sect-elasticRope-anchor",
    );
    bindNumber("inp-elasticAnchorY", "val-elasticAnchorY", "elasticRopeCard.anchor.anchorY", {
      digits: 1,
    });
    bindNumber("inp-elasticAnchorXMin", "val-elasticAnchorXMin", "elasticRopeCard.anchor.anchorXMin", {
      digits: 1,
    });
    bindNumber("inp-elasticAnchorXMax", "val-elasticAnchorXMax", "elasticRopeCard.anchor.anchorXMax", {
      digits: 1,
    });
    bindCycleButton(
      "btn-elasticAnchorMapMode",
      "val-elasticAnchorMapMode",
      "elasticRopeCard.anchor.mapMode",
      [
        { value: "continuous" as const, label: "continuous" },
        { value: "leftRightHalf" as const, label: "leftRightHalf" },
      ],
    );
    bindSectionExpand(
      "inp-expandElasticDebug",
      "val-expandElasticDebug",
      "elasticRopeCard.expandedSections.debug",
      "sect-elasticRope-debug",
    );
    bindToggle("inp-elasticDrawRope", "val-elasticDrawRope", "elasticRopeCard.debug.drawRope");
    bindToggle("inp-elasticDrawAnchor", "val-elasticDrawAnchor", "elasticRopeCard.debug.drawAnchor");
    bindToggle("inp-elasticShowHud", "val-elasticShowHud", "elasticRopeCard.debug.showHudReadouts");
    bindToggle(
      "inp-elasticFollowPtr",
      "val-elasticFollowPtr",
      "elasticRopeCard.sandbox.followPointerWhileDown",
    );
    bindToggle(
      "inp-elasticFreezeOnRelease",
      "val-elasticFreezeOnRelease",
      "elasticRopeCard.sandbox.freezeTargetOnRelease",
    );

    // 卡牌移动旋转（velocity-based tilt）：与 dragHandCard 同属"卡牌逻辑"专区。
    bindSectionExpand("inp-expandCardMoveRotation", "val-expandCardMoveRotation", "cardVisuals.expandedSections.cardMoveRotation", "sect-cardMoveRotation-params");
    bindToggle("inp-cardMoveRotationEnabled", "val-cardMoveRotationEnabled", "cardMoveRotation.enabled");
    bindToggle("inp-cardMoveRotationShowPivot", "val-cardMoveRotationShowPivot", "cardMoveRotation.showPivot");
    bindNumber("inp-cardMoveRotationPivotX", "val-cardMoveRotationPivotX", "cardMoveRotation.pivotOffsetX", { integer: true });
    bindNumber("inp-cardMoveRotationPivotY", "val-cardMoveRotationPivotY", "cardMoveRotation.pivotOffsetY", { integer: true });
    bindNumber("inp-cardMoveRotationPerSpeed", "val-cardMoveRotationPerSpeed", "cardMoveRotation.rotationPerSpeed", { digits: 3 });
    bindNumber("inp-cardMoveRotationDrawPerSpeed", "val-cardMoveRotationDrawPerSpeed", "cardMoveRotation.drawRotationPerSpeed", { digits: 3 });

    // 最大旋转角是派生量（参考速度 3000px/s × cardMoveRotation.rotationPerSpeed / 1000），
    // input 在 HTML 中已经标了 readonly+disabled，所以这里不挂 change 监听，
    // 只做"只读 sync"。两条更新路径：
    //   (a) 挂在 syncers 里 —— refreshAllControls / preset 加载 / 撤回反撤回 时触发；
    //   (b) 在上游 input（单位速度→旋转角系数）上各加一个 input/change
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

          // 上游输入实时联动：单位速度→旋转角系数。
          for (const upstreamId of ["inp-cardMoveRotationPerSpeed", "inp-cardMoveRotationDrawPerSpeed"]) {
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

    // === 6. 文字视效专项 ===
    bindSectionExpand("inp-expandPlayPileSettleText", "val-expandPlayPileSettleText", "cardVisuals.expandedSections.playPileSettleText", "sect-playPileSettleText-params");
    bindSectionExpand("inp-expandPlayPileSettleBgBlock", "val-expandPlayPileSettleBgBlock", "cardVisuals.expandedSections.playPileSettleBgBlock", "sect-playPileSettleBgBlock-params");

    // === 7. 小丑牌相关 ===
    // 启用效果：只做「是否对小丑复用该手牌专区」的总开关；参数值仍读手牌专区。
    bindSectionExpand("inp-expandJokerEffects", "val-expandJokerEffects", "cardVisuals.expandedSections.jokerEffects", "sect-jokerEffects-params");
    bindToggle("inp-jokerFxShadow", "val-jokerFxShadow", "joker.effects.shadow");
    bindToggle("inp-jokerFxBreathing", "val-jokerFxBreathing", "joker.effects.breathing");
    bindToggle("inp-jokerFxIdleTilt", "val-jokerFxIdleTilt", "joker.effects.idleTilt");
    bindToggle("inp-jokerFxHoverHit", "val-jokerFxHoverHit", "joker.effects.hoverHit");
    bindToggle("inp-jokerFxHoverScale", "val-jokerFxHoverScale", "joker.effects.hoverScale");
    bindToggle("inp-jokerFxHoverBreathing", "val-jokerFxHoverBreathing", "joker.effects.hoverBreathing");
    bindToggle("inp-jokerFxMouse3DTilt", "val-jokerFxMouse3DTilt", "joker.effects.mouse3DTilt");
    // 布局（最小必要字段）
    bindSectionExpand("inp-expandJokerLayout", "val-expandJokerLayout", "cardVisuals.expandedSections.jokerLayout", "sect-jokerLayout-params");
    bindNumber("inp-jokerSlotCount", "val-jokerSlotCount", "joker.slotCount", { integer: true });
    bindNumber("inp-jokerCardSpacing", "val-jokerCardSpacing", "joker.cardSpacing", { digits: 0 });
    bindNumber("inp-jokerBaseY", "val-jokerBaseY", "joker.baseY", { digits: 0 });
    bindNumber("inp-jokerBaseX", "val-jokerBaseX", "joker.baseX", { digits: 0 });

    // 小丑弹簧结算参数复用【出牌】出牌堆的结算效果（playPileSettleEffect），无独立专区。

    // === 【小丑】结算数字效果 + 红色背景方块 ===
    bindSectionExpand("inp-expandJokerSettleText", "val-expandJokerSettleText", "cardVisuals.expandedSections.jokerSettleText", "sect-jokerSettleText-params");
    bindSectionExpand("inp-expandJokerSettleBgBlock", "val-expandJokerSettleBgBlock", "cardVisuals.expandedSections.jokerSettleBgBlock", "sect-jokerSettleBgBlock-params");

    bindToggle("inp-jokerSettleTextEffectEnabled", "val-jokerSettleTextEffectEnabled", "jokerSettleTextEffect.enabled");
    bindNumber("inp-jokerSettleTextEffectDefaultMultBonus", "val-jokerSettleTextEffectDefaultMultBonus", "jokerSettleTextEffect.defaultMultBonus", { integer: true });
    bindNumber("inp-jokerSettleTextEffectFontSize", "val-jokerSettleTextEffectFontSize", "jokerSettleTextEffect.fontSize", { integer: true });
    bindNumber("inp-jokerSettleTextEffectLetterSpacing", "val-jokerSettleTextEffectLetterSpacing", "jokerSettleTextEffect.letterSpacing", { digits: 1 });
    bindColor("inp-jokerSettleTextEffectColor", "val-jokerSettleTextEffectColor", "jokerSettleTextEffect.color");
    bindNumber("inp-jokerSettleTextEffectOffsetY", "val-jokerSettleTextEffectOffsetY", "jokerSettleTextEffect.offsetY", { digits: 1 });
    bindNumber("inp-jokerSettleTextEffectFirstCharDelayMS", "val-jokerSettleTextEffectFirstCharDelayMS", "jokerSettleTextEffect.firstCharDelayMS", { integer: true });
    bindNumber("inp-jokerSettleTextEffectCharIntervalMS", "val-jokerSettleTextEffectCharIntervalMS", "jokerSettleTextEffect.charIntervalMS", { integer: true });
    bindNumber("inp-jokerSettleTextEffectCharIntervalReductionMS", "val-jokerSettleTextEffectCharIntervalReductionMS", "jokerSettleTextEffect.charIntervalReductionMS", { integer: true });
    bindNumber("inp-jokerSettleTextEffectAngularFreq", "val-jokerSettleTextEffectAngularFreq", "jokerSettleTextEffect.angularFreq", { digits: 1 });
    bindNumber("inp-jokerSettleTextEffectDampingRatio", "val-jokerSettleTextEffectDampingRatio", "jokerSettleTextEffect.dampingRatio", { digits: 2 });
    bindNumber("inp-jokerSettleTextEffectMass", "val-jokerSettleTextEffectMass", "jokerSettleTextEffect.mass", { digits: 2 });
    bindNumber("inp-jokerSettleTextEffectImpulseScale", "val-jokerSettleTextEffectImpulseScale", "jokerSettleTextEffect.impulseScale", { digits: 2 });
    bindNumber("inp-jokerSettleTextEffectMaxDurationMS", "val-jokerSettleTextEffectMaxDurationMS", "jokerSettleTextEffect.maxDurationMS", { integer: true });
    bindNumber("inp-jokerSettleTextEffectImpulseScaleVel", "val-jokerSettleTextEffectImpulseScaleVel", "jokerSettleTextEffect.impulseScaleVel", { digits: 2 });
    bindNumber("inp-jokerSettleTextEffectSettleEpsScale", "val-jokerSettleTextEffectSettleEpsScale", "jokerSettleTextEffect.settleEpsScale", { digits: 4 });
    bindNumber("inp-jokerSettleTextEffectSettleVelScale", "val-jokerSettleTextEffectSettleVelScale", "jokerSettleTextEffect.settleVelScale", { digits: 3 });
    bindNumber("inp-jokerSettleTextEffectMaxDtSec", "val-jokerSettleTextEffectMaxDtSec", "jokerSettleTextEffect.maxDtSec", { digits: 4 });
    bindNumber("inp-jokerSettleTextEffectSubsteps", "val-jokerSettleTextEffectSubsteps", "jokerSettleTextEffect.substeps", { integer: true });
    bindNumber("inp-jokerSettleTextEffectStayDurationMS", "val-jokerSettleTextEffectStayDurationMS", "jokerSettleTextEffect.stayDurationMS", { integer: true });
    bindNumber("inp-jokerSettleTextEffectFadeDurationMS", "val-jokerSettleTextEffectFadeDurationMS", "jokerSettleTextEffect.fadeDurationMS", { integer: true });
    bindNumber("inp-jokerSettleTextEffectShrinkAnchorY", "val-jokerSettleTextEffectShrinkAnchorY", "jokerSettleTextEffect.shrinkAnchorY", { digits: 2 });
    bindToggle("inp-jokerSettleTextEffectShadowEnabled", "val-jokerSettleTextEffectShadowEnabled", "jokerSettleTextEffect.shadowEnabled");
    bindColor("inp-jokerSettleTextEffectShadowColor", "val-jokerSettleTextEffectShadowColor", "jokerSettleTextEffect.shadowColor");
    bindNumber("inp-jokerSettleTextEffectShadowAlpha", "val-jokerSettleTextEffectShadowAlpha", "jokerSettleTextEffect.shadowAlpha", { digits: 2 });
    bindNumber("inp-jokerSettleTextEffectShadowDistance", "val-jokerSettleTextEffectShadowDistance", "jokerSettleTextEffect.shadowDistance", { digits: 1 });
    bindNumber("inp-jokerSettleTextEffectShadowAngleDeg", "val-jokerSettleTextEffectShadowAngleDeg", "jokerSettleTextEffect.shadowAngleDeg", { digits: 1 });
    bindNumber("inp-jokerSettleTextEffectShadowBlur", "val-jokerSettleTextEffectShadowBlur", "jokerSettleTextEffect.shadowBlur", { digits: 1 });
    bindToggle("inp-jokerSettleTextEffectBgBlockEnabled", "val-jokerSettleTextEffectBgBlockEnabled", "jokerSettleTextEffect.bgBlockEnabled");
    bindColor("inp-jokerSettleTextEffectBgBlockColor", "val-jokerSettleTextEffectBgBlockColor", "jokerSettleTextEffect.bgBlockColor");
    bindNumber("inp-jokerSettleTextEffectBgBlockInitAngleDeg", "val-jokerSettleTextEffectBgBlockInitAngleDeg", "jokerSettleTextEffect.bgBlockInitAngleDeg", { digits: 1 });
    bindNumber("inp-jokerSettleTextEffectBgBlockEndAngleDeg", "val-jokerSettleTextEffectBgBlockEndAngleDeg", "jokerSettleTextEffect.bgBlockEndAngleDeg", { digits: 1 });
    bindNumber("inp-jokerSettleTextEffectBgBlockDurationMS", "val-jokerSettleTextEffectBgBlockDurationMS", "jokerSettleTextEffect.bgBlockDurationMS", { integer: true });

    const jokerBgBlockScaleCurveMount = document.getElementById("mount-jokerBgBlockScaleCurve");
    if (jokerBgBlockScaleCurveMount && !jokerBgBlockScaleCurvePanel) {
      jokerBgBlockScaleCurvePanel = buildCurvePanel(jokerBgBlockScaleCurveMount, CONFIG.jokerSettleTextEffect.bgBlockScaleCurve, {
        label: "红色方块大小缩放曲线",
        onChange: () => {
          notify("jokerSettleTextEffect.bgBlockScaleCurve", CONFIG.jokerSettleTextEffect.bgBlockScaleCurve);
        }
      });

      syncers.push(() => {
        if (jokerBgBlockScaleCurvePanel) {
          jokerBgBlockScaleCurvePanel.setCurve(CONFIG.jokerSettleTextEffect.bgBlockScaleCurve);
        }
      });
    }

    const jokerBgBlockFadeCurveMount = document.getElementById("mount-jokerBgBlockFadeCurve");
    if (jokerBgBlockFadeCurveMount && !jokerBgBlockFadeCurvePanel) {
      jokerBgBlockFadeCurvePanel = buildCurvePanel(jokerBgBlockFadeCurveMount, CONFIG.jokerSettleTextEffect.bgBlockFadeCurve, {
        label: "红色方块透明度淡出曲线",
        onChange: () => {
          notify("jokerSettleTextEffect.bgBlockFadeCurve", CONFIG.jokerSettleTextEffect.bgBlockFadeCurve);
        }
      });

      syncers.push(() => {
        if (jokerBgBlockFadeCurvePanel) {
          jokerBgBlockFadeCurvePanel.setCurve(CONFIG.jokerSettleTextEffect.bgBlockFadeCurve);
        }
      });
    }

    bindToggle("inp-playPileSettleTextEffectEnabled", "val-playPileSettleTextEffectEnabled", "playPileSettleTextEffect.enabled");
    bindNumber("inp-playPileSettleTextEffectFontSize", "val-playPileSettleTextEffectFontSize", "playPileSettleTextEffect.fontSize", { integer: true });
    bindNumber("inp-playPileSettleTextEffectLetterSpacing", "val-playPileSettleTextEffectLetterSpacing", "playPileSettleTextEffect.letterSpacing", { digits: 1 });
    bindColor("inp-playPileSettleTextEffectColor", "val-playPileSettleTextEffectColor", "playPileSettleTextEffect.color");
    bindNumber("inp-playPileSettleTextEffectOffsetY", "val-playPileSettleTextEffectOffsetY", "playPileSettleTextEffect.offsetY", { digits: 1 });
    
    bindNumber("inp-playPileSettleTextEffectFirstCharDelayMS", "val-playPileSettleTextEffectFirstCharDelayMS", "playPileSettleTextEffect.firstCharDelayMS", { integer: true });
    bindNumber("inp-playPileSettleTextEffectCharIntervalMS", "val-playPileSettleTextEffectCharIntervalMS", "playPileSettleTextEffect.charIntervalMS", { integer: true });
    bindNumber("inp-playPileSettleTextEffectCharIntervalReductionMS", "val-playPileSettleTextEffectCharIntervalReductionMS", "playPileSettleTextEffect.charIntervalReductionMS", { integer: true });

    bindNumber("inp-playPileSettleTextEffectAngularFreq", "val-playPileSettleTextEffectAngularFreq", "playPileSettleTextEffect.angularFreq", { digits: 1 });
    bindNumber("inp-playPileSettleTextEffectDampingRatio", "val-playPileSettleTextEffectDampingRatio", "playPileSettleTextEffect.dampingRatio", { digits: 2 });
    bindNumber("inp-playPileSettleTextEffectMass", "val-playPileSettleTextEffectMass", "playPileSettleTextEffect.mass", { digits: 2 });
    bindNumber("inp-playPileSettleTextEffectImpulseScale", "val-playPileSettleTextEffectImpulseScale", "playPileSettleTextEffect.impulseScale", { digits: 2 });
    bindNumber("inp-playPileSettleTextEffectMaxDurationMS", "val-playPileSettleTextEffectMaxDurationMS", "playPileSettleTextEffect.maxDurationMS", { integer: true });
    bindNumber("inp-playPileSettleTextEffectImpulseScaleVel", "val-playPileSettleTextEffectImpulseScaleVel", "playPileSettleTextEffect.impulseScaleVel", { digits: 2 });
    bindNumber("inp-playPileSettleTextEffectSettleEpsScale", "val-playPileSettleTextEffectSettleEpsScale", "playPileSettleTextEffect.settleEpsScale", { digits: 4 });
    bindNumber("inp-playPileSettleTextEffectSettleVelScale", "val-playPileSettleTextEffectSettleVelScale", "playPileSettleTextEffect.settleVelScale", { digits: 3 });
    bindNumber("inp-playPileSettleTextEffectMaxDtSec", "val-playPileSettleTextEffectMaxDtSec", "playPileSettleTextEffect.maxDtSec", { digits: 4 });
    bindNumber("inp-playPileSettleTextEffectSubsteps", "val-playPileSettleTextEffectSubsteps", "playPileSettleTextEffect.substeps", { integer: true });

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

    // === 【弹弹动画】文字抖动 ===
    bindSectionExpand("inp-expandTextJitter", "val-expandTextJitter", "cardVisuals.expandedSections.textJitter", "sect-textJitter-params");
    bindToggle("inp-textJitterEnabled", "val-textJitterEnabled", "textJitter.enabled");
    bindNumber("inp-textJitterBaseAngleDeg", "val-textJitterBaseAngleDeg", "textJitter.baseAngleDeg", { digits: 1 });
    bindNumber("inp-textJitterFrequencyHz", "val-textJitterFrequencyHz", "textJitter.frequencyHz", { digits: 1 });
    bindNumber("inp-textJitterPhaseStaggerDeg", "val-textJitterPhaseStaggerDeg", "textJitter.phaseStaggerDeg", { digits: 1 });
    bindNumber("inp-textJitterDigitGrowth", "val-textJitterDigitGrowth", "textJitter.digitGrowth", { digits: 2 });
    bindNumber("inp-textJitterMinDigits", "val-textJitterMinDigits", "textJitter.minDigits", { integer: true });
    bindNumber("inp-textJitterSpeedRatio", "val-textJitterSpeedRatio", "textJitter.speedRatio", { digits: 2 });
    bindNumber("inp-textJitterPivotX", "val-textJitterPivotX", "textJitter.pivotX", { digits: 2 });
    bindNumber("inp-textJitterPivotY", "val-textJitterPivotY", "textJitter.pivotY", { digits: 2 });

    // === 【弹弹动画】筹码数字 ===
    bindSectionExpand("inp-expandChipsBounce", "val-expandChipsBounce", "cardVisuals.expandedSections.chipsBounce", "sect-chipsBounce-params");
    bindNumber("inp-chipsBounceInitScale", "val-chipsBounceInitScale", "chipsBounce.initScale", { digits: 2 });
    bindNumber("inp-chipsBounceMaxScale", "val-chipsBounceMaxScale", "chipsBounce.maxScale", { digits: 2 });
    bindNumber("inp-chipsBounceStableScale", "val-chipsBounceStableScale", "chipsBounce.stableScale", { digits: 2 });
    bindNumber("inp-chipsBounceScanSpeed", "val-chipsBounceScanSpeed", "chipsBounce.scanSpeed", { integer: true });
    bindNumber("inp-chipsBounceScaleStrength", "val-chipsBounceScaleStrength", "chipsBounce.scaleStrength", { digits: 2 });
    bindNumber("inp-chipsBounceSpeedRatio", "val-chipsBounceSpeedRatio", "chipsBounce.speedRatio", { digits: 2 });

    // === 【弹弹动画】倍率数字（弹簧阻尼，对齐出牌堆结算） ===
    bindSectionExpand("inp-expandMultBounce", "val-expandMultBounce", "cardVisuals.expandedSections.multBounce", "sect-multBounce-params");
    bindNumber("inp-multBounceScanSpeed", "val-multBounceScanSpeed", "multBounce.scanSpeed", { integer: true });
    bindNumber("inp-multBounceSpeedRatio", "val-multBounceSpeedRatio", "multBounce.speedRatio", { digits: 2 });
    bindNumber("inp-multBounceAngularFreq", "val-multBounceAngularFreq", "multBounce.angularFreq", { digits: 1 });
    bindNumber("inp-multBounceDampingRatio", "val-multBounceDampingRatio", "multBounce.dampingRatio", { digits: 2 });
    bindNumber("inp-multBounceMass", "val-multBounceMass", "multBounce.mass", { digits: 2 });
    bindNumber("inp-multBounceImpulseScale", "val-multBounceImpulseScale", "multBounce.impulseScale", { digits: 2 });
    bindNumber("inp-multBounceImpulseRotDeg", "val-multBounceImpulseRotDeg", "multBounce.impulseRotDeg", { digits: 1 });
    bindNumber("inp-multBounceMaxDurationMS", "val-multBounceMaxDurationMS", "multBounce.maxDurationMS", { integer: true });
    bindNumber("inp-multBounceImpulseScaleVel", "val-multBounceImpulseScaleVel", "multBounce.impulseScaleVel", { digits: 2 });
    bindNumber("inp-multBounceImpulseRotVelDeg", "val-multBounceImpulseRotVelDeg", "multBounce.impulseRotVelDeg", { digits: 1 });
    bindNumber("inp-multBounceSettleEpsScale", "val-multBounceSettleEpsScale", "multBounce.settleEpsScale", { digits: 4 });
    bindNumber("inp-multBounceSettleVelScale", "val-multBounceSettleVelScale", "multBounce.settleVelScale", { digits: 3 });
    bindNumber("inp-multBounceSettleEpsRotDeg", "val-multBounceSettleEpsRotDeg", "multBounce.settleEpsRotDeg", { digits: 2 });
    bindNumber("inp-multBounceSettleVelRotDeg", "val-multBounceSettleVelRotDeg", "multBounce.settleVelRotDeg", { digits: 1 });
    bindNumber("inp-multBounceMaxDtSec", "val-multBounceMaxDtSec", "multBounce.maxDtSec", { digits: 4 });
    bindNumber("inp-multBounceSubsteps", "val-multBounceSubsteps", "multBounce.substeps", { integer: true });

    // 牌型文字弹弹已复用 chipsBounce；牌型等级弹弹已复用 multBounce（无独立专区）

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
    bindNumber("inp-evalScoreTextStayDurationMS", "val-evalScoreTextStayDurationMS", "evalScoreText.stayDurationMS", { integer: true });

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
  let editModePicker: UIEditModePicker | null = null;
  const treeMount = document.getElementById("ui-hierarchy-tree");
  if (treeMount && worldRoot) {
    hierarchyView = new HierarchyView({ mount: treeMount, worldRoot });
  } else if (treeMount && !worldRoot) {
    treeMount.textContent = "（未注入 worldRoot，Hierarchy 视图不可用）";
  }

  // 界面UI · 编辑模式：画面悬停高亮 → 点击 → 树中逐级展开并高亮参数。
  const editModeBtn = document.getElementById("btn-ui-edit-mode") as HTMLButtonElement | null;
  const editModeVal = document.getElementById("val-ui-edit-mode");
  if (hierarchyView && editModeBtn) {
    const view = hierarchyView;
    editModePicker = new UIEditModePicker({
      onPick(node) {
        // 确保面板可见并切到「界面UI」分组，再展开路径。
        panel.style.display = "flex";
        clampPanelToViewport();
        activateGroupByLabel("界面UI");
        view.revealAndHighlight(node.nodeId);
      },
      onActiveChange(active) {
        editModeBtn.classList.toggle("is-active", active);
        editModeBtn.textContent = active ? "编辑中…（Esc 取消）" : "编辑模式";
        if (editModeVal) editModeVal.textContent = active ? "开" : "关";
      },
    });
    editModePicker.attach();
    editModeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      editModePicker?.toggle();
    });
  } else if (editModeBtn) {
    editModeBtn.disabled = true;
    editModeBtn.title = "Hierarchy 未就绪，无法使用编辑模式";
  }

  return {
    refresh(): void {
      refreshAllControls();
      lastHistorySnapshot = cloneConfig(CONFIG);
    },
    destroy(): void {
      editModePicker?.destroy();
      hierarchyView?.destroy();
      bgBlockFadeCurvePanel?.destroy();
      bgBlockScaleCurvePanel?.destroy();
      jokerBgBlockFadeCurvePanel?.destroy();
      jokerBgBlockScaleCurvePanel?.destroy();
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
