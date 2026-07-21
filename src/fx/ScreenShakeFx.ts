/**
 * CMOS 屏幕震动 + 画面跟随 + 画面呼吸晃动 — PIXI 适配层
 *
 * 在 worldRoot 下维护 shakeRoot；Scaler 只改 worldRoot。
 * 三层偏移（震动 / 跟随 / 呼吸）只写 shakeRoot（玩法内容），不碰背景 / CRT。
 * 规格：docs/cmos-screen-shake-plan.md §3
 */

import { Container, Point } from "pixi.js";
import type { App } from "@core/App";
import { CONFIG } from "@game/config";
import {
  CmosScreenShake,
  type CmosShakePresetId,
  type ImpulseArgs,
  type PresetOverride,
} from "@/motion/CmosScreenShake";

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export class ScreenShakeFx {
  readonly model = new CmosScreenShake();
  readonly shakeRoot: Container;

  private readonly app: App;
  /** 画面跟随当前偏移（世界像素，相对屏幕中心） */
  private followX = 0;
  private followY = 0;
  /** 画面呼吸晃动当前偏移（世界像素） */
  private breathX = 0;
  private breathY = 0;
  /** 呼吸时钟（秒，墙钟 dt，不随 gameSpeed） */
  private breathTimeSec = 0;
  /** 关闭时用于淡出的强度 0–1 */
  private breathFade = 1;
  private readonly _pointerLocal = new Point();

  constructor(app: App) {
    this.app = app;
    this.shakeRoot = new Container();
    this.shakeRoot.label = "ShakeRoot";
    this.shakeRoot.sortableChildren = true;
    app.worldRoot.addChild(this.shakeRoot);
    this.applyToRoot();
  }

  /** 玩法内容根：hydrate / reparent 的 null 父节点目标 */
  get contentRoot(): Container {
    return this.shakeRoot;
  }

  play(id: CmosShakePresetId, override?: Partial<PresetOverride>): void {
    this.model.play(id, override);
  }

  impulse(args: ImpulseArgs): void {
    this.model.impulse(args);
  }

  hardReset(): void {
    this.model.hardReset();
    this.followX = 0;
    this.followY = 0;
    this.breathX = 0;
    this.breathY = 0;
    this.breathTimeSec = 0;
    this.breathFade = 1;
    this.applyToRoot();
  }

  /**
   * 每帧：震动积分 + 画面跟随 + 呼吸晃动 + 写 shakeRoot 变换。
   * dtMS 与 TweenManager 同源（App.onUpdate）。
   */
  update(dtMS: number): void {
    const dtSec = Math.max(0, dtMS) / 1000;
    this.stepShake(dtSec, dtMS);
    this.stepFollow(dtSec);
    this.stepBreath(dtSec);
    this.applyToRoot();
  }

  private stepShake(dtSec: number, dtMS: number): void {
    const cfg = CONFIG.cmosShake;
    if (!cfg?.enabled) {
      this.model.hardReset();
      return;
    }

    let t = dtSec;
    if (cfg.useGameSpeed) {
      const speed = CONFIG.gameSpeed;
      if (typeof speed === "number" && Number.isFinite(speed) && speed > 0) {
        t = (Math.max(0, dtMS) / 1000) * speed;
      }
    }
    this.model.step(t);
  }

  /**
   * 根据指针在世界区的位置，指数平滑逼近目标偏移。
   * 归一化：屏幕中心 = 0，边缘 ≈ ±1（相对半宽/半高）。
   */
  private stepFollow(dtSec: number): void {
    const cfg = CONFIG.screenFollow;
    if (!cfg?.enabled) {
      // 关闭时平滑回中心，避免硬切
      const fall = 1 - Math.exp(-Math.max(0.1, cfg?.smoothing ?? 8) * dtSec);
      this.followX += (0 - this.followX) * fall;
      this.followY += (0 - this.followY) * fall;
      if (Math.abs(this.followX) < 0.01) this.followX = 0;
      if (Math.abs(this.followY) < 0.01) this.followY = 0;
      return;
    }

    const w = CONFIG.world?.width ?? this.app.scaler.worldWidth;
    const h = CONFIG.world?.height ?? this.app.scaler.worldHeight;
    const cx = w / 2;
    const cy = h / 2;
    const halfW = Math.max(1e-3, w / 2);
    const halfH = Math.max(1e-3, h / 2);

    const { nx, ny } = this.readPointerNorm(cx, cy, halfW, halfH);

    let ax = nx;
    let ay = ny;
    const dead = clamp(cfg.deadzone ?? 0, 0, 0.95);
    if (dead > 0) {
      const mag = Math.hypot(ax, ay);
      if (mag <= dead) {
        ax = 0;
        ay = 0;
      } else {
        const scale = (mag - dead) / (1 - dead);
        ax = (ax / mag) * scale;
        ay = (ay / mag) * scale;
      }
    }

    const intensity = clamp(cfg.intensity ?? 1, 0, 1);
    const signX = cfg.invertX ? -1 : 1;
    const signY = cfg.invertY ? -1 : 1;
    const targetX = ax * (cfg.maxOffsetX ?? 0) * intensity * signX;
    const targetY = ay * (cfg.maxOffsetY ?? 0) * intensity * signY;

    const smooth = Math.max(0, cfg.smoothing ?? 8);
    const alpha = smooth <= 0 ? 1 : 1 - Math.exp(-smooth * dtSec);
    this.followX += (targetX - this.followX) * alpha;
    this.followY += (targetY - this.followY) * alpha;
  }

  /**
   * 双轴独立 sin 呼吸：
   *   x = ampX * intensity * fade * sin(2π fX t + φX)
   *   y = ampY * intensity * fade * sin(2π fY t + φY)
   * 与跟随 / 震动无关；关闭时 fade 平滑归零。
   */
  private stepBreath(dtSec: number): void {
    const cfg = CONFIG.screenBreath;
    const wantOn = !!cfg?.enabled;
    const fadeRate = 4; // 1/s，开关时约 0.25s 淡入淡出
    const fadeAlpha = 1 - Math.exp(-fadeRate * dtSec);
    const targetFade = wantOn ? 1 : 0;
    this.breathFade += (targetFade - this.breathFade) * fadeAlpha;
    if (this.breathFade < 0.001) this.breathFade = 0;
    if (this.breathFade > 0.999) this.breathFade = 1;

    // 时钟始终推进，避免开关后相位跳变
    this.breathTimeSec += dtSec;
    // 防止长时间运行精度变差
    if (this.breathTimeSec > 1e6) this.breathTimeSec %= 1e6;

    if (this.breathFade <= 0 || !cfg) {
      this.breathX = 0;
      this.breathY = 0;
      return;
    }

    const intensity = clamp(cfg.intensity ?? 1, 0, 1) * this.breathFade;
    const t = this.breathTimeSec;
    const twoPi = Math.PI * 2;
    const fx = Math.max(0, cfg.freqX ?? 0);
    const fy = Math.max(0, cfg.freqY ?? 0);
    const px = degToRad(cfg.phaseXDeg ?? 0);
    const py = degToRad(cfg.phaseYDeg ?? 0);
    const ampX = (cfg.ampX ?? 0) * intensity;
    const ampY = (cfg.ampY ?? 0) * intensity;

    this.breathX = ampX * Math.sin(twoPi * fx * t + px);
    this.breathY = ampY * Math.sin(twoPi * fy * t + py);
  }

  /**
   * 读 PIXI 全局指针，转换到 worldRoot 本地（与卡牌/UI 同一坐标系）。
   * 指针不可用时视为中心。
   */
  private readPointerNorm(
    cx: number,
    cy: number,
    halfW: number,
    halfH: number,
  ): { nx: number; ny: number } {
    try {
      const events = this.app.pixi.renderer.events;
      const global = events?.pointer?.global;
      if (!global || !Number.isFinite(global.x) || !Number.isFinite(global.y)) {
        return { nx: 0, ny: 0 };
      }
      this.app.worldRoot.toLocal(global, undefined, this._pointerLocal);
      const nx = clamp((this._pointerLocal.x - cx) / halfW, -1, 1);
      const ny = clamp((this._pointerLocal.y - cy) / halfH, -1, 1);
      return { nx, ny };
    } catch {
      return { nx: 0, ny: 0 };
    }
  }

  applyToRoot(): void {
    const w = CONFIG.world?.width ?? this.app.scaler.worldWidth;
    const h = CONFIG.world?.height ?? this.app.scaler.worldHeight;
    const cx = w / 2;
    const cy = h / 2;
    const { x, y, rotation } = this.model.getOutput();
    this.shakeRoot.pivot.set(cx, cy);
    this.shakeRoot.position.set(
      cx + x + this.followX + this.breathX,
      cy + y + this.followY + this.breathY,
    );
    this.shakeRoot.rotation = rotation;
  }
}
