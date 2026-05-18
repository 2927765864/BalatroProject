import type { CardView } from "@render/CardView";
import type { TweenManager } from "@tween/TweenManager";
import { Easing } from "@tween/Easing";

/**
 * 卡牌视效集合
 *
 * 当前只暴露"移动到目标位姿"和"飞出回收"两个基础动画。
 * 未来按"卡牌视效专项"展开：拍下抖动、击杀爆光、连击焰光、玻璃碎裂等。
 *
 * 所有动画都返回一个 Promise，便于 GameController 串成动画序列。
 */
export const CardFx = {
  /** 平滑移动到目标位姿。原型里手写的 lerp 替代品。 */
  moveTo(
    tm: TweenManager,
    card: CardView,
    target: { x: number; y: number; rotation: number },
    durationMS = 280
  ): Promise<void> {
    return new Promise((resolve) => {
      tm.add(
        tm
          .create(card)
          .to(target, durationMS)
          .easing(Easing.cubicOut)
          .onComplete(resolve)
      );
    });
  },

  /** 飞出屏幕的回收动画（终点在世界右上方外）。 */
  flyOut(
    tm: TweenManager,
    card: CardView,
    worldWidth: number,
    durationMS = 320
  ): Promise<void> {
    return new Promise((resolve) => {
      tm.add(
        tm
          .create(card)
          .to(
            {
              x: worldWidth + 200,
              y: -200,
              rotation: Math.PI,
            },
            durationMS
          )
          .easing(Easing.cubicIn)
          .onComplete(resolve)
      );
    });
  },
};
