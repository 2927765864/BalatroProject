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
import { HierarchyView } from "./HierarchyView";
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

    // === 牌的绘制 ===
    bindToggle("inp-useSprites", "val-useSprites", "cardArt.useSprites");
    bindNumber("inp-cardCornerRadius", "val-cardCornerRadius", "cardArt.cornerRadius", { digits: 1 });
    bindColor("inp-faceColor", "val-faceColor", "cardArt.faceColor");
    bindColor("inp-outlineColor", "val-outlineColor", "cardArt.outlineColor");
    bindCardBackPicker("card-back-picker", "val-cardBack");

    // === 卡牌视效 ===
    bindColor("inp-shadowColor", "val-shadowColor", "cardShadow.color");
    bindNumber("inp-shadowAlpha", "val-shadowAlpha", "cardShadow.alpha", { digits: 2 });
    bindNumber("inp-shadowLightX", "val-shadowLightX", "cardShadow.lightX", { digits: 1 });
    bindNumber("inp-shadowLightY", "val-shadowLightY", "cardShadow.lightY", { digits: 1 });
    bindNumber("inp-shadowDistanceRatio", "val-shadowDistanceRatio", "cardShadow.distanceRatio", { digits: 5 });
    bindNumber("inp-shadowScaleRatio", "val-shadowScaleRatio", "cardShadow.scaleRatio", { digits: 2 });

    bindColor("inp-dragShadowColor", "val-dragShadowColor", "dragShadow.color");
    bindNumber("inp-dragShadowAlpha", "val-dragShadowAlpha", "dragShadow.alpha", { digits: 2 });
    bindNumber("inp-dragShadowLightX", "val-dragShadowLightX", "dragShadow.lightX", { digits: 1 });
    bindNumber("inp-dragShadowLightY", "val-dragShadowLightY", "dragShadow.lightY", { digits: 1 });
    bindNumber("inp-dragShadowDistanceRatio", "val-dragShadowDistanceRatio", "dragShadow.distanceRatio", { digits: 5 });
    bindNumber("inp-dragShadowScaleRatio", "val-dragShadowScaleRatio", "dragShadow.scaleRatio", { digits: 2 });

    // === 新增卡牌视效与逻辑参数 ===
    bindToggle("inp-breathingEnabled", "val-breathingEnabled", "cardVisuals.breathingEnabled");
    bindNumber("inp-breathingSpeed", "val-breathingSpeed", "cardVisuals.breathingSpeed", { digits: 4 });
    bindNumber("inp-breathingAmplitude", "val-breathingAmplitude", "cardVisuals.breathingAmplitude", { digits: 1 });
    bindNumber("inp-wobbleSpeed", "val-wobbleSpeed", "cardVisuals.wobbleSpeed", { digits: 4 });
    bindNumber("inp-wobbleAmplitude", "val-wobbleAmplitude", "cardVisuals.wobbleAmplitude", { digits: 3 });

    bindToggle("inp-hoverScaleEnabled", "val-hoverScaleEnabled", "cardVisuals.hoverScaleEnabled");
    bindNumber("inp-hoverScaleFactor", "val-hoverScaleFactor", "cardVisuals.hoverScaleFactor", { digits: 2 });
    bindNumber("inp-hoverScaleSpeed", "val-hoverScaleSpeed", "cardVisuals.hoverScaleSpeed", { digits: 2 });

    bindToggle("inp-mouseOffsetEnabled", "val-mouseOffsetEnabled", "cardVisuals.mouseOffsetEnabled");
    bindNumber("inp-mouseOffsetFactorX", "val-mouseOffsetFactorX", "cardVisuals.mouseOffsetFactorX", { digits: 3 });
    bindNumber("inp-mouseOffsetFactorY", "val-mouseOffsetFactorY", "cardVisuals.mouseOffsetFactorY", { digits: 3 });
    bindNumber("inp-mouseOffsetLimit", "val-mouseOffsetLimit", "cardVisuals.mouseOffsetLimit", { digits: 1 });

    bindNumber("inp-clickThresholdMS", "val-clickThresholdMS", "cardVisuals.clickThresholdMS", { integer: true });

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
