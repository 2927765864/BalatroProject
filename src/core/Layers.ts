/**
 * 渲染层级（z-order）常量
 *
 * 通过 zIndex 而非 addChild 顺序控制层级，便于不同子系统插入物体而互不影响。
 * App 在初始化舞台时会启用 sortableChildren。
 *
 * 约定（与玩法一致）：
 *   - 静态 UI（侧栏、按钮等）在卡牌之下，避免挡住手牌 / 小丑 / 盲注筹码。
 *   - 卡牌层（含 shadowLayer 子层）整体压在 UI 之上；特效 / 弹窗仍在最顶。
 *   - 牌堆 / 小丑槽底条仍在卡牌之下，发牌时牌盖住牌堆。
 */
export const Layers = {
  Background: 0,
  Deck: 10,
  /** 小丑牌槽位暗色底条：在牌堆之上、卡牌之下，避免挡住小丑牌 */
  JokerBar: 15,
  /** HUD / 得分面板等界面（低于卡牌） */
  UI: 25,
  /** 预留：旧手牌层名；主场景手牌实际挂在 Card 层 */
  Hand: 30,
  /**
   * 手牌 / 小丑 / 盲注筹码及阴影。
   * 必须高于 UI，拖拽与悬停才能盖住侧栏与按钮区。
   */
  Card: 40,
  Fx: 50,
  Popup: 60,
} as const;

export type LayerName = keyof typeof Layers;
