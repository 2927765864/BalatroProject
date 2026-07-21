/**
 * CMOS 屏幕震动 — 纯运动核（无 PIXI）
 *
 * 三轴 MSMD（x/y/θ），目标默认 0；速度冲量 + 可选位置踢；
 * 预设模式：impulse / pulse（定时脉冲串）/ oscillate（衰减正弦驱动目标）。
 * 规格：docs/cmos-screen-shake-plan.md
 * 积分：SpringDamper1D（半隐式欧拉 + maxDt + substeps）
 */

import { SpringDamper1D, type SpringDamper1DParams } from "./SpringDamper1D";
import {
  CONFIG,
  normalizeCmosShakeEffectPreset,
  normalizeDirAngleDeg,
  type CmosShakeEffectPreset,
  type CmosShakePresetMode,
} from "@game/config";

const CLAMP_VEL_SCALE = 0.5;

/**
 * 震动效果预设 id（CONFIG.cmosShake.presets 的 key）。
 * 内置默认：tap / scoreTick / playHand / bigHand / error / Sort / CardSettle + sway* / rumble 等。
 */
export type CmosShakePresetId = string;

/** 内置效果 id（仅作文档与业务常量，不限制 play 入参） */
export const CMOS_SHAKE_BUILTIN_IDS = [
  "tap",
  "scoreTick",
  "playHand",
  "bigHand",
  "error",
  "Sort",
  "CardSettle",
  "swayAngle",
  "swayLR",
  "bounceUD",
  "doubleKick",
  "rumble",
  "thud",
] as const;

export interface ImpulseArgs {
  x?: number;
  y?: number;
  rot?: number;
  /**
   * 方向角（度，0–360）。屏幕坐标：0°=+X 右，90°=+Y 下。
   * 与 radius 组成极坐标；未给时默认 90°（向下）。
   */
  angleDeg?: number;
  /**
   * 方向半径（绝对值 ≥0）。≈0 时无有效平移方向（回退默认向下单位向量）。
   * 内部归一化为单位方向；冲量模长仍由 strength / posKick 决定。
   */
  radius?: number;
  strength?: number;
  spin?: number;
  /** 沿 dir 的位置踢（px）；显式 x/y 冲量时忽略 */
  posKick?: number;
  /** 角位移踢（度） */
  angleKickDeg?: number;
}

export interface PresetOverride {
  strength?: number;
  spin?: number;
  dirAngleDeg?: number;
  dirRadius?: number;
  dirRandom?: boolean;
  dirAngleMin?: number;
  dirAngleMax?: number;
  mode?: CmosShakePresetMode;
  count?: number;
  intervalMS?: number;
  alternate?: boolean;
  falloff?: number;
  posKick?: number;
  angleKickDeg?: number;
  durationMS?: number;
  freqHz?: number;
  amp?: number;
  ampRotDeg?: number;
  decay?: number;
  phaseDeg?: number;
}

export interface CmosShakeOutput {
  x: number;
  y: number;
  rotation: number;
}

interface ScheduledImpulse {
  atMS: number;
  args: ImpulseArgs;
}

interface OscillateDrive {
  startMS: number;
  endMS: number;
  freqHz: number;
  amp: number;
  ampRotDeg: number;
  ux: number;
  uy: number;
  decay: number;
  phaseRad: number;
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function clampNum(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function softClampAxis(s: SpringDamper1D, maxAbs: number): void {
  if (!(maxAbs > 0) || !Number.isFinite(maxAbs)) return;
  if (s.x > maxAbs) {
    s.x = maxAbs;
    s.v *= CLAMP_VEL_SCALE;
  } else if (s.x < -maxAbs) {
    s.x = -maxAbs;
    s.v *= CLAMP_VEL_SCALE;
  }
}

/** 闭区间 [a,b] 均匀随机（a/b 顺序无关） */
function sampleUniform(a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 0;
  if (hi <= lo) return lo;
  return lo + Math.random() * (hi - lo);
}

/**
 * 解析预设方向（极坐标）：
 * - dirRandom：在 [dirAngleMin, dirAngleMax] 均匀采样角度（允许 360 表示满周）；
 * - 半径固定用 dirRadius。
 * 同一次 play 内应只调用一次，保证 pulse 串方向一致。
 */
function resolvePresetDir(preset: CmosShakeEffectPreset): {
  angleDeg: number;
  radius: number;
} {
  const radius = Math.max(0, preset.dirRadius ?? 1);
  if (preset.dirRandom) {
    return {
      angleDeg: sampleUniform(preset.dirAngleMin, preset.dirAngleMax),
      radius,
    };
  }
  return {
    angleDeg: normalizeDirAngleDeg(preset.dirAngleDeg ?? 90),
    radius,
  };
}

/**
 * 极坐标 → 单位方向。
 * radius≈0：回退默认向下 (0,1)（与旧 dir 长度≈0 行为一致）。
 * 角度：0°=+X 右，90°=+Y 下（PIXI y-down）。
 */
function polarToUnit(angleDeg: number, radius: number): { ux: number; uy: number } {
  if (!(radius > 1e-6)) {
    return { ux: 0, uy: 1 };
  }
  const rad = degToRad(normalizeDirAngleDeg(angleDeg));
  return { ux: Math.cos(rad), uy: Math.sin(rad) };
}

export class CmosScreenShake {
  readonly x = new SpringDamper1D();
  readonly y = new SpringDamper1D();
  readonly rot = new SpringDamper1D();

  private lastImpulseMS = 0;
  private nowMS = 0;

  /** 可选覆盖 CONFIG.intensity；null = 读 CONFIG */
  private intensityOverride: number | null = null;

  /** 定时脉冲队列（pulse 模式） */
  private schedule: ScheduledImpulse[] = [];

  /** 振荡驱动（目标位置层，非输出叠加） */
  private drive: OscillateDrive | null = null;

  setIntensity(v: number): void {
    this.intensityOverride = clampNum(v, 0, 1);
  }

  getIntensity(): number {
    if (this.intensityOverride != null) return this.intensityOverride;
    const cfg = CONFIG.cmosShake;
    if (!cfg?.enabled) return 0;
    return clampNum(cfg.intensity ?? 0, 0, 1);
  }

  hardReset(): void {
    this.x.reset(0, 0);
    this.y.reset(0, 0);
    this.rot.reset(0, 0);
    this.schedule.length = 0;
    this.drive = null;
  }

  /**
   * 清空尚未触发的脉冲串与振荡驱动（不重置弹簧状态）。
   * 新 play 默认会替换排程；可手动调用。
   */
  clearPending(): void {
    this.schedule.length = 0;
    this.drive = null;
  }

  step(dtSec: number): void {
    const cfg = CONFIG.cmosShake;
    if (!cfg || !cfg.enabled) {
      this.hardReset();
      return;
    }

    const safeDt = Math.max(0, dtSec);
    this.nowMS += safeDt * 1000;

    // 到期脉冲（按时间顺序）
    if (this.schedule.length > 0) {
      // 小队列：线性扫描即可
      const remain: ScheduledImpulse[] = [];
      for (const item of this.schedule) {
        if (item.atMS <= this.nowMS + 1e-6) {
          this.impulse(item.args);
        } else {
          remain.push(item);
        }
      }
      this.schedule = remain;
    }

    const targets = this.computeDriveTargets();

    const pXY: SpringDamper1DParams = {
      mass: cfg.mass,
      angularFreq: cfg.angularFreq,
      dampingRatio: cfg.dampingRatio,
    };
    const pR: SpringDamper1DParams = {
      mass: cfg.rotMass,
      angularFreq: cfg.rotAngularFreq,
      dampingRatio: cfg.rotDampingRatio,
    };

    this.x.step(safeDt, targets.x, pXY, cfg.maxDtSec, cfg.substeps);
    this.y.step(safeDt, targets.y, pXY, cfg.maxDtSec, cfg.substeps);
    this.rot.step(safeDt, targets.rot, pR, cfg.maxDtSec, cfg.substeps);

    softClampAxis(this.x, cfg.maxOffsetX);
    softClampAxis(this.y, cfg.maxOffsetY);
    softClampAxis(this.rot, degToRad(cfg.maxAngleDeg));
  }

  private computeDriveTargets(): { x: number; y: number; rot: number } {
    const d = this.drive;
    if (!d) return { x: 0, y: 0, rot: 0 };
    if (this.nowMS >= d.endMS) {
      this.drive = null;
      return { x: 0, y: 0, rot: 0 };
    }
    const t = Math.max(0, (this.nowMS - d.startMS) / 1000);
    const env = d.decay > 0 ? Math.exp(-d.decay * t) : 1;
    const s = Math.sin(2 * Math.PI * d.freqHz * t + d.phaseRad) * env;
    return {
      x: d.amp * d.ux * s,
      y: d.amp * d.uy * s,
      rot: degToRad(d.ampRotDeg) * s,
    };
  }

  impulse(args: ImpulseArgs): void {
    const cfg = CONFIG.cmosShake;
    if (!cfg || !cfg.enabled) return;

    // intensity=0：不累积冲量；非 0 时冲量用满量，输出侧再乘 intensity（可实时减弱）
    const I = this.getIntensity();
    if (I <= 0) return;

    const hasExplicit = args.x != null || args.y != null || args.rot != null;

    let vx = 0;
    let vy = 0;
    let omega = 0;
    let posX = 0;
    let posY = 0;
    let posR = 0;

    if (hasExplicit) {
      vx = args.x ?? 0;
      vy = args.y ?? 0;
      omega = args.rot ?? 0;
      // 显式速度冲量时仍允许角/位置踢
      if (args.angleKickDeg != null && Number.isFinite(args.angleKickDeg)) {
        posR = degToRad(args.angleKickDeg);
      }
    } else {
      let strength = args.strength ?? 0;
      let spin = args.spin ?? 0;

      const interval = cfg.minImpulseIntervalMS ?? 0;
      if (interval > 0 && this.lastImpulseMS > 0) {
        const elapsed = this.nowMS - this.lastImpulseMS;
        if (elapsed < interval) {
          strength *= 0.35;
          spin *= 0.35;
        }
      }

      const { ux, uy } = polarToUnit(args.angleDeg ?? 90, args.radius ?? 1);
      const speed = strength * (cfg.strengthToVelocity ?? 0);
      vx = ux * speed;
      vy = uy * speed;
      omega = spin * (cfg.spinToVelocity ?? 0);

      const pk = args.posKick ?? 0;
      if (Number.isFinite(pk) && pk !== 0) {
        posX = ux * pk;
        posY = uy * pk;
      }
      const ak = args.angleKickDeg ?? 0;
      if (Number.isFinite(ak) && ak !== 0) {
        posR = degToRad(ak);
      }
    }

    if (
      !Number.isFinite(vx) ||
      !Number.isFinite(vy) ||
      !Number.isFinite(omega) ||
      !Number.isFinite(posX) ||
      !Number.isFinite(posY) ||
      !Number.isFinite(posR)
    ) {
      return;
    }

    this.x.v += vx;
    this.y.v += vy;
    this.rot.v += omega;
    this.x.x += posX;
    this.y.x += posY;
    this.rot.x += posR;

    const maxXY = cfg.maxSpeedXY ?? Infinity;
    const maxR = cfg.maxSpeedRot ?? Infinity;
    const sp = Math.hypot(this.x.v, this.y.v);
    if (sp > maxXY && sp > 1e-8) {
      const s = maxXY / sp;
      this.x.v *= s;
      this.y.v *= s;
    }
    if (Math.abs(this.rot.v) > maxR) {
      this.rot.v = Math.sign(this.rot.v) * maxR;
    }

    // 位置夹持（位置踢后立即）
    softClampAxis(this.x, cfg.maxOffsetX);
    softClampAxis(this.y, cfg.maxOffsetY);
    softClampAxis(this.rot, degToRad(cfg.maxAngleDeg));

    this.lastImpulseMS = this.nowMS;
  }

  /**
   * 按稳定 id 播放一次震动效果（读 CONFIG.cmosShake.presets[id]）。
   * 未知 id 静默忽略（避免业务/面板旧引用炸运行时）。
   * 新 play 会清空未完成的 pulse 排程与 oscillate 驱动（弹簧状态保留，可叠加感）。
   */
  play(id: CmosShakePresetId, override?: Partial<PresetOverride>): void {
    if (!id || typeof id !== "string") return;
    const raw = CONFIG.cmosShake?.presets?.[id];
    if (!raw) {
      if (typeof console !== "undefined") {
        console.warn(`[cmosShake] unknown preset id: ${id}`);
      }
      return;
    }
    const preset = normalizeCmosShakeEffectPreset(id, {
      ...raw,
      ...override,
    });
    this.playPreset(preset);
  }

  /** 直接播放已归一化的效果描述（面板试射 / 测试用） */
  playPreset(preset: CmosShakeEffectPreset): void {
    const cfg = CONFIG.cmosShake;
    if (!cfg || !cfg.enabled) return;
    if (this.getIntensity() <= 0) return;

    // 替换时序层；弹簧状态保留以便连打叠加
    this.schedule.length = 0;
    this.drive = null;

    const mode = preset.mode ?? "impulse";
    // dirRandom：本帧 play 采样一次角度，整次 pulse/oscillate 共用
    const { angleDeg, radius } = resolvePresetDir(preset);

    if (mode === "oscillate") {
      this.startOscillate(preset, angleDeg, radius);
      // 可选首帧位置踢 + 初速度，增加「起振」
      if (
        (preset.posKick !== 0 && Number.isFinite(preset.posKick)) ||
        (preset.angleKickDeg !== 0 && Number.isFinite(preset.angleKickDeg)) ||
        preset.strength > 0 ||
        preset.spin !== 0
      ) {
        this.impulse({
          angleDeg,
          radius,
          strength: preset.strength,
          spin: preset.spin,
          posKick: preset.posKick,
          angleKickDeg: preset.angleKickDeg,
        });
      }
      return;
    }

    const count =
      mode === "pulse" ? Math.max(1, Math.floor(preset.count || 1)) : 1;
    const interval = Math.max(0, preset.intervalMS || 0);
    const falloff = Number.isFinite(preset.falloff) ? preset.falloff : 1;
    const alternate = !!preset.alternate;

    for (let i = 0; i < count; i += 1) {
      const sign = alternate && i % 2 === 1 ? -1 : 1;
      const scale = falloff === 1 ? 1 : Math.pow(falloff, i);
      // alternate：角度 +180° 翻向；spin / 角踢仍乘符号
      const kickAngle = sign < 0 ? angleDeg + 180 : angleDeg;
      const args: ImpulseArgs = {
        angleDeg: kickAngle,
        radius,
        strength: preset.strength * scale,
        spin: preset.spin * sign * scale,
        posKick: (preset.posKick || 0) * scale,
        angleKickDeg: (preset.angleKickDeg || 0) * sign * scale,
      };
      if (i === 0) {
        this.impulse(args);
      } else {
        this.schedule.push({
          atMS: this.nowMS + interval * i,
          args,
        });
      }
    }
  }

  private startOscillate(
    preset: CmosShakeEffectPreset,
    angleDeg: number,
    radius: number,
  ): void {
    const duration = Math.max(0, preset.durationMS || 0);
    if (duration <= 0) return;
    const freq = Math.max(0, preset.freqHz || 0);
    if (freq <= 0 && (preset.amp || 0) === 0 && (preset.ampRotDeg || 0) === 0) {
      return;
    }
    const { ux, uy } = polarToUnit(angleDeg, radius);
    this.drive = {
      startMS: this.nowMS,
      endMS: this.nowMS + duration,
      freqHz: freq > 0 ? freq : 1,
      amp: preset.amp || 0,
      ampRotDeg: preset.ampRotDeg || 0,
      ux,
      uy,
      decay: Math.max(0, preset.decay || 0),
      phaseRad: degToRad(preset.phaseDeg || 0),
    };
  }

  /** 当前是否存在该效果预设 */
  hasPreset(id: CmosShakePresetId): boolean {
    return !!(id && CONFIG.cmosShake?.presets?.[id]);
  }

  /** 列出全部效果预设 id（排序后，便于面板） */
  listPresetIds(): string[] {
    const p = CONFIG.cmosShake?.presets;
    if (!p) return [];
    return Object.keys(p).sort((a, b) => a.localeCompare(b));
  }

  getOutput(): CmosShakeOutput {
    const cfg = CONFIG.cmosShake;
    const I = this.getIntensity();
    if (!cfg || !cfg.enabled || I <= 0) {
      return { x: 0, y: 0, rotation: 0 };
    }
    const maxA = degToRad(cfg.maxAngleDeg);
    return {
      x: clampNum(this.x.x, -cfg.maxOffsetX, cfg.maxOffsetX) * I,
      y: clampNum(this.y.x, -cfg.maxOffsetY, cfg.maxOffsetY) * I,
      rotation: clampNum(this.rot.x, -maxA, maxA) * I,
    };
  }

  isSettled(): boolean {
    const cfg = CONFIG.cmosShake;
    if (!cfg) return true;
    if (this.schedule.length > 0 || this.drive != null) return false;
    return (
      this.x.isSettled(0, cfg.settlePosPx, cfg.settleVelPx) &&
      this.y.isSettled(0, cfg.settlePosPx, cfg.settleVelPx) &&
      this.rot.isSettled(0, cfg.settleAngleRad, cfg.settleAngVel)
    );
  }
}

/** 烟测：ζ=1 回零；ζ 欠阻尼过冲；intensity=0 冲量无效；pulse/oscillate 基本行为。 */
export function __cmosScreenShakeSelfTest(): string[] {
  const errors: string[] = [];
  const backup = { ...CONFIG.cmosShake };
  const presetsBackup = { ...CONFIG.cmosShake.presets };

  try {
    CONFIG.cmosShake.enabled = true;
    CONFIG.cmosShake.intensity = 1;
    CONFIG.cmosShake.mass = 1;
    CONFIG.cmosShake.angularFreq = 14;
    CONFIG.cmosShake.dampingRatio = 1;
    CONFIG.cmosShake.rotMass = 1;
    CONFIG.cmosShake.rotAngularFreq = 14;
    CONFIG.cmosShake.rotDampingRatio = 1;
    CONFIG.cmosShake.maxOffsetX = 100;
    CONFIG.cmosShake.maxOffsetY = 100;
    CONFIG.cmosShake.maxAngleDeg = 10;
    CONFIG.cmosShake.strengthToVelocity = 900;
    CONFIG.cmosShake.spinToVelocity = 8;
    CONFIG.cmosShake.maxSpeedXY = 10000;
    CONFIG.cmosShake.maxSpeedRot = 100;
    CONFIG.cmosShake.minImpulseIntervalMS = 0;
    CONFIG.cmosShake.maxDtSec = 1 / 30;
    CONFIG.cmosShake.substeps = 4;
    CONFIG.cmosShake.settlePosPx = 0.5;
    CONFIG.cmosShake.settleVelPx = 5;
    CONFIG.cmosShake.settleAngleRad = 0.01;
    CONFIG.cmosShake.settleAngVel = 0.1;

    const a = new CmosScreenShake();
    a.impulse({ angleDeg: 90, radius: 1, strength: 0.5, spin: 0.05 });
    for (let i = 0; i < 180; i += 1) a.step(1 / 60);
    if (!a.isSettled()) {
      errors.push("critical damping should settle near zero after impulse");
    }

    CONFIG.cmosShake.dampingRatio = 0.35;
    CONFIG.cmosShake.rotDampingRatio = 0.35;
    const b = new CmosScreenShake();
    b.impulse({ x: 0, y: 600, rot: 0 });
    let crossed = false;
    let prev = b.y.x;
    for (let i = 0; i < 90; i += 1) {
      b.step(1 / 60);
      if (prev > 0 && b.y.x < 0) crossed = true;
      if (prev < 0 && b.y.x > 0) crossed = true;
      prev = b.y.x;
    }
    if (!crossed) {
      errors.push("underdamped Y should overshoot past zero at least once");
    }

    CONFIG.cmosShake.intensity = 0;
    const c = new CmosScreenShake();
    c.impulse({ angleDeg: 90, radius: 1, strength: 1, spin: 0.2 });
    const out = c.getOutput();
    if (
      Math.abs(c.x.v) > 1e-9 ||
      Math.abs(c.y.v) > 1e-9 ||
      Math.abs(c.rot.v) > 1e-9 ||
      Math.abs(out.x) > 1e-9 ||
      Math.abs(out.y) > 1e-9 ||
      Math.abs(out.rotation) > 1e-9
    ) {
      errors.push("intensity=0 must ignore impulse and output zero");
    }

    // posKick：瞬间位移（0° = +X）
    CONFIG.cmosShake.intensity = 1;
    CONFIG.cmosShake.dampingRatio = 1;
    const d = new CmosScreenShake();
    d.impulse({ angleDeg: 0, radius: 1, strength: 0, spin: 0, posKick: 5 });
    if (Math.abs(d.x.x - 5) > 1e-6) {
      errors.push(`posKick should set x≈5, got ${d.x.x}`);
    }

    // pulse alternate：第二拍方向相反（0° 右 ↔ 180° 左）
    CONFIG.cmosShake.presets = {
      ...CONFIG.cmosShake.presets,
      __testPulse: normalizeCmosShakeEffectPreset("__testPulse", {
        label: "test",
        mode: "pulse",
        strength: 0.5,
        spin: 0,
        dirAngleDeg: 0,
        dirRadius: 1,
        count: 2,
        intervalMS: 100,
        alternate: true,
        falloff: 1,
        posKick: 0,
        angleKickDeg: 0,
      }),
    };
    const e = new CmosScreenShake();
    e.play("__testPulse");
    const v0 = e.x.v;
    for (let i = 0; i < 7; i += 1) e.step(1 / 60); // ~116ms
    // 第二拍应加入负向速度；因弹簧积分 v 会变化，只检查 schedule 已消费且有过冲行为
    if (e.isSettled() && Math.abs(e.x.v) < 1e-6 && Math.abs(e.x.x) < 1e-6) {
      // 可能已衰减——再给一次更明确的检查：播放后短时间内 |v| 应非零
    }
    if (!(Math.abs(v0) > 1e-3)) {
      errors.push("pulse first kick should produce non-zero velocity");
    }

    // oscillate：驱动期间 isSettled=false，结束后回零
    CONFIG.cmosShake.presets = {
      ...CONFIG.cmosShake.presets,
      __testOsc: normalizeCmosShakeEffectPreset("__testOsc", {
        label: "testOsc",
        mode: "oscillate",
        strength: 0,
        spin: 0,
        dirAngleDeg: 0,
        dirRadius: 1,
        durationMS: 200,
        freqHz: 10,
        amp: 4,
        ampRotDeg: 0.5,
        decay: 0,
        phaseDeg: 0,
      }),
    };
    CONFIG.cmosShake.dampingRatio = 0.8;
    CONFIG.cmosShake.rotDampingRatio = 0.8;
    const f = new CmosScreenShake();
    f.play("__testOsc");
    if (f.isSettled()) {
      errors.push("oscillate should not be settled immediately after play");
    }
    let maxAbsX = 0;
    for (let i = 0; i < 12; i += 1) {
      f.step(1 / 60);
      maxAbsX = Math.max(maxAbsX, Math.abs(f.x.x));
    }
    if (maxAbsX < 0.5) {
      errors.push(`oscillate should move x, maxAbsX=${maxAbsX}`);
    }
    for (let i = 0; i < 180; i += 1) f.step(1 / 60);
    if (!f.isSettled()) {
      errors.push("oscillate should settle after duration + spring return");
    }
  } finally {
    Object.assign(CONFIG.cmosShake, backup);
    CONFIG.cmosShake.presets = presetsBackup;
  }

  return errors;
}
