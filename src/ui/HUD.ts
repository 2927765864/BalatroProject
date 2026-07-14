import { Theme } from "./theme";
import { Panel } from "./components/Panel";
import { Button } from "./components/Button";
import { ScorePanel } from "./components/ScorePanel";
import { DeckView } from "@render/DeckView";
import { OpacityComponent, UINode } from "@ui/hierarchy";
import { CONFIG } from "@game/config";

/**
 * HUD：左侧侧栏 + 顶部小丑槽位条 + 底部按钮 + 牌堆位置
 *
 * 全部坐标基于 worldWidth/worldHeight（默认 1280×720）。
 * 子组件按需暴露，让 GameController 接管交互回调。
 *
 * 支持两种布局模式：
 *   - "normal"：完整 UI（左侧侧栏 + 得分面板 + 底部按钮 + 右下角牌堆）。
 *   - "minimal"：精简版（仅保留底部按钮 + 右下角牌堆，且按钮居中放置）。
 *
 * 切换模式由 GameController.switchMode 触发，HUD 只负责显示/位置的应用。
 *
 * jokerBar 会在 GameController.start 里 reparent 到 worldRoot（Layers.JokerBar），
 * 保证渲染在卡牌层之下，作为小丑牌的暗色底框而不挡住牌面。
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
  /** 顶部小丑牌槽位暗色长条（框） */
  readonly jokerBar: Panel;
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

    // 顶部小丑牌槽位：暗色长条框（宽度覆盖主玩法区，高度包住卡牌 140 + 内边距）
    const jokerBarMarginX = 24;
    const jokerBarHeight = 168;
    const jokerBarY = 8;
    this.jokerBar = new Panel({
      id: "hud.jokerBar",
      displayName: "小丑牌槽位条",
      width: worldWidth - this.sidebarWidth - jokerBarMarginX * 2,
      height: jokerBarHeight,
      fill: Theme.colors.jokerBar,
      radius: 14,
    });
    // 默认位姿 / 透明度仅作"代码兜底"；真正布局以 shipping / CONFIG.uiNodes 为准。
    // 组件必须在 addChild（register）之前挂好，且不要在构造期调用会
    // notify→persist 的 setter——hydrate 前的树是临时父子关系。
    this.jokerBar.position.set(this.sidebarWidth + jokerBarMarginX, jokerBarY);
    const jokerBarOpacity = new OpacityComponent();
    this.jokerBar.addComponent(jokerBarOpacity);
    // 直接 deserialize 默认值，避免 setAlpha 在 register 后触发持久化路径
    jokerBarOpacity.deserialize({ alpha: 0.72 });
    jokerBarOpacity.apply();
    this.addChild(this.jokerBar);

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

    // 牌堆（世界坐标由 CONFIG.playfield 驱动，见 applyPlayfield）
    this.deckView = new DeckView(52);
    this.addChild(this.deckView);

    // 手牌可用区域 / 按钮位置 / leftPanel & scorePanel 可见性
    // 由 applyMode 根据 mode 一次性设置。
    this.handAreaLeft = 0;
    this.handAreaRight = 0;
    this.handBaseY = 0;
    this.applyMode("normal");
  }

  /**
   * 从 CONFIG.playfield 刷新手牌区域与牌堆世界坐标。
   * 手牌水平宽度仍由 mode 决定，仅叠加 handOffsetX；Y 与牌堆位置直接读配置。
   * 出牌结算堆相对 handBaseY / 手牌中线，会随手牌整体一起移动。
   */
  applyPlayfield(): void {
    const { worldWidth } = this;
    const pf = CONFIG.playfield;
    const ox = pf.handOffsetX ?? 0;

    this.handBaseY = pf.handBaseY;

    if (this._mode === "minimal") {
      // 精简：避开右下角牌堆，围绕屏幕中线居中，再加整体水平偏移。
      this.handAreaLeft = 200 + ox;
      this.handAreaRight = worldWidth - 200 + ox;
    } else {
      this.handAreaLeft = this.sidebarWidth + ox;
      this.handAreaRight = worldWidth - 40 + ox;
    }

    // 用 TransformComponent 写入，保证 Hierarchy / persist 与运行时位置一致。
    // 注意：playfield 是牌堆位置的 SSOT；hydrate 之后也应再调一次本方法覆盖存档里的旧坐标。
    this.deckView.transform.setTransformDirect(
      pf.deckX,
      pf.deckY,
      this.deckView.rotation,
      this.deckView.scale.x,
      this.deckView.scale.y,
    );
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

    // 小丑槽位条：只随 mode 改宽度（minimal 拉满 / normal 贴主玩法区）。
    // 位置与透明度一律以 shipping / CONFIG.uiNodes 为准，禁止在这里 setTransformDirect，
    // 否则会覆盖用户 Hierarchy 微调，并在 hydrate 前污染 parentId 存档。
    const jokerBarMarginX = 24;
    const jokerBarHeight = 168;
    const jokerBarW =
      mode === "minimal"
        ? worldWidth - jokerBarMarginX * 2
        : worldWidth - this.sidebarWidth - jokerBarMarginX * 2;
    this.jokerBar.setSize(jokerBarW, jokerBarHeight);

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

      // 手牌区域 + 牌堆：见 applyPlayfield（读 CONFIG.playfield）。
    } else {
      // normal：完整布局，恢复初始可见性与位置
      this.leftPanel.visible = true;
      this.scorePanel.visible = true;

      const playAreaCenterX = this.sidebarWidth + (worldWidth - this.sidebarWidth) / 2;
      this.playBtn.position.set(playAreaCenterX - 160, mainBtnY);
      this.discardBtn.position.set(playAreaCenterX + 20, mainBtnY);
      this.sortRankBtn.position.set(playAreaCenterX - 160, sortBtnY);
      this.sortSuitBtn.position.set(playAreaCenterX + 20, sortBtnY);
    }

    this.applyPlayfield();
  }
}
