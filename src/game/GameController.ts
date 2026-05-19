import { Container } from "pixi.js";
import type { App } from "@core/App";
import { EventBus } from "@core/EventBus";
import { Store } from "@core/Store";
import { Layers } from "@core/Layers";
import { TweenManager } from "@tween/TweenManager";
import { Deck } from "@domain/Deck";
import { calculateScore } from "@domain/Scoring";
import type { CardData, ScoreResult, HandTypeName } from "@domain/types";
import { CardView } from "@render/CardView";
import { computeHandLayout } from "@render/HandLayout";
import { HUD } from "@ui/HUD";
import { CardFx } from "@fx/CardFx";
import { GameConfig } from "./config";
import type { GameEvents } from "./events";

/**
 * 游戏总控
 *
 * 职责拆解：
 *   - 管理 GameStore（手牌引用、选中、回合计数、总分）
 *   - 监听 CardView 点击 -> 更新选中、触发 evaluate
 *   - 出牌 / 弃牌 -> 调用 domain.Scoring -> 通过 fx 播放动画 -> 更新 HUD
 *   - 通过 HandLayout + TweenManager 让手牌摆位平滑过渡
 *
 * 引擎 / 渲染细节都被下层封装，这里只剩"游戏怎么玩"的语义。
 */
interface GameState {
  hand: CardView[];
  selected: CardView[];
  totalScore: number;
  plays: number;
  discards: number;
  currentResult: ScoreResult;
}

const EMPTY_RESULT: ScoreResult = {
  handType: "无" as HandTypeName,
  baseChips: 0,
  cardChips: 0,
  totalChips: 0,
  mult: 0,
  score: 0,
};

export class GameController {
  readonly bus = new EventBus<GameEvents>();
  readonly store: Store<GameState>;
  readonly tween = new TweenManager();

  private readonly deck = new Deck();

  private readonly cardLayer = new Container();
  private hud!: HUD;

  /** id -> CardView 缓存，复用同一份 view（牌只是回到牌堆，不销毁）。 */
  private readonly viewByCardId = new Map<string, CardView>();

  constructor(private readonly app: App) {
    this.store = new Store<GameState>({
      hand: [],
      selected: [],
      totalScore: 0,
      plays: GameConfig.rules.plays,
      discards: GameConfig.rules.discards,
      currentResult: EMPTY_RESULT,
    });

    // 卡牌层放在世界根之下，UI 之下、特效之上由 zIndex 控制。
    this.cardLayer.label = "CardLayer";
    this.cardLayer.zIndex = Layers.Card;
    this.cardLayer.sortableChildren = true;
    this.app.worldRoot.addChild(this.cardLayer);
  }

  start(): void {
    // 构建 HUD
    this.hud = new HUD({
      worldWidth: GameConfig.world.width,
      worldHeight: GameConfig.world.height,
      targetScore: GameConfig.rules.targetScore,
      plays: GameConfig.rules.plays,
      discards: GameConfig.rules.discards,
      onPlay: () => this.playSelected(),
      onDiscard: () => this.discardSelected(),
    });
    this.hud.zIndex = Layers.UI;
    this.app.worldRoot.addChild(this.hud);

    // 把 tween 接入 app 的更新循环
    this.app.onUpdate((dtMS) => this.tween.update(dtMS));

    // 准备牌堆
    this.deck.reset();
    this.hud.deckView.setCount(this.deck.size);

    // 首抽 8 张
    this.drawToFull();
    this.updateButtons();
  }

  // --- 抽牌 / 布局 -------------------------------------------------

  private drawToFull(): void {
    const need = GameConfig.rules.handSize - this.store.getState().hand.length;
    if (need <= 0) {
      this.layoutHand();
      return;
    }
    const drawn = this.deck.draw(need);
    const newHand = [...this.store.getState().hand];

    for (const data of drawn) {
      const view = this.getOrCreateView(data);
      view.selected = false;
      // 把 view 放进卡牌层，初始位置在屏幕外（牌堆方向）。
      this.cardLayer.addChild(view);
      view.x = GameConfig.world.width + 200;
      view.y = GameConfig.world.height + 200;
      view.rotation = 0;
      newHand.push(view);
    }
    this.store.setState({ hand: newHand });
    this.hud.deckView.setCount(this.deck.size);
    this.layoutHand();
  }

  private getOrCreateView(data: CardData): CardView {
    let v = this.viewByCardId.get(data.id);
    if (v) return v;
    v = new CardView(data, {
      onClick: (view) => this.toggleSelection(view),
      onHoverIn: (view) => this.onHoverIn(view),
      onHoverOut: (view) => this.onHoverOut(view),
    });
    this.viewByCardId.set(data.id, v);
    return v;
  }

  private layoutHand(): void {
    const hand = this.store.getState().hand;
    const slots = computeHandLayout(hand, {
      areaLeft: this.hud.handAreaLeft,
      areaRight: this.hud.handAreaRight,
      baseY: this.hud.handBaseY,
    });
    hand.forEach((view, i) => {
      // 用 zIndex 保证右边的牌盖住左边的（卡牌层启用 sortableChildren）。
      view.zIndex = i;
      const slot = slots[i]!;
      CardFx.moveTo(this.tween, view, slot, GameConfig.animation.moveDurationMS);
    });
  }

  // --- 交互 --------------------------------------------------------

  private toggleSelection(view: CardView): void {
    const state = this.store.getState();
    const selected = [...state.selected];

    if (view.selected) {
      view.selected = false;
      const idx = selected.indexOf(view);
      if (idx >= 0) selected.splice(idx, 1);
    } else {
      if (selected.length >= GameConfig.rules.maxSelected) return;
      view.selected = true;
      selected.push(view);
    }
    this.store.setState({ selected });
    this.bus.emit("card:selectionChanged", { selected });
    this.layoutHand();
    this.evaluateAndUpdate();
  }

  private onHoverIn(view: CardView): void {
    if (view.selected) return;
    // 临时抬高一点；离开时由 layoutHand 复位。
    CardFx.moveTo(
      this.tween,
      view,
      {
        x: view.x,
        y: view.y - GameConfig.animation.hoverLiftPx,
        rotation: view.rotation,
      },
      120
    );
  }

  private onHoverOut(view: CardView): void {
    if (view.selected) return;
    this.layoutHand();
  }

  // --- 计分 + UI ---------------------------------------------------

  private evaluateAndUpdate(): void {
    const selected = this.store.getState().selected;
    const cards = selected.map((v) => v.data);
    const result = calculateScore(cards);
    this.store.setState({ currentResult: result });

    this.hud.scorePanel.setHandName(result.handType);
    // HUD 预览只显示牌型对应的基础筹码与倍率，不计入所选牌的点数
    this.hud.scorePanel.setChipsMult(result.baseChips, result.mult);
    this.hud.scorePanel.setExpectScore(result.score);

    this.updateButtons();
  }

  private updateButtons(): void {
    const { selected, plays, discards } = this.store.getState();
    const hasSelection = selected.length > 0;
    this.hud.playBtn.setEnabled(hasSelection && plays > 0);
    this.hud.discardBtn.setEnabled(hasSelection && discards > 0);
  }

  // --- 出牌 / 弃牌 -------------------------------------------------

  private playSelected(): void {
    const state = this.store.getState();
    if (state.selected.length === 0 || state.plays <= 0) return;

    const result = state.currentResult;
    const totalScore = state.totalScore + result.score;

    this.store.setState({
      plays: state.plays - 1,
      totalScore,
    });
    this.hud.scorePanel.setPlays(state.plays - 1);
    this.hud.scorePanel.setTotalScore(totalScore);

    this.bus.emit("round:play", {
      cards: state.selected.map((v) => v.data),
      result,
    });
    this.bus.emit("round:scoreChanged", { totalScore });

    this.recycleSelected();
  }

  private discardSelected(): void {
    const state = this.store.getState();
    if (state.selected.length === 0 || state.discards <= 0) return;

    this.store.setState({ discards: state.discards - 1 });
    this.hud.scorePanel.setDiscards(state.discards - 1);

    this.bus.emit("round:discard", {
      cards: state.selected.map((v) => v.data),
    });

    this.recycleSelected();
  }

  // --- 外部刷新钩子 ------------------------------------------------

  /**
   * 让牌堆按当前 CONFIG.cardArt 重新渲染。
   * ControlPanel 切换牌背时调用。
   */
  refreshDeckArt(): void {
    if (this.hud) this.hud.deckView.refresh();
  }

  /**
   * 重新绘制所有已缓存的 CardView。
   * 保留 CardView 实例本身，避免运行时调颜色/圆角时销毁交互对象导致手牌闪没。
   */
  refreshHandArt(): void {
    if (!this.hud) return;

    for (const view of this.viewByCardId.values()) {
      view.refreshArt();
    }
    this.layoutHand();
  }

  private recycleSelected(): void {
    const state = this.store.getState();
    const recycling = [...state.selected];
    const remaining = state.hand.filter((v) => !recycling.includes(v));

    // 视觉：先飞出
    for (const v of recycling) {
      v.selected = false;
      CardFx.flyOut(
        this.tween,
        v,
        GameConfig.world.width,
        GameConfig.animation.flyOutDurationMS
      );
    }

    // 数据：放回牌堆并洗牌
    this.deck.recycle(recycling.map((v) => v.data));
    this.deck.shuffle();
    this.hud.deckView.setCount(this.deck.size);
    this.bus.emit("deck:changed", { size: this.deck.size });

    this.store.setState({ hand: remaining, selected: [] });
    this.bus.emit("card:selectionChanged", { selected: [] });

    // 补牌并重新摆位
    this.drawToFull();
    this.evaluateAndUpdate();
  }
}
