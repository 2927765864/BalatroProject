import { Graphics } from "pixi.js";
import { UINode } from "@ui/hierarchy";

/**
 * 通用圆角面板
 *
 * 重做后的实现：
 *   - Panel 自身是一个空 UINode，只承担"挂载点 + transform"。
 *   - 圆角矩形背景被拆成 PanelBackground（也是一个 UINode）作为 Panel 的子节点。
 *   - 这样背景在 Hierarchy 里就是一个独立、可见、可调位置的节点，
 *     同时遵守"父先渲染、子后渲染"的统一规则：
 *        Panel(空) → PanelBackground → 用户后续 addChild 的内容
 *     用户拖进来的子 UINode 渲染在 PanelBackground 之上。
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
      borderColor: opts.borderColor,
      borderWidth: opts.borderWidth,
    });
    this.addChild(this.background);
  }

  setSize(width: number, height: number): void {
    this.opts = { ...this.opts, width, height };
    this.background.setSize(width, height);
  }

  setFill(fill: number): void {
    this.opts = { ...this.opts, fill };
    this.background.setFill(fill);
  }
}

// ---- 背景独立节点 -------------------------------------------------

export interface PanelBackgroundOptions {
  id: string;
  displayName: string;
  width: number;
  height: number;
  fill: number;
  radius?: number;
  borderColor?: number;
  borderWidth?: number;
}

export class PanelBackground extends UINode {
  private readonly g = new Graphics();
  private opts: PanelBackgroundOptions;

  constructor(opts: PanelBackgroundOptions) {
    super({ id: opts.id, displayName: opts.displayName });
    this.opts = opts;
    this.addChild(this.g);
    this.redraw();
  }

  setSize(width: number, height: number): void {
    this.opts = { ...this.opts, width, height };
    this.redraw();
  }

  setFill(fill: number): void {
    this.opts = { ...this.opts, fill };
    this.redraw();
  }

  private redraw(): void {
    const { width, height, fill, radius = 10, borderColor, borderWidth } = this.opts;
    this.g.clear();
    this.g.roundRect(0, 0, width, height, radius);
    this.g.fill({ color: fill });
    if (borderColor !== undefined && borderWidth !== undefined) {
      this.g.stroke({ width: borderWidth, color: borderColor });
    }
  }
}
