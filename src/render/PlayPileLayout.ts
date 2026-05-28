/**
 * 出牌堆（PlayPile）排布算法 —— 纯计算，零副作用。
 *
 * 设计参考 HandLayout：
 *   - 不依赖 PIXI，仅返回每张牌的目标位姿 (x, y, rotation)。
 *   - 上层把这些目标值喂给 TweenManager / CardFx 实现动画。
 *
 * 公式（满足"中位与手牌堆中位对齐 + 间隔参数化"）：
 *   centerX = centerAlignsHand ? (handAreaLeft + handAreaRight) / 2 : worldCenterX
 *   slot[i].x = centerX + (i - (n - 1) / 2) * cardSpacing
 *   slot[i].y = handBaseY + baseYOffset
 *   slot[i].rotation = 0   （出牌堆不做扇形，平铺）
 *
 * 你描述的"第一张居中，此后每张右移一点"等价于：n=1 时居中；n>1 时整堆
 * 仍然以中位对齐手牌中位（更对称、更舒服），第一张落在中位左侧。
 * 如果未来需要"绝对第一张居中、整堆向右扩展"，把 startOffset 改成 0 即可。
 */
export interface PlayPileSlot {
  x: number;
  y: number;
  rotation: number;
}

export interface PlayPileLayoutOptions {
  /** 总张数。 */
  count: number;
  /** 手牌堆水平区域（用于"中位对齐手牌堆中位"）。 */
  handAreaLeft: number;
  handAreaRight: number;
  /** 手牌堆基准 Y（出牌堆 y = handBaseY + baseYOffset）。 */
  handBaseY: number;
  /** 出牌堆 baseY 相对手牌堆 baseY 的偏移，负值在上方。 */
  baseYOffset: number;
  /** 是否中位对齐手牌堆中位；false 时使用世界中线。 */
  centerAlignsHand: boolean;
  /** 世界宽度（centerAlignsHand=false 时用于求世界中线）。 */
  worldWidth: number;
  /** 相邻牌中心点间距（像素）。 */
  cardSpacing: number;
}

export function computePlayPileLayout(opts: PlayPileLayoutOptions): PlayPileSlot[] {
  const n = Math.max(0, opts.count);
  if (n === 0) return [];

  const centerX = opts.centerAlignsHand
    ? (opts.handAreaLeft + opts.handAreaRight) / 2
    : opts.worldWidth / 2;
  const y = opts.handBaseY + opts.baseYOffset;
  const startOffset = ((n - 1) / 2) * opts.cardSpacing;

  const slots: PlayPileSlot[] = [];
  for (let i = 0; i < n; i++) {
    slots.push({
      x: centerX - startOffset + i * opts.cardSpacing,
      y,
      rotation: 0,
    });
  }
  return slots;
}

/**
 * 按"第一张和最后一张过冲大，中间小"插值得到第 i 张的过冲幅度。
 * 简单 V 形：t = |2i/(n-1) - 1|，t∈[0,1]，端点取 first/last，谷底取 mid。
 *
 * 留作"未来可换更复杂曲线"的钩子点（例如读 CONFIG.playPile 的贝塞尔曲线）。
 */
export function computeLandingOvershoot(
  index: number,
  total: number,
  firstPx: number,
  midPx: number,
  lastPx: number
): number {
  if (total <= 1) return firstPx;
  const u = index / (total - 1); // 0 → 1
  if (u <= 0.5) {
    // first → mid
    const t = u / 0.5; // 0 → 1
    return firstPx + (midPx - firstPx) * t;
  } else {
    // mid → last
    const t = (u - 0.5) / 0.5;
    return midPx + (lastPx - midPx) * t;
  }
}
