import { Graphics } from "pixi.js";
import { Theme } from "../theme";
import { UINode, isUINode, ShadowComponent, ColorComponent } from "@ui/hierarchy";
import { UIText } from "./UIText";

/**
 * 通用按钮（状态机：normal / hover / down / disabled）
 *
 * 实现要点：
 *   - Button 自身是空 UINode，挂"背景 UINode" + "文字 UINode"。
 *   - 常态色：若背景挂了 ColorComponent（shipping 调色），以其为准；
 *     否则用构造时的 activeColor。禁用用 idleColor，**不改 alpha**。
 *   - hover / down：在常态色上略压暗（变灰），松手/移出后恢复常态色。
 *   - 按下（down）：额外内容沿阴影方向微移，并临时隐藏 ShadowComponent。
 *   - 背景为单色：白几何 + tint。
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

/** 没有可用 ShadowComponent 时的默认按下位移（度 / 像素）。 */
const DEFAULT_PRESS_ANGLE_DEG = 90;
const DEFAULT_PRESS_DISTANCE_PX = 3;

/** hover / down 相对常态色的压暗系数（1 = 不变，越小越暗/越灰）。 */
const HOVER_DARKEN = 0.82;

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function hexToNumber(hex: string): number {
  if (!HEX_RE.test(hex)) return 0xffffff;
  return parseInt(hex.slice(1), 16);
}

/** 按通道乘系数压暗（视觉上略变灰），不改 alpha。 */
function darkenColor(color: number, factor: number): number {
  const f = Math.min(1, Math.max(0, factor));
  const r = Math.round(((color >> 16) & 0xff) * f);
  const g = Math.round(((color >> 8) & 0xff) * f);
  const b = Math.round((color & 0xff) * f);
  return (r << 16) | (g << 8) | b;
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
  /** 当前是否处于视觉上的「压入」位移。 */
  private sunk = false;

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
      if (!this.enabled) return;
      if (this.pressed) {
        this.setState("down");
      } else {
        this.setState("hover");
      }
    });
    this.on("pointerout", () => {
      if (!this.enabled) return;
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

  /**
   * 常态显示色：优先背景 ColorComponent（shipping / Inspector 调色），
   * 否则构造参数 activeColor。避免 hover 后用 Theme 色覆盖掉存档色。
   */
  private resolveNormalColor(): number {
    const cc = this.background.getComponent<ColorComponent>("color");
    if (cc) {
      const n = hexToNumber(cc.color);
      if (HEX_RE.test(cc.color)) return n;
    }
    return this.activeColor;
  }

  /**
   * 上色策略：
   *   - normal + enabled：若有 ColorComponent 则 apply 其存档色（真正恢复常态）；
   *     否则写 activeColor。
   *   - hover / down：在常态色上压暗，只改叶子 tint，不改 ColorComponent 数据。
   *   - disabled：idleColor。
   */
  private paintBackgroundForState(): void {
    if (!this.enabled) {
      this.background.setColor(this.idleColor);
      return;
    }

    const normal = this.resolveNormalColor();
    if (this.state === "hover" || this.state === "down") {
      this.background.setColor(darkenColor(normal, HOVER_DARKEN));
      return;
    }

    // normal
    const cc = this.background.getComponent<ColorComponent>("color");
    if (cc) {
      // 写回存档色，而不是 Theme.activeColor（二者可能不一致）
      cc.apply();
    } else {
      this.background.setColor(this.activeColor);
    }
  }

  private applyState(): void {
    this.paintBackgroundForState();

    // 禁用 / 启用都不改整体透明度：禁用只靠 idleColor 变灰。
    // 若节点上挂了 OpacityComponent，保留其 alpha，不在这里强行写 1。
    if (!this.enabled) {
      this.eventMode = "none";
      this.cursor = "default";
      this.applyPressVisual(false);
      return;
    }
    this.eventMode = "static";
    this.cursor = "pointer";

    this.applyPressVisual(this.state === "down");
  }

  /**
   * 按下视觉：内容沿阴影方向位移；阴影临时隐藏。
   * 不改 Button 根节点 transform（避免污染 Hierarchy / shipping 存档）。
   */
  private applyPressVisual(down: boolean): void {
    if (down === this.sunk) {
      // 仍需同步阴影 forceHidden（组件可能在 hydrate 后才挂上）。
      this.setShadowsHidden(down);
      if (down) this.offsetContentTowardShadow();
      return;
    }
    this.sunk = down;
    this.setShadowsHidden(down);
    if (down) {
      this.offsetContentTowardShadow();
    } else {
      this.restoreContentPositions();
    }
  }

  private collectShadows(): ShadowComponent[] {
    const out: ShadowComponent[] = [];
    const visit = (node: UINode): void => {
      const shadow = node.getComponent<ShadowComponent>("shadow");
      if (shadow) out.push(shadow);
      for (const child of node.listUIChildren()) visit(child);
    };
    visit(this);
    return out;
  }

  private setShadowsHidden(hidden: boolean): void {
    for (const s of this.collectShadows()) {
      s.setForceHidden(hidden);
    }
  }

  /**
   * 取「主阴影」的 angle/distance：优先背景上的 shadow，其次按钮自身，
   * 再退到子树里第一个，最后用默认值。
   */
  private resolvePressOffset(): { ox: number; oy: number } {
    const bgShadow = this.background.getComponent<ShadowComponent>("shadow");
    const selfShadow = this.getComponent<ShadowComponent>("shadow");
    const any = this.collectShadows()[0];
    const primary = bgShadow ?? selfShadow ?? any;
    const angle = primary?.angle ?? DEFAULT_PRESS_ANGLE_DEG;
    const distance = primary?.distance ?? DEFAULT_PRESS_DISTANCE_PX;
    const rad = (angle * Math.PI) / 180;
    return {
      ox: Math.cos(rad) * distance,
      oy: Math.sin(rad) * distance,
    };
  }

  private offsetContentTowardShadow(): void {
    const { ox, oy } = this.resolvePressOffset();
    // 只挪背景与文字（UINode 子），不动 ShadowComponent 注入的剪影 Sprite。
    for (const child of this.children) {
      if (!isUINode(child)) continue;
      const baseX = child.transform.x;
      const baseY = child.transform.y;
      child.position.set(baseX + ox, baseY + oy);
    }
  }

  private restoreContentPositions(): void {
    for (const child of this.children) {
      if (!isUINode(child)) continue;
      child.position.set(child.transform.x, child.transform.y);
    }
  }
}

// ---- 背景独立节点（单色） ------------------------------------------

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
    this.g.label = "shape";
    this.addChild(this.g);
    this.redraw();
  }

  setColor(color: number): void {
    this.opts = { ...this.opts, color };
    // 直接指定：白几何 + tint
    this.g.tint = color & 0xffffff;
  }

  private redraw(): void {
    const { width, height, color, radius = 8 } = this.opts;
    this.g.clear();
    this.g.roundRect(0, 0, width, height, radius);
    this.g.fill({ color: 0xffffff });
    this.g.tint = color & 0xffffff;
  }
}
