/**
 * 游戏参数（一处定义，方便平衡数值与切关卡）
 */
export const GameConfig = {
  world: {
    width: 1280,
    height: 720,
    backgroundColor: 0x4a8b66,
  },
  rules: {
    handSize: 8, // 满手牌数量
    maxSelected: 5, // 最多选 5 张
    plays: 4, // 每回合出牌次数
    discards: 3, // 每回合弃牌次数
    targetScore: 450, // 目标分（盲注）
  },
  animation: {
    moveDurationMS: 280,
    flyOutDurationMS: 320,
  },
} as const;
