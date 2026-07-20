/**
 * TextJitterComponent（【弹弹动画】文字抖动）
 * ---------------------------------------------------------------
 * 常态逐字角摆动：每个字符绕可配置轴点做顺/逆时针正弦微抖。
 * 实现 CharEffect，向宿主 CharLayer 注册；不触发、不自注销。
 *
 * 位数分级（读 CONFIG.textJitter）：
 *   n < minDigits → 幅度 0
 *   n == minDigits → baseAngleDeg
 *   n > minDigits → baseAngleDeg * digitGrowth^(n - minDigits)
 *
 * 频率 LFO（非固定 Hz）：
 *   瞬时频率 f(t) 在 frequencyHzMin ↔ frequencyHzMax 间按 frequencyModHz 正弦往返。
 *   载波相位用 ∫ 2π f(s) ds 解析积分，避免直接 sin(ω(t)·t) 在变频时跳相。
 *
 * 轴点：pivotX / pivotY（0–1 归一化，默认 0.5/0.5 = 字心）。
 * 通过 CharFrame.pivotX/Y 交给 CharLayer 做位置补偿，不改 display anchor，
 * 故 Bounce 的 scale 仍绕中心，仅抖动旋转绕所选轴点。
 *
 * 阴影：不设 ignoreSilhouetteForShadow —— CharLayer 每帧对 rotation 变化
 * 同步 notifyVisualChanged，ShadowComponent 同帧重烤，阴影与数字共抖。
 * 与 BounceText 可同层叠加（rotation 累加）。
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

export function textJitterCanAttach(host: import("../UINode").UINode): boolean {
  return isTextHost(host);
}

/**
 * 位数 → 幅度倍数。
 * minDigits 默认 2：1 位为 0，2 位为 1，之后 growth^(n-minDigits)。
 */
export function digitAmplitudeScale(
  n: number,
  growth: number,
  minDigits: number
): number {
  const min = Math.max(1, Math.floor(minDigits));
  if (n < min) return 0;
  if (n === min) return 1;
  return Math.pow(growth, n - min);
}

export class TextJitterComponent extends UIComponent implements CharEffect {
  readonly type = "textJitter";
  readonly displayName = "【弹弹动画】文字抖动";

  private configKey: string = "textJitter";
  private charLayer: CharLayerComponent | null = null;
  private startTime = 0;
  private phaseSeed = 0;

  constructor(configKey: string = "textJitter") {
    super();
    this.configKey = configKey;
  }

  // ---- 生命周期 -------------------------------------------------

  protected override onAttach(): void {
    if (!isTextHost(this.host)) return;
    this.startTime = performance.now();
    this.phaseSeed = Math.random() * Math.PI * 2;
    this.charLayer = ensureCharLayer(this.host);
    // 始终注册：enabled 每帧在 contribute 读 CONFIG，面板开关即时生效，无需 apply。
    if (this.charLayer) {
      this.charLayer.registerEffect(this);
    }
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
    if (this.charLayer) {
      this.charLayer.registerEffect(this);
    }
  }

  // ---- CharEffect 实现 ------------------------------------------

  isActive(): boolean {
    return this.isConfigEnabled();
  }

  contribute(i: number, count: number, now: number, acc: CharFrame): void {
    const cfg = this.readConfig();
    if (!cfg || !cfg.enabled) return;

    // 轴点始终写入（即使本帧幅度为 0），便于面板调参后立刻反映、阴影补偿一致。
    const pivotX =
      typeof cfg.pivotX === "number" && Number.isFinite(cfg.pivotX)
        ? cfg.pivotX
        : 0.5;
    const pivotY =
      typeof cfg.pivotY === "number" && Number.isFinite(cfg.pivotY)
        ? cfg.pivotY
        : 0.5;
    acc.pivotX = pivotX;
    acc.pivotY = pivotY;

    const scale = digitAmplitudeScale(count, cfg.digitGrowth, cfg.minDigits);
    const fLo = Math.min(cfg.frequencyHzMin, cfg.frequencyHzMax);
    const fHi = Math.max(cfg.frequencyHzMin, cfg.frequencyHzMax);
    if (scale <= 0 || cfg.baseAngleDeg === 0 || fHi <= 0) return;

    const A = ((cfg.baseAngleDeg * Math.PI) / 180) * scale;
    const speedRatio = Math.max(0.01, cfg.speedRatio);
    const t = ((now - this.startTime) / 1000) * speedRatio;
    const phi =
      this.phaseSeed + i * ((cfg.phaseStaggerDeg * Math.PI) / 180);

    // f(t) = fMid + fAmp · sin(2π fMod t)
    // ∫₀ᵗ f = fMid·t − (fAmp/(2π fMod))·(cos(2π fMod t) − 1)   (fMod>0)
    // 载波相位 θ = 2π ∫ f
    const fMid = (fLo + fHi) * 0.5;
    const fAmp = (fHi - fLo) * 0.5;
    const fMod = Math.max(0, cfg.frequencyModHz);
    let carrierPhase: number;
    if (fAmp <= 1e-9 || fMod <= 1e-9) {
      carrierPhase = 2 * Math.PI * fMid * t;
    } else {
      const twoPiMod = 2 * Math.PI * fMod;
      carrierPhase =
        2 * Math.PI * fMid * t -
        (fAmp / fMod) * (Math.cos(twoPiMod * t) - 1);
    }

    acc.rotation += A * Math.sin(carrierPhase + phi);
  }

  // ---- CONFIG ---------------------------------------------------

  private isConfigEnabled(): boolean {
    const cfg = this.readConfig();
    return !!cfg?.enabled;
  }

  private readConfig(): {
    enabled: boolean;
    baseAngleDeg: number;
    frequencyHzMin: number;
    frequencyHzMax: number;
    frequencyModHz: number;
    phaseStaggerDeg: number;
    digitGrowth: number;
    minDigits: number;
    speedRatio: number;
    pivotX: number;
    pivotY: number;
  } | null {
    if (this.configKey === "textJitter") {
      return CONFIG.textJitter;
    }
    const raw = (CONFIG as unknown as Record<string, unknown>)[this.configKey];
    if (!raw || typeof raw !== "object") return null;
    return raw as {
      enabled: boolean;
      baseAngleDeg: number;
      frequencyHzMin: number;
      frequencyHzMax: number;
      frequencyModHz: number;
      phaseStaggerDeg: number;
      digitGrowth: number;
      minDigits: number;
      speedRatio: number;
      pivotX: number;
      pivotY: number;
    };
  }

  // ---- 序列化 ----------------------------------------------------

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
    root.textContent = `绑定的配置专区：${this.configKey}（参数请在「文字视效 → 【弹弹动画】文字抖动」调整）`;
    return root;
  }
}
