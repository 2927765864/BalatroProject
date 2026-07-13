import type { EventBus } from "@core/EventBus";
import type { TweenManager } from "@tween/TweenManager";
import type { CardView } from "@render/CardView";
import type { ScoreResult } from "@domain/types";
import {
  computePlayPileLayout,
  computeLandingOvershoot,
} from "@render/PlayPileLayout";
import { PlayPileFx, sleep } from "@fx/PlayPileFx";
import { CardFx } from "@fx/CardFx";
import { TextFx } from "@fx/TextFx";
import { CONFIG } from "./config";
import type { GameEvents } from "./events";

/**
 * 出牌流程主控（5 阶段编排）
 *
 * 关注点：
 *   - 仅做"时序 + 调度"，不直接画任何东西；具体视效在 PlayPileFx / CardFx 内部。
 *   - 每个阶段首尾通过 EventBus.emit('play:xxx')，让未来视效/音效/分析无侵入式接入。
 *   - 不直接访问 GameController 的内部状态，所有依赖都通过构造参数注入；
 *     这使 PlayPipeline 易于单测，也避免循环依赖。
 *
 * 阶段对应需求：
 *   1. 逐张出牌：选中牌按 handIndex 从左到右依次飞往出牌堆槽位，错开发车；
 *                每张牌发车前调一次 layoutHand({force:true}) 让剩余手牌挤位。
 *   2. 出牌堆排布：第一张居中（n=1 时），多张时整堆中位对齐手牌堆中位；
 *                  每张牌落位时按位置插值得到不同过冲幅度（首尾大、中间小）。
 *   3. 整堆上抬：所有牌落定后一起向上一次过冲（钩子：未来抬阴影）。
 *   4a. 手牌结算：逐张弹性震荡 + 筹码弹字（蓝色背景方块）。
 *   4b. 小丑结算：顶部小丑逐张弹性震荡 + 倍率弹字（红色背景方块，默认 +10）；无上下移。
 *   5. 下移 + 预期分迁移 + 丢牌：整堆下移 → 分数迁移 → 从左到右逐张飞出。
 */
export interface PlayPipelineDeps {
  tween: TweenManager;
  bus: EventBus<GameEvents>;
  worldWidth: number;
  worldHeight: number;
  /** 读手牌堆水平区域（用于出牌堆中位对齐）。 */
  getHandArea: () => { left: number; right: number; baseY: number };
  /** 触发手牌重排（force 用于 1) 让出选中的牌后剩余牌挤位）。 */
  layoutHand: (opts?: { force?: boolean }) => void;
  /**
   * 阶段 4 结算时把 result.score 加到 totalScore；返回最新 totalScore。
   * 由 GameController 注入（既负责数据写回 store，也负责 HUD 文本刷新）。
   */
  applyScore: (result: ScoreResult) => number;
  /**
   * 从手牌数组中移除"已经飞出去的牌"，并立即重排剩余手牌。
   * 调用时机：阶段 1 内每张牌发车的瞬间——这样剩余手牌能立刻挤位填空。
   */
  removeFromHand: (view: CardView) => void;
  /**
   * 读取当前顶部小丑列表（从左到右顺序）。
   * 小丑结算阶段会按此顺序逐张触发倍率结算视效。
   */
  getJokers?: () => readonly CardView[];
  /**
   * 分数迁移效果。在整堆卡牌下移后、飞往弃牌堆前，将预期分数迁移到回合分上。
   */
  animateScoreTransfer?: (result: ScoreResult) => Promise<void>;
}

export class PlayPipeline {
  constructor(private readonly deps: PlayPipelineDeps) {}

  /**
   * 执行一次完整的出牌流程。返回 Promise，调用方 await 后即可"补牌 + 解锁"。
   *
   * 入参 selected 必须已经是稳定的"按 handIndex 升序"或调用方期望的出牌顺序；
   * 本方法内部会再按 handIndex 兜底排序一次，保证"从左到右逐张"的语义。
   */
  async run(
    selectedRaw: readonly CardView[],
    result: ScoreResult
  ): Promise<{ totalScore: number; views: CardView[] }> {
    const cfg = CONFIG.playPile;
    const bus = this.deps.bus;

    // 兜底排序：按当前 handIndex 从左到右。
    const selected = [...selectedRaw].sort((a, b) => a.handIndex - b.handIndex);
    const total = selected.length;

    bus.emit("play:start", {
      cards: selected.map((v) => v.data),
      result,
    });

    // ── 阶段 1 + 2：逐张出牌 / 出牌堆排布 ────────────────────────
    const dispCfg = CONFIG.playPileDisplacement;
    const isDisplacementEnabled = dispCfg && dispCfg.enabled;
    const landingPromises: Promise<void>[] = [];

    if (isDisplacementEnabled) {
      const playPileCardSpacing = dispCfg.cardSpacing;
      const handArea = this.deps.getHandArea();
      const centerX = cfg.centerAlignsHand
        ? (handArea.left + handArea.right) / 2
        : this.deps.worldWidth / 2;
      const handBaseY = handArea.baseY;
      const baseYOffset = cfg.baseYOffset;

      for (let i = 0; i < total; i++) {
        const view = selected[i]!;

        // 计算当前这堆（共 i+1 张）的目标槽位偏移量
        const startOffset = (i / 2) * playPileCardSpacing;

        // 此时，出牌堆中已存在的 0 ... i-1 张卡牌，向左移动到它们在 size i+1 状态下的新目标槽位。
        // 其向左换位的时机和新牌 i 发车时机相同。
        for (let j = 0; j < i; j++) {
          const existingView = selected[j]!;
          const targetX = centerX - startOffset + j * playPileCardSpacing;
          const targetY = handBaseY + baseYOffset;

          CardFx.swapMove(
            this.deps.tween,
            existingView,
            { x: targetX, y: targetY, rotation: 0 },
            dispCfg
          );
        }

        // 新发车的卡牌 i，飞向它在 size i+1 状态下的目标槽位
        const targetX_i = centerX - startOffset + i * playPileCardSpacing;
        const targetY_i = handBaseY + baseYOffset;
        const targetSlot_i = { x: targetX_i, y: targetY_i, rotation: 0 };

        this.deps.removeFromHand(view);
        view.zIndex = 100000 + i;
        view.selected = false;

        bus.emit("play:cardEjected", { view, index: i, total });

        // 使用原本的落位过冲逻辑
        const overshoot = computeLandingOvershoot(
          i,
          total,
          cfg.overshootFirstPx,
          cfg.overshootMidPx,
          cfg.overshootLastPx
        );

        const landPromise = PlayPileFx.landOnPile(
          this.deps.tween,
          view,
          targetSlot_i,
          overshoot,
          cfg.flyDurationMS
        );
        landingPromises.push(landPromise);

        // 前一张牌与后一张牌的发车间隔（若设为0则所有牌一起启动），不需要等当前牌完全 landing 才 sleep。
        // 第一张牌发出后，间隔 interval 时间再启动下一张。
        // 每次发车间隔递减 intervalReductionMS，直到最后一对牌。发车间隔最小为 0。
        const interval = Math.max(0, dispCfg.firstIntervalMS - i * dispCfg.intervalReductionMS);

        if (i < total - 1) {
          await sleep(interval);
        }
      }
    } else {
      // 先算出整堆的目标槽位（按"最终张数"= total 来算，不会因发车节奏变化）。
      const handArea = this.deps.getHandArea();
      const slots = computePlayPileLayout({
        count: total,
        handAreaLeft: handArea.left,
        handAreaRight: handArea.right,
        handBaseY: handArea.baseY,
        baseYOffset: cfg.baseYOffset,
        centerAlignsHand: cfg.centerAlignsHand,
        worldWidth: this.deps.worldWidth,
        cardSpacing: cfg.cardSpacing,
      });

      // 错开发车：第 i 张在 ejectIntervalMS * i 时发出。
      const ejectIntervalMS = cfg.flyDurationMS * cfg.ejectIntervalRatio;

      for (let i = 0; i < total; i++) {
        const view = selected[i]!;
        const slot = slots[i]!;
        const overshoot = computeLandingOvershoot(
          i,
          total,
          cfg.overshootFirstPx,
          cfg.overshootMidPx,
          cfg.overshootLastPx
        );

        // 把这张牌从手牌数组里摘掉 → 剩余手牌立即挤位（layoutHand 在 removeFromHand 内部触发）。
        // 之所以"先摘再发车"：摘掉后该牌不再被 layoutHand 触碰，不会与 PlayPipeline 自己的飞行 tween 冲突。
        this.deps.removeFromHand(view);
        // 把 zIndex 抬到极高，确保飞行/落定过程中盖住其他卡牌。
        // 后到的牌 zIndex 更高，自然就会盖在先到的牌上（堆叠从左到右）。
        view.zIndex = 100000 + i;
        view.selected = false;

        bus.emit("play:cardEjected", { view, index: i, total });

        // 发车——landOnPile 返回的 Promise 标记"该牌完全落定"。
        landingPromises.push(
          PlayPileFx.landOnPile(
            this.deps.tween,
            view,
            slot,
            overshoot,
            cfg.flyDurationMS
          )
        );

        // 错开下一张：等 ejectIntervalMS 后再进入下一轮循环。
        // 最后一张发车后不再等待（直接走出循环 await 所有 landing 完成）。
        if (i < total - 1) {
          await sleep(ejectIntervalMS);
        }
      }
    }

    // 等所有牌都完全落定到出牌堆。
    await Promise.all(landingPromises);

    if (isDisplacementEnabled) {
      // 最后一张牌落定后，再等待最后一张牌的间隔时间（lastIntervalMS）才触发出牌堆牌的上移效果。
      await sleep(dispCfg.lastIntervalMS);
    }
    bus.emit("play:pileFormed", { views: selected });

    // 记录出牌完成后每张牌的基准 Y 坐标，供后续下移复位使用
    const cardBaselines = new Map<CardView, number>();
    for (const card of selected) {
      cardBaselines.set(card, card.y);
    }

    const liftEffectCfg = CONFIG.playPileLiftEffect;
    const isLiftEffectEnabled = liftEffectCfg && liftEffectCfg.enabled;

    // ── 阶段 3：出牌堆上抬 ──────────────────────────────────────
    if (isLiftEffectEnabled) {
      const scoringCards = result.scoringCards ?? [];
      const scoringViews = selected.filter((v) => scoringCards.some((sc) => sc.id === v.data.id));
      if (scoringViews.length > 0) {
        const liftPromises: Promise<void>[] = [];
        for (let i = 0; i < scoringViews.length; i++) {
          const card = scoringViews[i]!;
          const delay = i * liftEffectCfg.interval;
          const promise = (async () => {
            if (delay > 0) {
              await sleep(delay);
            }
            await PlayPileFx.liftCardScoring(this.deps.tween, card, liftEffectCfg);
          })();
          liftPromises.push(promise);
        }
        await Promise.all(liftPromises);
        if (liftEffectCfg.stayDuration && liftEffectCfg.stayDuration > 0) {
          await sleep(liftEffectCfg.stayDuration);
        }
      }
    } else {
      await PlayPileFx.liftPile(
        this.deps.tween,
        selected,
        cfg.liftPx,
        cfg.liftDurationMS,
        cfg.liftOvershootPx
      );
    }
    bus.emit("play:lifted", { views: selected });

    // ── 阶段 4a：手牌结算（内缩 + 过大弹 / 逐张弹性 + 筹码弹字） ──
    // 注意：最终入账延后到小丑结算之后（倍率可能被小丑修改）。
    const settleEffectCfg = CONFIG.playPileSettleEffect;
    if (settleEffectCfg && settleEffectCfg.enabled) {
      const scoringCards = result.scoringCards ?? [];
      const scoringViews = selected.filter((v) => scoringCards.some((sc) => sc.id === v.data.id));
      if (scoringViews.length > 0) {
        for (let i = 0; i < scoringViews.length; i++) {
          const card = scoringViews[i]!;
          
          // 执行每张卡牌的弹性震荡动画并等待其结束
          await PlayPileFx.animateCardSettle(this.deps.tween, card, settleEffectCfg, () => {
            const textCfg = CONFIG.playPileSettleTextEffect;
            if (textCfg && textCfg.enabled && card.parent) {
              const chips = card.data.chips;
              TextFx.createSettleText(card.parent, this.deps.tween, card, chips, textCfg);
            }
            bus.emit("play:cardSettleTextTriggered", { card, chips: card.data.chips });
          });
          
          // 第一张卡牌结束后的停留间隔，之后每张牌减少，最后一张使用 lastIntervalMS
          let interval = settleEffectCfg.firstIntervalMS - i * settleEffectCfg.intervalReductionMS;
          interval = Math.max(0, interval);
          if (i === scoringViews.length - 1) {
            interval = settleEffectCfg.lastIntervalMS;
          }
          
          if (interval > 0) {
            await sleep(interval);
          }
        }
      }
    } else {
      await PlayPileFx.settleSquash(this.deps.tween, selected, {
        squashScale: cfg.squashScale,
        bouncePeakScale: cfg.bouncePeakScale,
        bounceCount: cfg.bounceCount,
        squashDurationMS: cfg.squashDurationMS,
        bounceDurationMS: cfg.bounceDurationMS,
      });
    }

    // ── 阶段 4b：小丑牌结算（不上下移，直接原地结算倍率） ────
    // 与手牌结算视效同构（弹性震荡 + 逐字弹字 + 背景方块），区别：
    //   1) 小丑不抬升/下移；
    //   2) 增加倍率而非筹码；
    //   3) 文字默认 "+10"，背景小方块默认红色。
    let finalResult: ScoreResult = {
      ...result,
      scoringCards: result.scoringCards,
    };
    let totalJokerMultBonus = 0;
    const jokerSettleCfg = CONFIG.jokerSettleEffect;
    const jokers = this.deps.getJokers?.() ?? [];
    if (jokerSettleCfg && jokerSettleCfg.enabled && jokers.length > 0) {
      const textCfg = CONFIG.jokerSettleTextEffect;
      const multBonus = Math.max(0, textCfg?.defaultMultBonus ?? 10);

      for (let i = 0; i < jokers.length; i++) {
        const joker = jokers[i]!;

        await PlayPileFx.animateCardSettle(this.deps.tween, joker, jokerSettleCfg, () => {
          if (textCfg && textCfg.enabled && joker.parent) {
            TextFx.createSettleText(joker.parent, this.deps.tween, joker, multBonus, textCfg);
          }
          bus.emit("play:jokerSettleTextTriggered", { card: joker, mult: multBonus });
        });

        totalJokerMultBonus += multBonus;

        let interval = jokerSettleCfg.firstIntervalMS - i * jokerSettleCfg.intervalReductionMS;
        interval = Math.max(0, interval);
        if (i === jokers.length - 1) {
          interval = jokerSettleCfg.lastIntervalMS;
        }
        if (interval > 0) {
          await sleep(interval);
        }
      }

      // 倍率入账后重算最终得分：totalChips × (手牌倍率 + 小丑倍率加成)
      const finalMult = result.mult + totalJokerMultBonus;
      finalResult = {
        ...result,
        mult: finalMult,
        score: result.totalChips * finalMult,
        scoringCards: result.scoringCards,
      };
      bus.emit("play:jokersSettled", {
        jokers,
        totalMultBonus: totalJokerMultBonus,
        result: finalResult,
      });
    }

    // 手牌 + 小丑结算全部完成后，才把最终分数写入 totalScore。
    const totalScore = this.deps.applyScore(finalResult);
    bus.emit("play:settled", { result: finalResult, totalScore });

    // ── 阶段 5：下移 + 丢牌 ──────────────────────────────────
    // 5a: 整堆下移（与阶段 3 对称，回到出牌堆基线 y）。
    if (isLiftEffectEnabled) {
      const scoringCards = result.scoringCards ?? [];
      const scoringViews = selected.filter((v) => scoringCards.some((sc) => sc.id === v.data.id));
      if (scoringViews.length > 0) {
        const dropPromises: Promise<void>[] = [];
        for (let i = 0; i < scoringViews.length; i++) {
          const card = scoringViews[i]!;
          const delay = i * liftEffectCfg.interval;
          const targetY = cardBaselines.get(card) ?? card.y;
          const promise = (async () => {
            if (delay > 0) {
              await sleep(delay);
            }
            await PlayPileFx.dropCardScoring(
              this.deps.tween,
              card,
              targetY,
              liftEffectCfg
            );
          })();
          dropPromises.push(promise);
        }
        await Promise.all(dropPromises);
      }
    } else {
      await PlayPileFx.dropPile(
        this.deps.tween,
        selected,
        cfg.liftPx, // 与 lift 同距离
        cfg.dropDurationMS
      );
    }

    // ====== 在卡牌下移后、飞出前：预期分迁移（使用含小丑倍率的最终 result） ======
    if (this.deps.animateScoreTransfer) {
      await this.deps.animateScoreTransfer(finalResult);
    }

    // 5b: 从左到右逐张丢弃到弃牌堆。每张错开「弃牌时间间隔」。
    // 出牌结束的丢弃飞行时长沿用 playPile.discardFlyDurationMS，
    // 但相邻两张牌的错开间隔与手牌弃牌共用「弃牌/出牌结束」专区的 discard.intervalMS，
    // 翻面（压成一条线）共用「弃牌/出牌结束」翻面参数（discardFlip），
    // 整体节奏受弃牌动画速度比例 discard.speedRatio 调制。
    //
    // 居中复位：每丢出一张牌，剩余的出牌堆牌立刻用「出牌堆的位移」逻辑（swapMove）
    // 重新排布、保持整体居中。沿用位移专区前四个参数：
    //   enabled / cardSpacing / riseDurationMS / springDurationMS。
    const discardCfg = CONFIG.discard;
    const speedRatio = Math.max(0.01, discardCfg?.speedRatio ?? 1.0);
    const flyDurationMS = Math.max(1, cfg.discardFlyDurationMS / speedRatio);
    const intervalMS = Math.max(0, (discardCfg?.intervalMS ?? cfg.discardIntervalMS) / speedRatio);
    // 随机旋转范围（度→弧度），与手牌弃牌共用 discardFlip.randomRotationDeg。
    const randRotDeg = Math.max(0, CONFIG.discardFlip?.randomRotationDeg ?? 0);
    const randomRotation = (): number =>
      randRotDeg <= 0 ? 0 : ((Math.random() * 2 - 1) * randRotDeg * Math.PI) / 180;

    // 居中重排所需的几何参数（与阶段 1+2 的位移逻辑保持一致）。
    const handArea2 = this.deps.getHandArea();
    const centerX2 = cfg.centerAlignsHand
      ? (handArea2.left + handArea2.right) / 2
      : this.deps.worldWidth / 2;
    const baseY2 = handArea2.baseY + cfg.baseYOffset;
    // 剩余出牌堆（按从左到右顺序）。每丢出一张就从头部移除。
    const remaining: CardView[] = [...selected];

    for (let i = 0; i < total; i++) {
      const view = selected[i]!;
      // 飞出瞬间：图层置于手牌之下、但仍在阴影层之上。
      //   手牌 zIndex = 0..n-1（≥0），阴影层 zIndex = -1；取 (-1, 0) 区间的值即可。
      view.zIndex = -0.1 - i * 0.001;
      // 正面朝上 → 飞行途中沿竖中轴线翻约 90° → 压成一条线，目标弃牌堆（屏幕正右方外、垂直居中）。
      view.startDiscardFlip(flyDurationMS);
      // 进入弃牌飞行期：禁用速度→旋转联动，保持飞出瞬间的随机旋转角度直到弃牌结束。
      view.beginDiscardFly();
      // 不 await 单张飞出，让下一张能立即错开发车。
      void PlayPileFx.flyToDiscard(
        this.deps.tween,
        view,
        this.deps.worldWidth,
        this.deps.worldHeight,
        flyDurationMS,
        randomRotation()
      );

      // 该牌刚弃出 → 立即把它从剩余堆移除，并让剩下的牌重排居中。
      const idx = remaining.indexOf(view);
      if (idx !== -1) remaining.splice(idx, 1);

      if (isDisplacementEnabled && remaining.length > 0) {
        const n = remaining.length;
        const spacing = dispCfg.cardSpacing;
        const startOffset = ((n - 1) / 2) * spacing;
        for (let j = 0; j < n; j++) {
          const card = remaining[j]!;
          const targetX = centerX2 - startOffset + j * spacing;
          CardFx.swapMove(
            this.deps.tween,
            card,
            { x: targetX, y: baseY2, rotation: 0 },
            dispCfg
          );
        }
      }

      if (i < total - 1) {
        await sleep(intervalMS);
      }
    }
    // 等最后一张飞行时长，确保所有牌都飞到屏幕外才结束 pipeline。
    await sleep(flyDurationMS);
    // 弃牌飞行结束：恢复速度旋转标志，避免这些 CardView 被回收复用后残留禁用态。
    for (const view of selected) {
      view.endDiscardFly();
    }

    bus.emit("play:discarded", { cards: selected.map((v) => v.data) });
    bus.emit("play:end", { result: finalResult, totalScore });

    return { totalScore, views: selected };
  }
}
