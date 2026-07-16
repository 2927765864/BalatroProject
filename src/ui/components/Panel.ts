import { Graphics } from "pixi.js";
import { UINode } from "@ui/hierarchy";

/**
 * 通用圆角面板
 *
 * 实现约定：
 *   - Panel 自身是空 UINode，只承担"挂载点 + transform"。
 *   - 填充与描边拆成两个完全独立的单色 UINode：
 *       Panel → PanelBackground（填充）→ [可选] PanelBorder（描边）
 *   - 每个叶子 Graphics 一律以白色（0xffffff）绘制几何，颜色通过 tint 直接指定。
 *     这样「颜色」组件改的是直接色值，而不是对已有色做相乘；
 *     且只作用在本节点的非 UINode 子显示对象上，不会下传到子 UINode。
 */
export interface PanelOptions {
  /** UI Hierarchy 中的稳定 id，例如 "hud.leftPanel"。 */
  id: string;
  /** Hierarchy 中显示的名字。 */
  displayName: string;
  width: number;
  height: number;
  fill: number;
  radius?: number;
  borderColor?: number;
  borderWidth?: number;
}

export class Panel extends UINode {
  private readonly background: PanelBackground;
  private border: PanelBorder | null = null;
  private opts: PanelOptions;

  constructor(opts: PanelOptions) {
    super({ id: opts.id, displayName: opts.displayName });
    this.opts = opts;
    this.background = new PanelBackground({
      id: `${opts.id}.background`,
      displayName: "背景",
      width: opts.width,
      height: opts.height,
      fill: opts.fill,
      radius: opts.radius,
    });
    this.addChild(this.background);

    if (opts.borderColor !== undefined && opts.borderWidth !== undefined) {
      this.border = new PanelBorder({
        id: `${opts.id}.border`,
        displayName: "描边",
        width: opts.width,
        height: opts.height,
        color: opts.borderColor,
        borderWidth: opts.borderWidth,
        radius: opts.radius,
      });
      this.addChild(this.border);
    }
  }

  setSize(width: number, height: number): void {
    this.opts = { ...this.opts, width, height };
    this.background.setSize(width, height);
    this.border?.setSize(width, height);
  }

  setFill(fill: number): void {
    this.opts = { ...this.opts, fill };
    this.background.setFill(fill);
  }
}

// ---- 填充（单色） -------------------------------------------------

export interface PanelBackgroundOptions {
  id: string;
  displayName: string;
  width: number;
  height: number;
  fill: number;
  radius?: number;
}

/**
 * 圆角矩形填充叶子。几何恒为白，颜色 = Graphics.tint。
 * 旧 API 的 border* 已移除：描边请用独立的 PanelBorder 节点。
 */
export class PanelBackground extends UINode {
  private readonly g = new Graphics();
  private opts: PanelBackgroundOptions;

  constructor(opts: PanelBackgroundOptions) {
    super({ id: opts.id, displayName: opts.displayName });
    this.opts = opts;
    this.g.label = "shape";
    this.addChild(this.g);
    this.redraw();
  }

  setSize(width: number, height: number): void {
    this.opts = { ...this.opts, width, height };
    this.redraw();
  }

  setFill(fill: number): void {
    this.opts = { ...this.opts, fill };
    // 直接指定色：白几何 × tint = fill
    this.g.tint = fill & 0xffffff;
  }

  private redraw(): void {
    const { width, height, fill, radius = 10 } = this.opts;
    this.g.clear();
    this.g.roundRect(0, 0, width, height, radius);
    this.g.fill({ color: 0xffffff });
    this.g.tint = fill & 0xffffff;
  }
}

// ---- 描边（单色） -------------------------------------------------

export interface PanelBorderOptions {
  id: string;
  displayName: string;
  width: number;
  height: number;
  color: number;
  borderWidth: number;
  radius?: number;
}

/** 圆角矩形描边叶子。与填充完全独立，可单独挂「颜色」组件。 */
export class PanelBorder extends UINode {
  private readonly g = new Graphics();
  private opts: PanelBorderOptions;

  constructor(opts: PanelBorderOptions) {
    super({ id: opts.id, displayName: opts.displayName });
    this.opts = opts;
    this.g.label = "shape";
    this.addChild(this.g);
    this.redraw();
  }

  setSize(width: number, height: number): void {
    this.opts = { ...this.opts, width, height };
    this.redraw();
  }

  setColor(color: number): void {
    this.opts = { ...this.opts, color };
    this.g.tint = color & 0xffffff;
  }

  private redraw(): void {
    const { width, height, color, borderWidth, radius = 10 } = this.opts;
    this.g.clear();
    this.g.roundRect(0, 0, width, height, radius);
    this.g.stroke({ width: borderWidth, color: 0xffffff });
    this.g.tint = color & 0xffffff;
  }
}
