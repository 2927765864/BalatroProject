/**
 * BounceTextComponent（弹弹动画）
 * ---------------------------------------------------------------
 * 从左到右逐字扫描的"弹弹"缩放效果：未扫到的字停在 initScale（偏大），
 * 扫到时瞬间膨胀到 maxScale（二次平滑），随后用 e^(-scaleStrength·dt) 简谐
 * 衰减回 stableScale。
 *
 * 重构要点（合并为单一逐字引擎后）：
 *   - 本组件不再自己拆字、不再碰宿主 Text 的 visible，也不再自建逐字节点。
 *   - 它实现 CharEffect 接口，向宿主的 CharLayer（逐字层）注册。逐字层每帧
 *     对每个字调 contribute，本组件只把"缩放贡献"乘进累加器。
 *   - 这样呼吸（写 y 偏移）和弹弹（写 scale）作用在同一组字符上，互不抢占，
 *     弹弹播完缩放回 1，呼吸无缝继续。
 *
 * 触发：业务调 trigger() → 置 isAnimating + 记 startTime。逐字层每帧驱动
 * contribute；衰减结束后 isAnimating 自动归 false，scale 贡献回到 1。
 */
import { UIComponent, type SerializedComponent } from "../UIComponent";
import type { UIText } from "@ui/components/UIText";
import { CONFIG } from "@game/config";
import {
  ensureCharLayer,
  type CharEffect,
  type CharFrame,
  type CharLayerComponent,
} from "./CharLayerComponent";

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

export class BounceTextComponent extends UIComponent implements CharEffect {
  readonly type = "bounceText";
  readonly displayName = "【弹弹动画】组件";

  private configKey: string = "chipsBounce";
  private isAnimating = false;
  private startTime = 0;
  /** 所属逐字层。 */
  private charLayer: CharLayerComponent | null = null;

  constructor(configKey: string = "chipsBounce") {
    super();
    this.configKey = configKey;
  }

  public getAnimating(): boolean {
    return this.isAnimating;
  }

  // ---- 生命周期 -------------------------------------------------

  protected override onAttach(): void {
    if (!isTextHost(this.host)) return;
    // 惰性确保宿主有逐字层（拆字 / 接管渲染的唯一者）。
    // 弹弹是"一次性"效果：仅在 trigger() 后的播放窗口内注册为效果，播完注销。
    // 注销时若逐字层已无其它效果（如呼吸），逐字层会自动回退显示原生 Text。
    this.charLayer = ensureCharLayer(this.host);
  }

  protected override onDetach(): void {
    if (this.charLayer) {
      this.charLayer.unregisterEffect(this);
      this.charLayer = null;
    }
  }

  apply(): void {
    if (!isTextHost(this.host)) return;
    if (!this.charLayer) {
      this.charLayer = ensureCharLayer(this.host);
    }
  }

  /** 触发弹弹动画。 */
  trigger(): void {
    if (!isTextHost(this.host)) return;
    // 空文本无字可弹：直接忽略，避免常驻占用逐字层却永不结束。
    if (this.host.getPixiText().text.length === 0) return;
    if (!this.charLayer) {
      this.charLayer = ensureCharLayer(this.host);
    }
    if (!this.charLayer) return;
    this.isAnimating = true;
    this.startTime = performance.now();
    // 进入播放窗口：注册为效果，逐字层开始接管渲染并每帧调 contribute。
    this.charLayer.registerEffect(this);
  }

  /** 结束弹弹：从逐字层注销。若无其它效果，逐字层回退原生 Text。 */
  private finish(): void {
    this.isAnimating = false;
    if (this.charLayer) {
      this.charLayer.unregisterEffect(this);
    }
  }

  // ---- CharEffect 实现 ------------------------------------------

  isActive(): boolean {
    return this.isAnimating;
  }

  /** 把第 i 个字的缩放贡献乘进累加器。未播放时贡献 1（不放大）。 */
  contribute(i: number, _count: number, now: number, acc: CharFrame): void {
    if (!this.isAnimating) return;

    const config = (CONFIG as Record<string, any>)[this.configKey];
    if (!config) {
      this.finish();
      return;
    }

    const scanSpeed = Math.max(1, config.scanSpeed);
    const scaleStrength = Math.max(0.1, config.scaleStrength);
    const initScale = config.initScale;
    const maxScale = config.maxScale;
    const stableScale = config.stableScale;
    const speedRatio = config.speedRatio !== undefined ? Math.max(0.01, config.speedRatio) : 1.0;

    const rotAngle1 = config.rotAngle1 !== undefined ? config.rotAngle1 : 0;
    const rotAngle2 = config.rotAngle2 !== undefined ? config.rotAngle2 : 0;
    const rotDamping = config.rotDamping !== undefined ? Math.max(0, config.rotDamping) : 0;
    const rotFreq = config.rotFreq !== undefined ? Math.max(0, config.rotFreq) : 0;

    const elapsed = (now - this.startTime) * speedRatio;
    const delay = i * scanSpeed;
    const dt = elapsed - delay;

    let scale = initScale;
    let scaleFinished = false;
    let rotFinished = true;
    let rotRad = 0;

    if (dt < 0) {
      // 还没扫到：停在 initScale。
      scale = initScale;
    } else {
      const riseTime = 80; // 升起到最大比例的时间 (ms)
      if (dt < riseTime) {
        const ratio = dt / riseTime;
        const easeRatio = 1 - Math.pow(1 - ratio, 2); // quadraticOut
        scale = initScale + (maxScale - initScale) * easeRatio;
      } else {
        // 从最大比例衰减到目标稳定比例。
        const t_decay = (dt - riseTime) / 1000;
        const decay = Math.exp(-scaleStrength * t_decay);
        scale = stableScale + (maxScale - stableScale) * decay;
        if (decay <= 0.01) scaleFinished = true;
      }

      if ((rotAngle1 !== 0 || rotAngle2 !== 0) && rotFreq > 0) {
        const t = dt / 1000;
        const decay = Math.exp(-rotDamping * t);
        const safeDamping = Math.max(0.01, rotDamping);
        const omega = rotFreq * 2 * Math.PI;
        const phase = (omega / safeDamping) * (1 - Math.exp(-safeDamping * t));

        const rad1 = (rotAngle1 * Math.PI) / 180;
        const rad2 = (rotAngle2 * Math.PI) / 180;

        rotRad = decay * (rad1 * Math.cos(phase) + rad2 * Math.sin(phase));
        if (decay > 0.01) rotFinished = false;
      }
    }

    acc.scale *= scale;
    acc.rotation += rotRad;

    const charFinished = scaleFinished && rotFinished;

    // 收尾判定：最后一个字 delay 最大、最晚完成衰减，它一旦完成即全部完成。
    // 此处调 finish() 只从逐字层注销（不立即 teardown），由逐字层在下一帧
    // tick 开头统一处理"无效果回退原生 Text"或交还给呼吸继续。
    if (i === _count - 1 && charFinished) {
      this.finish();
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
