/**
 * BreathingTextComponent
 * ---------------------------------------------------------------
 * 给"文字 / 数字"做逐字呼吸（起伏）效果：从左到右每个字依次开始一段
 * 用三次贝塞尔曲线塑形的 y 方向偏移，到最高点再回落到 0。
 *
 * 适配范围（强隔离）：
 *   - 只能挂在 UIText（暴露 getPixiText() 的节点）上。
 *   - 注册时通过 canAttach 把面板"添加组件"下拉中的非文字节点过滤掉。
 *   - 万一外部代码硬塞到非 UIText 上，apply / 每帧 tick 都会自动 no-op，
 *     不影响宿主的常规渲染。
 *
 * 工作原理：
 *   1. 把宿主里那一份 PIXI.Text 临时设为不可见，但保留它的样式 / anchor /
 *      tint 作为"渲染模板"。
 *   2. 拷贝它的 style，给文本里的每个**可见字符**各建一个独立 PIXI.Text，
 *      横向按原文本布局排好（保留原 anchor 的对齐方式）。
 *   3. 每帧给每个字算 `t = ((now - i*stagger) mod cycle) / cycle`，再过曲线
 *      得到 y 偏移 (0 → maxY → 0 之类的形状由 curve 控制)。
 *
 * 卸载（onDetach / 失效）时：销毁所有逐字 Text，把宿主 PIXI.Text 设回可见。
 *
 * inspector 字段：
 *   - enabled        是否启用
 *   - stagger        每个字之间的"开始"延迟（毫秒）
 *   - cycle          单个字完成一次起伏的时长（毫秒）
 *   - loopGap        一个字两次循环之间的停顿（毫秒，0 = 无缝）
 *   - amplitudeMin   最低点（像素，初始就是 0；负值=向上）
 *   - amplitudeMax   最高点（像素，负值=向上）
 *   - curve          单字起伏的速率曲线（三次贝塞尔，BezierCurveEditor）
 *
 * 注意：曲线的 y 是"位移的归一化进度"，0 表示停在 amplitudeMin（一般是 0），
 * 1 表示到 amplitudeMax。如果想要"先升后降"的完整波形，请在曲线中部把
 * y 拉到 1、两端拉到 0；BezierCurveEditor 的 startScale/endScale 暴露成
 * 0/0，就会精确得到首尾归 0 的波形。
 */
import { Text } from "pixi.js";
import { UIComponent, type SerializedComponent } from "../UIComponent";
import { uiHierarchy } from "../UIHierarchy";
import { attachDragScrub } from "@/debug/dragScrub";
import { buildCurvePanel, cubic, type BezierCurvePanel } from "@/debug/BezierCurveEditor";
import type { BezierCurveConfig } from "@game/config";
import type { UIText } from "@ui/components/UIText";

interface BreathingTextData {
  enabled: boolean;
  /** 每个字之间的"起始延迟"。下一个字相对上一个延后多久开始它的波形。 */
  stagger: number;
  /** 单字波形周期：从开始升起到回到 0 一共这么久。 */
  cycle: number;
  /** 单字两次循环之间的停顿。stagger 是字间相位差，loopGap 是同一字的两次波之间的"歇一会"。 */
  loopGap: number;
  /** 起伏最低点（像素，正向 = 向下，负 = 向上；通常 = 0）。 */
  amplitudeMin: number;
  /** 起伏最高点（像素，正向 = 向下，负 = 向上）。 */
  amplitudeMax: number;
  /** 单字 y 偏移的归一化曲线（0..1 输入 → 0..1 输出；输出 0 对应 min，1 对应 max）。 */
  curve: BezierCurveConfig;
}

const DEFAULT_DATA: BreathingTextData = {
  enabled: true,
  stagger: 80,
  cycle: 700,
  loopGap: 200,
  amplitudeMin: 0,
  amplitudeMax: -10,
  // 默认曲线：easeOut（"快速上拉、缓缓回落"的呼吸感）。
  // sampleBreathCurve 会把 t 折叠成 |2t-1| 的三角再过曲线，所以端点 (0,0)/(1,1)
  // 的固定属性正好保证"起伏开始 / 结束时位移=0"。
  curve: {
    enabled: true,
    // startScale / endScale 在 BreathingText 里**未使用**（端点固定为 0）；
    // 留着是为了与 BezierCurvePanel 共用面板，便于以后扩展。
    startScale: 0,
    endScale: 1,
    p1: { x: 0, y: 0 },
    p2: { x: 0.58, y: 1 },
  },
};

function cloneCurve(c: BezierCurveConfig): BezierCurveConfig {
  return {
    enabled: c.enabled,
    startScale: c.startScale,
    endScale: c.endScale,
    p1: { x: c.p1.x, y: c.p1.y },
    p2: { x: c.p2.x, y: c.p2.y },
  };
}

/**
 * 用曲线把 [0,1] 的归一化时间进度映射成"位移强度"。
 *
 * 设计要点（这版要解决"长周期下动画一帧一帧硬切"的卡顿感）：
 *
 *   1) 单字波形用 sin²(πt)：t=0→0.5→1 时位移 0→1→0，
 *      并且一阶导数在端点 / 峰值处都连续。换言之"位置"和"速度"
 *      都不会出现折角，长 cycle 时也不会有"上到顶突然反向"的硬切。
 *
 *   2) 曲线作为"时间整形 (time warping)"：先把原始时间 t 过贝塞尔
 *      得到一个新的 t'（曲线端点固定 (0,0)/(1,1)，本身就是 0→1 单调），
 *      再喂给 sin²。这样曲线的语义对呼吸来说是直观的：
 *        - Linear  ：标准正弦呼吸（上升下降对称）。
 *        - EaseOut ：前段被拉长 → "缓慢起、快速落"。
 *        - EaseIn  ：前段被压缩 → "快速起、缓慢落"。
 *        - Smooth  ：起伏更慢更柔，更像深呼吸。
 *
 *   旧实现把 t 折叠成 |2t-1| 的三角波，然后再喂给贝塞尔；三角波本身
 *   在峰值处导数不连续，所以即使曲线再光滑也会留下一个"折角"，
 *   长 cycle 时这一帧的速度突变就被看出来了。
 */
function sampleBreathCurve(curve: BezierCurveConfig, t: number): number {
  const tt = Math.max(0, Math.min(1, t));
  // 第一步：时间整形。曲线未启用就走 identity（=纯正弦呼吸）。
  const warped =
    curve && curve.enabled !== false
      ? Math.max(0, Math.min(1, cubic(0, curve.p1.y, curve.p2.y, 1, tt)))
      : tt;
  // 第二步：sin²(π * t') —— 在端点 / 峰值都 C¹ 连续的钟形波。
  const s = Math.sin(Math.PI * warped);
  return s * s;
}

/** 判断宿主是不是 UIText（有 getPixiText 接口）。 */
function isTextHost(host: unknown): host is UIText {
  return (
    !!host &&
    typeof host === "object" &&
    typeof (host as { getPixiText?: unknown }).getPixiText === "function"
  );
}

/** UIText 视为本组件的合法宿主；其它 UINode（Panel、Button 容器等）不行。 */
export function breathingTextCanAttach(host: import("../UINode").UINode): boolean {
  return isTextHost(host);
}

export class BreathingTextComponent extends UIComponent {
  readonly type = "breathingText";
  readonly displayName = "逐字呼吸";

  private data: BreathingTextData = {
    ...DEFAULT_DATA,
    curve: cloneCurve(DEFAULT_DATA.curve),
  };

  /** 当前生成出来的逐字 Text 节点（按字符顺序）。 */
  private chars: Text[] = [];
  /** 每个字的"基线 y"（不动状态下的 y 值；偏移叠在它上面）。 */
  private baseY: number[] = [];
  /** 上次成功 split 时宿主显示的文本，用于检测文本变化触发重建。 */
  private lastText = "";
  /** 上次成功 split 时使用的 style hash，用于检测样式变化（字号 / 颜色 / 字体等）。 */
  private lastStyleHash = "";
  /** App ticker 反注册函数（每帧 tick）。 */
  private unsubscribeTick: (() => void) | null = null;
  /** uiHierarchy 反注册（监听 textStyle 改变以重建逐字 Text）。 */
  private unsubscribeHierarchy: (() => void) | null = null;
  /** 组件挂载的时间戳（performance.now），用作相位起点。 */
  private startTime = 0;

  // ---- 生命周期 ------------------------------------------------

  protected override onAttach(): void {
    if (!isTextHost(this.host)) {
      // 不是文字宿主 —— 直接 no-op。不要污染宿主的渲染。
      return;
    }

    this.startTime = performance.now();

    // 监听别的组件 / 业务把宿主文本或样式改了 —— 我们要 rebuild 逐字 Text。
    this.unsubscribeHierarchy = uiHierarchy.subscribe((type, node) => {
      if (node !== this.host) return;
      if (type !== "componentsChanged") return;
      // 文字 / 样式可能变了，按需重建（rebuildIfNeeded 内部做 hash 判等）。
      this.rebuildIfNeeded();
    });

    // 每帧驱动 y 偏移。
    const ticker = uiHierarchy.getTicker();
    if (ticker) {
      const onTick = (): void => this.tick();
      ticker.add(onTick);
      this.unsubscribeTick = (): void => {
        ticker.remove(onTick);
      };
    }

    this.rebuildIfNeeded();
  }

  protected override onDetach(): void {
    if (this.unsubscribeTick) {
      this.unsubscribeTick();
      this.unsubscribeTick = null;
    }
    if (this.unsubscribeHierarchy) {
      this.unsubscribeHierarchy();
      this.unsubscribeHierarchy = null;
    }
    this.teardownChars();
    // 把原生 PIXI.Text 还回去
    if (isTextHost(this.host)) {
      const pt = this.host.getPixiText();
      pt.visible = true;
    }
  }

  apply(): void {
    if (!isTextHost(this.host)) return;
    if (!this.data.enabled) {
      // 关闭：拆掉逐字 Text，让原生 Text 显示
      this.teardownChars();
      this.host.getPixiText().visible = true;
      return;
    }
    this.rebuildIfNeeded(true);
  }

  // ---- 拆分 & 重建 ----------------------------------------------

  /** 把宿主当前样式做个简易 hash，用来检测是否需要重建逐字 Text。 */
  private computeStyleHash(t: Text): string {
    const s = t.style;
    return [
      s.fontFamily,
      s.fontSize,
      s.fontWeight,
      s.fontStyle,
      // fill 可能是 number / string / 数组，JSON 化最稳。
      JSON.stringify((s as unknown as { fill?: unknown }).fill ?? null),
      s.stroke ? JSON.stringify(s.stroke) : "",
      s.letterSpacing ?? 0,
      t.anchor.x,
      t.anchor.y,
    ].join("|");
  }

  private rebuildIfNeeded(force = false): void {
    if (!isTextHost(this.host)) return;
    if (!this.data.enabled) {
      this.teardownChars();
      this.host.getPixiText().visible = true;
      return;
    }
    const src = this.host.getPixiText();
    const text = src.text;
    const styleHash = this.computeStyleHash(src);
    if (
      !force &&
      text === this.lastText &&
      styleHash === this.lastStyleHash &&
      this.chars.length > 0
    ) {
      return;
    }
    this.teardownChars();
    this.buildChars(src, text);
    this.lastText = text;
    this.lastStyleHash = styleHash;
  }

  private buildChars(src: Text, text: string): void {
    // 没字符可拆 —— 仍然隐藏原 Text 没意义，直接退出，让原 Text 自己渲染（空串无视觉影响）。
    if (text.length === 0) return;

    // 利用原 Text 的位置 / 样式 / anchor / tint 做模板。
    const style = src.style;
    const anchorX = src.anchor.x;
    const anchorY = src.anchor.y;
    const tint = src.tint;
    const alpha = src.alpha;

    // 把宿主里那份 Text 隐藏起来：保留它作为"几何模板"和未来恢复用。
    src.visible = false;

    const resolution = src.resolution;

    // 先逐字生成 Text，量宽度。
    // 这里把 "\n" 视为换行，逐字加；逐字效果通常只用单行文字，但有人用换行也能工作。
    // 实际场景里"牌型: 三条"这种短串就够了。
    const chars: Text[] = [];
    const widths: number[] = [];
    let totalWidth = 0;

    for (const ch of [...text]) {
      // 用 [...text] 是为了正确按字符（包括代理对）切分；中文 / emoji 都安全。
      const t = new Text({ text: ch, style, resolution });
      t.anchor.set(0, anchorY);
      t.tint = tint;
      t.alpha = alpha;
      t.eventMode = "none";
      // 关掉每个逐字 Text 的整数像素吸附。
      // 项目全局开了 roundPixels: true（让卡牌精灵图整数对齐避免亚像素闪烁），
      // 但呼吸动画在长周期下单帧位移可能远小于 1 像素 —— 被吸到整数像素后会
      // 表现为"卡好几帧不动、突然跳一格"。这里给文字单独走亚像素位置，
      // 不影响其它素材。
      t.roundPixels = false;
      chars.push(t);
      widths.push(t.width);
      totalWidth += t.width;
    }

    // 计算"首字左边缘"在 src 坐标系下的 x：anchor 决定原 Text 的几何中心，
    // 这里需要让整串字看上去与原 Text 占的位置一致。
    // PIXI.Text 渲染时左边缘 = position.x - anchor.x * width。
    // 我们把每个字独立摆放，让"整串"在父坐标系下与原 Text 重合：
    //   firstLeftX = src.x - anchor.x * totalWidth
    // 然后逐个把 x 累加上去。
    const firstLeftX = src.position.x - anchorX * totalWidth;
    let cursorX = firstLeftX;

    const baseY: number[] = [];
    for (let i = 0; i < chars.length; i += 1) {
      const ch = chars[i]!;
      ch.position.set(cursorX, src.position.y);
      cursorX += widths[i]!;
      baseY.push(src.position.y);
      // 直接挂到宿主上；UINode.resortChildren 只移动 UINode 子节点，
      // 不会把这些纯 PIXI.Text 弄乱顺序。它们与原 src Text 一样属于"内部 PIXI"。
      this.host.addChild(ch);
    }

    this.chars = chars;
    this.baseY = baseY;
  }

  private teardownChars(): void {
    for (const ch of this.chars) {
      if (ch.parent) ch.parent.removeChild(ch);
      ch.destroy();
    }
    this.chars = [];
    this.baseY = [];
  }

  // ---- 每帧 tick ----------------------------------------------

  private tick(): void {
    if (!isTextHost(this.host)) return;
    if (!this.data.enabled) return;

    // 业务代码可能在两次 tick 之间用 UIText.setText 改了内容（如得分滚动）。
    // UIText.setText 不会发 componentsChanged，所以我们这里轻量地比对一下文本/样式，
    // 必要时重建逐字 Text。
    const src = this.host.getPixiText();
    if (src.text !== this.lastText || this.computeStyleHash(src) !== this.lastStyleHash) {
      this.rebuildIfNeeded();
    }

    if (this.chars.length === 0) return;

    const now = performance.now();
    const cycle = Math.max(1, this.data.cycle);
    const gap = Math.max(0, this.data.loopGap);
    const period = cycle + gap;
    const stagger = this.data.stagger;
    const amin = this.data.amplitudeMin;
    const amax = this.data.amplitudeMax;

    for (let i = 0; i < this.chars.length; i += 1) {
      // 每个字的"相位起点"：startTime + i * stagger。
      // 相位差为负就先压在 0（min）等到时机再起。
      const phase = now - this.startTime - i * stagger;
      let intensity = 0; // 0..1：0 = min，1 = max
      if (phase >= 0) {
        const local = phase % period;
        if (local < cycle) {
          const t = local / cycle;
          intensity = sampleBreathCurve(this.data.curve, t);
        } else {
          intensity = 0; // 在 gap 期间，固定在 0
        }
      }
      const offset = amin + (amax - amin) * intensity;
      this.chars[i]!.position.y = this.baseY[i]! + offset;
    }
  }

  // ---- 序列化 ----------------------------------------------------

  serialize(): SerializedComponent {
    return {
      type: this.type,
      data: {
        enabled: this.data.enabled,
        stagger: this.data.stagger,
        cycle: this.data.cycle,
        loopGap: this.data.loopGap,
        amplitudeMin: this.data.amplitudeMin,
        amplitudeMax: this.data.amplitudeMax,
        curve: cloneCurve(this.data.curve),
      },
    };
  }

  deserialize(d: Record<string, unknown>): void {
    if (typeof d["enabled"] === "boolean") this.data.enabled = d["enabled"];
    if (typeof d["stagger"] === "number") this.data.stagger = d["stagger"];
    if (typeof d["cycle"] === "number") this.data.cycle = d["cycle"];
    if (typeof d["loopGap"] === "number") this.data.loopGap = d["loopGap"];
    if (typeof d["amplitudeMin"] === "number")
      this.data.amplitudeMin = d["amplitudeMin"];
    if (typeof d["amplitudeMax"] === "number")
      this.data.amplitudeMax = d["amplitudeMax"];
    const c = d["curve"];
    if (c && typeof c === "object") {
      const obj = c as Partial<BezierCurveConfig> & {
        p1?: { x?: unknown; y?: unknown };
        p2?: { x?: unknown; y?: unknown };
      };
      // 这里"就地修改"this.data.curve 而不是替换引用 —— buildInspector 的
      // BezierCurvePanel 持有同一个 curve 对象的引用，就地改字段后调
      // panel.setCurve / panel.refresh 才能让 UI 反映出来。
      if (typeof obj.enabled === "boolean") this.data.curve.enabled = obj.enabled;
      if (typeof obj.startScale === "number") this.data.curve.startScale = obj.startScale;
      if (typeof obj.endScale === "number") this.data.curve.endScale = obj.endScale;
      if (typeof obj.p1?.x === "number") this.data.curve.p1.x = obj.p1.x as number;
      if (typeof obj.p1?.y === "number") this.data.curve.p1.y = obj.p1.y as number;
      if (typeof obj.p2?.x === "number") this.data.curve.p2.x = obj.p2.x as number;
      if (typeof obj.p2?.y === "number") this.data.curve.p2.y = obj.p2.y as number;
    }
  }

  // ---- inspector DOM --------------------------------------------

  buildInspector(): HTMLElement {
    const root = document.createElement("div");
    root.className = "ui-comp-body";

    if (!isTextHost(this.host)) {
      // 兜底：被错误地挂到非 UIText 上时，给个明确提示而不是默默无声。
      const warn = document.createElement("div");
      warn.className = "ui-comp-error";
      warn.textContent = "逐字呼吸 只能挂在 UIText（文字/数字）节点上。";
      root.appendChild(warn);
      return root;
    }

    const commit = (rebuild = false): void => {
      if (rebuild) this.rebuildIfNeeded(true);
      uiHierarchy.notifyComponentsChanged(this.host);
    };

    // enabled
    {
      const row = document.createElement("div");
      row.className = "ui-comp-row";
      const lab = document.createElement("span");
      lab.className = "ui-comp-row-label";
      lab.textContent = "启用";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = this.data.enabled;
      input.addEventListener("change", () => {
        this.data.enabled = input.checked;
        this.apply();
        commit();
      });
      row.appendChild(lab);
      row.appendChild(input);
      root.appendChild(row);
    }

    // 数值行通用工具
    const numberRow = (
      label: string,
      key: "stagger" | "cycle" | "loopGap" | "amplitudeMin" | "amplitudeMax",
      opts: { step: number; digits: number; min?: number; integer?: boolean },
    ): void => {
      const row = document.createElement("div");
      row.className = "ui-comp-row";
      const lab = document.createElement("span");
      lab.className = "ui-comp-row-label";
      lab.textContent = label;
      const input = document.createElement("input");
      input.type = "number";
      input.className = "panel-number";
      input.step = String(opts.step);
      if (opts.min !== undefined) input.min = String(opts.min);
      input.value = opts.integer
        ? String(Math.round(this.data[key]))
        : this.data[key].toFixed(opts.digits);
      attachDragScrub(input, {
        step: opts.step,
        digits: opts.digits,
        ...(opts.min !== undefined ? { min: opts.min } : {}),
        ...(opts.integer ? { integer: true } : {}),
      });
      input.addEventListener("input", () => {
        const v = Number(input.value);
        if (!Number.isFinite(v)) return;
        const next = opts.min !== undefined ? Math.max(opts.min, v) : v;
        this.data[key] = opts.integer ? Math.round(next) : next;
        commit();
      });
      input.addEventListener("change", () => {
        input.value = opts.integer
          ? String(Math.round(this.data[key]))
          : this.data[key].toFixed(opts.digits);
      });
      row.appendChild(lab);
      row.appendChild(input);
      root.appendChild(row);
    };

    numberRow("字间延迟(ms)", "stagger", { step: 10, digits: 0, min: 0, integer: true });
    numberRow("起伏周期(ms)", "cycle", { step: 50, digits: 0, min: 1, integer: true });
    numberRow("循环间隔(ms)", "loopGap", { step: 50, digits: 0, min: 0, integer: true });
    numberRow("最低点", "amplitudeMin", { step: 1, digits: 1 });
    numberRow("最高点", "amplitudeMax", { step: 1, digits: 1 });

    // 曲线编辑器
    const curveWrap = document.createElement("div");
    curveWrap.className = "ui-comp-curve";
    root.appendChild(curveWrap);

    // BezierCurvePanel 内部会写回我们传入的 curve 对象（引用相同）。
    const panel: BezierCurvePanel = buildCurvePanel(curveWrap, this.data.curve, {
      label: "单字速率曲线",
      onChange: () => {
        // 曲线只影响每帧 tick，不需要 rebuild 逐字 Text。
        commit();
      },
    });
    // 把 panel 句柄存到 root 上，detach 时清理（buildInspector 每次重渲染都会被替换，
    // 旧 panel 会被 DOM 清掉；但 canvas pointer listener 不挂在 document 上，
    // 让它随 element 一起被 GC 即可，不需要主动 destroy）。
    (root as unknown as { __curvePanel?: BezierCurvePanel }).__curvePanel = panel;

    return root;
  }
}
