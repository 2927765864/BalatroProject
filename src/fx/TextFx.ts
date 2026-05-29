import { Container, Text } from "pixi.js";
import type { TweenManager } from "@tween/TweenManager";
import { Easing } from "@tween/Easing";
import type { CardView } from "@render/CardView";
import { GameFonts } from "@ui/fonts";

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
        fontFamily: GameFonts.textFxStack,
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

  /**
   * 创建出牌堆卡牌结算筹码时的专用往复震荡、逐字弹出数字效果。
   * 
   * @param parent 效果容器所在的父级节点（通常是卡牌的 parent，以便文字在相同层级显示并独立于卡牌自身运动）
   * @param tm 缓动管理器
   * @param card 对应的卡牌视图
   * @param chips 筹码数量
   * @param cfg 结算文字效果配置
   */
  createSettleText(
    parent: Container,
    tm: TweenManager,
    card: CardView,
    chips: number,
    cfg: {
      fontSize: number;
      letterSpacing: number;
      color: number;
      offsetY: number;
      firstCharDelayMS: number;
      charIntervalMS: number;
      charIntervalReductionMS: number;
      charScaleDurationMS: number;
      charMaxScale: number;
      charStableScale: number;
      swingPivotY: number;
      swingMaxAngleDeg: number;
      swingFrequency: number;
      swingDamping: number;
      swingDurationMS: number;
      stayDurationMS: number;
      fadeDurationMS: number;
      shrinkAnchorY: number;
      shadowEnabled: boolean;
      shadowColor: number;
      shadowAlpha: number;
      shadowDistance: number;
      shadowAngleDeg: number;
      shadowBlur: number;
    }
  ): void {
    const textStr = "+" + chips;
    const chars = textStr.split("");

    const container = new Container();
    const targetX = card.x;
    const targetY = card.y + cfg.offsetY;

    // 设置不倒翁往复摆动的旋转圆心（设置为 local 下方偏移 swingPivotY 像素处）
    container.pivot.set(0, cfg.swingPivotY);
    container.position.set(targetX, targetY + cfg.swingPivotY);
    parent.addChild(container);

    const textStyle = {
      fontFamily: GameFonts.textFxStack,
      fontSize: cfg.fontSize,
      fill: cfg.color,
      fontWeight: "bold" as const,
      dropShadow: cfg.shadowEnabled,
      dropShadowColor: cfg.shadowColor,
      dropShadowAlpha: cfg.shadowAlpha,
      dropShadowDistance: cfg.shadowDistance,
      dropShadowAngle: (cfg.shadowAngleDeg * Math.PI) / 180,
      dropShadowBlur: cfg.shadowBlur,
    };

    // 实例化单字以便测量宽度并进行精确排版
    const charTexts = chars.map((char) => new Text({ text: char, style: textStyle }));

    const letterSpacing = cfg.letterSpacing;
    const widths = charTexts.map((t) => t.width);
    const totalWidth = widths.reduce((sum, w) => sum + w, 0) + (chars.length - 1) * letterSpacing;

    let currentX = -totalWidth / 2;
    charTexts.forEach((t, idx) => {
      const w = widths[idx]!;

      // 将 X 轴锚点设为 0，Y 轴锚点设为偏上。这样单字出现时会向右侧展开，其左侧边缘完全固定，实现"一个萝卜一个坑"的固定排版
      t.anchor.set(0, cfg.shrinkAnchorY);

      // 设置 X 轴定位为其左边缘。
      t.x = currentX;
      // 设置 Y 轴偏置补偿，使单字原本的几何中心在 local y = 0
      t.y = (cfg.shrinkAnchorY - 0.5) * t.height;

      // 初始比例为 0 达到不可见
      t.scale.set(0);

      container.addChild(t);
      currentX += w + letterSpacing;
    });

    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    // 1. 逐字从小变大弹出（从左到右依次执行）
    const animateChar = async (idx: number, delay: number) => {
      if (delay > 0) {
        await sleep(delay);
      }
      const t = charTexts[idx]!;
      const upDur = cfg.charScaleDurationMS * 0.6;
      const downDur = cfg.charScaleDurationMS * 0.4;

      tm.add(
        tm.create(t.scale)
          .to({ x: cfg.charMaxScale, y: cfg.charMaxScale }, upDur)
          .easing(Easing.cubicOut)
          .onComplete(() => {
            tm.add(
              tm.create(t.scale)
                .to({ x: cfg.charStableScale, y: cfg.charStableScale }, downDur)
                .easing(Easing.quadInOut)
            );
          })
      );
    };

    let currentDelay = cfg.firstCharDelayMS;
    for (let j = 0; j < chars.length; j++) {
      void animateChar(j, currentDelay);
      if (j < chars.length - 1) {
        const stepDelay = Math.max(0, cfg.charIntervalMS - j * cfg.charIntervalReductionMS);
        currentDelay += stepDelay;
      }
    }

    // 2. 整个文本不倒翁往复摆动效果（阻尼简谐振动模型，与 "+" 出现一瞬间同步启动）
    const dummy = { progress: 0 };
    const maxRotRad = (cfg.swingMaxAngleDeg * Math.PI) / 180;

    // 3. 摆动平稳后静止并在停留一段时间后收缩淡出
    const handleStayAndFade = async () => {
      if (cfg.stayDurationMS > 0) {
        await sleep(cfg.stayDurationMS);
      }

      // 整体数字淡出：透明度 1 -> 0
      tm.add(
        tm.create(container)
          .to({ alpha: 0 }, cfg.fadeDurationMS)
          .easing(Easing.cubicOut)
          .onComplete(() => {
            container.parent?.removeChild(container);
            container.destroy({ children: true });
          })
      );

      // 单字独立变小：大小从 1 -> 0
      charTexts.forEach((t) => {
        tm.add(
          tm.create(t.scale)
            .to({ x: 0, y: 0 }, cfg.fadeDurationMS)
            .easing(Easing.cubicOut)
        );
      });
    };

    tm.add(
      tm.create(dummy)
        .to({ progress: 1 }, cfg.swingDurationMS)
        .easing(Easing.linear)
        .onUpdate(() => {
          const p = dummy.progress;
          // θ(p) = θ_max * e^(-damping * p) * sin(p * 2 * PI * frequency)
          const angle = maxRotRad * Math.exp(-cfg.swingDamping * p) * Math.sin(p * Math.PI * 2 * cfg.swingFrequency);
          container.rotation = angle;
        })
        .onComplete(() => {
          container.rotation = 0;
          void handleStayAndFade();
        })
    );
  },
};
