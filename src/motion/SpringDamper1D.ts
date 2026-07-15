/**
 * 一维质量–弹簧–阻尼（MSMD）数值积分器。
 *
 * 公式与标定对齐 docs/play-pile-settle-spring-damper-plan.md §2、
 * docs/elastic-rope-rotation-damping-plan.md §2.4：
 *   k = m * ωn²
 *   c = 2 * ζ * m * ωn
 * 子步半隐式欧拉：v += a*h; x += v*h（对照 ElasticRopeMotion / Gaffer）。
 *
 * 禁止 npm 动画库；仅用于 scoring 通道等 1D 状态。
 */

export interface SpringDamper1DParams {
  mass: number;
  /** 自然频率 ωn (rad/s) */
  angularFreq: number;
  /** 阻尼比 ζ */
  dampingRatio: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export class SpringDamper1D {
  x = 0;
  v = 0;

  reset(x: number, v: number): void {
    this.x = x;
    this.v = v;
  }

  /**
   * 积分 dtSec 秒（调用方负责 gameSpeed 有效时间）。
   * 内部：dt = min(dtSec, maxDtSec)；h = dt/substeps；子步半隐式欧拉。
   */
  step(
    dtSec: number,
    xTarget: number,
    params: SpringDamper1DParams,
    maxDtSec: number,
    substeps: number,
  ): void {
    const m = Math.max(1e-6, params.mass);
    const wn = clamp(params.angularFreq, 1e-6, 60);
    const zeta = Math.max(0, params.dampingRatio);
    const k = m * wn * wn;
    const c = 2 * zeta * m * wn;

    const dt = Math.min(Math.max(0, dtSec), Math.max(1e-6, maxDtSec));
    const n = Math.max(1, Math.floor(substeps));
    const h = dt / n;

    for (let i = 0; i < n; i += 1) {
      const a = (-k * (this.x - xTarget) - c * this.v) / m;
      this.v += a * h;
      this.x += this.v * h;
      if (!Number.isFinite(this.x) || !Number.isFinite(this.v)) {
        this.x = xTarget;
        this.v = 0;
        break;
      }
    }
  }

  isSettled(xTarget: number, epsPos: number, epsVel: number): boolean {
    return Math.abs(this.x - xTarget) < epsPos && Math.abs(this.v) < epsVel;
  }
}

/** 烟测：ζ=1 应回目标；ζ=0.3 应过冲。开发时可手动调用。 */
export function __springDamper1DSelfTest(): string[] {
  const errors: string[] = [];
  const pCrit: SpringDamper1DParams = {
    mass: 1,
    angularFreq: 12,
    dampingRatio: 1,
  };
  const s = new SpringDamper1D();
  s.reset(2, 0);
  for (let i = 0; i < 120; i += 1) {
    s.step(1 / 60, 1, pCrit, 1 / 30, 4);
  }
  if (!s.isSettled(1, 0.02, 0.1)) {
    errors.push("critical damping should settle near target");
  }

  const pUnder: SpringDamper1DParams = {
    mass: 1,
    angularFreq: 14,
    dampingRatio: 0.3,
  };
  const u = new SpringDamper1D();
  u.reset(0.9, 0);
  let crossed = false;
  let prev = u.x - 1;
  for (let i = 0; i < 90; i += 1) {
    u.step(1 / 60, 1, pUnder, 1 / 30, 4);
    const d = u.x - 1;
    if (prev < 0 && d > 0) crossed = true;
    if (prev > 0 && d < 0) crossed = true;
    prev = d;
  }
  if (!crossed) {
    errors.push("underdamped should overshoot at least once");
  }
  return errors;
}
