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
 *
 * 弧形 / 扇形规则（与 control panel "手牌摆放" 对齐）：
 *   - cardSpacing: 相邻牌中心点的水平间距（像素）。
 *   - arcHeight:   弧形最大下沉幅度（像素）。中间牌 Y 偏移为 0，最外两张为 arcHeight。
 *                  使用 t = (i - center) / (n/2)，offsetY = arcHeight * t^2。
 *                  当 n <= 1 或 arcEnabled=false 时整体退化为 0。
 *   - fanAnglePerCardDeg: 每张牌相对中心牌的旋转角度（度）。最外侧旋转 ≈ (n-1)/2 * 该值。
 */
export interface HandLayoutOptions {
  /** 手牌区域的水平范围（世界坐标）。 */
  areaLeft: number;
  areaRight: number;
  /** 手牌基准 Y（世界坐标，未选中时的 Y）。 */
  baseY: number;
  /** 卡牌之间的水平间距。 */
  cardSpacing?: number;
  /** 选中卡牌的弹起距离。 */
  selectedRiseY?: number;
  /** 是否启用弧形摆放。 */
  arcEnabled?: boolean;
  /** 弧形最大下沉幅度（像素，最外侧两张相对中心牌的 Y 偏移）。 */
  arcHeight?: number;
  /** 每张牌相对中心牌的扇形旋转角度（度/张）。 */
  fanAnglePerCardDeg?: number;
}

export interface CardSlot {
  x: number;
  y: number;
  rotation: number;
}

const DEG_TO_RAD = Math.PI / 180;

export function computeHandLayout(
  hand: readonly CardView[],
  opts: HandLayoutOptions
): CardSlot[] {
  const spacing = opts.cardSpacing ?? 65;
  const rise = opts.selectedRiseY ?? CardSkin.selectedRiseY;
  const arcEnabled = opts.arcEnabled ?? false;
  const arcHeight = opts.arcHeight ?? 0;
  const fanDeg = opts.fanAnglePerCardDeg ?? 0;

  const handSize = hand.length;
  const areaCenter = (opts.areaLeft + opts.areaRight) / 2;
  const startX = areaCenter - ((handSize - 1) * spacing) / 2;
  const centerIndex = (handSize - 1) / 2;
  // 归一化半径，避免 handSize=1 时除零；最外侧 |t|=1。
  const halfSpan = Math.max(1, centerIndex);

  return hand.map((card, index) => {
    const t = (index - centerIndex) / halfSpan;
    const arcOffsetY = arcEnabled && handSize > 1 ? arcHeight * t * t : 0;
    const baseY = opts.baseY + arcOffsetY;
    return {
      x: startX + index * spacing,
      y: card.selected ? baseY - rise : baseY,
      rotation: t * halfSpan * fanDeg * DEG_TO_RAD,
    };
  });
}
