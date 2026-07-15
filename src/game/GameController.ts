import { Container } from "pixi.js";
import type { App } from "@core/App";
import { EventBus } from "@core/EventBus";
import { Store } from "@core/Store";
import { Layers } from "@core/Layers";
import { TweenManager } from "@tween/TweenManager";
import { Easing } from "@tween/Easing";
import { Deck } from "@domain/Deck";
import { calculateScore } from "@domain/Scoring";
import type { CardData, ScoreResult, HandTypeName } from "@domain/types";
import { SUITS } from "@domain/types";
import { CardView, CardState } from "@render/CardView";
import { computeHandLayout } from "@render/HandLayout";
import { BackgroundView } from "@render/BackgroundView";
import { HUD, type HUDMode } from "@ui/HUD";
import { uiHierarchy } from "@ui/hierarchy";
import { CardFx } from "@fx/CardFx";
import { CrtFilter } from "@fx/CrtFilter";
import { CONFIG, GameConfig, setDrawingCards } from "./config";
import type { GameEvents } from "./events";
import { PlayPipeline } from "./PlayPipeline";

/** 理牌模式：按点数 或 按花色。 */
export type HandSortMode = "rank" | "suit";

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
  scoringCards: [],
};

export class GameController {
  readonly bus = new EventBus<GameEvents>();
  readonly store: Store<GameState>;
  readonly tween = new TweenManager();

  private readonly deck = new Deck();

  private readonly cardLayer = new Container();
  private readonly shadowLayer = new Container();
  private readonly background: BackgroundView;
  private readonly crtFilter: CrtFilter;
  private hud!: HUD;
  private playPipeline!: PlayPipeline;

  /**
   * 出牌流程进行中：
   *   - 按钮（包括"出牌/弃牌"）会通过 updateButtons 自动 disable；
   *   - toggleSelection 直接 return（点击无法改变选中态）；
   *   - 卡牌的 hover / 拖拽 / 换位等"非选中"交互仍可正常工作（来自需求）。
   */
  private isPlaying = false;

  /**
   * 出牌"挤位阶段"标志：仅在 PlayPipeline.run 期间为 true。
   *
   * 与 isPlaying 的区别：isPlaying 是整个出牌/弃牌"流程锁"（含补牌），在 finally 才解除；
   * 而本标志只覆盖"选中牌飞向出牌堆、剩余手牌向中间挤位让路"这一阶段。
   *
   * 用途：layoutHand 中据此决定剩余手牌走 CardFx.swapMove（playHandSwap 物理挤位，
   * 利落挤位）。一旦进入补牌阶段（drawToFull），本标志已置回 false，发出的新牌就会
   * 正确走 setMoveTarget/弹性绳归位，而不是被误判成"挤位"短路径，
   * 避免补牌"移动速度异常快"。
   */
  private isPlayPhaseSwapping = false;

  /**
   * 出牌流程中手牌整体垂直偏移（px，正值向下）。
   * layoutHand 与出牌堆 getHandArea 的 baseY 都会叠加该值：
   * 手牌挤位与结算区（出牌堆）同步下移/上移，相对关系保持不变。
   */
  private handPlayYOffset = 0;

  private lastHandType = "";
  private lastSelectedCount = 0;

  /** id -> CardView 缓存，复用同一份 view（牌只是回到牌堆，不销毁）。 */
  private readonly viewByCardId = new Map<string, CardView>();

  /**
   * 当前装备的小丑牌视图（默认前 5 张图集槽位）。
   * 与 hand 独立：不参与出牌/弃牌/理牌，但走同一套 CardView 视效管线。
   */
  private jokers: CardView[] = [];

  constructor(private readonly app: App) {
    this.store = new Store<GameState>({
      hand: [],
      selected: [],
      totalScore: 0,
      plays: GameConfig.rules.plays,
      discards: GameConfig.rules.discards,
      currentResult: EMPTY_RESULT,
    });

    // Paint-mix 背景挂在 stage（屏幕坐标），铺满整窗，盖住 Scaler contain 的 letterbox。
    // 不挂 worldRoot：否则只有 1280×720 世界区有涡旋，上下/左右会出现纯色条。
    this.background = new BackgroundView(window.innerWidth, window.innerHeight);
    this.app.pixi.stage.addChildAt(this.background, 0);
    this.app.onResize(() => {
      this.background.coverScreen(window.innerWidth, window.innerHeight);
    });
    this.applyBackgroundClearColor();

    // 全屏 CRT：挂 stage，一次覆盖 BackgroundView + worldRoot（勿只挂 worldRoot）。
    this.crtFilter = new CrtFilter();
    this.syncCrt();

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
      onPlay: () => { void this.playSelected(); },
      onDiscard: () => this.discardSelected(),
      onSortByRank: () => this.sortHand("rank"),
      onSortBySuit: () => this.sortHand("suit"),
    });
    this.hud.zIndex = Layers.UI;
    this.app.worldRoot.addChild(this.hud);

    // HUD 及其后代此时都已注册到 UI Hierarchy。
    // 调一次 hydrate：把 CONFIG.uiNodes 里存档的父子顺序 / transform / 组件灌回去。
    uiHierarchy.hydrateFromConfig(this.app.worldRoot);

    // 牌堆层级修正：把 deckView 从 HUD（UI 层）移到 worldRoot 的 Deck 层（zIndex=10），
    // 使其位于卡牌层（zIndex=30）之下，这样发牌时"发出的牌"会盖住牌堆，而不是被牌堆遮住。
    // reparent 会保持牌堆的世界坐标不变（HUD 无偏移，视觉位置不变），并登记到 UI 层级系统，
    // 后续 hydrate/persist 行为保持稳定。必须放在 hydrate 之后，否则会被 hydrate 按旧存档移回 HUD。
    uiHierarchy.reparent(this.hud.deckView, null, this.app.worldRoot);
    this.hud.deckView.zIndex = Layers.Deck;

    // 玩法区坐标以 CONFIG.playfield 为 SSOT：hydrate 可能写回 shipping 里的旧 deck 位姿，
    // 这里再覆盖一次，保证手牌基准 / 牌堆与参数面板一致。
    this.hud.applyPlayfield();

    // 小丑槽位暗色底条：shipping 已记 parentId=null；hydrate 后应已在 worldRoot。
    // 这里再 ensure 一次（兼容旧存档仍挂在 HUD 下的情况），并固定 zIndex 在卡牌之下。
    if (this.hud.jokerBar.parent !== this.app.worldRoot) {
      uiHierarchy.reparent(this.hud.jokerBar, null, this.app.worldRoot);
    }
    this.hud.jokerBar.zIndex = Layers.JokerBar;

    // 每次刷新网页时，都把界面UI的筹码文字和倍率文字设为0，回合分数文字也设为0，默认隐藏牌型文字和预期分数文字
    this.hud.scorePanel.setChipsMult(0, 0);
    this.hud.scorePanel.setTotalScore(0);
    this.hud.scorePanel.setHandNameVisible(false);
    this.hud.scorePanel.setExpectScoreVisible(false);

    // 注册结算卡牌逐张爆字时的筹码数字弹弹动画监听
    this.bus.on("play:cardSettleTextTriggered", (payload) => {
      const currentChips = this.hud.scorePanel.getChips();
      const currentMult = this.hud.scorePanel.getMult();
      const newChips = currentChips + payload.chips;
      this.hud.scorePanel.setChipsMult(newChips, currentMult);
      this.hud.scorePanel.triggerChipsBounce();
    });

    // 注册小丑结算逐张爆字时的倍率数字弹弹动画监听
    this.bus.on("play:jokerSettleTextTriggered", (payload) => {
      const currentChips = this.hud.scorePanel.getChips();
      const currentMult = this.hud.scorePanel.getMult();
      const newMult = currentMult + payload.mult;
      this.hud.scorePanel.setChipsMult(currentChips, newMult);
      this.hud.scorePanel.triggerMultBounce();
    });

    // 把 tween 接入 app 的更新循环
    this.app.onUpdate((dtMS) => {
      this.background.update(dtMS);
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

    // 创建出牌流程控制器（依赖注入：所有交互都走回调，pipeline 不直接读 store）。
    this.playPipeline = new PlayPipeline({
      tween: this.tween,
      bus: this.bus,
      worldWidth: GameConfig.world.width,
      worldHeight: GameConfig.world.height,
      getHandArea: () => ({
        left: this.hud.handAreaLeft,
        right: this.hud.handAreaRight,
        // 与 handPlayYOffset 同步：整体下移后，出牌结算区也落在偏移后的高度。
        baseY: this.hud.handBaseY + this.handPlayYOffset,
      }),
      layoutHand: (opts) => this.layoutHand(opts),
      applyScore: (result) => {
        const state = this.store.getState();
        const totalScore = state.totalScore + result.score;
        this.store.setState({ totalScore });
        if (!this.isPlaying) {
          this.hud.scorePanel.setTotalScore(totalScore);
        }
        this.bus.emit("round:scoreChanged", { totalScore });
        return totalScore;
      },
      removeFromHand: (view) => {
        const hand = this.store.getState().hand;
        const newHand = hand.filter((v) => v !== view);
        this.store.setState({ hand: newHand });
        // 剩余手牌立即挤位（force：跳过 swap 弹性豁免，保证整齐对齐）。
        this.layoutHand({ force: true });
      },
      getJokers: () => this.jokers,
      animateScoreTransfer: async (result) => {
        const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
        
        // "结算结束后，即出牌堆所有牌结算完，且全部下移后，间隔一段时间后，同时刻：
        //  筹码倍率数字变为0触发弹弹动画；牌型文字隐藏，切换到预期分数文字，预期分数文字触发弹弹动画。"
        await sleep(300);

        this.hud.scorePanel.setChipsMult(0, 0);
        this.hud.scorePanel.triggerChipsBounce();
        this.hud.scorePanel.triggerMultBounce();

        this.hud.scorePanel.setHandNameVisible(false);
        this.hud.scorePanel.setExpectScore(result.score);
        this.hud.scorePanel.setExpectScoreVisible(true);
        this.hud.scorePanel.triggerEvalScoreBounce();

        // 间隔极短时间后开始进行分数迁移
        await sleep(GameConfig.evalScoreText.delayMS);

        // "分数迁移，预期得分文字的数字快速变小，等量加和到回合分数数字上，回合分数字快速变大，
        //  预期得分文字的数字减为0时瞬间消失，回合分数字此时刚好等于原分数+预期得分文字原本的数字。"
        const state = this.store.getState();
        const finalRoundScore = state.totalScore;
        const startRoundScore = finalRoundScore - result.score;

        const animData = {
          evalScore: result.score,
          roundScore: startRoundScore,
        };

        await new Promise<void>((resolve) => {
          this.tween.add(
            this.tween
              .create(animData)
              .to({ evalScore: 0, roundScore: finalRoundScore }, GameConfig.evalScoreText.decreaseDurationMS)
              .easing(Easing.cubicOut)
              .onUpdate(() => {
                this.hud.scorePanel.setExpectScore(Math.round(animData.evalScore));
                this.hud.scorePanel.setTotalScore(Math.round(animData.roundScore));
              })
              .onComplete(() => {
                this.hud.scorePanel.setExpectScore(0);
                this.hud.scorePanel.setTotalScore(finalRoundScore);
                this.hud.scorePanel.setExpectScoreVisible(false);
                resolve();
              })
          );
        });

        if (GameConfig.evalScoreText.stayDurationMS && GameConfig.evalScoreText.stayDurationMS > 0) {
          await sleep(GameConfig.evalScoreText.stayDurationMS);
        }
      },
    });

    // 顶部小丑槽：前 5 张图集（与手牌视效管线共享参数）。
    this.initJokers();

    // 首抽 8 张
    this.drawToFull();
    this.updateButtons();
  }

  // --- 小丑牌 -------------------------------------------------

  /**
   * 初始化 / 重建顶部小丑槽。
   * 默认读取图集前 CONFIG.joker.slotCount 张（0..n-1），水平居中、等间距摆放。
   * 复用手牌拖拽排序 / 选中弹起；不出牌、不弃牌、不参与点数花色理牌。
   * 视效由 joker.effects 门控。公开以便 ControlPanel 修改 slotCount 后即时重建。
   */
  initJokers(): void {
    // 清理旧实例（热重载 / 再次 start 防御）
    for (const v of this.jokers) {
      if (v.parent) v.parent.removeChild(v);
      v.destroy({ children: true });
    }
    this.jokers = [];

    const count = Math.max(0, Math.floor(GameConfig.joker?.slotCount ?? 5));
    for (let i = 0; i < count; i += 1) {
      const data: CardData = {
        id: `joker-${i}`,
        rank: "A",
        suit: "♠",
        value: 14,
        chips: 0,
      };
      const view = new CardView(
        data,
        {
          // 选中只作用于小丑自身（弹起视效），不进 store.selected，避免污染出牌计分。
          onClick: (v) => this.toggleJokerSelection(v),
          onHoverIn: () => {},
          onHoverOut: () => {},
          onDragStart: (v) => {
            this.tween.killOf(v);
            // 递增 gen，使任何残留 swap tween 的 onStop 不再误清后续状态。
            v.swapAnimGen += 1;
            v.isSwapAnimating = false;
            v.isSelectAnimating = false;
            v.zIndex = 9999;
            v.isReturning = false;
          },
          onDragging: (v) => {
            // 与手牌相同：用视觉中线 view.x 判定换位时机。
            this.reorderJokersWhileDragging(v, v.x);
          },
          onDragEnd: (v) => {
            // 松手用鼠标逻辑位置再兜底一次换位（快速甩动场景）。
            this.reorderJokersWhileDragging(v, v.dragLogicalX);
            v.isReturning = true;
            this.layoutJokers();
          },
        },
        this.shadowLayer,
        { role: "joker", jokerIndex: i },
      );
      // 顶部条 zIndex 基准略高于普通手牌（0..n），拖拽时仍会抬到 9999。
      view.zIndex = 50 + i;
      this.cardLayer.addChild(view);
      this.jokers.push(view);
    }
    // 新建实例：先写好 layout 元数据并瞬移到位（尚无「从别处飞入」语义）。
    this.snapJokersToLayout();
  }

  /** 仅写 layout 元数据 + 瞬移到槽位（重建 / 首次生成用）。 */
  private snapJokersToLayout(): void {
    const list = this.jokers;
    const n = list.length;
    if (n <= 0) return;

    const spacing = GameConfig.joker?.cardSpacing ?? 120;
    const baseY = GameConfig.joker?.baseY ?? 90;
    const rise = GameConfig.cardVisuals.selectRiseY ?? 30;
    // 整体中线：读 joker.baseX（世界坐标），缺省回退到世界宽度中线。
    const centerX = GameConfig.joker?.baseX ?? GameConfig.world.width / 2;
    const startX = centerX - ((n - 1) * spacing) / 2;

    list.forEach((view, i) => {
      this.tween.killOf(view);
      view.swapAnimGen += 1;
      view.isSwapAnimating = false;
      view.isSelectAnimating = false;
      view.handIndex = i;
      view.handCount = n;
      view.zIndex = 50 + i;
      view.layoutX = startX + i * spacing;
      view.layoutY = view.selected ? baseY - rise : baseY;
      view.layoutRotation = 0;
      view.x = view.layoutX;
      view.y = view.layoutY;
      view.rotation = 0;
      view.syncRopePose({
        x: view.layoutX,
        y: view.layoutY,
        rotation: 0,
      });
    });
  }

  /**
   * 按 CONFIG.joker 重新计算顶部小丑槽位姿。
   * 动画路径与 layoutHand 同构（swapMove / 绳目标归位 / select 豁免）。
   * 公开以便 ControlPanel 改 spacing / baseX / baseY / slotCount 后即时生效。
   */
  layoutJokers(opts?: {
    swapFor?: ReadonlySet<CardView>;
    force?: boolean;
  }): void {
    const list = this.jokers;
    const n = list.length;
    if (n <= 0) return;

    const spacing = GameConfig.joker?.cardSpacing ?? 120;
    const baseY = GameConfig.joker?.baseY ?? 90;
    const rise =
      GameConfig.cardVisuals.selectRiseY ?? 30;
    // 水平中线：读 joker.baseX（世界坐标），缺省回退到世界宽度中线。
    const centerX = GameConfig.joker?.baseX ?? GameConfig.world.width / 2;
    const totalSpan = (n - 1) * spacing;
    const startX = centerX - totalSpan / 2;

    list.forEach((view, i) => {
      view.zIndex = view.isDragging ? 9999 : 50 + i;
      view.handIndex = i;
      view.handCount = n;

      const slot = {
        x: startX + i * spacing,
        y: view.selected ? baseY - rise : baseY,
        rotation: 0,
      };
      view.layoutX = slot.x;
      view.layoutY = slot.y;
      view.layoutRotation = slot.rotation;

      if (view.isDragging) return;

      if (view.isSelectAnimating) return;

      if (opts?.swapFor?.has(view)) {
        CardFx.swapMove(this.tween, view, slot);
        return;
      }

      // force=true 时无视 swap 豁免（与 layoutHand 一致）。
      if (!opts?.force && view.isSwapAnimating) {
        if (!view.isRopeSettled()) {
          view.setMoveTarget(slot.x, slot.y, slot.rotation);
          return;
        }
        view.isSwapAnimating = false;
      }

      CardFx.moveToWithOvershoot(
        this.tween,
        view,
        slot,
        GameConfig.animation.moveDurationMS,
      );
    });
  }

  /**
   * 小丑拖拽换位：与 reorderHandWhileDragging 同构，操作 this.jokers 数组。
   */
  private reorderJokersWhileDragging(view: CardView, dragCenter: number): void {
    const list = this.jokers;
    const i = list.indexOf(view);
    if (i < 0) return;

    let newIndex = i;
    const swapFor = new Set<CardView>();

    // 与 reorderHandWhileDragging 一致：不把正在 swap 的邻牌当墙，
    // 快速左右往返时逻辑序始终跟手；动画由 CardFx retarget 路径消化。
    while (newIndex > 0) {
      const left = list[newIndex - 1]!;
      if (dragCenter < left.layoutX) {
        swapFor.add(left);
        newIndex -= 1;
      } else {
        break;
      }
    }

    while (newIndex < list.length - 1) {
      const right = list[newIndex + 1]!;
      if (dragCenter > right.layoutX) {
        swapFor.add(right);
        newIndex += 1;
      } else {
        break;
      }
    }

    if (newIndex === i) return;

    const next = list.slice();
    next.splice(i, 1);
    next.splice(newIndex, 0, view);
    this.jokers = next;

    this.layoutJokers({ swapFor });
  }

  /**
   * 小丑选中弹起：复用手牌 selectMove 参数，但不写入 store.selected、不触发计分。
   */
  private toggleJokerSelection(view: CardView): void {
    if (!view.isJoker) return;
    // 出牌流程中仍允许悬停/拖拽排序；选中弹起与手牌一致：流程锁期间不切换。
    if (this.isPlaying) return;

    let direction: "rise" | "fall" | null = null;
    if (view.selected) {
      view.selected = false;
      direction = "fall";
    } else {
      view.selected = true;
      direction = "rise";
    }

    const cv = GameConfig.cardVisuals;
    const useSelectFx =
      cv.selectMoveEnabled !== false && direction !== null;
    if (useSelectFx) {
      this.tween.killOf(view);
      view.isSelectAnimating = true;
    }

    this.layoutJokers({ force: true });

    if (useSelectFx && direction) {
      const target = {
        x: view.layoutX,
        y: view.layoutY,
        rotation: view.layoutRotation,
      };
      const isRise = direction === "rise";
      void isRise;
      CardFx.selectMove(this.tween, view, target, direction, {
        startSpeed: 0,
        overshoot: 0,
        stiffness: 0,
        onSettle: () => {
          view.isSelectAnimating = false;
        },
      });
    }
  }

  // --- 抽牌 / 布局 -------------------------------------------------

  /**
   * 估测弹性绳飞向目标的「主行程」时长（用于抓牌翻面节奏 / 交错发车）。
   * 过冲振荡不计入；终端速度近似 V ≈ k·Lmax / c（线性阻尼）。
   */
  private getAnimationDuration(
    card: CardView,
    target: { x: number; y: number },
    speedRatio = 1.0
  ): number {
    const dist = Math.hypot(target.x - card.x, target.y - card.y);
    if (dist < 1e-3) return 0;

    const er = GameConfig.elasticRopeCard;
    const k = Math.max(0, er?.spring?.stiffness ?? 100);
    const Lmax = Math.max(1, er?.spring?.maxElasticLength ?? 120);
    const c = Math.max(0.05, er?.airDrag?.linearCoeff ?? 10);
    const vTerm = Math.max(80, (k * Lmax) / c);
    // 粗估：主行程 + 少量 settle 余量
    const naturalMS = (dist / vTerm) * 1000 * 1.8;
    const minMS = 100;
    const maxMS = 2200;
    const riseMS = Math.min(maxMS, Math.max(minMS, naturalMS));
    return riseMS / Math.max(0.01, speedRatio);
  }

  private async drawToFull(): Promise<void> {
    setDrawingCards(true);
    try {
      const need = GameConfig.rules.handSize - this.store.getState().hand.length;
      if (need <= 0) {
        // 手牌数量校正路径：force 强制对齐，避免极端情况下豁免 swap 弹性导致错位。
        this.layoutHand({ force: true });
        return;
      }
      const drawn = this.deck.draw(need);
      const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

      const speedRatio = GameConfig.drawCard?.speedRatio ?? 1.0;

      for (let i = 0; i < drawn.length; i++) {
        const data = drawn[i]!;
        const view = this.getOrCreateView(data);
        view.selected = false;
        this.cardLayer.addChild(view);
        
        // 从右下角的卡牌堆（deckView）位置刷出（对齐中心点）
        view.x = this.hud.deckView.x + view.pivot.x;
        view.y = this.hud.deckView.y + view.pivot.y;
        view.rotation = GameConfig.drawCard?.useInitialRotation
          ? (GameConfig.drawCard.initialRotationDeg * Math.PI) / 180
          : 0;
        // 从发牌堆瞬移生成：同步绳状态，随后 layoutHand 只设目标点
        view.syncRopePose({
          x: view.x,
          y: view.y,
          rotation: view.rotation,
        });

        const currentHand = [...this.store.getState().hand];
        const insertIndex = Math.floor(Math.random() * (currentHand.length + 1));
        
        currentHand.splice(insertIndex, 0, view);
        this.store.setState({ hand: currentHand });
        this.hud.deckView.setCount(this.deck.size);

        const slots = computeHandLayout(currentHand, {
          areaLeft: this.hud.handAreaLeft,
          areaRight: this.hud.handAreaRight,
          baseY: this.hud.handBaseY,
          cardSpacing: GameConfig.handLayout.cardSpacing,
          arcEnabled: GameConfig.handLayout.arcEnabled,
          arcHeight: GameConfig.handLayout.arcHeight,
          fanAnglePerCardDeg: GameConfig.handLayout.fanAnglePerCardDeg,
        });
        const slot = slots[insertIndex]!;

        // 抽牌后：手牌数量变化，必须强制对齐（force），不豁免任何"正在弹性"的牌。
        // layoutHand 对全体手牌只 setMoveTarget；新牌路径/速率/过冲完全由弹性绳处理。
        this.layoutHand({ force: true, speedRatio });
        // 显式再钉一次本张目标（防御 layout 分支漏设），不写 x/y/tween。
        view.setMoveTarget(slot.x, slot.y, slot.rotation);

        // 翻面节奏用绳主行程估时（仅驱动 flip 通道，不驱动位移）。
        const duration = this.getAnimationDuration(view, slot, speedRatio);
        view.startDrawFlip(duration);

        const nextCardAdvance = GameConfig.drawCard?.nextCardAdvanceMS ?? 0;
        const scaledNextAdvance = nextCardAdvance / speedRatio;

        let delayMS = Math.max(0, duration - scaledNextAdvance);

        if (drawn.length >= 4 && i === drawn.length - 2) {
          const lastCardAdvance = GameConfig.drawCard?.lastCardAdvanceMS ?? 150;
          // 最后一组牌的提前量为下一张牌提前量与最后一张牌提前量叠加
          const scaledLastAdvance = lastCardAdvance / speedRatio;
          delayMS = Math.max(0, duration - (scaledNextAdvance + scaledLastAdvance));
        }

        if (i < drawn.length - 1) {
          // 错开发车：只等间隔，不 await 整段 settle（下一张可提前飞出）。
          await sleep(delayMS);
        } else {
          // 最后一张：等到本张绳吸附；循环后再等全手牌，覆盖前序牌的过冲回落。
          await view.waitSettled();
        }
      }
      // 确保本轮抓出的牌及挤位中的旧牌都绳吸附完成后再解除 isDrawing。
      await Promise.all(
        this.store.getState().hand.map((c) => c.waitSettled())
      );
    } finally {
      setDrawingCards(false);
      // drawToFull 是 async：start() 里若未 await，会在手牌仍为空时提前 updateButtons，
      // 把理牌按钮关掉且不再刷新。这里在抽牌结束（或 early-return）后统一刷新一次，
      // 确保手牌满后「点数 / 花色」立即可用，不依赖先选中牌。
      this.updateButtons();
    }
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
          // killOf 会 stop 所有相关 tween。CardFx 中的 swapMove/selectMove 已通过
          // Tween.onStop 在被打断时清旗，所以这里通常已经为 false。
          // 但为防御任何路径下的标志残留（例如 tween 未启动但标志已置位、或
          // 未来新增的动画忘记挂 onStop），在此显式清零作为最后一道保险。
          // 递增 gen：保证旧 swap 回调不会与本次拖拽之后的新动画串扰。
          view.swapAnimGen += 1;
          view.isSwapAnimating = false;
          view.isSelectAnimating = false;
          view.zIndex = 9999;
          view.isReturning = false;
        },
        onDragging: (view, _x, _y) => {
          // 拖拽过程中：用 view.x（lerp 平滑后的实际渲染中线）做换位判定。
          // 这样"换位时机"严格对应卡片视觉中线穿过邻牌中线那一刻，手感清晰不模糊。
          this.reorderHandWhileDragging(view, view.x);
        },
        onDragEnd: (view) => {
          // 选中状态完全由 toggleSelection 翻转，慢点击/拖拽松手不会改动 view.selected，
          // 因此这里不再需要"兜底同步 store.selected"的逻辑。只负责回弹与重排即可。
          //
          // 松手瞬间——按「鼠标光标的逻辑位置」(dragLogicalX = 鼠标位置 - 抓握偏移)
          // 再做一次最终换位判定。这是为了解决「快速甩动鼠标后立刻松手」的场景：
          // 由于卡牌位置受 lerp/maxSpeed 限制会滞后于鼠标，如果只用拖拽过程中累积的
          // 换位结果（基于 view.x 计算），最终落位会停留在「卡牌已滑过」而非「鼠标
          // 到达」的位置——不符合玩家意图。在这里用 dragLogicalX 兜底覆盖一次，
          // 让最终顺序与玩家鼠标松手时所在的位置一致。
          this.reorderHandWhileDragging(view, view.dragLogicalX);

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
   *                     而非默认的绳目标归位。
   *                     不在集合中、且未被 isDragging/isSelectAnimating 跳过的牌仍走
   *                     绳目标归位，保证发牌/松手归位等其它场景行为不变。
   * @param opts.sortFor 可选——本次重排是「点数/花色理牌」触发的，集合中的牌走
   *                     CardFx.sortMove（距离自适应速度的 rise→spring）。
   *                     调用前 hand 数组已按最终顺序排好，本函数开头写的 zIndex
   *                     已是最终显示层序（落点靠左下层、靠右上层）。
   * @param opts.force   可选——true 时无视 view.isSwapAnimating 的豁免，对所有牌强制
   *                     重排。用于"手牌数量变化"等必须立刻整齐对齐的场景（抽牌、出牌、
   *                     弃牌、回合重置等）。拖拽中的 onDragging 重排不应传 true，
   *                     否则会打断正在播放的 swap 弹性。默认 false。
   */
  layoutHand(opts?: {
    swapFor?: ReadonlySet<CardView>;
    sortFor?: ReadonlySet<CardView>;
    force?: boolean;
    speedRatio?: number;
  }): void {
    const hand = this.store.getState().hand;
    const slots = computeHandLayout(hand, {
      areaLeft: this.hud.handAreaLeft,
      areaRight: this.hud.handAreaRight,
      baseY: this.hud.handBaseY + this.handPlayYOffset,
      cardSpacing: GameConfig.handLayout.cardSpacing,
      arcEnabled: GameConfig.handLayout.arcEnabled,
      arcHeight: GameConfig.handLayout.arcHeight,
      fanAnglePerCardDeg: GameConfig.handLayout.fanAnglePerCardDeg,
    });
    const handCount = hand.length;
    hand.forEach((view, i) => {
      // 用 zIndex 保证右边的牌盖住左边的（卡牌层启用 sortableChildren）。
      // 处于拖拽态的卡牌，其显示应该置于所有卡牌上。
      // 理牌场景：hand 已按最终顺序排好 → 此处 zIndex 立刻等于最终落点层序，
      // 动画开始前就排好显示顺序，避免到位后再切 zIndex 的生硬跳变。
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

      // 「点数/花色理牌」分支：走距离自适应速度的 sortMove（远牌更快）。
      // 放在 isSelectAnimating 豁免之前：理牌 force 场景需要立刻接管所有牌
      // （包括正在选中过弹的牌），由 TweenManager 同字段互斥自然打断旧动画。
      // 同步清零 isSelectAnimating，避免后续帧再被选中豁免卡住。
      if (opts?.sortFor?.has(view)) {
        view.isSelectAnimating = false;
        CardFx.sortMove(this.tween, view, slot);
        return;
      }

      // 正在播放"选中/取消选中位移过弹动画"的牌：交给 CardFx.selectMove 自己跑两段补间。
      // 这里只更新 layoutX/Y/Rotation 元数据，不再下发普通 moveTo（避免 TweenManager
      // 同字段冲突踢掉过弹段）。
      //
      // 【重要】标志为 true 时一律跳过，即使当前尚无活跃 tween。
      // 原因：toggleSelection 的顺序是「置位 isSelectAnimating → layoutHand → selectMove」。
      // 若在标志未稳时自愈清旗并走常规归位，会与随后启动的 selectMove 竞态；
      // 更糟的是 CardView 快速点击路径在 onClick 之后还会立刻调 onDragEnd→layoutHand，
      // 若此时标志已被清掉，归位动画会直接互斥掉 selectMove——表现为选中参数"完全不起作用"。
      // 残留标志的清理由 selectMove.onSettle / onDragStart.killOf 路径负责。
      if (view.isSelectAnimating) {
        return;
      }

      // 「手动理牌换位让位」分支：本次 layoutHand 由 reorderHandWhileDragging 触发，
      // view 在被让位集合里——走专属的 CardFx.swapMove（固定时长 + 固定过冲），
      // 仍走 swapMove（绳目标），与常规归位分支区分以便维护 isSwapAnimating。
      if (opts?.swapFor?.has(view)) {
        CardFx.swapMove(this.tween, view, slot);
        return;
      }

      // 「swap 豁免」：换位牌仍在飞向目标时，不要被常规 layout 重设目标打断。
      // force=true 时无视。自愈：标志为 true 但已 settle → 清旗后走常规路径。
      if (!opts?.force && view.isSwapAnimating) {
        if (!view.isRopeSettled()) {
          // 目标可能已变（快速连续换位）：仅更新目标，保持 swap 标志
          view.setMoveTarget(slot.x, slot.y, slot.rotation);
          return;
        }
        view.isSwapAnimating = false;
      }

      // 「【出牌】手牌换位」分支：出牌"挤位阶段"，手牌的其他牌向中位移位（利落短动画）。
      // 注意：必须用 isPlayPhaseSwapping 而非 isPlaying——后者在补牌阶段仍为 true，
      // 若用 isPlaying 会让 drawToFull 发出的新牌也误走这条 swapMove（固定 110ms），
      // 导致补牌移动速度异常快。补牌阶段本标志已为 false，自然落入下面的距离驱动归位。
      if (this.isPlayPhaseSwapping) {
        CardFx.swapMove(this.tween, view, slot);
        return;
      }

      // 弹性绳：只设目标槽位，速度/过冲由 CardView 牵引模型处理。
      CardFx.moveToWithOvershoot(
        this.tween,
        view,
        slot,
        GameConfig.animation.moveDurationMS,
        0,
        false,
        opts?.speedRatio ?? 1.0
      );
    });
  }

  /**
   * 按点数或花色理牌。
   *
   * 流程：
   *   1. 根据 mode 计算每张牌的最终下标（稳定排序，相等键保留相对顺序）；
   *   2. 立刻写回 hand 数组；
   *   3. layoutHand：先按最终下标写 zIndex（落点靠左下层、靠右上层），
   *      再让每张需要移动的牌走 CardFx.sortMove（距离越大速度越大）。
   *
   * 排序规则：
   *   - rank：主键 value 降序（A…2，大的在左、小的在右），次键花色顺序（♠♥♣♦）；
   *   - suit：主键花色顺序（♠♥♣♦），次键 value 升序。
   */
  sortHand(mode: HandSortMode): void {
    if (this.isPlaying) return;

    const hand = this.store.getState().hand;
    if (hand.length <= 1) return;

    // 拖拽进行中不理牌：拖拽牌由鼠标主导位置，强行改 hand 序会和松手归位打架。
    if (hand.some((v) => v.isDragging)) return;

    const suitIndex = (suit: string): number => {
      const i = SUITS.indexOf(suit as (typeof SUITS)[number]);
      return i >= 0 ? i : 0;
    };

    const sorted = hand.slice().sort((a, b) => {
      if (mode === "rank") {
        // 降序：点数大的靠左，小的靠右（A … 2）
        const dv = b.data.value - a.data.value;
        if (dv !== 0) return dv;
        return suitIndex(a.data.suit) - suitIndex(b.data.suit);
      }
      const ds = suitIndex(a.data.suit) - suitIndex(b.data.suit);
      if (ds !== 0) return ds;
      return a.data.value - b.data.value;
    });

    // 已是目标顺序：无需动画，但仍可刷新一次按钮态。
    const unchanged = sorted.every((v, i) => v === hand[i]);
    if (unchanged) {
      this.updateButtons();
      return;
    }

    this.store.setState({ hand: sorted });

    // 所有最终位置相对当前视觉位置有变化的牌都参与 sortMove。
    // 用当前 view 坐标与即将写入的 layout 目标比距离即可，但此时 layout 尚未算好；
    // 简单起见：全部纳入 sortFor，sortMove 对 dist≈0 的牌会直接置位返回。
    const sortFor = new Set(sorted);

    // force=true：打断进行中的 swap/选中等弹性，立刻按新序开跑。
    // zIndex 在 layoutHand 入口按最终下标写好，动画开跑前显示层序已正确。
    this.layoutHand({ sortFor, force: true });
    this.updateButtons();
  }

  /**
   * 拖拽中手动理牌：当「拖拽牌中线 dragCenter」穿过左/右邻牌的「槽位中线 layoutX」时，
   * 立即与该邻牌在 hand 数组中互换位置，并触发 layoutHand 让让位牌平滑移动到新槽位。
   *
   * 双重调用机制：
   *   - 拖拽过程中（onDragging）：传入 `view.x`（已 lerp 平滑的实际渲染中线）。
   *     这样"换位时机"严格对应卡片视觉中线真正滑过邻牌中线那一刻，手感明确不模糊。
   *     除 pointermove 外，CardView.updateDragging 每帧也会回调一次，确保卡牌在
   *     追赶鼠标的过程中（鼠标已停、牌还在 lerp）仍能持续跨越中线完成换位。
   *   - 松手瞬间（onDragEnd）：传入 `view.dragLogicalX`（= 鼠标位置 - 抓握偏移）。
   *     这是为了解决「快速甩动鼠标后立刻松手」时——由于 lerp/maxSpeed 限速，卡牌
   *     还没追上鼠标——基于 view.x 算出的最终落位会停留在「卡牌已滑过」而非「鼠标
   *     到达」的位置，不符合玩家意图。松手时用鼠标逻辑位置做一次最终判定，确保
   *     落位与玩家鼠标光标位置一致。
   *
   * 设计要点：
   *   1. 邻牌一侧用 `layoutX` 而非 `view.x`：
   *      layoutX 是 layoutHand 写入的、与 hand 数组顺序一一对应的目标槽位 x；
   *      用它做基准等价于"按数组当前顺序计算的稳定槽位中线"，不会因相邻牌
   *      还在动画途中其 view.x 漂移而出现"反复 swap 抖动"。
   *      换位后邻牌的新 layoutX 立刻就位（其 view.x 还在动画途中），离当前
   *      dragCenter 已是一整个 cardSpacing 的距离，天然形成滞回——不会立即反向 swap。
   *
   *   2. 用 while 循环允许「一次性跳多格」——快速划过 2~3 张牌时也能跟手，不会因
   *      为单帧只换一格而残留视觉错位。松手分支同样依赖这一点：鼠标可能远在 view.x
   *      右侧好几格，需要一次性补齐。
   *
   *   3. 邻牌即便正在播放 swap 动画也可再次被跨越（无「换位墙」）。
   *      旧设计把 isSwapAnimating 邻牌当不可穿越的墙，是为了避免 rise 被反复打断
   *      造成视觉变慢；但快速左右往返时会表现为「换位停住 / 严重延迟」。
   *      现在改为：逻辑序始终跟手；被再次让位的牌立刻打断并用 handSwap 物理模型
   *      （startSpeed / overshoot / stiffness）从当前位置重新开完整 rise→spring，
   *      时长按当前距离重算，短距离不会变慢。
   *
   *   4. swap 之后立即调用 layoutHand：
   *      - 拖拽牌本身：layoutHand 会更新它的 zIndex / handIndex / layoutX/Y/Rotation
   *        元数据。
   *        · onDragging 路径：isDragging=true，跳过 TweenManager 写位置（鼠标主导）；
   *          新的 layoutX 即"松手回弹的目标点"。
   *        · onDragEnd 路径：调用方在本函数返回后立刻置 view.isReturning=true 并再调
   *          一次 layoutHand()，那时才让 TweenManager 把拖拽牌平滑送到新槽位。
   *      - 被让位的相邻牌：layoutHand 会用 CardFx.swapMove 带它过去
   *        （物理 rise + spring，可立刻打断重开）。
   *
   *   5. 只看 x 不看 y：手牌区域是横向一字排开（带轻微弧形），换位仅由水平位置决定。
   */
  private reorderHandWhileDragging(view: CardView, dragCenter: number): void {
    const hand = this.store.getState().hand;
    const i = hand.indexOf(view);
    if (i < 0) return;

    let newIndex = i;
    // 本次手势中被「跨过 / 让位」的相邻牌——它们将走 CardFx.swapMove 走利落的过冲动画，
    // 而不是默认归位分支（便于维护 isSwapAnimating）。
    const swapFor = new Set<CardView>();

    // 向左检查：拖拽牌中线穿过左邻牌槽位中线 left.layoutX 时换位。
    // 越过则交换，并继续向左追问新左邻；while 支持单次手势跨多格。
    // 不把 isSwapAnimating 邻牌当墙——快速往返必须能立刻反向换位。
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
    // 出牌期间：点击不改变选中态（hover / 拖拽 / 换位仍由 CardView 自身处理）。
    if (this.isPlaying) return;

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
    // 标记必须在 layoutHand() 之前置位（且 layoutHand 不得在"尚无 tween"时清旗）。
    const cv = GameConfig.cardVisuals;
    const useSelectFx =
      cv.selectMoveEnabled !== false && direction !== null;
    if (useSelectFx) {
      // 先停掉残留 tween（其 onStop 可能把 isSelectAnimating 清成 false），
      // 再置位标志，避免旧 settle 冲掉本次选中动画的豁免。
      this.tween.killOf(view);
      view.isSelectAnimating = true;
    }

    // 选中/取消选中：需要其它牌立即对齐到新基线（被选中的牌弹起后腾出/腾回位置），
    // 用 force 跳过 swap 弹性豁免，避免视觉错位。
    // 本牌因 isSelectAnimating=true 被跳过，不会下发 moveTo。
    this.layoutHand({ force: true });

    // 取出该牌经 layoutHand 写好的目标位姿，启动选中/取消选中过弹动画。
    // 上移（rise）与下移（fall）使用各自独立的启动速度 / 过冲 / 刚度参数。
    if (useSelectFx && direction) {
      const target = {
        x: view.layoutX,
        y: view.layoutY,
        rotation: view.layoutRotation,
      };
      const isRise = direction === "rise";
      void isRise;
      // 位移参数已退役；过冲/速度由弹性绳统一处理。
      CardFx.selectMove(this.tween, view, target, direction, {
        startSpeed: 0,
        overshoot: 0,
        stiffness: 0,
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

    const count = selected.length;

    if (count === 0) {
      this.hud.scorePanel.setHandNameVisible(false);
      this.hud.scorePanel.setExpectScoreVisible(false);
      this.hud.scorePanel.setChipsMult(0, 0);

      if (this.lastSelectedCount > 0) {
        this.hud.scorePanel.triggerChipsBounce();
        this.hud.scorePanel.triggerMultBounce();
      }
    } else {
      this.hud.scorePanel.setHandNameVisible(true);
      this.hud.scorePanel.setExpectScoreVisible(false);

      this.hud.scorePanel.setHandName(result.handType);
      // HUD 预览只显示牌型对应的基础筹码与倍率，不计入所选牌的点数
      this.hud.scorePanel.setChipsMult(result.baseChips, result.mult);
      this.hud.scorePanel.setExpectScore(result.score);

      const isJustSelected = this.lastSelectedCount === 0;
      const isHandTypeChanged = !isJustSelected && this.lastHandType !== result.handType;

      if (isJustSelected || isHandTypeChanged) {
        this.hud.scorePanel.triggerHandNameBounce();
        this.hud.scorePanel.triggerChipsBounce();
        this.hud.scorePanel.triggerMultBounce();
      }
    }

    this.lastSelectedCount = count;
    this.lastHandType = result.handType;

    this.updateButtons();
  }

  private updateButtons(): void {
    const { selected, plays, discards, hand } = this.store.getState();
    const hasSelection = selected.length > 0;
    // 出牌期间所有按钮均 disable，避免在流程播放中再次触发出牌/弃牌。
    const allowAction = !this.isPlaying;
    // 无限模式：忽略剩余次数限制。
    const unlimited = GameConfig.rules.unlimitedActions;
    this.hud.playBtn.setEnabled(allowAction && hasSelection && (unlimited || plays > 0));
    this.hud.discardBtn.setEnabled(allowAction && hasSelection && (unlimited || discards > 0));
    // 理牌：出牌流程中禁用；手牌 ≥ 2 张才有意义。
    const canSort = allowAction && hand.length > 1;
    this.hud.sortRankBtn.setEnabled(canSort);
    this.hud.sortSuitBtn.setEnabled(canSort);
  }

  // --- 出牌 / 弃牌 -------------------------------------------------

  /** 出牌/弃牌/点数/花色四键瞬间显隐（visible，与 setEnabled 独立）。 */
  private setActionButtonsVisible(visible: boolean): void {
    this.hud.playBtn.visible = visible;
    this.hud.discardBtn.visible = visible;
    this.hud.sortRankBtn.visible = visible;
    this.hud.sortSuitBtn.visible = visible;
  }

  /**
   * 手牌整体垂直位移（下移正 / 上移负），并同步 handPlayYOffset，
   * 使后续 layoutHand 挤位仍落在偏移后的高度。
   */
  private async shiftHandGroup(deltaY: number): Promise<void> {
    const cfg = GameConfig.playHandGroupShift;
    const hand = this.store.getState().hand;
    if (!cfg || hand.length === 0 || Math.abs(deltaY) < 1e-3) {
      this.handPlayYOffset += deltaY;
      return;
    }
    // 先写入偏移，避免位移过程中 layoutHand 把牌拽回旧 baseY。
    this.handPlayYOffset += deltaY;
    await CardFx.shiftHandGroupY(this.tween, hand, deltaY);
  }

  /**
   * 轮询直到手牌补满且每张都到达 layout 目标附近
   * （过冲峰值仍远离目标，不会在飞向过冲点时误触发）。
   * 不等待回弹/过冲动画播完。
   */
  private waitHandNearLayoutTargets(thresholdPx = 8, timeoutMS = 5000): Promise<void> {
    const threshold = Math.max(1, thresholdPx);
    const targetCount = GameConfig.rules.handSize;
    const start = performance.now();
    return new Promise((resolve) => {
      const tick = () => {
        const hand = this.store.getState().hand;
        // 必须先补满，否则「仅剩旧牌已在位」会在发新牌前就提前 resolve。
        const full = hand.length >= targetCount;
        const allNear =
          full &&
          hand.every((v) => {
            const dx = v.x - v.layoutX;
            const dy = v.y - v.layoutY;
            return Math.hypot(dx, dy) <= threshold;
          });
        if (allNear || performance.now() - start >= timeoutMS) {
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  private async playSelected(): Promise<void> {
    const state = this.store.getState();
    const unlimited = GameConfig.rules.unlimitedActions;
    if (state.selected.length === 0) return;
    if (!unlimited && state.plays <= 0) return;
    if (this.isPlaying) return;

    const result = state.currentResult;
    const selectedSnapshot = [...state.selected];
    const shiftCfg = GameConfig.playHandGroupShift;
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    // 进入"出牌锁"：按钮 disable、toggleSelection 跳过。
    // 注意：hover / 拖拽 / 换位仍然有效（需求要求）。
    this.isPlaying = true;
    // 出牌瞬间：四按钮立刻隐藏（与 disable 独立）。
    this.setActionButtonsVisible(false);
    // 立刻清空当前选中（HUD 上不再保留高亮）。
    // 无限模式下不扣减出牌次数，也不刷新 HUD 数字。
    const nextPlays = unlimited ? state.plays : state.plays - 1;
    this.store.setState({
      plays: nextPlays,
      selected: [],
    });
    if (!unlimited) {
      this.hud.scorePanel.setPlays(nextPlays);
    }
    this.bus.emit("card:selectionChanged", { selected: [] });
    // 兼容旧事件：round:play 在流程开始时一次性 emit（视觉细节请订阅 play:* 系列）。
    this.bus.emit("round:play", {
      cards: selectedSnapshot.map((v) => v.data),
      result,
    });
    this.updateButtons();

    let buttonsRestored = false;
    const restoreButtons = () => {
      if (buttonsRestored) return;
      buttonsRestored = true;
      this.setActionButtonsVisible(true);
    };

    try {
      // ── 整体下移：按钮隐藏 → 等待 → 下移 → 等待 → 打出 ──
      if (shiftCfg?.enabled) {
        const dist = Math.max(0, shiftCfg.distancePx ?? 0);
        if (shiftCfg.preDownWaitMS > 0) await sleep(shiftCfg.preDownWaitMS);
        if (dist > 0) await this.shiftHandGroup(dist);
        if (shiftCfg.postDownWaitMS > 0) await sleep(shiftCfg.postDownWaitMS);
      }

      // 进入"挤位阶段"：run() 内部触发的剩余手牌重排走 swapMove（利落挤位）。
      this.isPlayPhaseSwapping = true;
      let views: CardView[];
      try {
        ({ views } = await this.playPipeline.run(selectedSnapshot, result));
      } finally {
        // 出牌堆流程结束、进入补牌前关闭挤位标志：drawToFull 发出的新牌将走
        // 绳目标归位，而非出牌挤位专用 swap 分支。
        this.isPlayPhaseSwapping = false;
      }

      // ── 流程结束：数据回收 ───────────────────────
      // 视图层面：所有牌已飞出屏幕，无需 flyOut；但需要把 view 状态复位以便复用。
      for (const v of views) {
        v.selected = false;
        v.cardState = CardState.Normal;
      }

      // 数据：放回牌堆并洗牌。
      this.deck.recycle(views.map((v) => v.data));
      this.deck.shuffle();
      this.hud.deckView.setCount(this.deck.size);
      this.bus.emit("deck:changed", { size: this.deck.size });

      // ── 整体上移：分数已入账后、发牌前 ──
      if (shiftCfg?.enabled && Math.abs(this.handPlayYOffset) > 1e-3) {
        if (shiftCfg.preUpWaitMS > 0) await sleep(shiftCfg.preUpWaitMS);
        await this.shiftHandGroup(-this.handPlayYOffset);
        if (shiftCfg.postUpWaitMS > 0) await sleep(shiftCfg.postUpWaitMS);
      } else {
        this.handPlayYOffset = 0;
      }

      // 补牌：启动发牌动画；按钮在「新牌到达布局位置」时立刻显示，
      // 不必等过冲/回弹播完（drawToFull 仍可在后台跑完）。
      const drawPromise = this.drawToFull();
      await this.waitHandNearLayoutTargets();
      restoreButtons();
      this.isPlaying = false;
      this.updateButtons();
      await drawPromise;
      this.evaluateAndUpdate();
    } finally {
      // 兜底：即便 run() 抛错绕过了上面的内层 finally，这里也确保挤位标志被关闭。
      this.isPlayPhaseSwapping = false;
      // 异常路径：保证偏移复位、按钮重新出现。
      if (Math.abs(this.handPlayYOffset) > 1e-3) {
        this.handPlayYOffset = 0;
        this.layoutHand({ force: true });
      }
      restoreButtons();
      this.isPlaying = false;
      this.updateButtons();
    }
  }

  private async discardSelected(): Promise<void> {
    if (this.isPlaying) return;
    const state = this.store.getState();
    const unlimited = GameConfig.rules.unlimitedActions;
    if (state.selected.length === 0) return;
    if (!unlimited && state.discards <= 0) return;

    // 无限模式下不扣减弃牌次数，也不刷新 HUD 数字。
    if (!unlimited) {
      this.store.setState({ discards: state.discards - 1 });
      this.hud.scorePanel.setDiscards(state.discards - 1);
    }

    this.bus.emit("round:discard", {
      cards: state.selected.map((v) => v.data),
    });

    await this.recycleSelected();
  }

  // --- 外部刷新钩子 ------------------------------------------------

  /**
   * 当前 HUD 模式。仅作只读访问；切换走 switchMode / setMode。
   */
  get mode(): HUDMode {
    return this.hud ? this.hud.mode : "normal";
  }

  /**
   * 设置 HUD 模式（normal / minimal）。变更时同步重排手牌（force 跳过 swap 豁免）。
   * ControlPanel 的"切换模式"按钮调用 toggleMode() 间接走到这里。
   */
  setMode(mode: HUDMode): void {
    if (!this.hud) return;
    if (this.hud.mode === mode) return;
    this.hud.setMode(mode);
    // 模式切换后：手牌可用区域 / 基准 Y 变了，必须强制重排。
    this.layoutHand({ force: true });
  }

  /** 在 normal / minimal 之间切换。 */
  toggleMode(): void {
    this.setMode(this.mode === "normal" ? "minimal" : "normal");
  }

  /**
   * 从 CONFIG.playfield 刷新手牌整体区域与牌堆世界坐标，并强制重排手牌。
   * ControlPanel 改 playfield.* 或 preset 整表载入时由 main.onChange 调用。
   * 出牌结算堆相对 handBaseY / 手牌中线，会随手牌整体移动，无需单独刷。
   */
  refreshPlayfieldLayout(): void {
    if (!this.hud) return;
    this.hud.applyPlayfield();
    this.layoutHand({ force: true });
  }

  /**
   * 从 CONFIG.world.background 同步程序化背景，并更新 renderer 清屏色。
   * ControlPanel / preset 变更时由 main.onChange 调用。
   */
  syncBackground(): void {
    this.background.syncFromConfig();
    this.applyBackgroundClearColor();
  }

  /**
   * 从 CONFIG.world.crt 同步全屏 CRT Filter。
   * 挂在 stage.filters（第一版独占，不与其它 stage filter 合并）。
   */
  syncCrt(): void {
    const c = CONFIG.world.crt;
    if (!c.enabled) {
      this.app.pixi.stage.filters = null;
      return;
    }
    this.crtFilter.resolution = c.resolution;
    this.crtFilter.applyUniforms({
      intensity: c.intensity,
      scanlineCount: c.scanlineCount,
      noiseAmount: c.noiseAmount,
      contrast: c.contrast,
      noiseSeed: 0,
    });
    this.app.pixi.stage.filters = [this.crtFilter];
  }

  /** Off 档用 backgroundColor；shader 开启时用 colour3 降低 letterbox 闪色。 */
  private applyBackgroundClearColor(): void {
    try {
      (this.app.pixi.renderer.background as unknown as { color: number }).color =
        this.background.getClearColor();
    } catch (err) {
      console.warn("[GameController] 应用背景清屏色失败：", err);
    }
  }

  /**
   * 让牌堆按当前 CONFIG.cardArt 重新渲染。
   * ControlPanel 切换牌背时调用。
   */
  refreshDeckArt(): void {
    if (this.hud) this.hud.deckView.refresh();
  }

  /**
   * 让出/弃牌按钮立即按当前配置重新计算可用状态。
   * 主要给"无限出牌/弃牌"开关在剩余次数为 0 后切换时使用，
   * 否则按钮要等下一次选牌变化才会更新。
   */
  refreshActionButtons(): void {
    this.updateButtons();
  }

  /**
   * 重新绘制所有已缓存的 CardView（含手牌 + 小丑）。
   * 保留 CardView 实例本身，避免运行时调颜色/圆角时销毁交互对象导致手牌闪没。
   */
  refreshHandArt(): void {
    if (!this.hud) return;

    for (const view of this.viewByCardId.values()) {
      view.refreshArt();
    }
    for (const view of this.jokers) {
      view.refreshArt();
    }
    // 开发面板手动 refresh：强制对齐所有牌，不豁免正在弹性的牌。
    this.layoutHand({ force: true });
    this.layoutJokers();
  }

  private async recycleSelected(): Promise<void> {
    const state = this.store.getState();
    // 按 handIndex 从左到右依次弃牌（与你的需求一致）。
    const recycling = [...state.selected].sort((a, b) => a.handIndex - b.handIndex);
    const remaining = state.hand.filter((v) => !recycling.includes(v));

    this.isPlaying = true;
    // 进入"挤位阶段"：每张牌弃出瞬间触发的剩余手牌重排走 playHandSwap（利落挤位居中）。
    this.isPlayPhaseSwapping = true;
    this.updateButtons();

    try {
      const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

      // 弃牌参数：speedRatio 同时缩放飞行时长与弃牌间隔（>1 更快）。
      const discardCfg = GameConfig.discard;
      const speedRatio = Math.max(0.01, discardCfg?.speedRatio ?? 1.0);
      const flyDurationMS = Math.max(1, GameConfig.animation.flyOutDurationMS / speedRatio);
      const intervalMS = Math.max(0, (discardCfg?.intervalMS ?? 0) / speedRatio);

      // 视觉：从左到右逐张错开飞向弃牌堆（屏幕正右方外、垂直居中），飞行途中翻约 90° 压成一条线。
      const flyPromises: Promise<void>[] = [];
      for (let i = 0; i < recycling.length; i++) {
        const v = recycling[i]!;
        v.selected = false;
        v.cardState = CardState.Normal;

        // ① 弃出瞬间：从手牌数组摘掉这张，立即让剩余手牌挤位居中重排（playHandSwap）。
        const curHand = this.store.getState().hand;
        this.store.setState({ hand: curHand.filter((c) => c !== v) });
        this.layoutHand({ force: true });

        // ② 飞出瞬间：图层置于手牌之下、但仍在阴影层之上。
        //    手牌 zIndex = 0..n-1（≥0），阴影层 zIndex = -1；取 (-1, 0) 区间的值即可。
        //    后弃出的牌略低于先弃出的牌（i 越大越靠下），但都 > -1 不会钻到阴影下。
        v.zIndex = -0.1 - i * 0.001;
        const randomRotation = this.computeDiscardRandomRotation();

        // 翻面节奏参考时长仅驱动 flip 通道；位移完全由弹性绳 setMoveTarget 完成。
        v.startDiscardFlip(flyDurationMS);
        v.beginDiscardFly();
        // 随机基角写入 moveTargetRotation；绳相对倾角在飞行中叠加，settle 后回落到基角。
        // 不 await 单张，按 intervalMS 错开发车；全部 waitSettled 后再 endDiscardFly。
        flyPromises.push(
          CardFx.flyToDiscardPile(
            this.tween,
            v,
            GameConfig.world.width,
            GameConfig.world.height,
            flyDurationMS,
            randomRotation
          )
        );
        if (i < recycling.length - 1 && intervalMS > 0) {
          await sleep(intervalMS);
        }
      }

      // 等待全部弃牌绳吸附完成（替代固定 flyDurationMS）
      await Promise.all(flyPromises);
      // 最后一张弃牌后额外等待（受 speedRatio 缩放）
      const lastCardWaitMS = Math.max(0, (discardCfg?.lastCardWaitMS ?? 0) / speedRatio);
      if (lastCardWaitMS > 0) {
        await sleep(lastCardWaitMS);
      }
      // 弃牌飞行结束：恢复速度旋转标志，避免这些 CardView 被回收复用后残留禁用态。
      for (const v of recycling) {
        v.endDiscardFly();
      }
      // 挤位阶段结束（补牌应走距离驱动归位，而非 playHandSwap 短动画）。
      this.isPlayPhaseSwapping = false;

      // 数据：放回牌堆并洗牌
      this.deck.recycle(recycling.map((v) => v.data));
      this.deck.shuffle();
      this.hud.deckView.setCount(this.deck.size);
      this.bus.emit("deck:changed", { size: this.deck.size });

      // 手牌数组已在上面逐张摘空到 remaining；这里同步选中态。
      this.store.setState({ hand: remaining, selected: [] });
      this.bus.emit("card:selectionChanged", { selected: [] });

      // 补牌并重新摆位
      await this.drawToFull();
      this.evaluateAndUpdate();
    } finally {
      this.isPlaying = false;
      this.isPlayPhaseSwapping = false;
      this.updateButtons();
    }
  }

  /**
   * 计算丢入弃牌堆时的随机旋转角度（弧度）。
   * 取值范围 [-randomRotationDeg, +randomRotationDeg]（度），翻面关闭时仍生效。
   */
  private computeDiscardRandomRotation(): number {
    const deg = Math.max(0, GameConfig.discardFlip?.randomRotationDeg ?? 0);
    if (deg <= 0) return 0;
    const r = (Math.random() * 2 - 1) * deg;
    return (r * Math.PI) / 180;
  }
}
