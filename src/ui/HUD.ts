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
 */
export interface HUDOptions {
  worldWidth: number;
  worldHeight: number;
  targetScore: number;
  plays: number;
  discards: number;
  onPlay: () => void;
  onDiscard: () => void;
}

export class HUD extends UINode {
  private readonly leftPanel: Panel;
  readonly scorePanel: ScorePanel;
  readonly playBtn: Button;
  readonly discardBtn: Button;
  readonly deckView: DeckView;

  /** 手牌可用水平区域：[left, right]（世界坐标） */
  readonly handAreaLeft: number;
  readonly handAreaRight: number;
  /** 手牌基准 Y（世界坐标） */
  readonly handBaseY: number;

  constructor(opts: HUDOptions) {
    super({ id: "hud", displayName: "HUD" });
    const { worldWidth, worldHeight } = opts;

    const sidebarWidth = 280;

    // 左侧深色面板背景
    this.leftPanel = new Panel({
      id: "hud.leftPanel",
      displayName: "左侧侧栏",
      width: sidebarWidth,
      height: worldHeight,
      fill: Theme.colors.panelDark,
      radius: 0,
    });
    this.addChild(this.leftPanel);

    // 得分面板
    this.scorePanel = new ScorePanel(opts.targetScore, opts.plays, opts.discards);
    this.addChild(this.scorePanel);

    // 底部按钮
    const playAreaCenterX = sidebarWidth + (worldWidth - sidebarWidth) / 2;
    const bottomY = worldHeight - 80;

    this.playBtn = new Button({
      id: "hud.playBtn",
      displayName: "出牌按钮",
      text: "出牌",
      width: 140,
      height: 60,
      activeColor: Theme.colors.playBtn,
      onClick: opts.onPlay,
    });
    this.playBtn.position.set(playAreaCenterX - 160, bottomY - 30);
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
    this.discardBtn.position.set(playAreaCenterX + 20, bottomY - 30);
    this.addChild(this.discardBtn);

    // 牌堆
    this.deckView = new DeckView(52);
    this.deckView.position.set(worldWidth - 120, worldHeight - 180);
    this.addChild(this.deckView);

    // 提供给 HandLayout 的世界坐标范围
    this.handAreaLeft = sidebarWidth;
    this.handAreaRight = worldWidth - 40;
    this.handBaseY = worldHeight - 250;
  }
}
