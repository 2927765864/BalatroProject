import type { CardView } from "./CardView";
import { CardSkin } from "./CardSkin";

/**
 * 手牌扇形排布算法（纯计算 -> 返回每张牌的目标位姿）
 *
 * 将位置计算与动画驱动解耦：
 *   - HandLayout.compute() 只算出每张牌的 (x, y, rotation)。
 *   - 上层把这些目标值喂给 TweenManager。
 *
 * 参数全部基于世界坐标系，外部不应再读 window.innerWidth。
 */
export interface HandLayoutOptions {
  /** 手牌区域的水平范围（世界坐标）。 */
  areaLeft: number;
  areaRight: number;
  /** 手牌基准 Y（世界坐标，未选中时的 Y）。 */
  baseY: number;
  /** 卡牌之间的水平间距。 */
  overlapSpacing?: number;
  /** 选中卡牌的弹起距离。 */
  selectedRiseY?: number;
  /** 扇形弧度系数（每张相对中心的角度）。 */
  fanRadians?: number;
}

export interface CardSlot {
  x: number;
  y: number;
  rotation: number;
}

export function computeHandLayout(
  hand: readonly CardView[],
  opts: HandLayoutOptions
): CardSlot[] {
  const overlap = opts.overlapSpacing ?? 65;
  const rise = opts.selectedRiseY ?? CardSkin.selectedRiseY;
  const fan = opts.fanRadians ?? 0.02;

  const handSize = hand.length;
  const areaCenter = (opts.areaLeft + opts.areaRight) / 2;
  const startX = areaCenter - ((handSize - 1) * overlap) / 2;

  return hand.map((card, index) => ({
    x: startX + index * overlap,
    y: card.selected ? opts.baseY - rise : opts.baseY,
    rotation: (index - (handSize - 1) / 2) * fan,
  }));
}
