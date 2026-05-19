import type { Container } from "pixi.js";
import { Text } from "pixi.js";
import type { TweenManager } from "@tween/TweenManager";
import { Easing } from "@tween/Easing";
import { Theme } from "@ui/theme";

/**
 * 文字视效（占位起步）
 *
 * 当前只实现"在指定位置跳出一个分数 / 提示字并淡出"——这就是计分爆出的雏形。
 * 未来"文字视效专项"会扩展：
 *   - 字符逐字浮现 / 抖动 / 渐变颜色
 *   - "+X chips"、"X1.5 mult" 风格的复合弹字
 */
export interface PopTextOptions {
  text: string;
  x: number;
  y: number;
  color?: number;
  fontSize?: number;
  riseY?: number;
  durationMS?: number;
}

export const TextFx = {
  popUp(parent: Container, tm: TweenManager, opts: PopTextOptions): Promise<void> {
    const t = new Text({
      text: opts.text,
      style: {
        fontFamily: Theme.fontFamily,
        fontSize: opts.fontSize ?? 32,
        fill: opts.color ?? 0xffffff,
        fontWeight: "bold",
      },
    });
    t.anchor.set(0.5);
    t.position.set(opts.x, opts.y);
    parent.addChild(t);

    const rise = opts.riseY ?? 60;
    const dur = opts.durationMS ?? 800;

    return new Promise((resolve) => {
      tm.add(
        tm
          .create(t)
          .to({ y: opts.y - rise, alpha: 0 }, dur)
          .easing(Easing.cubicOut)
          .onComplete(() => {
            t.parent?.removeChild(t);
            t.destroy();
            resolve();
          })
      );
    });
  },
};
