import { Graphics } from "pixi.js";
import { Theme } from "../theme";
import { UINode } from "@ui/hierarchy";
import { UIText } from "./UIText";

/**
 * 通用按钮（状态机：normal / hover / down / disabled）
 *
 * 重做后的实现：
 *   - Button 自身是空 UINode，挂"背景 UINode" + "文字 UINode"。
 *   - 状态切换通过修改 background 颜色 + 自身 alpha 实现。
 *   - 这样 Hierarchy 里能看到 "按钮 > 背景 / 文字" 三个独立节点，
 *     渲染顺序由统一规则保证。
 */
export type ButtonState = "normal" | "hover" | "down" | "disabled";

export interface ButtonOptions {
  id: string;
  displayName: string;
  text: string;
  width?: number;
  height?: number;
  idleColor?: number;
  activeColor?: number;
  onClick: () => void;
}

export class Button extends UINode {
  private readonly background: ButtonBackground;
  private readonly labelText: UIText;
  private state: ButtonState = "normal";

  private readonly w: number;
  private readonly h: number;
  private idleColor: number;
  private activeColor: number;
  private enabled = true;
  /** 是否在本按钮上按下；仅在按钮内抬起时触发 onClick。 */
  private pressed = false;

  constructor(opts: ButtonOptions) {
    super({ id: opts.id, displayName: opts.displayName });
    this.w = opts.width ?? 140;
    this.h = opts.height ?? 60;
    this.idleColor = opts.idleColor ?? Theme.colors.btnIdle;
    this.activeColor = opts.activeColor ?? Theme.colors.playBtn;

    this.background = new ButtonBackground({
      id: `${opts.id}.background`,
      displayName: "背景",
      width: this.w,
      height: this.h,
      color: this.activeColor,
    });
    this.addChild(this.background);

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

    this.on("pointerover", () => {
      if (this.pressed) {
        this.setState("down");
      } else {
        this.setState("hover");
      }
    });
    this.on("pointerout", () => {
      // 按下后拖出按钮：取消 down 高亮；pressed 仍保留，在外抬起不触发 click
      this.setState("normal");
    });
    this.on("pointerdown", () => {
      if (!this.enabled) return;
      this.pressed = true;
      this.setState("down");
    });
    this.on("pointerup", () => {
      if (this.pressed && this.enabled) {
        this.pressed = false;
        this.setState("hover");
        opts.onClick();
      } else {
        this.pressed = false;
        this.setState(this.enabled ? "hover" : "disabled");
      }
    });
    this.on("pointerupoutside", () => {
      this.pressed = false;
      this.setState(this.enabled ? "normal" : "disabled");
    });
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.setState(enabled ? "normal" : "disabled");
  }

  setActiveColor(color: number): void {
    this.activeColor = color;
    this.applyState();
  }

  private setState(s: ButtonState): void {
    this.state = s;
    this.applyState();
  }

  private applyState(): void {
    const color = this.enabled ? this.activeColor : this.idleColor;
    this.background.setColor(color);

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

// ---- 背景独立节点 -------------------------------------------------

export interface ButtonBackgroundOptions {
  id: string;
  displayName: string;
  width: number;
  height: number;
  color: number;
  radius?: number;
}

export class ButtonBackground extends UINode {
  private readonly g = new Graphics();
  private opts: ButtonBackgroundOptions;

  constructor(opts: ButtonBackgroundOptions) {
    super({ id: opts.id, displayName: opts.displayName });
    this.opts = opts;
    this.addChild(this.g);
    this.redraw();
  }

  setColor(color: number): void {
    this.opts = { ...this.opts, color };
    this.redraw();
  }

  private redraw(): void {
    const { width, height, color, radius = 8 } = this.opts;
    this.g.clear();
    this.g.roundRect(0, 0, width, height, radius);
    this.g.fill({ color });
  }
}
