/**
 * 弹性绳子牵引卡牌模型 — 类型
 *
 * 参数语义见 docs/elastic-rope-traction-card-model.md §1 / §6
 * 与 docs/elastic-rope-rotation-damping-plan.md（旋转阻尼定稿）。
 */

export type AirDragMode = "linear" | "quadratic";
export type AnchorMapMode = "continuous" | "leftRightHalf";
export type ElasticRopeRotDynamics = "instant" | "follow" | "springDamper";
export type ElasticRopeRotMapMode = "linear" | "power";

export interface ElasticRopeParams {
  enabled: boolean;
  spring: {
    maxElasticLength: number;
    stiffness: number;
  };
  airDrag: {
    mode: AirDragMode;
    linearCoeff: number;
    quadraticCoeff: number;
  };
  integration: {
    mass: number;
    maxDtSec: number;
    substeps: number;
  };
  settle: {
    distancePx: number;
    speedPxPerSec: number;
  };
  rotation: {
    enabled: boolean;
    /** 仅 mapMode=linear 时参与 θ* */
    forceToAngle: number;
    maxAngleDeg: number;
    /** 仅 dynamics=follow */
    angleFollow: number;
    rotationAffectsAnchor: boolean;
    dynamics: ElasticRopeRotDynamics;
    mapMode: ElasticRopeRotMapMode;
    /** power 映射指数；linear 时忽略 */
    responseGamma: number;
    /** 角惯量 I */
    inertia: number;
    /** 自然频率 ωn (rad/s) */
    angularFreq: number;
    /** 阻尼比 ζ（1=临界） */
    dampingRatio: number;
  };
}

export interface ElasticRopeStepResult {
  x: number;
  y: number;
  /** 弧度 */
  rotation: number;
}

export interface ElasticRopeDebugSnapshot {
  D: number;
  Le: number;
  Lr: number;
  FsMag: number;
  speed: number;
  terminalSpeedApprox: number;
  C: { x: number; y: number };
  T: { x: number; y: number };
  elasticEnd: { x: number; y: number };
  anchorWorld: { x: number; y: number };
  /** 目标角 rad（可选 HUD） */
  thetaTarget: number;
  /** 角速度 rad/s */
  omega: number;
}
