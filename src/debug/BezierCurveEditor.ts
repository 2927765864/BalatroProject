/**
 * BezierCurveEditor
 * ------------------------------------------------------------------
 * 一个独立的、与业务解耦的三次贝塞尔曲线编辑器。
 *
 * 用途：当参数数量膨胀时，与其堆砌 slider，不如用一条语义曲线压缩复杂度。
 * 例如：combo 数 → 倍率缩放、压力 → 响应曲线、按手牌数变化某个 endpoint scale。
 *
 * 它只操作一个普通对象（BezierCurveConfig）：
 *   {
 *     enabled, startScale, endScale,
 *     p1: { x, y },
 *     p2: { x, y },
 *   }
 * 端点固定在 (0,0) 与 (1,1)，拖拽 p1 / p2 控制形状。
 */

import type { BezierCurveConfig } from "@game/config";

export interface BezierCurvePanelOptions {
  label?: string;
  onChange?: () => void;
}

export interface BezierCurvePanel {
  refresh(): void;
  setCurve(curve: BezierCurveConfig): void;
  destroy(): void;
}

/** 三次贝塞尔曲线在 t 处的值。 */
export function cubic(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
): number {
  const it = 1 - t;
  return (
    it * it * it * p0 +
    3 * it * it * t * p1 +
    3 * it * t * t * p2 +
    t * t * t * p3
  );
}

/** 在 [0,1] 区间按曲线采样一个标量值（套上 startScale/endScale）。 */
export function sampleCurve(curve: BezierCurveConfig, t: number): number {
  if (!curve || curve.enabled === false) return 1;
  const tt = Math.max(0, Math.min(1, t));
  const y = cubic(0, curve.p1.y, curve.p2.y, 1, tt);
  return curve.startScale + (curve.endScale - curve.startScale) * y;
}

class BezierCurveEditor {
  private readonly canvas: HTMLCanvasElement;
  private curve: BezierCurveConfig;
  private readonly onChange: () => void;
  private readonly pad = 14;
  private readonly dpr = Math.max(1, window.devicePixelRatio || 1);
  private activePoint: "p1" | "p2" | null = null;
  private pointerId: number | undefined;

  constructor(
    canvas: HTMLCanvasElement,
    curve: BezierCurveConfig,
    onChange: () => void,
  ) {
    this.canvas = canvas;
    this.curve = curve;
    this.onChange = onChange;

    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("lostpointercapture", this.onPointerUp);

    this.resize();
    this.draw();
  }

  setCurve(curve: BezierCurveConfig): void {
    this.curve = curve;
    this.draw();
  }

  resize(): void {
    const width = this.canvas.clientWidth || 240;
    const height = this.canvas.clientHeight || 150;
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
  }

  refresh(): void {
    this.resize();
    this.draw();
  }

  destroy(): void {
    const c = this.canvas;
    c.removeEventListener("pointerdown", this.onPointerDown);
    c.removeEventListener("pointermove", this.onPointerMove);
    c.removeEventListener("pointerup", this.onPointerUp);
    c.removeEventListener("pointercancel", this.onPointerUp);
    c.removeEventListener("lostpointercapture", this.onPointerUp);
  }

  applyPreset(name: string): void {
    const presets: Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }> = {
      linear: { p1: { x: 0, y: 0 }, p2: { x: 1, y: 1 } },
      easeIn: { p1: { x: 0.42, y: 0 }, p2: { x: 1, y: 1 } },
      easeOut: { p1: { x: 0, y: 0 }, p2: { x: 0.58, y: 1 } },
      smooth: { p1: { x: 0.42, y: 0 }, p2: { x: 0.58, y: 1 } },
    };
    const preset = presets[name];
    if (!preset) return;
    this.curve.p1 = { ...preset.p1 };
    this.curve.p2 = { ...preset.p2 };
    this.onChange();
    this.draw();
  }

  // --- 坐标变换 -------------------------------------------------

  private toPx(x: number, y: number): { x: number; y: number } {
    const pad = this.pad * this.dpr;
    const innerW = this.canvas.width - pad * 2;
    const innerH = this.canvas.height - pad * 2;
    return { x: pad + x * innerW, y: pad + (1 - y) * innerH };
  }

  private fromPx(px: number, py: number): { x: number; y: number } {
    const pad = this.pad * this.dpr;
    const innerW = this.canvas.width - pad * 2;
    const innerH = this.canvas.height - pad * 2;
    return { x: (px - pad) / innerW, y: 1 - (py - pad) / innerH };
  }

  private eventToPx(event: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * this.dpr,
      y: (event.clientY - rect.top) * this.dpr,
    };
  }

  private hitTest(px: number, py: number): "p1" | "p2" | null {
    const radius = 14 * this.dpr;
    for (const key of ["p1", "p2"] as const) {
      const point = this.curve[key];
      const pos = this.toPx(point.x, point.y);
      const dx = pos.x - px;
      const dy = pos.y - py;
      if (dx * dx + dy * dy <= radius * radius) return key;
    }
    return null;
  }

  // --- 指针交互 -------------------------------------------------

  private onPointerDown(event: PointerEvent): void {
    const { x, y } = this.eventToPx(event);
    const hit = this.hitTest(x, y);
    if (!hit) return;
    event.preventDefault();
    event.stopPropagation();
    this.activePoint = hit;
    this.pointerId = event.pointerId;
    this.canvas.setPointerCapture?.(event.pointerId);
    this.draw();
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.activePoint || event.pointerId !== this.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const { x, y } = this.eventToPx(event);
    const data = this.fromPx(x, y);
    const point = this.curve[this.activePoint];
    point.x = Math.max(0, Math.min(1, data.x));
    // 允许 y 略出界（-0.3 ~ 1.3）以制造冲量/回弹曲线
    point.y = Math.max(-0.3, Math.min(1.3, data.y));
    this.onChange();
    this.draw();
  }

  private onPointerUp(event: PointerEvent): void {
    if (!this.activePoint || event.pointerId !== this.pointerId) return;
    this.activePoint = null;
    this.pointerId = undefined;
    this.canvas.releasePointerCapture?.(event.pointerId);
    this.draw();
  }

  // --- 绘制 -----------------------------------------------------

  private draw(): void {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;

    const width = this.canvas.width;
    const height = this.canvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
    ctx.fillRect(0, 0, width, height);

    // 网格
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = this.dpr;
    ctx.beginPath();
    for (let i = 0; i <= 4; i += 1) {
      const t = i / 4;
      const a = this.toPx(0, t);
      const b = this.toPx(1, t);
      const c = this.toPx(t, 0);
      const d = this.toPx(t, 1);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(d.x, d.y);
    }
    ctx.stroke();

    const start = this.toPx(0, 0);
    const end = this.toPx(1, 1);
    const p1 = this.toPx(this.curve.p1.x, this.curve.p1.y);
    const p2 = this.toPx(this.curve.p2.x, this.curve.p2.y);

    // 控制柄虚线
    ctx.setLineDash([4 * this.dpr, 4 * this.dpr]);
    ctx.strokeStyle = "rgba(145,197,58,0.45)";
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // 曲线本体
    ctx.strokeStyle = "#91c53a";
    ctx.lineWidth = 2 * this.dpr;
    ctx.beginPath();
    for (let i = 0; i <= 48; i += 1) {
      const t = i / 48;
      const x = cubic(0, this.curve.p1.x, this.curve.p2.x, 1, t);
      const y = cubic(0, this.curve.p1.y, this.curve.p2.y, 1, t);
      const pos = this.toPx(x, y);
      if (i === 0) ctx.moveTo(pos.x, pos.y);
      else ctx.lineTo(pos.x, pos.y);
    }
    ctx.stroke();

    // 控制点
    for (const [pos, key] of [
      [p1, "p1"],
      [p2, "p2"],
    ] as const) {
      ctx.fillStyle = this.activePoint === key ? "#cbe88b" : "#91c53a";
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 2 * this.dpr;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 6 * this.dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}

/**
 * 在指定 mount 元素中渲染一个完整的曲线面板（曲线 + 起终倍率 + 预设按钮）。
 * 返回 refresh/setCurve/destroy 三个钩子，便于外部在加载 preset 时刷新。
 */
export function buildCurvePanel(
  mount: HTMLElement,
  initialCurve: BezierCurveConfig,
  options: BezierCurvePanelOptions = {},
): BezierCurvePanel {
  const { label = "Curve", onChange = () => {} } = options;
  let curve = initialCurve;

  mount.innerHTML = "";
  mount.className = "bezier-panel";
  mount.innerHTML = `
    <div class="bezier-header">
      <strong>${label}</strong>
      <label><input type="checkbox" class="bezier-enabled"> 启用</label>
    </div>
    <canvas class="bezier-canvas"></canvas>
    <div class="bezier-scales">
      <label><span>起点倍率</span><input class="panel-number bezier-start" type="number" step="0.1"></label>
      <label><span>终点倍率</span><input class="panel-number bezier-end" type="number" step="0.1"></label>
    </div>
    <div class="bezier-presets">
      <button type="button" data-preset="linear">Linear</button>
      <button type="button" data-preset="easeIn">EaseIn</button>
      <button type="button" data-preset="easeOut">EaseOut</button>
      <button type="button" data-preset="smooth">Smooth</button>
    </div>
  `;

  const canvas = mount.querySelector("canvas") as HTMLCanvasElement;
  const enabled = mount.querySelector(".bezier-enabled") as HTMLInputElement;
  const startInput = mount.querySelector(".bezier-start") as HTMLInputElement;
  const endInput = mount.querySelector(".bezier-end") as HTMLInputElement;

  const editor = new BezierCurveEditor(canvas, curve, onChange);

  function refresh(): void {
    enabled.checked = curve.enabled !== false;
    startInput.value = Number(curve.startScale ?? 1).toFixed(2);
    endInput.value = Number(curve.endScale ?? 1).toFixed(2);
    editor.refresh();
  }

  enabled.addEventListener("change", () => {
    curve.enabled = enabled.checked;
    onChange();
  });

  const commitScale = (): void => {
    const startValue = Number(startInput.value);
    const endValue = Number(endInput.value);
    if (Number.isFinite(startValue)) curve.startScale = startValue;
    if (Number.isFinite(endValue)) curve.endScale = endValue;
    onChange();
    editor.refresh();
  };
  startInput.addEventListener("input", commitScale);
  endInput.addEventListener("input", commitScale);

  mount.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.preset;
      if (name) editor.applyPreset(name);
    });
  });

  refresh();

  return {
    refresh,
    setCurve(next: BezierCurveConfig): void {
      curve = next;
      editor.setCurve(next);
      refresh();
    },
    destroy(): void {
      editor.destroy();
    },
  };
}
