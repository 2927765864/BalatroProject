/**
 * 弹性绳子牵引 — 纯运动核（无 PIXI）
 *
 * 理论与公式：
 *   docs/elastic-rope-traction-card-model.md
 *   docs/elastic-rope-rotation-damping-plan.md
 *   - Le = min(D, Lmax), Lr = max(0, D - Lmax)；绳永远共线
 *   - Fs = k * Le * û（力饱和于 k*Lmax）
 *   - Fd = -c*v 或 -c2*|v|*v
 *   - 半隐式欧拉 + dt clamp + substeps（Gaffer timestep）
 *   - settle：D < ds 且 |v| < vs 时硬贴合
 *   - 旋转：θ* 仅由 Fs_x；dynamics = instant | follow | springDamper
 */

import type {
  ElasticRopeDebugSnapshot,
  ElasticRopeParams,
  ElasticRopeStepResult,
} from "./ElasticRopeTypes";

const EPS_D = 1e-6;
const EPS_CROSS = 1e-6;
/** springDamper 安全网：|ω| 超限时清零（见 damping-plan T1） */
const OMEGA_SAFE = 1000;

export class ElasticRopeMotion {
  private x = 0;
  private y = 0;
  private vx = 0;
  private vy = 0;
  private tx = 0;
  private ty = 0;
  private rotation = 0;
  /** 角速度 rad/s（仅 springDamper 有意义） */
  private omega = 0;
  private anchorLocalX = 0;
  private anchorLocalY = 0;
  private lastThetaTarget = 0;
  private debug: ElasticRopeDebugSnapshot = emptyDebug();

  reset(pose: { x: number; y: number; rotation?: number }): void {
    this.x = pose.x;
    this.y = pose.y;
    this.vx = 0;
    this.vy = 0;
    this.tx = pose.x;
    this.ty = pose.y;
    this.rotation = pose.rotation ?? 0;
    this.omega = 0;
    this.lastThetaTarget = 0;
    this.debug = emptyDebug();
    this.debug.C = { x: this.x, y: this.y };
    this.debug.T = { x: this.tx, y: this.ty };
  }

  setTarget(x: number, y: number): void {
    this.tx = x;
    this.ty = y;
  }

  setAnchorLocal(x: number, y: number): void {
    this.anchorLocalX = x;
    this.anchorLocalY = y;
  }

  getAnchorLocal(): { x: number; y: number } {
    return { x: this.anchorLocalX, y: this.anchorLocalY };
  }

  isSettled(params: ElasticRopeParams): boolean {
    const D = Math.hypot(this.tx - this.x, this.ty - this.y);
    const speed = Math.hypot(this.vx, this.vy);
    return (
      D < params.settle.distancePx && speed < params.settle.speedPxPerSec
    );
  }

  getDebug(): ElasticRopeDebugSnapshot {
    return {
      ...this.debug,
      C: { ...this.debug.C },
      T: { ...this.debug.T },
      elasticEnd: { ...this.debug.elasticEnd },
      anchorWorld: { ...this.debug.anchorWorld },
    };
  }

  step(dtMS: number, params: ElasticRopeParams): ElasticRopeStepResult {
    if (!params.enabled) {
      this.refreshDebug(params, 0, 0, 0, 0, 0, 0);
      return { x: this.x, y: this.y, rotation: this.rotation };
    }

    const maxDt = Math.max(1e-4, params.integration.maxDtSec);
    const dtSec = Math.min(Math.max(0, dtMS / 1000), maxDt);
    const substeps = Math.max(1, Math.floor(params.integration.substeps));
    const h = dtSec / substeps;
    const m = Math.max(1e-6, params.integration.mass);
    const k = Math.max(0, params.spring.stiffness);
    const Lmax = Math.max(0, params.spring.maxElasticLength);
    const c = Math.max(0, params.airDrag.linearCoeff);
    const c2 = Math.max(0, params.airDrag.quadraticCoeff);
    const quadratic = params.airDrag.mode === "quadratic";

    const rot = params.rotation;
    const dynamics = rot.dynamics ?? "follow";
    const maxRad = (Math.max(0, rot.maxAngleDeg) * Math.PI) / 180;
    const I = Math.max(1e-6, rot.inertia ?? 1);
    const wn = Math.min(60, Math.max(1e-6, rot.angularFreq ?? 12));
    const zeta = Math.max(0, rot.dampingRatio ?? 1);
    const kTheta = I * wn * wn;
    const cTheta = 2 * zeta * I * wn;
    const springDamperOn = rot.enabled && dynamics === "springDamper";

    let lastFsx = 0;
    let lastFsy = 0;
    let lastLe = 0;
    let lastLr = 0;
    let lastD = 0;

    for (let i = 0; i < substeps; i += 1) {
      const dx = this.tx - this.x;
      const dy = this.ty - this.y;
      const D = Math.hypot(dx, dy);
      lastD = D;

      let ux = 0;
      let uy = 0;
      if (D > EPS_D) {
        ux = dx / D;
        uy = dy / D;
      }

      const Le = Math.min(D, Lmax);
      const Lr = Math.max(0, D - Lmax);
      lastLe = Le;
      lastLr = Lr;

      const FsMag = k * Le;
      lastFsx = FsMag * ux;
      lastFsy = FsMag * uy;

      let Fdx = 0;
      let Fdy = 0;
      if (quadratic) {
        const sp = Math.hypot(this.vx, this.vy);
        Fdx = -c2 * sp * this.vx;
        Fdy = -c2 * sp * this.vy;
      } else {
        Fdx = -c * this.vx;
        Fdy = -c * this.vy;
      }

      const ax = (lastFsx + Fdx) / m;
      const ay = (lastFsy + Fdy) / m;

      // 半隐式欧拉（平移）
      this.vx += ax * h;
      this.vy += ay * h;
      this.x += this.vx * h;
      this.y += this.vy * h;

      // 角 springDamper：与平移同一子步（damping-plan §2.5 / §10）
      if (springDamperOn) {
        const thetaTarget = this.computeThetaTarget(lastFsx, params, maxRad);
        this.lastThetaTarget = thetaTarget;
        const torque = kTheta * (thetaTarget - this.rotation) - cTheta * this.omega;
        this.omega += (torque / I) * h;
        this.rotation += this.omega * h;
        // C3 限幅
        if (this.rotation > maxRad) {
          this.rotation = maxRad;
          if (this.omega > 0) this.omega = 0;
        } else if (this.rotation < -maxRad) {
          this.rotation = -maxRad;
          if (this.omega < 0) this.omega = 0;
        }
        // T1 安全网
        if (!Number.isFinite(this.omega) || Math.abs(this.omega) > OMEGA_SAFE) {
          this.omega = 0;
          this.rotation = clamp(this.rotation, -maxRad, maxRad);
        }
        if (!Number.isFinite(this.rotation)) {
          this.rotation = 0;
          this.omega = 0;
        }
      }
    }

    // settle：距离 ∧ 速度
    const Ds = Math.hypot(this.tx - this.x, this.ty - this.y);
    const speed = Math.hypot(this.vx, this.vy);
    const settled =
      Ds < params.settle.distancePx && speed < params.settle.speedPxPerSec;
    if (settled) {
      this.x = this.tx;
      this.y = this.ty;
      this.vx = 0;
      this.vy = 0;
      lastD = 0;
      lastLe = 0;
      lastLr = 0;
      lastFsx = 0;
      lastFsy = 0;
    }

    // 旋转：follow / instant 仅帧末一次（T6）；springDamper 已在子步内
    if (!rot.enabled) {
      this.rotation = 0;
      this.omega = 0;
      this.lastThetaTarget = 0;
    } else if (dynamics === "follow") {
      const thetaTarget = this.computeThetaTarget(lastFsx, params, maxRad);
      this.lastThetaTarget = thetaTarget;
      const follow = rot.angleFollow;
      if (follow <= 0 || follow >= 1) {
        this.rotation = thetaTarget;
      } else {
        const alpha = 1 - Math.pow(1 - follow, dtMS / 16.667);
        this.rotation += (thetaTarget - this.rotation) * alpha;
      }
      this.omega = 0;
    } else if (dynamics === "instant") {
      const thetaTarget = this.computeThetaTarget(lastFsx, params, maxRad);
      this.lastThetaTarget = thetaTarget;
      this.rotation = thetaTarget;
      this.omega = 0;
    } else if (dynamics === "springDamper") {
      // 子步已更新；若 settled 会在下方清零
      if (!springDamperOn) {
        // enabled 但未进循环（不应发生）
        this.lastThetaTarget = this.computeThetaTarget(lastFsx, params, maxRad);
      }
    } else {
      // 未知 dynamics：退回 follow 语义的安全默认
      const thetaTarget = this.computeThetaTarget(lastFsx, params, maxRad);
      this.lastThetaTarget = thetaTarget;
      this.rotation = thetaTarget;
      this.omega = 0;
    }

    // S1：吸附时强制角归零
    if (settled && rot.enabled) {
      this.rotation = 0;
      this.omega = 0;
      this.lastThetaTarget = 0;
    }

    this.refreshDebug(params, lastD, lastLe, lastLr, lastFsx, lastFsy, c);
    return { x: this.x, y: this.y, rotation: this.rotation };
  }

  /**
   * θ*：仅 Fs_x + 未旋转锚点 py 符号；linear / power 映射。
   * docs/elastic-rope-rotation-damping-plan.md §2.2–2.3
   */
  private computeThetaTarget(
    Fsx: number,
    params: ElasticRopeParams,
    maxRad: number,
  ): number {
    const mag = Math.abs(Fsx);
    const py = this.anchorLocalY;
    const cross = -py * Fsx;
    if (mag <= EPS_D || Math.abs(cross) < EPS_CROSS) {
      return 0;
    }
    const sign = Math.sign(cross);
    const mapMode = params.rotation.mapMode ?? "linear";
    if (mapMode === "power") {
      const Fref = Math.max(
        params.spring.stiffness * params.spring.maxElasticLength,
        1e-9,
      );
      const u = clamp(mag / Fref, 0, 1);
      const gamma = Math.max(0.05, params.rotation.responseGamma ?? 1.5);
      const g = Math.pow(u, gamma);
      return clamp(sign * maxRad * g, -maxRad, maxRad);
    }
    return clamp(
      params.rotation.forceToAngle * mag * sign,
      -maxRad,
      maxRad,
    );
  }

  private refreshDebug(
    params: ElasticRopeParams,
    D: number,
    Le: number,
    Lr: number,
    Fsx: number,
    Fsy: number,
    c: number,
  ): void {
    const dx = this.tx - this.x;
    const dy = this.ty - this.y;
    const dist = Math.hypot(dx, dy);
    let ux = 0;
    let uy = 0;
    if (dist > EPS_D) {
      ux = dx / dist;
      uy = dy / dist;
    }
    const FsMag = Math.hypot(Fsx, Fsy);
    const Lmax = Math.max(0, params.spring.maxElasticLength);
    const k = Math.max(0, params.spring.stiffness);
    const linearC = Math.max(1e-9, c > 0 ? c : params.airDrag.linearCoeff);
    const terminal =
      params.airDrag.mode === "linear" && linearC > 0
        ? (k * Lmax) / linearC
        : 0;

    let awx = this.x + this.anchorLocalX;
    let awy = this.y + this.anchorLocalY;
    if (params.rotation.rotationAffectsAnchor && this.rotation !== 0) {
      const cos = Math.cos(this.rotation);
      const sin = Math.sin(this.rotation);
      awx = this.x + this.anchorLocalX * cos - this.anchorLocalY * sin;
      awy = this.y + this.anchorLocalX * sin + this.anchorLocalY * cos;
    }

    this.debug = {
      D: D > 0 ? D : dist,
      Le,
      Lr,
      FsMag,
      speed: Math.hypot(this.vx, this.vy),
      terminalSpeedApprox: terminal,
      C: { x: this.x, y: this.y },
      T: { x: this.tx, y: this.ty },
      elasticEnd: {
        x: this.x + ux * Le,
        y: this.y + uy * Le,
      },
      anchorWorld: { x: awx, y: awy },
      thetaTarget: this.lastThetaTarget,
      omega: this.omega,
    };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function emptyDebug(): ElasticRopeDebugSnapshot {
  return {
    D: 0,
    Le: 0,
    Lr: 0,
    FsMag: 0,
    speed: 0,
    terminalSpeedApprox: 0,
    C: { x: 0, y: 0 },
    T: { x: 0, y: 0 },
    elasticEnd: { x: 0, y: 0 },
    anchorWorld: { x: 0, y: 0 },
    thetaTarget: 0,
    omega: 0,
  };
}

function defaultRotFields(
  partial: Partial<ElasticRopeParams["rotation"]> &
    Pick<
      ElasticRopeParams["rotation"],
      "enabled" | "forceToAngle" | "maxAngleDeg" | "angleFollow" | "rotationAffectsAnchor"
    >,
): ElasticRopeParams["rotation"] {
  return {
    dynamics: "follow",
    mapMode: "linear",
    responseGamma: 1.5,
    inertia: 1,
    angularFreq: 12,
    dampingRatio: 1,
    ...partial,
  };
}

/** 开发期自检：返回失败信息数组，空 = 通过。 */
export function selfCheckElasticRopeMotion(): string[] {
  const errors: string[] = [];
  const m = new ElasticRopeMotion();
  const base: ElasticRopeParams = {
    enabled: true,
    spring: { maxElasticLength: 100, stiffness: 50 },
    airDrag: { mode: "linear", linearCoeff: 10, quadraticCoeff: 0.001 },
    integration: { mass: 1, maxDtSec: 1 / 30, substeps: 2 },
    settle: { distancePx: 2, speedPxPerSec: 30 },
    rotation: defaultRotFields({
      enabled: false,
      forceToAngle: 0.00003,
      maxAngleDeg: 20,
      angleFollow: 1,
      rotationAffectsAnchor: false,
    }),
  };

  m.reset({ x: 0, y: 0 });
  m.setTarget(0, 0);
  m.step(16, base);
  const d0 = m.getDebug();
  if (d0.FsMag > 1e-6) errors.push("D=0 时期望 Fs≈0");

  m.reset({ x: 0, y: 0 });
  m.setTarget(300, 0); // D > Lmax
  m.step(0.001, { ...base, integration: { ...base.integration, substeps: 1, maxDtSec: 1 } });
  const d1 = m.getDebug();
  const expectedFs = base.spring.stiffness * base.spring.maxElasticLength;
  if (Math.abs(d1.FsMag - expectedFs) > 1e-2) {
    errors.push(`D>Lmax 时期望 Fs=${expectedFs}，得 ${d1.FsMag}`);
  }

  const Vterm = expectedFs / base.airDrag.linearCoeff;
  m.reset({ x: 0, y: 0 });
  m.setTarget(500, 0);
  for (let i = 0; i < 120; i += 1) {
    m.step(16, base);
  }
  const d2 = m.getDebug();
  if (d2.speed > Vterm * 1.35) {
    errors.push(`速度应接近终端上限 ~${Vterm}，得 ${d2.speed}`);
  }

  m.reset({ x: 1, y: 0 });
  m.setTarget(0, 0);
  for (let i = 0; i < 200; i += 1) {
    m.step(16, base);
  }
  if (!m.isSettled(base) && m.getDebug().D > base.settle.distancePx * 2) {
    errors.push("长时间后应 settle 到目标附近");
  }

  // follow + angleFollow=1：纯垂直 / 水平（回归）
  const rotFollow: ElasticRopeParams = {
    ...base,
    rotation: defaultRotFields({
      enabled: true,
      forceToAngle: 0.001,
      maxAngleDeg: 25,
      angleFollow: 1,
      rotationAffectsAnchor: false,
      dynamics: "follow",
      mapMode: "linear",
    }),
  };
  const stepTiny = {
    ...rotFollow,
    integration: { ...rotFollow.integration, substeps: 1, maxDtSec: 1 },
  };
  m.reset({ x: 0, y: 0, rotation: 0 });
  m.setAnchorLocal(20, -40);
  m.setTarget(0, 200);
  const rVert = m.step(0.001, stepTiny);
  if (Math.abs(rVert.rotation) > 1e-5) {
    errors.push(`纯垂直牵引时期望 rotation≈0，得 ${rVert.rotation}`);
  }
  m.reset({ x: 0, y: 0, rotation: 0 });
  m.setAnchorLocal(20, -40);
  m.setTarget(200, 0);
  const rHoriz = m.step(0.001, stepTiny);
  if (Math.abs(rHoriz.rotation) < 1e-5) {
    errors.push(`纯水平牵引时期望非零 rotation，得 ${rHoriz.rotation}`);
  }

  // springDamper：多帧后水平非零；垂直≈0；不爆炸；settle 清角
  const rotSd: ElasticRopeParams = {
    ...base,
    rotation: defaultRotFields({
      enabled: true,
      forceToAngle: 0.001,
      maxAngleDeg: 25,
      angleFollow: 0.35,
      rotationAffectsAnchor: false,
      dynamics: "springDamper",
      mapMode: "linear",
      inertia: 1,
      angularFreq: 20,
      dampingRatio: 1,
    }),
  };

  m.reset({ x: 0, y: 0, rotation: 0 });
  m.setAnchorLocal(20, -40);
  m.setTarget(200, 0);
  let lastRot = 0;
  for (let i = 0; i < 40; i += 1) {
    lastRot = m.step(16, rotSd).rotation;
  }
  if (Math.abs(lastRot) < 1e-5) {
    errors.push(`springDamper 水平牵引多帧后期望非零 rotation，得 ${lastRot}`);
  }
  const dbgSd = m.getDebug();
  if (!Number.isFinite(dbgSd.omega) || Math.abs(dbgSd.omega) > OMEGA_SAFE) {
    errors.push(`springDamper omega 应有限且受控，得 ${dbgSd.omega}`);
  }
  const maxRadSd = (rotSd.rotation.maxAngleDeg * Math.PI) / 180;
  if (Math.abs(lastRot) > maxRadSd + 1e-3) {
    errors.push(`springDamper |θ| 不应超过 maxAngle，得 ${lastRot}`);
  }

  m.reset({ x: 0, y: 0, rotation: 0 });
  m.setAnchorLocal(20, -40);
  m.setTarget(0, 200);
  for (let i = 0; i < 40; i += 1) {
    lastRot = m.step(16, rotSd).rotation;
  }
  if (Math.abs(lastRot) > 1e-3) {
    errors.push(`springDamper 纯垂直多帧后期望 rotation≈0，得 ${lastRot}`);
  }

  // settle 清 θ、ω：近目标多帧
  const settleParams: ElasticRopeParams = {
    ...rotSd,
    settle: { distancePx: 5, speedPxPerSec: 500 },
  };
  m.reset({ x: 0.5, y: 0, rotation: 0.1 });
  m.setAnchorLocal(20, -40);
  m.setTarget(0, 0);
  // 先给一点角速度态：水平拉开再拉回
  m.setTarget(80, 0);
  for (let i = 0; i < 10; i += 1) m.step(16, settleParams);
  m.setTarget(0, 0);
  for (let i = 0; i < 80; i += 1) m.step(16, settleParams);
  const afterSettle = m.step(16, settleParams);
  if (m.isSettled(settleParams)) {
    if (Math.abs(afterSettle.rotation) > 1e-6) {
      errors.push(`settle 后期望 rotation=0，得 ${afterSettle.rotation}`);
    }
    if (Math.abs(m.getDebug().omega) > 1e-6) {
      errors.push(`settle 后期望 omega=0，得 ${m.getDebug().omega}`);
    }
  }

  return errors;
}
