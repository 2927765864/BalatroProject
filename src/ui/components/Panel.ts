import { Container, Graphics } from "pixi.js";

/**
 * 通用圆角面板
 *
 * 不持有逻辑，只负责绘制矩形 + 圆角 + 可选描边。
 * 通过 setSize 支持运行时改尺寸（layout 阶段使用）。
 */
export interface PanelOptions {
  width: number;
  height: number;
  fill: number;
  radius?: number;
  borderColor?: number;
  borderWidth?: number;
}

export class Panel extends Container {
  private readonly g = new Graphics();
  private opts: PanelOptions;

  constructor(opts: PanelOptions) {
    super();
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
