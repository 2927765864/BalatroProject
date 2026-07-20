import { Container, Text, Graphics } from "pixi.js";
import type { TweenManager } from "@tween/TweenManager";
import { Easing } from "@tween/Easing";
import type { CardView } from "@render/CardView";
import { GameFonts } from "@ui/fonts";
import { sampleCurve } from "../debug/BezierCurveEditor";
import { CONFIG, scaleTimeMS, type BezierCurveConfig } from "@game/config";
import { SpringDamper1D } from "@/motion/SpringDamper1D";

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

/**
 * 结算数字参数：单字 scale 弹簧 + 整串跟随卡牌视觉位姿（无独立不倒翁）。
 * 见 docs/play-pile-settle-spring-damper-plan.md（scale 通道）；rot 由 CardView 结算摆动驱动。
 */
export type SettleTextSpringConfig = {
  fontSize: number;
  letterSpacing: number;
  color: number;
  offsetY: number;
  firstCharDelayMS: number;
  charIntervalMS: number;
  charIntervalReductionMS: number;
  mass: number;
  angularFreq: number;
  dampingRatio: number;
  impulseScale: number;
  impulseScaleVel: number;
  settleEpsScale: number;
  settleVelScale: number;
  maxDurationMS: number;
  maxDtSec: number;
  substeps: number;
  stayDurationMS: number;
  fadeDurationMS: number;
  /**
   * 单字 scale 缩放/消失锚点相对比例（Pixi Text.anchor）。
   * X/Y：0=左/上，0.5=中心，1=右/下；可超出 [0,1] 做偏心枢轴。
   * 排版仍按左缘推进 currentX，会用 anchor 补偿 x/y，保证静止时视觉位置不变。
   */
  shrinkAnchorX: number;
  shrinkAnchorY: number;
  shadowEnabled: boolean;
  shadowColor: number;
  shadowAlpha: number;
  shadowDistance: number;
  shadowAngleDeg: number;
  shadowBlur: number;
  bgBlockEnabled: boolean;
  bgBlockColor: number;
  /** 出现后恒定自转角速度（度/秒）；初始角每次 spawn 在 [0, 360) 均匀随机。 */
  bgBlockAngularSpeedDeg: number;
  bgBlockDurationMS: number;
  bgBlockFadeCurve: BezierCurveConfig;
  bgBlockScaleCurve: BezierCurveConfig;
  /** 数字后缀，如小丑倍率的 "倍率"；缺省为空（手牌筹码保持 "+N"）。 */
  textSuffix?: string;
};

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
      resolution: Math.max(3, (window.devicePixelRatio || 1) * 2),
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
   * 结算专用弹字：
   * - 逐字 scale 弹簧（目标 1，初值 1+impulseScale）
   * - 整串 position/rotation 每帧跟随对应卡牌视觉中心与摆动
   *   （CardView.displayWrapper 含 scoringRotOffset，与卡牌结算同源）
   * - 无独立不倒翁角弹簧
   */
  createSettleText(
    parent: Container,
    tm: TweenManager,
    card: CardView,
    value: number,
    cfg: SettleTextSpringConfig
  ): void {
    // 文字视效中的 ms 时间参数按 gameSpeed 缩放（面板仍显示 1× 基准值）
    cfg = {
      ...cfg,
      firstCharDelayMS: scaleTimeMS(cfg.firstCharDelayMS),
      charIntervalMS: scaleTimeMS(cfg.charIntervalMS),
      charIntervalReductionMS: scaleTimeMS(cfg.charIntervalReductionMS),
      maxDurationMS: scaleTimeMS(cfg.maxDurationMS),
      stayDurationMS: scaleTimeMS(cfg.stayDurationMS),
      fadeDurationMS: scaleTimeMS(cfg.fadeDurationMS),
      bgBlockDurationMS: scaleTimeMS(cfg.bgBlockDurationMS),
    };

    const textStr = "+" + value + (cfg.textSuffix ?? "");
    const chars = Array.from(textStr);

    const container = new Container();
    // pivot 保持中心：旋转 = 卡牌视觉旋转时，整串绕数字几何中心转（与牌心同心偏移）
    container.pivot.set(0, 0);
    const pose0 = card.getVisualFollowPoseInParent(cfg.offsetY);
    container.position.set(pose0.x, pose0.y);
    container.rotation = pose0.rotation;
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

    const charTexts = chars.map(
      (char) =>
        new Text({
          text: char,
          style: textStyle,
          resolution: Math.max(3, (window.devicePixelRatio || 1) * 2),
        })
    );

    const letterSpacing = cfg.letterSpacing;
    const widths = charTexts.map((t) => t.width);
    const totalWidth =
      widths.reduce((sum, w) => sum + w, 0) + (chars.length - 1) * letterSpacing;

    const ax = cfg.shrinkAnchorX;
    const ay = cfg.shrinkAnchorY;
    let currentX = -totalWidth / 2;
    charTexts.forEach((t, idx) => {
      const w = widths[idx]!;
      // 缩放枢轴 = (ax, ay)；用位置补偿使静止时视觉排版仍以左缘 currentX / 垂直中线为准
      t.anchor.set(ax, ay);
      t.x = currentX + ax * w;
      t.y = (ay - 0.5) * t.height;
      t.scale.set(0);
      container.addChild(t);
      currentX += w + letterSpacing;
    });

    const springParams = {
      mass: cfg.mass,
      angularFreq: cfg.angularFreq,
      dampingRatio: cfg.dampingRatio,
    };

    // 逐字启动延迟（墙钟，ms 已 scaleTimeMS）
    const startDelays: number[] = [];
    let delayAcc = cfg.firstCharDelayMS;
    for (let j = 0; j < chars.length; j++) {
      startDelays.push(delayAcc);
      if (j < chars.length - 1) {
        const stepDelay = Math.max(
          0,
          cfg.charIntervalMS - j * cfg.charIntervalReductionMS
        );
        delayAcc += stepDelay;
      }
    }
    const lastCharStartDelay = startDelays[chars.length - 1] ?? 0;

    const scaleSprings = chars.map(() => new SpringDamper1D());
    const scaleStarted = chars.map(() => false);
    const scaleSettled = chars.map(() => false);

    let wallElapsedMS = 0;
    let springElapsedMS = 0;
    let lastWallNow = performance.now();
    let lifeDone = false;
    let bgSpawned = false;
    let fadeStarted = false;
    let bgContainer: Container | null = null;
    // 背景方块跟随卡牌视觉角；自转本地角 = 随机初值 + 恒定角速度 × 时间
    let bgBaseFollowRot = 0;

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));

    const applyFollowPose = (): void => {
      if (container.destroyed || card.destroyed) return;
      const pose = card.getVisualFollowPoseInParent(cfg.offsetY);
      container.position.set(pose.x, pose.y);
      container.rotation = pose.rotation;
      if (bgContainer && !bgContainer.destroyed) {
        // 方块中心跟数字同一视觉锚点；rotation 由方块 tween onUpdate 写（跟随角 + 自转）
        bgContainer.position.set(pose.x, pose.y);
      }
    };

    const spawnBgBlock = (): void => {
      if (!cfg.bgBlockEnabled || bgSpawned || container.destroyed) return;
      bgSpawned = true;

      const pose = card.destroyed
        ? { x: container.x, y: container.y, rotation: container.rotation }
        : card.getVisualFollowPoseInParent(cfg.offsetY);

      bgContainer = new Container();
      bgContainer.position.set(pose.x, pose.y);
      bgBaseFollowRot = pose.rotation;
      // 初始本地角均匀随机；之后以恒定角速度自转（叠在卡牌视觉角上）
      const initLocal = Math.random() * Math.PI * 2;
      const speedRad =
        ((cfg.bgBlockAngularSpeedDeg || 0) * Math.PI) / 180;
      bgContainer.rotation = pose.rotation + initLocal;
      bgContainer.alpha = 1.0;
      bgContainer.scale.set(cfg.bgBlockScaleCurve.startScale);

      const bgBlock = new Graphics();
      const bgSize = Math.max(totalWidth + 24, cfg.fontSize * 1.6);
      bgBlock.rect(-bgSize / 2, -bgSize / 2, bgSize, bgSize);
      bgBlock.fill({ color: cfg.bgBlockColor });
      bgContainer.addChild(bgBlock);

      const idx = parent.children.indexOf(container);
      if (idx >= 0) {
        parent.addChildAt(bgContainer, idx);
      } else {
        parent.addChild(bgContainer);
      }

      const duration = cfg.bgBlockDurationMS;
      const progressDummy = { t: 0 };
      const bgRef = bgContainer;

      tm.add(
        tm
          .create(progressDummy)
          .to({ t: 1 }, duration)
          .easing(Easing.linear)
          .onUpdate(() => {
            if (!bgRef || bgRef.destroyed) return;
            // 位置每帧由 applyFollowPose 同步；此处只驱动 scale / alpha / 相对转角
            const followRot = card.destroyed
              ? bgBaseFollowRot
              : card.getVisualFollowPoseInParent(cfg.offsetY).rotation;
            bgBaseFollowRot = followRot;
            // 恒定角速度：elapsed 与 duration 同一时间基（已含 gameSpeed 缩放）
            const elapsedSec = (progressDummy.t * duration) / 1000;
            bgRef.rotation = followRot + initLocal + speedRad * elapsedSec;

            const currentScale = sampleCurve(
              cfg.bgBlockScaleCurve,
              progressDummy.t
            );
            bgRef.scale.set(currentScale);
            const fadeProgress = sampleCurve(
              cfg.bgBlockFadeCurve,
              progressDummy.t
            );
            bgRef.alpha = Math.max(0, Math.min(1, 1 - fadeProgress));
          })
          .onComplete(() => {
            bgRef.parent?.removeChild(bgRef);
            bgRef.destroy({ children: true });
            if (bgContainer === bgRef) bgContainer = null;
          })
      );
    };

    const handleStayAndFade = async (): Promise<void> => {
      if (fadeStarted || container.destroyed) return;
      fadeStarted = true;
      for (const t of charTexts) {
        if (!t.destroyed) t.scale.set(1);
      }

      if (cfg.stayDurationMS > 0) {
        await sleep(cfg.stayDurationMS);
      }
      if (container.destroyed) return;

      tm.add(
        tm
          .create(container)
          .to({ alpha: 0 }, cfg.fadeDurationMS)
          .easing(Easing.cubicOut)
          .onComplete(() => {
            container.parent?.removeChild(container);
            container.destroy({ children: true });
          })
      );

      charTexts.forEach((t) => {
        if (t.destroyed) return;
        tm.add(
          tm
            .create(t.scale)
            .to({ x: 0, y: 0 }, cfg.fadeDurationMS)
            .easing(Easing.cubicOut)
        );
      });
    };

    // 长时驱动：每帧积分 scale 弹簧 + 跟随卡牌位姿
    const driver = { t: 0 };
    tm.add(
      tm
        .create(driver)
        .to({ t: 1 }, 60_000)
        .easing(Easing.linear)
        .onUpdate(() => {
          if (container.destroyed) return;

          // 始终跟随（含 stay / fade），直到销毁
          applyFollowPose();

          if (lifeDone || fadeStarted) return;

          const now = performance.now();
          let wallDtMS = now - lastWallNow;
          lastWallNow = now;
          if (!Number.isFinite(wallDtMS) || wallDtMS < 0) wallDtMS = 0;
          wallDtMS = Math.min(wallDtMS, Math.max(1e-3, cfg.maxDtSec) * 1000 * 2);

          const speed = CONFIG.gameSpeed;
          const speedMul = Number.isFinite(speed) && speed > 0 ? speed : 1;
          const effectiveDtMS = wallDtMS * speedMul;
          const dtSec = effectiveDtMS / 1000;

          wallElapsedMS += wallDtMS;
          springElapsedMS += effectiveDtMS;

          // 1) 逐字 scale 弹簧
          for (let i = 0; i < chars.length; i++) {
            if (!scaleStarted[i] && wallElapsedMS >= (startDelays[i] ?? 0)) {
              scaleStarted[i] = true;
              scaleSprings[i]!.reset(
                1 + cfg.impulseScale,
                cfg.impulseScaleVel
              );
            }
            if (scaleStarted[i] && !scaleSettled[i]) {
              const s = scaleSprings[i]!;
              s.step(dtSec, 1, springParams, cfg.maxDtSec, cfg.substeps);
              if (
                s.isSettled(1, cfg.settleEpsScale, cfg.settleVelScale) ||
                springElapsedMS >= cfg.maxDurationMS
              ) {
                s.reset(1, 0);
                scaleSettled[i] = true;
              }
              const t = charTexts[i]!;
              if (!t.destroyed) {
                const sc = Math.max(0, s.x);
                t.scale.set(sc);
              }
            } else if (scaleSettled[i]) {
              const t = charTexts[i]!;
              if (!t.destroyed) t.scale.set(1);
            }
          }

          // 2) 背景方块：全部单字 scale 收敛后弹出
          if (
            !bgSpawned &&
            scaleSettled.every(Boolean) &&
            scaleStarted.every(Boolean)
          ) {
            spawnBgBlock();
          }
          if (
            !bgSpawned &&
            wallElapsedMS >= lastCharStartDelay + cfg.maxDurationMS * 0.5
          ) {
            spawnBgBlock();
          }

          // 3) scale 通道 settle 或硬帽 → 停留淡出（rot 由卡牌驱动，不单独 settle）
          const allScaleDone =
            scaleSettled.every(Boolean) || chars.length === 0;
          const timedOut = springElapsedMS >= cfg.maxDurationMS;
          if (allScaleDone || timedOut) {
            lifeDone = true;
            void handleStayAndFade();
          }
        })
        .onComplete(() => {
          if (!lifeDone && !container.destroyed) {
            lifeDone = true;
            void handleStayAndFade();
          }
        })
    );
  },
};
