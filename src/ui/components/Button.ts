import { Graphics } from "pixi.js";
import { Theme } from "../theme";
import { UINode } from "@ui/hierarchy";
import { UIText } from "./UIText";

/**
 * 通用按钮（状态机：normal / hover / down / disabled）
 *
 * 与原型相比：
 *   - 把 alpha 切换 + 颜色重绘合并进 setState；调用方只需 setEnabled(true|false)
 *     和 setActiveColor，不必每次手动 redraw。
 */
export type ButtonState = "normal" | "hover" | "down" | "disabled";

export interface ButtonOptions {
  /** UI Hierarchy 中的稳定 id。 */
  id: string;
  /** Hierarchy 中显示的名字。 */
  displayName: string;
  text: string;
  width?: number;
  height?: number;
  idleColor?: number;
  activeColor?: number; // 高亮色（启用时用）
  onClick: () => void;
}

export class Button extends UINode {
  private readonly g = new Graphics();
  private readonly labelText: UIText;
  private state: ButtonState = "normal";

  private readonly w: number;
  private readonly h: number;
  private idleColor: number;
  private activeColor: number;
  private enabled = true;

  constructor(opts: ButtonOptions) {
    super({ id: opts.id, displayName: opts.displayName });
    this.w = opts.width ?? 140;
    this.h = opts.height ?? 60;
    this.idleColor = opts.idleColor ?? Theme.colors.btnIdle;
    this.activeColor = opts.activeColor ?? Theme.colors.playBtn;

    // 按钮背景也是实现细节，必须永远在按钮文字/用户子物体下方。
    // 不启用 sortableChildren，避免嵌套子 UI 被按钮自身 UI 重新排序后遮挡。
    this.g.zIndex = -1;
    this.addChild(this.g);
    // Button 内文字独立成 UIText 节点，于是在 Hierarchy 里能看见 "出牌按钮 > 文字"。
    // 注意 id 必须依赖外部传入的 opts.id，否则多按钮会冲突。
    this.labelText = new UIText({
      id: `${opts.id}.label`,
      displayName: "文字",
      text: opts.text,
      style: {
        fontFamily: Theme.fontFamily,
        fontSize: Theme.fontSize.button,
        fill: Theme.colors.textWhite,
        fontWeight: "bold",
      },
    });
    this.labelText.setAnchor(0.5);
    this.labelText.position.set(this.w / 2, this.h / 2);
    this.addChild(this.labelText);

    this.eventMode = "static";
    this.cursor = "pointer";

    this.on("pointerover", () => this.setState("hover"));
    this.on("pointerout", () => this.setState("normal"));
    this.on("pointerdown", () => {
      if (!this.enabled) return;
      this.setState("down");
      opts.onClick();
    });
    this.on("pointerup", () => this.setState("hover"));
    this.on("pointerupoutside", () => this.setState("normal"));

    this.redraw();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.setState(enabled ? "normal" : "disabled");
  }

  setActiveColor(color: number): void {
    this.activeColor = color;
    this.redraw();
  }

  private setState(s: ButtonState): void {
    this.state = s;
    this.redraw();
  }

  private redraw(): void {
    this.g.clear();
    this.g.roundRect(0, 0, this.w, this.h, 8);
    const color = this.enabled ? this.activeColor : this.idleColor;
    this.g.fill({ color });

    if (!this.enabled) {
      this.alpha = 0.5;
      this.eventMode = "none";
      return;
    }
    this.eventMode = "static";

    switch (this.state) {
      case "hover":
        this.alpha = 0.9;
        break;
      case "down":
        this.alpha = 0.7;
        break;
      default:
        this.alpha = 1.0;
    }
  }
}
