/**
 * BounceTextComponent（弹弹动画）
 * ---------------------------------------------------------------
 * 从左到右逐字扫描的"弹弹"效果。实现 CharEffect，向宿主 CharLayer 注册。
 *
 * 两条动力学路径：
 *   1) 经典解析路径（chipsBounce：筹码数字 / 牌型文字；以及 evalScoreBounce 等）：
 *      init→max 二次升起 + e^(-strength·t) 衰减；可选旧版 rotAngle1/2 伪相位旋转。
 *   2) 弹簧阻尼路径（multBounce：倍率数字 / 牌型等级文字）：复刻出牌堆结算的
 *      SpringDamper1D 双通道（scale→1、rot→0），见 docs/play-pile-settle-spring-damper-plan.md。
 *
 * 触发：业务调 trigger() → 置 isAnimating + 记 startTime。逐字层每帧 contribute。
 */
import { UIComponent, type SerializedComponent } from "../UIComponent";
import type { UIText } from "@ui/components/UIText";
import {
  CONFIG,
  scaleTimeMS,
  type SpringBounceAnimationConfig,
} from "@game/config";
import { SpringDamper1D } from "@/motion/SpringDamper1D";
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

/** multBounce 等：含 angularFreq + dampingRatio 即走弹簧路径。 */
function isSpringBounceConfig(
  config: Record<string, unknown>
): config is SpringBounceAnimationConfig & Record<string, unknown> {
  return (
    typeof config["angularFreq"] === "number" &&
    typeof config["dampingRatio"] === "number" &&
    typeof config["mass"] === "number"
  );
}

/**
 * 已废弃的独立弹弹 configKey → 共用专区。
 * shipping / localStorage 里若仍写旧 key，CONFIG 上已无对应字段，
 * contribute 会读到 undefined 并立刻 finish，表现为「完全没动画」。
 */
const BOUNCE_CONFIG_KEY_ALIASES: Readonly<Record<string, string>> = {
  handNameBounce: "chipsBounce",
  handLevelBounce: "multBounce",
};

/** 将废弃 key 归一到当前有效 CONFIG 字段名。 */
export function resolveBounceConfigKey(key: string): string {
  return BOUNCE_CONFIG_KEY_ALIASES[key] ?? key;
}

type CharSpringState = {
  scale: SpringDamper1D;
  rot: SpringDamper1D;
  started: boolean;
  settled: boolean;
  elapsedMS: number;
};

export class BounceTextComponent extends UIComponent implements CharEffect {
  readonly type = "bounceText";
  readonly displayName = "【弹弹动画】组件";

  private configKey: string = "chipsBounce";
  private isAnimating = false;
  private startTime = 0;
  /** 所属逐字层。 */
  private charLayer: CharLayerComponent | null = null;

  // —— 弹簧路径状态（仅 multBounce 等）——
  private charSprings: CharSpringState[] | null = null;
  private lastFrameNow = 0;
  private frameDtSec = 1 / 60;

  constructor(configKey: string = "chipsBounce") {
    super();
    this.configKey = resolveBounceConfigKey(configKey);
  }

  public getAnimating(): boolean {
    return this.isAnimating;
  }

  /** 业务侧可强制绑定专区（hydrate 后若需纠偏可调用）。 */
  public setConfigKey(key: string): void {
    this.configKey = resolveBounceConfigKey(key);
  }

  public getConfigKey(): string {
    return this.configKey;
  }

  // ---- 生命周期 -------------------------------------------------

  protected override onAttach(): void {
    if (!isTextHost(this.host)) return;
    this.charLayer = ensureCharLayer(this.host);
  }

  protected override onDetach(): void {
    if (this.charLayer) {
      this.charLayer.unregisterEffect(this);
      this.charLayer = null;
    }
    this.charSprings = null;
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
    if (this.host.getPixiText().text.length === 0) return;
    if (!this.charLayer) {
      this.charLayer = ensureCharLayer(this.host);
    }
    if (!this.charLayer) return;
    this.isAnimating = true;
    this.startTime = performance.now();
    this.charSprings = null;
    this.lastFrameNow = 0;
    this.frameDtSec = 1 / 60;
    this.charLayer.registerEffect(this);
  }

  private finish(): void {
    this.isAnimating = false;
    this.charSprings = null;
    this.lastFrameNow = 0;
    if (this.charLayer) {
      this.charLayer.unregisterEffect(this);
    }
  }

  // ---- CharEffect 实现 ------------------------------------------

  isActive(): boolean {
    return this.isAnimating;
  }

  contribute(i: number, _count: number, now: number, acc: CharFrame): void {
    if (!this.isAnimating) return;

    // 运行时自愈：旧存档/hydrate 可能仍带着 handNameBounce 等已删 key。
    const resolved = resolveBounceConfigKey(this.configKey);
    if (resolved !== this.configKey) this.configKey = resolved;

    const config = (CONFIG as unknown as Record<string, unknown>)[
      this.configKey
    ] as Record<string, unknown> | undefined;
    if (!config) {
      this.finish();
      return;
    }

    if (isSpringBounceConfig(config)) {
      this.contributeSpring(i, _count, now, acc, config);
      return;
    }

    this.contributeLegacy(i, _count, now, acc, config);
  }

  /**
   * 弹簧阻尼双通道（对齐 PlayPileFx.animateCardSettle）。
   * 每字独立一对 SpringDamper1D；扫描到后以冲量初值启动，积分到 settle 或 maxDuration。
   */
  private contributeSpring(
    i: number,
    count: number,
    now: number,
    acc: CharFrame,
    cfg: SpringBounceAnimationConfig
  ): void {
    // 帧首：算真实 dt（contribute 按字序调用，i===0 更新一次）
    if (i === 0) {
      if (this.lastFrameNow > 0) {
        this.frameDtSec = Math.max(0, (now - this.lastFrameNow) / 1000);
      } else {
        this.frameDtSec = 1 / 60;
      }
      this.lastFrameNow = now;
    }

    if (!this.charSprings || this.charSprings.length !== count) {
      this.charSprings = Array.from({ length: count }, () => ({
        scale: new SpringDamper1D(),
        rot: new SpringDamper1D(),
        started: false,
        settled: false,
        elapsedMS: 0,
      }));
    }

    const state = this.charSprings[i]!;
    const scanSpeed = Math.max(1, scaleTimeMS(cfg.scanSpeed));
    const speedRatio =
      cfg.speedRatio !== undefined ? Math.max(0.01, cfg.speedRatio) : 1.0;
    const elapsed = (now - this.startTime) * speedRatio;
    const delay = i * scanSpeed;
    const dtLogical = elapsed - delay;

    const impulseScale = cfg.impulseScale;
    const preScale = 1 + impulseScale;

    if (dtLogical < 0) {
      // 尚未扫到：停在冲量后的放大/缩小静姿态（与旧 initScale 等待感一致）。
      acc.scale *= preScale;
      return;
    }

    const deg2rad = (deg: number) => (deg * Math.PI) / 180;
    const params = {
      mass: cfg.mass,
      angularFreq: cfg.angularFreq,
      dampingRatio: cfg.dampingRatio,
    };

    if (!state.started) {
      state.started = true;
      state.settled = false;
      state.elapsedMS = 0;
      state.scale.reset(1 + cfg.impulseScale, cfg.impulseScaleVel);
      state.rot.reset(
        deg2rad(cfg.impulseRotDeg),
        deg2rad(cfg.impulseRotVelDeg)
      );
    }

    if (!state.settled) {
      const gameSpeed = CONFIG.gameSpeed;
      const speedMul =
        (Number.isFinite(gameSpeed) && gameSpeed > 0 ? gameSpeed : 1) *
        speedRatio;
      const dtSec = this.frameDtSec * speedMul;
      const effectiveDtMS = dtSec * 1000;
      state.elapsedMS += effectiveDtMS;

      state.scale.step(dtSec, 1, params, cfg.maxDtSec, cfg.substeps);
      state.rot.step(dtSec, 0, params, cfg.maxDtSec, cfg.substeps);

      const rotEps = deg2rad(cfg.settleEpsRotDeg);
      const rotVelEps = deg2rad(cfg.settleVelRotDeg);
      const maxDur = scaleTimeMS(cfg.maxDurationMS);
      const settled =
        state.scale.isSettled(1, cfg.settleEpsScale, cfg.settleVelScale) &&
        state.rot.isSettled(0, rotEps, rotVelEps);
      const timedOut = state.elapsedMS >= maxDur;

      if (settled || timedOut) {
        state.scale.reset(1, 0);
        state.rot.reset(0, 0);
        state.settled = true;
      }
    }

    acc.scale *= state.scale.x;
    acc.rotation += state.rot.x;

    // 最后一个字最晚启动；它 settle 后更早的字必然已 settle，可整体收尾。
    if (i === count - 1 && state.settled) {
      this.finish();
    }
  }

  /** 经典解析路径（筹码 / 牌型 / 预期分）。 */
  private contributeLegacy(
    i: number,
    _count: number,
    now: number,
    acc: CharFrame,
    config: Record<string, any>
  ): void {
    const scanSpeed = Math.max(1, scaleTimeMS(config.scanSpeed));
    const scaleStrength = Math.max(0.1, config.scaleStrength);
    const initScale = config.initScale;
    const maxScale = config.maxScale;
    const stableScale = config.stableScale;
    const speedRatio =
      config.speedRatio !== undefined ? Math.max(0.01, config.speedRatio) : 1.0;

    const rotAngle1 = config.rotAngle1 !== undefined ? config.rotAngle1 : 0;
    const rotAngle2 = config.rotAngle2 !== undefined ? config.rotAngle2 : 0;
    const rotDamping =
      config.rotDamping !== undefined ? Math.max(0, config.rotDamping) : 0;
    const rotFreq =
      config.rotFreq !== undefined ? Math.max(0, config.rotFreq) : 0;

    const elapsed = (now - this.startTime) * speedRatio;
    const delay = i * scanSpeed;
    const dt = elapsed - delay;

    let scale = initScale;
    let scaleFinished = false;
    let rotFinished = true;
    let rotRad = 0;

    if (dt < 0) {
      scale = initScale;
    } else {
      const riseTime = 80;
      if (dt < riseTime) {
        const ratio = dt / riseTime;
        const easeRatio = 1 - Math.pow(1 - ratio, 2);
        scale = initScale + (maxScale - initScale) * easeRatio;
      } else {
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
    if (typeof d["configKey"] === "string") {
      this.configKey = resolveBounceConfigKey(d["configKey"]);
    }
  }

  buildInspector(): HTMLElement {
    const root = document.createElement("div");
    root.className = "ui-comp-body";
    root.textContent = `绑定的配置专区：${this.configKey}`;
    return root;
  }
}
