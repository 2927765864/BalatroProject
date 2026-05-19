/**
 * Unity 风格的「按住拖动调参」工具。
 *
 * 给一个 <input type="number"> 绑定 drag-scrub 能力：
 *   - 在输入框上按住鼠标主键并水平拖动 → 修改数值
 *   - 拖动越远，每像素的增量越大（线性放大，类似 Unity Inspector）
 *   - 修饰键：Shift = ×0.1 精度；Ctrl/Meta = ×10 步长
 *   - 没移动过（点击）时，松开时手动让 input 聚焦，保留原本输入行为
 *
 * 实现思路：
 *   - pointerdown 立刻 preventDefault()，阻止 <input> 的默认聚焦
 *     —— 这是关键。否则一按下就进入文本输入模式，没法识别拖动。
 *   - 用 setPointerCapture 在 input 上吃掉 pointermove，
 *     不需要 pointer lock（它在 <input> 上不可靠且会"鼠标消失"）。
 *   - 拖动距离超过阈值后才正式视为拖动；否则 pointerup 时手动 focus。
 *   - 任何路径退出都会清理 body 的全局光标 class，防卡住。
 */

const DRAG_THRESHOLD_PX = 3;
const PIXELS_PER_STEP = 4; // 起始灵敏度：每 4 像素 = 1 step
const ACCEL_PIXELS = 80; // 从这个距离开始线性放大
const ACCEL_MAX = 8; // 最大放大倍率

export interface DragScrubOptions {
  /** 步长，未指定时从 input.step 读取，仍为空则取 1 */
  step?: number;
  /** 最小值，未指定时从 input.min 读取 */
  min?: number;
  /** 最大值，未指定时从 input.max 读取 */
  max?: number;
  /** 是否限制为整数，默认从 step 推断 */
  integer?: boolean;
  /** 数值显示精度（小数位），默认从 step 推断 */
  digits?: number;
}

function parseAttr(value: string): number | undefined {
  if (value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function inferDigits(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 2;
  if (step >= 1) return 0;
  const s = String(step);
  const dotIdx = s.indexOf(".");
  return dotIdx >= 0 ? s.length - dotIdx - 1 : 0;
}

function clamp(v: number, min: number | undefined, max: number | undefined): number {
  if (min !== undefined && v < min) v = min;
  if (max !== undefined && v > max) v = max;
  return v;
}

function roundToStep(v: number, step: number): number {
  if (step <= 0) return v;
  return Math.round(v / step) * step;
}

/**
 * 给 <input type="number"> 附加「按住拖动调参」能力。
 * 安全调用：重复调用同一个 input 会跳过。
 */
export function attachDragScrub(input: HTMLInputElement, opts: DragScrubOptions = {}): void {
  if (input.dataset["dragScrub"] === "1") return;
  input.dataset["dragScrub"] = "1";
  input.classList.add("drag-scrub");

  let accumDx = 0;
  let totalDx = 0;
  let isDragging = false;
  let pointerId = -1;
  let downClientX = 0;
  let downClientY = 0;

  const resolveStep = (): number => {
    const fromOpt = opts.step;
    const fromAttr = parseAttr(input.step);
    const step = fromOpt ?? fromAttr ?? 1;
    return Number.isFinite(step) && step > 0 ? step : 1;
  };
  const resolveMin = (): number | undefined => opts.min ?? parseAttr(input.min);
  const resolveMax = (): number | undefined => opts.max ?? parseAttr(input.max);

  function cleanup(): void {
    // 用捕获阶段监听 —— 移除时也必须用 capture 标志，否则移不掉
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("pointerup", onPointerUp, true);
    document.removeEventListener("pointercancel", onPointerCancel, true);
    document.body.classList.remove("drag-scrub-active");
    pointerId = -1;
    isDragging = false;
    accumDx = 0;
    totalDx = 0;
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
    // 已经聚焦的输入框：让用户正常编辑文字，不抢拖动
    if (document.activeElement === input) return;

    // 关键：阻止 <input> 的默认聚焦行为
    e.preventDefault();

    pointerId = e.pointerId;
    isDragging = false;
    accumDx = 0;
    totalDx = 0;
    downClientX = e.clientX;
    downClientY = e.clientY;

    // 关键设计：用捕获阶段监听 document。
    //   - 捕获阶段事件从 document 向下传递，先于任何子树的 stopPropagation。
    //   - 这样即便控制面板在自己身上注册了 stopPropagation 阻止冒泡，
    //     我们的拖动逻辑依然能稳定收到 pointermove / pointerup。
    //   - 不依赖 setPointerCapture（它在某些浏览器会因 input.value 改动而意外释放）。
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerCancel, true);
  }

  function beginDrag(): void {
    isDragging = true;
    document.body.classList.add("drag-scrub-active");
  }

  function applyDelta(dxPixels: number, e: PointerEvent): void {
    accumDx += dxPixels;

    const step = resolveStep();
    const min = resolveMin();
    const max = resolveMax();

    let multiplier = 1;
    if (e.shiftKey) multiplier *= 0.1;
    if (e.ctrlKey || e.metaKey) multiplier *= 10;

    const dist = Math.abs(totalDx);
    const accel =
      dist <= ACCEL_PIXELS
        ? 1
        : Math.min(ACCEL_MAX, 1 + (dist - ACCEL_PIXELS) / ACCEL_PIXELS);

    const pxPerStep = PIXELS_PER_STEP / accel;
    const stepsRaw = accumDx / pxPerStep;
    const steps = stepsRaw >= 0 ? Math.floor(stepsRaw) : Math.ceil(stepsRaw);
    if (steps === 0) return;
    accumDx -= steps * pxPerStep;

    const delta = steps * step * multiplier;
    let next = Number(input.value);
    if (!Number.isFinite(next)) next = 0;
    next = next + delta;

    const integer = opts.integer ?? Number.isInteger(step);
    if (!integer) {
      const effectiveStep = step * multiplier;
      if (effectiveStep > 0) next = roundToStep(next, effectiveStep);
    } else {
      next = Math.round(next);
    }
    next = clamp(next, min, max);

    const digits = opts.digits ?? inferDigits(step * (e.shiftKey ? 0.1 : 1));
    const formatted = integer ? String(next) : next.toFixed(digits);
    if (formatted === input.value) return;
    input.value = formatted;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function onPointerMove(e: PointerEvent): void {
    if (e.pointerId !== pointerId) return;

    // 用相对于按下点的总位移，再减去已累计的 totalDx，得到本帧增量。
    // 不用 movementX：它在不同浏览器/缩放下不稳。
    const totalSinceDown = e.clientX - downClientX;
    const dx = totalSinceDown - totalDx;
    if (dx === 0) return;

    if (!isDragging) {
      const absX = Math.abs(totalSinceDown);
      const absY = Math.abs(e.clientY - downClientY);
      if (absX < DRAG_THRESHOLD_PX && absY < DRAG_THRESHOLD_PX) {
        // 还没达到阈值，但 totalDx 也要更新，否则下次 dx 会重复计入
        totalDx = totalSinceDown;
        return;
      }
      // 垂直方向先动得多：视为不是拖动，放弃
      if (absY > absX) {
        cleanup();
        return;
      }
      beginDrag();
      accumDx = 0; // 真正的拖动从 0 开始累
    }
    totalDx = totalSinceDown;
    applyDelta(dx, e);
  }

  function onPointerUp(e: PointerEvent): void {
    if (pointerId !== -1 && e.pointerId !== pointerId) return;
    const wasDragging = isDragging;
    cleanup();
    if (wasDragging) {
      // 与原生 spinner 行为对齐
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      // 没拖动 → 视为点击：手动聚焦并全选，方便直接输入
      input.focus({ preventScroll: true });
      input.select();
    }
  }

  function onPointerCancel(e: PointerEvent): void {
    if (pointerId !== -1 && e.pointerId !== pointerId) return;
    cleanup();
  }

  input.addEventListener("pointerdown", onPointerDown);

  // 兜底：万一某些场景 body class 没清掉，全局 mouseup 再清一次
  // （只清自己留下的状态，开销可忽略）
  window.addEventListener("blur", () => {
    if (pointerId !== -1) cleanup();
  });
}
