/**
 * 渲染层级（z-order）常量
 *
 * 通过 zIndex 而非 addChild 顺序控制层级，便于不同子系统插入物体而互不影响。
 * App 在初始化舞台时会启用 sortableChildren。
 */
export const Layers = {
  Background: 0,
  Deck: 10,
  /** 小丑牌槽位暗色底条：在牌堆之上、卡牌之下，避免挡住小丑牌 */
  JokerBar: 15,
  Hand: 20,
  Card: 30,
  UI: 40,
  Fx: 50,
  Popup: 60,
} as const;

export type LayerName = keyof typeof Layers;
