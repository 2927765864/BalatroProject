import { Theme } from "./theme";
import { Panel } from "./components/Panel";
import { Button } from "./components/Button";
import { ScorePanel } from "./components/ScorePanel";
import { DeckView } from "@render/DeckView";
import { UINode } from "@ui/hierarchy";

/**
 * HUD：左侧侧栏 + 底部按钮 + 牌堆位置
 *
 * 全部坐标基于 worldWidth/worldHeight（默认 1280×720）。
 * 子组件按需暴露，让 GameController 接管交互回调。
 *
 * 支持两种布局模式：
 *   - "normal"：完整 UI（左侧侧栏 + 得分面板 + 底部按钮 + 右下角牌堆）。
 *   - "minimal"：精简版（仅保留底部按钮 + 右下角牌堆，且按钮居中放置）。
 *
 * 切换模式由 GameController.switchMode 触发，HUD 只负责显示/位置的应用。
 */
export type HUDMode = "normal" | "minimal";

export interface HUDOptions {
  worldWidth: number;
  worldHeight: number;
  targetScore: number;
  plays: number;
  discards: number;
  onPlay: () => void;
  onDiscard: () => void;
  /** 按点数理牌 */
  onSortByRank: () => void;
  /** 按花色理牌 */
  onSortBySuit: () => void;
}

export class HUD extends UINode {
  private readonly leftPanel: Panel;
  readonly scorePanel: ScorePanel;
  readonly playBtn: Button;
  readonly discardBtn: Button;
  readonly sortRankBtn: Button;
  readonly sortSuitBtn: Button;
  readonly deckView: DeckView;

  private readonly worldWidth: number;
  private readonly worldHeight: number;
  private readonly sidebarWidth = 280;

  private _mode: HUDMode = "normal";

  /** 手牌可用水平区域：[left, right]（世界坐标） */
  handAreaLeft: number;
  handAreaRight: number;
  /** 手牌基准 Y（世界坐标） */
  handBaseY: number;

  constructor(opts: HUDOptions) {
    super({ id: "hud", displayName: "HUD" });
    const { worldWidth, worldHeight } = opts;
    this.worldWidth = worldWidth;
    this.worldHeight = worldHeight;

    // 左侧深色面板背景
    this.leftPanel = new Panel({
      id: "hud.leftPanel",
      displayName: "左侧侧栏",
      width: this.sidebarWidth,
      height: worldHeight,
      fill: Theme.colors.panelDark,
      radius: 0,
    });
    this.addChild(this.leftPanel);

    // 得分面板
    this.scorePanel = new ScorePanel(opts.targetScore, opts.plays, opts.discards);
    this.addChild(this.scorePanel);

    // 底部按钮：出牌 / 弃牌
    this.playBtn = new Button({
      id: "hud.playBtn",
      displayName: "出牌按钮",
      text: "出牌",
      width: 140,
      height: 60,
      activeColor: Theme.colors.playBtn,
      onClick: opts.onPlay,
    });
    this.addChild(this.playBtn);

    this.discardBtn = new Button({
      id: "hud.discardBtn",
      displayName: "弃牌按钮",
      text: "弃牌",
      width: 140,
      height: 60,
      activeColor: Theme.colors.discardBtn,
      onClick: opts.onDiscard,
    });
    this.addChild(this.discardBtn);

    // 理牌按钮：点数 / 花色（位于出牌、弃牌正下方）
    this.sortRankBtn = new Button({
      id: "hud.sortRankBtn",
      displayName: "点数理牌按钮",
      text: "点数",
      width: 140,
      height: 40,
      activeColor: Theme.colors.sortRankBtn,
      onClick: opts.onSortByRank,
    });
    this.addChild(this.sortRankBtn);

    this.sortSuitBtn = new Button({
      id: "hud.sortSuitBtn",
      displayName: "花色理牌按钮",
      text: "花色",
      width: 140,
      height: 40,
      activeColor: Theme.colors.sortSuitBtn,
      onClick: opts.onSortBySuit,
    });
    this.addChild(this.sortSuitBtn);

    // 牌堆
    this.deckView = new DeckView(52);
    this.deckView.position.set(worldWidth - 120, worldHeight - 180);
    this.addChild(this.deckView);

    // 手牌可用区域 / 按钮位置 / leftPanel & scorePanel 可见性
    // 由 applyMode 根据 mode 一次性设置。
    this.handAreaLeft = 0;
    this.handAreaRight = 0;
    this.handBaseY = 0;
    this.applyMode("normal");
  }

  get mode(): HUDMode {
    return this._mode;
  }

  /**
   * 切换 HUD 布局模式。
   *
   * - "normal"：完整 UI；按钮位于左侧侧栏右侧的下方居中；手牌避开 leftPanel。
   * - "minimal"：精简版；隐藏 leftPanel + scorePanel；按钮居中（屏幕中央偏下）；
   *               手牌也以整个屏幕宽度为可用区域、整体居中。
   */
  setMode(mode: HUDMode): void {
    if (this._mode === mode) return;
    this.applyMode(mode);
  }

  private applyMode(mode: HUDMode): void {
    this._mode = mode;
    const { worldWidth, worldHeight } = this;

    // 主按钮 60h + 间距 8 + 理牌按钮 40h → 底部区域总高约 108。
    // 主按钮顶边放在 worldHeight - 120，理牌按钮顶边 = 主按钮底 + 8。
    const mainBtnH = 60;
    const btnGap = 8;
    const mainBtnY = worldHeight - 120;
    const sortBtnY = mainBtnY + mainBtnH + btnGap;

    if (mode === "minimal") {
      // 隐藏完整 UI 部件
      this.leftPanel.visible = false;
      this.scorePanel.visible = false;

      // 按钮居中：以屏幕宽度的中线为中心，左右对称排布。
      const centerX = worldWidth / 2;
      // 两个 140×60 按钮，中间留 40px 间距 → 总宽 320，左右各偏 160。
      this.playBtn.position.set(centerX - 160, mainBtnY);
      this.discardBtn.position.set(centerX + 20, mainBtnY);
      this.sortRankBtn.position.set(centerX - 160, sortBtnY);
      this.sortSuitBtn.position.set(centerX + 20, sortBtnY);

      // 手牌区域：避开右下角牌堆所在水平区间，整体围绕屏幕水平中线居中。
      // 牌堆位于 (worldWidth-120, worldHeight-180)，半宽 ≈ 60，
      // 因此手牌右边界保守取 worldWidth - 200，左边界对称取 200，使中线对齐 worldWidth/2。
      this.handAreaLeft = 200;
      this.handAreaRight = worldWidth - 200;
      this.handBaseY = worldHeight - 250;
    } else {
      // normal：完整布局，恢复初始可见性与位置
      this.leftPanel.visible = true;
      this.scorePanel.visible = true;

      const playAreaCenterX = this.sidebarWidth + (worldWidth - this.sidebarWidth) / 2;
      this.playBtn.position.set(playAreaCenterX - 160, mainBtnY);
      this.discardBtn.position.set(playAreaCenterX + 20, mainBtnY);
      this.sortRankBtn.position.set(playAreaCenterX - 160, sortBtnY);
      this.sortSuitBtn.position.set(playAreaCenterX + 20, sortBtnY);

      this.handAreaLeft = this.sidebarWidth;
      this.handAreaRight = worldWidth - 40;
      this.handBaseY = worldHeight - 250;
    }
  }
}
