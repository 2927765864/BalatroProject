/**
 * 全局拖拽会话（引用计数）
 *
 * 手牌 / 小丑牌（CardView）与左上角盲注筹码徽章（BlindChipBadge）在
 * pointerdown 进入拖拽时 acquire，pointerup / destroy 时 release。
 *
 * 其它可交互卡牌在 isDragSessionActive() 为 true 且自身并非拖拽源时，
 * 应抑制 pointerover 触发的触碰动画（hover 缩放 / 呼吸晃动 / 伪 3D 倾斜等），
 * 避免拖拽过程中划过邻牌时出现连锁 hover 效果。
 */

let activeCount = 0;

/** 开始一次拖拽会话（同一对象请勿重复 acquire，调用方应做本地幂等）。 */
export function beginDragSession(): void {
  activeCount += 1;
}

/** 结束一次拖拽会话。 */
export function endDragSession(): void {
  if (activeCount > 0) activeCount -= 1;
}

/** 是否存在任意进行中的卡牌 / 徽章拖拽。 */
export function isDragSessionActive(): boolean {
  return activeCount > 0;
}
