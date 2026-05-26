import { Container } from "pixi.js";
import type { App } from "@core/App";
import { EventBus } from "@core/EventBus";
import { Store } from "@core/Store";
import { Layers } from "@core/Layers";
import { TweenManager } from "@tween/TweenManager";
import { Deck } from "@domain/Deck";
import { calculateScore } from "@domain/Scoring";
import type { CardData, ScoreResult, HandTypeName } from "@domain/types";
import { CardView, CardState } from "@render/CardView";
import { computeHandLayout } from "@render/HandLayout";
import { HUD } from "@ui/HUD";
import { uiHierarchy } from "@ui/hierarchy";
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
  private readonly shadowLayer = new Container();
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

    // 阴影层作为 cardLayer 的子容器，但是 zIndex = -1 使得它总是被渲染在卡牌下方，不会投影到其他卡牌上
    this.shadowLayer.label = "ShadowLayer";
    this.shadowLayer.zIndex = -1;
    this.cardLayer.addChild(this.shadowLayer);
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

    // HUD 及其后代此时都已注册到 UI Hierarchy。
    // 调一次 hydrate：把 CONFIG.uiNodes 里存档的父子顺序 / transform / 组件灌回去。
    uiHierarchy.hydrateFromConfig(this.app.worldRoot);

    // 把 tween 接入 app 的更新循环
    this.app.onUpdate((dtMS) => {
      this.tween.update(dtMS);
      // 更新卡牌状态、阴影与动画
      for (const child of this.cardLayer.children) {
        if (child instanceof CardView) {
          child.update(dtMS);
          child.updateShadow();
        }
      }
    });

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
      // 手牌数量校正路径：force 强制对齐，避免极端情况下豁免 swap 弹性导致错位。
      this.layoutHand({ force: true });
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
      // 标记"本次 layoutHand 应当对该牌触发过冲反弹动画"——
      // 屏幕外瞬移过来时 lastSpeed 不可靠（没有真实跨帧位移可采样），
      // 用这个一次性标志显式告诉 moveToWithOvershoot 走过冲路径。
      view.forceOvershootOnce = true;
      newHand.push(view);
    }
    this.store.setState({ hand: newHand });
    this.hud.deckView.setCount(this.deck.size);
    // 抽牌后：手牌数量变化，必须强制对齐（force），不豁免任何"正在弹性"的牌。
    this.layoutHand({ force: true });
  }

  private getOrCreateView(data: CardData): CardView {
    let v = this.viewByCardId.get(data.id);
    if (v) return v;
    v = new CardView(
      data,
      {
        onClick: (view) => this.toggleSelection(view),
        onHoverIn: (view) => this.onHoverIn(view),
        onHoverOut: (view) => this.onHoverOut(view),
        onDragStart: (view) => {
          this.tween.killOf(view);
          view.zIndex = 9999;
          view.isReturning = false;
        },
        onDragging: (view, x, _y) => {
          this.reorderHandWhileDragging(view, x);
        },
        onDragEnd: (view) => {
          // 选中状态完全由 toggleSelection 翻转，慢点击/拖拽松手不会改动 view.selected，
          // 因此这里不再需要"兜底同步 store.selected"的逻辑。只负责回弹与重排即可。
          view.isReturning = true;
          this.layoutHand();
        }
      },
      this.shadowLayer
    );
    this.viewByCardId.set(data.id, v);
    return v;
  }

  /**
   * 重新计算并应用手牌摆位。
   *
   * 公开访问以便 ControlPanel 调整 handLayout.* 参数后能立即触发重排。
   *
   * @param opts.swapFor 可选——本次重排是「手动理牌换位」触发的，集合中的 CardView
   *                     是被让位的相邻牌，应走 CardFx.swapMove（rise + 过冲 + spring）
   *                     而非默认的 moveToWithOvershoot（距离驱动归位手感）。
   *                     不在集合中、且未被 isDragging/isSelectAnimating 跳过的牌仍走
   *                     moveToWithOvershoot，保证发牌/松手归位等其它场景行为不变。
   * @param opts.force   可选——true 时无视 view.isSwapAnimating 的豁免，对所有牌强制
   *                     重排。用于"手牌数量变化"等必须立刻整齐对齐的场景（抽牌、出牌、
   *                     弃牌、回合重置等）。拖拽中的 onDragging 重排不应传 true，
   *                     否则会打断正在播放的 swap 弹性。默认 false。
   */
  layoutHand(opts?: { swapFor?: ReadonlySet<CardView>; force?: boolean }): void {
    const hand = this.store.getState().hand;
    const slots = computeHandLayout(hand, {
      areaLeft: this.hud.handAreaLeft,
      areaRight: this.hud.handAreaRight,
      baseY: this.hud.handBaseY,
      cardSpacing: GameConfig.handLayout.cardSpacing,
      arcEnabled: GameConfig.handLayout.arcEnabled,
      arcHeight: GameConfig.handLayout.arcHeight,
      fanAnglePerCardDeg: GameConfig.handLayout.fanAnglePerCardDeg,
    });
    const handCount = hand.length;
    hand.forEach((view, i) => {
      // 用 zIndex 保证右边的牌盖住左边的（卡牌层启用 sortableChildren）。
      // 处于拖拽态的卡牌，其显示应该置于所有卡牌上
      view.zIndex = view.isDragging ? 9999 : i;
      // 写入手牌位置元数据：供 CardView 内"鼠标悬停伪3D倾斜左右梯度"按 i/(n-1) 计算每张卡的强度倍率。
      view.handIndex = i;
      view.handCount = handCount;
      const slot = slots[i]!;
      
      // 保存布局时的目标位姿，以便在拖拽松手后可以回弹
      view.layoutX = slot.x;
      view.layoutY = slot.y;
      view.layoutRotation = slot.rotation;

      // 如果当前正在拖动卡牌，跳过 TweenManager 的自动移动，由鼠标位置主导
      if (view.isDragging) {
        return;
      }

      // 正在播放"选中/取消选中位移过弹动画"的牌：交给 CardFx.selectMove 自己跑两段补间。
      // 这里只更新 layoutX/Y/Rotation 元数据，不再下发普通 moveTo（避免 TweenManager
      // 同字段冲突踢掉过弹段）。
      if (view.isSelectAnimating) {
        return;
      }

      // 「手动理牌换位让位」分支：本次 layoutHand 由 reorderHandWhileDragging 触发，
      // view 在被让位集合里——走专属的 CardFx.swapMove（固定时长 + 固定过冲），
      // 不复用 moveToWithOvershoot 的距离驱动模型（短距离会被阈值短路成无过冲单段）。
      if (opts?.swapFor?.has(view)) {
        CardFx.swapMove(this.tween, view, slot);
        return;
      }

      // 「swap 弹性豁免」分支：view 当前正在播放 swapMove 的 rise→spring 弹性动画，
      // 且本帧不在 swapFor 中（说明拖拽牌已不再覆盖它）。如果继续走下面的
      // moveToWithOvershoot，会通过 TweenManager 同字段互斥停掉 rise 阶段；而
      // Tween.stop() 不会触发 onComplete，导致 spring 段（在 rise 的 onComplete 内
      // lazy 调度）永远排不上——弹性效果丢失。这是"一次跨越多张牌时弹性失效"
      // 的根因。豁免后让它自己跑完 rise→spring；最终位置已经是新 slot，不会错位。
      // opts.force=true 时（手牌数量变化等强制对齐场景）跳过此豁免。
      if (!opts?.force && view.isSwapAnimating) {
        return;
      }

      // 过冲反弹判定（v2：距离驱动）：
      //   过冲幅度与 rise 段时长完全由 CardFx.moveToWithOvershoot 内部按
      //   "起点 → 终点"距离自适应计算，调用方无需提供速度信息。
      //   forceOvershoot=true 仍可强制满额过冲（保留给发牌场景作为语义兼容；
      //   实际不再必要，因为发牌的瞬移距离远大于 tweenFullOvershootDistancePx，
      //   自然就会得到满额过冲）。
      const force = view.forceOvershootOnce === true;
      if (force) view.forceOvershootOnce = false;
      CardFx.moveToWithOvershoot(
        this.tween,
        view,
        slot,
        GameConfig.animation.moveDurationMS,
        0,
        force,
      );
    });
  }

  /**
   * 拖拽中手动理牌：当拖拽牌的「实际渲染中线 view.x」穿过左/右邻牌的「槽位中线 layoutX」时，
   * 立即与该邻牌在 hand 数组中互换位置，并触发 layoutHand 让让位牌平滑移动到新槽位。
   *
   * 设计要点：
   *   1. 拖拽牌一侧用 `view.x`（已 lerp 平滑的实际渲染位置），而非 dragTargetX。
   *      这让"换位时机"严格对应卡片视觉中线真正滑过邻牌中线那一刻，手感明确不模糊。
   *
   *   2. 邻牌一侧用 `layoutX` 而非 `view.x`：
   *      layoutX 是 layoutHand 写入的、与 hand 数组顺序一一对应的目标槽位 x；
   *      用它做基准等价于"按数组当前顺序计算的稳定槽位中线"，不会因相邻牌
   *      还在动画途中其 view.x 漂移而出现"反复 swap 抖动"。
   *      换位后邻牌的新 layoutX 立刻就位（其 view.x 还在动画途中），离当前 view.x
   *      已是一整个 cardSpacing 的距离，天然形成滞回——不会立即反向 swap。
   *
   *   3. 每次 onDragging 用 while 循环允许「一次性跳多格」——快速划过 2~3 张牌
   *      时也能跟手，不会因为单帧只换一格而残留视觉错位。
   *
   *   4. swap 之后立即调用 layoutHand：
   *      - 拖拽牌本身：layoutHand 会更新它的 zIndex / handIndex / layoutX/Y/Rotation
   *        元数据，但因 isDragging=true 会跳过 TweenManager 写位置（鼠标仍主导）。
   *        新的 layoutX 即"松手回弹的目标点"。
   *      - 被让位的相邻牌：layoutHand 会用 moveToWithOvershoot 自然带它过去。
   *        相邻槽位距离正好 = cardSpacing（远小于 tweenFullOvershootDistancePx），
   *        会走"小距离单段补间"路径，节奏顺滑。
   *
   *   5. 只看 x 不看 y：手牌区域是横向一字排开（带轻微弧形），换位仅由水平位置决定。
   *
   *   注：参数 _dragX 保留是为了不改 onDragging 调用方签名，便于日后切回"跟手目标位置"
   *   作为判定基准。当前实现不使用它。
   */
  private reorderHandWhileDragging(view: CardView, _dragX: number): void {
    const hand = this.store.getState().hand;
    const i = hand.indexOf(view);
    if (i < 0) return;

    // 拖拽牌中线 = 实际渲染位置 view.x（已 lerp 平滑）。
    // 含义："卡片真正滑过邻牌中线"才换位，手感清晰、不模糊。
    const dragCenter = view.x;

    let newIndex = i;
    // 本次手势中被「跨过 / 让位」的相邻牌——它们将走 CardFx.swapMove 走利落的过冲动画，
    // 而不是默认的 moveToWithOvershoot（短距离会被距离阈值短路为无过冲）。
    const swapFor = new Set<CardView>();

    // 向左检查：拖拽牌中线 view.x 穿过左邻牌槽位中线 left.layoutX 时换位。
    // 越过则交换，并继续向左追问新左邻；while 支持单次手势跨多格。
    while (newIndex > 0) {
      const left = hand[newIndex - 1]!;
      if (dragCenter < left.layoutX) {
        swapFor.add(left);
        newIndex -= 1;
      } else {
        break;
      }
    }

    // 向右检查：对称逻辑。
    while (newIndex < hand.length - 1) {
      const right = hand[newIndex + 1]!;
      if (dragCenter > right.layoutX) {
        swapFor.add(right);
        newIndex += 1;
      } else {
        break;
      }
    }

    if (newIndex === i) return;

    // 应用换位：splice(i,1) 取出，再 splice(newIndex,0,view) 插回。
    // 注意：当 newIndex > i 时，先删后插用同一个目标下标即可——因为删除已经
    // 让后面元素整体左移一位，目标下标对齐"删除后的视角"。
    const newHand = hand.slice();
    newHand.splice(i, 1);
    newHand.splice(newIndex, 0, view);
    this.store.setState({ hand: newHand });

    this.layoutHand({ swapFor });
  }

  // --- 交互 --------------------------------------------------------

  private toggleSelection(view: CardView): void {
    const state = this.store.getState();
    const selected = [...state.selected];

    let direction: "rise" | "fall" | null = null;
    if (view.selected) {
      // 取消选中：从弹起态向下回落到基准 y。
      view.selected = false;
      const idx = selected.indexOf(view);
      if (idx >= 0) selected.splice(idx, 1);
      direction = "fall";
    } else {
      if (selected.length >= GameConfig.rules.maxSelected) return;
      view.selected = true;
      selected.push(view);
      direction = "rise";
    }
    this.store.setState({ selected });
    this.bus.emit("card:selectionChanged", { selected });

    // 先标记，让 layoutHand 跳过对该牌的普通 tween 写入；
    // 标记必须在 layoutHand() 之前置位。
    const cv = GameConfig.cardVisuals;
    const useSelectFx =
      cv.selectMoveEnabled !== false && direction !== null;
    if (useSelectFx) {
      view.isSelectAnimating = true;
    }

    // 选中/取消选中：需要其它牌立即对齐到新基线（被选中的牌弹起后腾出/腾回位置），
    // 用 force 跳过 swap 弹性豁免，避免视觉错位。
    this.layoutHand({ force: true });

    // 取出该牌经 layoutHand 写好的目标位姿，启动选中/取消选中过弹动画。
    if (useSelectFx && direction) {
      const target = {
        x: view.layoutX,
        y: view.layoutY,
        rotation: view.layoutRotation,
      };
      CardFx.selectMove(this.tween, view, target, direction, {
        durationMS: cv.selectMoveDurationMS,
        curve: cv.selectMoveCurve,
        overshoot: cv.selectMoveOvershoot,
        stiffness: cv.selectMoveStiffness,
        onSettle: () => {
          view.isSelectAnimating = false;
        },
      });
    }

    this.evaluateAndUpdate();
  }

  private onHoverIn(_view: CardView): void {
    // 删除了鼠标触碰到卡牌的向上伸出效果
  }

  private onHoverOut(_view: CardView): void {
    // 删去了向上伸出，因此离开时也不需要 layoutHand 复位
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
    // 开发面板手动 refresh：强制对齐所有牌，不豁免正在弹性的牌。
    this.layoutHand({ force: true });
  }

  private recycleSelected(): void {
    const state = this.store.getState();
    const recycling = [...state.selected];
    const remaining = state.hand.filter((v) => !recycling.includes(v));

    // 视觉：先飞出
    for (const v of recycling) {
      v.selected = false;
      v.cardState = CardState.Normal;
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
