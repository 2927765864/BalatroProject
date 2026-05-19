import { Graphics } from "pixi.js";
import { UINode } from "@ui/hierarchy";

/**
 * 通用圆角面板
 *
 * 不持有逻辑，只负责绘制矩形 + 圆角 + 可选描边。
 * 通过 setSize 支持运行时改尺寸（layout 阶段使用）。
 *
 * 继承自 UINode：构造时必须传入稳定的 hierarchy id 与显示名，
 * 这样它会自动出现在调参面板的 Hierarchy 树里。
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
  private readonly g = new Graphics();
  private opts: PanelOptions;

  constructor(opts: PanelOptions) {
    super({ id: opts.id, displayName: opts.displayName });
    this.opts = opts;
    // Panel 的 Graphics 是实现细节背景，不应该参与用户调层级。
    // 这里不用 sortableChildren，否则多层嵌套时同 zIndex 的父级内部 UI
    // 可能在渲染排序后盖住用户拖进去的子 UINode。
    this.g.zIndex = -1;
    this.addChild(this.g);
    this.redraw();

    // 让背景始终位于 children 数组最底层（下标 0）。
    // 否则当 Hierarchy 面板里用户把别的 UINode reparent 进来时，新子会被
    // addChild 追加到末尾、画在背景之上是没问题，但 hydrate/reorder 会按
    // siblingIndex 重新排，可能把背景挤到上面去——表现为"背板盖住了内容"。
    this.on("childAdded", (child) => {
      if (child !== this.g && this.children[0] !== this.g) {
        this.setChildIndex(this.g, 0);
      }
    });
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
