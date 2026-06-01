import { Text } from "pixi.js";
import { UIComponent, type SerializedComponent } from "../UIComponent";
import { uiHierarchy } from "../UIHierarchy";
import type { UIText } from "@ui/components/UIText";
import { CONFIG } from "@game/config";

/** 判断宿主是不是 UIText（有 getPixiText 接口）。 */
function isTextHost(host: unknown): host is UIText {
  return (
    !!host &&
    typeof host === "object" &&
    typeof (host as { getPixiText?: unknown }).getPixiText === "function"
  );
}

export function bounceTextCanAttach(host: import("../UINode").UINode): boolean {
  return isTextHost(host);
}

export class BounceTextComponent extends UIComponent {
  readonly type = "bounceText";
  readonly displayName = "【弹弹动画】组件";

  private configKey: string = "chipsBounce";
  private isAnimating = false;
  private startTime = 0;
  private chars: Text[] = [];
  private lastText = "";
  private lastStyleHash = "";
  private unsubscribeTick: (() => void) | null = null;
  private unsubscribeHierarchy: (() => void) | null = null;

  constructor(configKey: string = "chipsBounce") {
    super();
    this.configKey = configKey;
  }

  protected override onAttach(): void {
    if (!isTextHost(this.host)) {
      return;
    }

    // 监听别的组件 / 业务把宿主文本或样式改了 —— 如果正在动画，我们需要 rebuild 逐字 Text
    this.unsubscribeHierarchy = uiHierarchy.subscribe((type, node) => {
      if (node !== this.host) return;
      if (type !== "componentsChanged") return;
      if (this.isAnimating) {
        this.rebuildIfNeeded();
      }
    });

    // 每帧驱动 scale
    const ticker = uiHierarchy.getTicker();
    if (ticker) {
      const onTick = (): void => this.tick();
      ticker.add(onTick);
      this.unsubscribeTick = (): void => {
        ticker.remove(onTick);
      };
    }
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
    if (isTextHost(this.host)) {
      const pt = this.host.getPixiText();
      pt.visible = true;
    }
  }

  apply(): void {
    // 主要是更新配置或重新构建
    if (this.isAnimating) {
      this.rebuildIfNeeded(true);
    }
  }

  /** 触发弹弹动画 */
  trigger(): void {
    if (!isTextHost(this.host)) return;
    this.isAnimating = true;
    this.startTime = performance.now();
    this.rebuildIfNeeded(true);
  }

  /** 把宿主当前样式做个简易 hash，用来检测是否需要重建逐字 Text。 */
  private computeStyleHash(t: Text): string {
    const s = t.style;
    return [
      s.fontFamily,
      s.fontSize,
      s.fontWeight,
      s.fontStyle,
      JSON.stringify((s as unknown as { fill?: unknown }).fill ?? null),
      s.stroke ? JSON.stringify(s.stroke) : "",
      s.letterSpacing ?? 0,
      t.anchor.x,
      t.anchor.y,
    ].join("|");
  }

  private rebuildIfNeeded(force = false): void {
    if (!isTextHost(this.host)) return;
    if (!this.isAnimating) {
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
    if (text.length === 0) return;

    const style = src.style;
    const anchorX = src.anchor.x;
    const anchorY = src.anchor.y;
    const tint = src.tint;
    const alpha = src.alpha;

    src.visible = false;

    const resolution = src.resolution;
    const chars: Text[] = [];
    const widths: number[] = [];
    let totalWidth = 0;

    for (const ch of [...text]) {
      const t = new Text({ text: ch, style, resolution });
      t.tint = tint;
      t.alpha = alpha;
      t.eventMode = "none";
      t.roundPixels = false;
      chars.push(t);
      widths.push(t.width);
      totalWidth += t.width;
    }

    const firstLeftX = src.position.x - anchorX * totalWidth;
    let cursorX = firstLeftX;

    for (let i = 0; i < chars.length; i += 1) {
      const ch = chars[i]!;
      const w = widths[i]!;
      // 设置锚点为水平 0.5 这样缩放能沿单字中轴线进行
      ch.anchor.set(0.5, anchorY);
      ch.position.set(cursorX + w / 2, src.position.y);
      cursorX += w;
      this.host.addChild(ch);
    }

    this.chars = chars;
  }

  private teardownChars(): void {
    for (const ch of this.chars) {
      if (ch.parent) ch.parent.removeChild(ch);
      ch.destroy();
    }
    this.chars = [];
  }

  private stop(): void {
    this.isAnimating = false;
    this.teardownChars();
    if (isTextHost(this.host)) {
      this.host.getPixiText().visible = true;
    }
  }

  private tick(): void {
    if (!this.isAnimating) return;
    if (!isTextHost(this.host)) return;

    // 检查宿主文本是否在两次 tick 之间改变了
    const src = this.host.getPixiText();
    if (src.text !== this.lastText || this.computeStyleHash(src) !== this.lastStyleHash) {
      this.rebuildIfNeeded();
    }

    if (this.chars.length === 0) {
      this.stop();
      return;
    }

    const config = (CONFIG as any)[this.configKey];
    if (!config) {
      this.stop();
      return;
    }

    const now = performance.now();
    const elapsed = now - this.startTime;

    const scanSpeed = Math.max(1, config.scanSpeed);
    const scaleStrength = Math.max(0.1, config.scaleStrength);
    const initScale = config.initScale;
    const maxScale = config.maxScale;
    const stableScale = config.stableScale;

    let allFinished = true;

    for (let i = 0; i < this.chars.length; i++) {
      const charSprite = this.chars[i]!;
      const delay = i * scanSpeed;
      const dt = elapsed - delay;

      let scale = initScale;
      if (dt < 0) {
        scale = initScale;
        allFinished = false;
      } else {
        const riseTime = 80; // 升起到最大比例的时间 (ms)
        if (dt < riseTime) {
          const ratio = dt / riseTime;
          const easeRatio = 1 - Math.pow(1 - ratio, 2); // quadraticOut
          scale = initScale + (maxScale - initScale) * easeRatio;
          allFinished = false;
        } else {
          // 从最大比例衰减到目标稳定比例
          const t_decay = (dt - riseTime) / 1000;
          const decay = Math.exp(-scaleStrength * t_decay);
          scale = stableScale + (maxScale - stableScale) * decay;

          // 若衰减仍在进行，则未完成
          if (decay > 0.01) {
            allFinished = false;
          }
        }
      }
      charSprite.scale.set(scale);
    }

    if (allFinished) {
      this.stop();
    }
  }

  serialize(): SerializedComponent {
    return {
      type: this.type,
      data: {
        configKey: this.configKey,
      },
    };
  }

  deserialize(d: Record<string, unknown>): void {
    if (typeof d["configKey"] === "string") this.configKey = d["configKey"];
  }

  buildInspector(): HTMLElement {
    const root = document.createElement("div");
    root.className = "ui-comp-body";
    root.textContent = `绑定的配置专区：${this.configKey}`;
    return root;
  }
}
