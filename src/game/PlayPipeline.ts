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
 * 5 阶段对应需求：
 *   1. 逐张出牌：选中牌按 handIndex 从左到右依次飞往出牌堆槽位，错开发车；
 *                每张牌发车前调一次 layoutHand({force:true}) 让剩余手牌挤位。
 *   2. 出牌堆排布：第一张居中（n=1 时），多张时整堆中位对齐手牌堆中位；
 *                  每张牌落位时按位置插值得到不同过冲幅度（首尾大、中间小）。
 *   3. 整堆上抬：所有牌落定后一起向上一次过冲（钩子：未来抬阴影）。
 *   4. 结算：内缩 → 过大弹两次（钩子：每次弹瞬间触发"+xxx"爆字 + 加分到 totalScore）。
 *   5. 下移 + 丢牌：整堆下移收阴影 → 从左到右逐张飞出。
 */
export interface PlayPipelineDeps {
  tween: TweenManager;
  bus: EventBus<GameEvents>;
  worldWidth: number;
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

    // ── 阶段 3：整堆上抬 ──────────────────────────────────────
    await PlayPileFx.liftPile(
      this.deps.tween,
      selected,
      cfg.liftPx,
      cfg.liftDurationMS,
      cfg.liftOvershootPx
    );
    bus.emit("play:lifted", { views: selected });

    // ── 阶段 4：结算（内缩 + 过大弹） ─────────────────────────
    // 实际加分发生在结算"开始"时——视觉过程中分数已经在 HUD 上变化，
    // 配合未来的"逐牌爆字"会更顺：开始算 → 一张张爆 → 总分跳完。
    const totalScore = this.deps.applyScore(result);
    await PlayPileFx.settleSquash(this.deps.tween, selected, {
      squashScale: cfg.squashScale,
      bouncePeakScale: cfg.bouncePeakScale,
      bounceCount: cfg.bounceCount,
      squashDurationMS: cfg.squashDurationMS,
      bounceDurationMS: cfg.bounceDurationMS,
    });
    bus.emit("play:settled", { result, totalScore });

    // ── 阶段 5：下移 + 丢牌 ──────────────────────────────────
    // 5a: 整堆下移（与阶段 3 对称，回到出牌堆基线 y）。
    await PlayPileFx.dropPile(
      this.deps.tween,
      selected,
      cfg.liftPx, // 与 lift 同距离
      cfg.dropDurationMS
    );

    // 5b: 从左到右逐张飞出。每张错开 discardIntervalMS。
    for (let i = 0; i < total; i++) {
      const view = selected[i]!;
      // 不 await 单张飞出，让下一张能立即错开发车。
      void PlayPileFx.flyToDiscard(
        this.deps.tween,
        view,
        this.deps.worldWidth,
        cfg.discardFlyDurationMS
      );
      if (i < total - 1) {
        await sleep(cfg.discardIntervalMS);
      }
    }
    // 等最后一张飞行时长，确保所有牌都飞到屏幕外才结束 pipeline。
    await sleep(cfg.discardFlyDurationMS);

    bus.emit("play:discarded", { cards: selected.map((v) => v.data) });
    bus.emit("play:end", { result, totalScore });

    return { totalScore, views: selected };
  }
}
