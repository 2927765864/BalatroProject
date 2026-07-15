/**
 * 弹性绳参数读取与锚点映射（主场景 / 沙盒共用）
 */
import { CONFIG } from "@game/config";
import { CardSkin } from "@render/CardSkin";
import type { ElasticRopeParams } from "./ElasticRopeTypes";

export function readElasticRopeParams(): ElasticRopeParams {
  const c = CONFIG.elasticRopeCard;
  return {
    enabled: c.enabled,
    spring: { ...c.spring },
    airDrag: { ...c.airDrag },
    integration: { ...c.integration },
    settle: { ...c.settle },
    rotation: { ...c.rotation },
  };
}

/**
 * 程序位移（抓牌/弃牌/归位等）默认绳锚点：牌心 X + 配置的 anchorY。
 *
 * 旋转 θ* 仅由水平弹力 Fs_x 与锚点本地 Y 的力矩符号决定（cross = -py * Fsx）。
 * 若 py≡0（构造默认值），则 θ* 恒为 0——抓牌等非拖拽路径从未 pointerdown 采样锚点时
 * 就会「有位移、无倾角」。拖拽仍由 mapElasticRopeAnchorLocal 在按下时覆盖。
 */
export function defaultElasticRopeAnchorLocal(): { x: number; y: number } {
  const a = CONFIG.elasticRopeCard.anchor;
  return { x: 0, y: a.anchorY };
}

/**
 * 将 pointer 在 CardView 本地（左上原点）的坐标映射为绳锚点（相对牌心）。
 */
export function mapElasticRopeAnchorLocal(
  localX: number,
  _localY: number,
): { x: number; y: number } {
  const a = CONFIG.elasticRopeCard.anchor;
  const W = CardSkin.width;
  const cx = localX - W / 2;
  let anchorLocalX: number;
  if (a.mapMode === "leftRightHalf") {
    anchorLocalX = cx < 0 ? a.anchorXMin : a.anchorXMax;
  } else {
    const t = Math.max(0, Math.min(1, localX / W));
    anchorLocalX = a.anchorXMin + (a.anchorXMax - a.anchorXMin) * t;
  }
  return { x: anchorLocalX, y: a.anchorY };
}
