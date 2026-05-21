import { Theme } from "../theme";
import { Panel, PanelBackground } from "./Panel";
import { UINode } from "@ui/hierarchy";
import { UIText } from "./UIText";

/**
 * 左侧得分面板
 *
 * 把"目标分 / 回合分 / 筹码×倍率 / 牌型 / 预期 / 出牌次数 / 弃牌次数"集中显示。
 * 仅暴露 set* 系列方法供 GameController 调用，自身不读 GameState。
 *
 * 内部每段文字都包成 UIText，确保它们在调参面板的 Hierarchy 树里
 * 各自占一个条目，能独立调位置 / 改文案。
 */
export class ScorePanel extends UINode {
  private readonly scoreText: UIText;
  private readonly chipsText: UIText;
  private readonly multText: UIText;
  private readonly handNameText: UIText;
  private readonly evalScoreText: UIText;
  private readonly playsText: UIText;
  private readonly discardsText: UIText;

  constructor(targetScore: number, plays: number, discards: number) {
    super({ id: "hud.scorePanel", displayName: "得分面板" });

    // 目标分（盲注）
    const targetPanel = new Panel({
      id: "hud.scorePanel.targetPanel",
      displayName: "目标分背板",
      width: 240,
      height: 100,
      fill: Theme.colors.targetBg,
      borderColor: Theme.colors.targetBorder,
      borderWidth: 4,
    });
    targetPanel.position.set(20, 20);
    this.addChild(targetPanel);

    const targetLabel = new UIText({
      id: "hud.scorePanel.targetLabel",
      displayName: "目标分标签",
      text: "至少得分",
      style: {
        fontFamily: Theme.fontFamily,
        fontSize: Theme.fontSize.label,
        fill: Theme.colors.textWhite,
        fontWeight: "bold",
      },
    });
    targetLabel.position.set(120, 30);
    this.addChild(targetLabel);

    const targetScoreText = new UIText({
      id: "hud.scorePanel.targetScoreText",
      displayName: "目标分数字",
      text: String(targetScore),
      style: {
        fontFamily: Theme.monoFont,
        fontSize: Theme.fontSize.big,
        fill: Theme.colors.danger,
        fontWeight: "bold",
      },
    });
    targetScoreText.position.set(120, 55);
    this.addChild(targetScoreText);

    // 回合分数
    const scorePanel = new Panel({
      id: "hud.scorePanel.roundScorePanel",
      displayName: "回合分背板",
      width: 240,
      height: 60,
      fill: Theme.colors.panelBlack,
    });
    scorePanel.position.set(20, 140);
    this.addChild(scorePanel);

    const scoreLabel = new UIText({
      id: "hud.scorePanel.scoreLabel",
      displayName: "回合分标签",
      text: "回合分数",
      style: {
        fontFamily: Theme.fontFamily,
        fontSize: Theme.fontSize.label,
        fill: Theme.colors.textWhite,
        fontWeight: "bold",
      },
    });
    scoreLabel.position.set(30, 150);
    this.addChild(scoreLabel);

    this.scoreText = new UIText({
      id: "hud.scorePanel.scoreText",
      displayName: "回合分数字",
      text: "0",
      style: {
        fontFamily: Theme.monoFont,
        fontSize: Theme.fontSize.value,
        fill: Theme.colors.textWhite,
        fontWeight: "bold",
      },
    });
    this.scoreText.setAnchor(1, 0);
    this.scoreText.position.set(240, 150);
    this.addChild(this.scoreText);

    // chips × mult
    const chipMultPanel = new Panel({
      id: "hud.scorePanel.chipMultPanel",
      displayName: "筹码倍率背板",
      width: 240,
      height: 80,
      fill: Theme.colors.panelBlack,
    });
    chipMultPanel.position.set(20, 220);
    this.addChild(chipMultPanel);

    const blueBg = new PanelBackground({
      id: "hud.scorePanel.chipBg",
      displayName: "筹码底",
      width: 95,
      height: 60,
      fill: Theme.colors.blueChip,
      radius: 8,
    });
    blueBg.position.set(30, 230);
    this.addChild(blueBg);

    const redBg = new PanelBackground({
      id: "hud.scorePanel.multBg",
      displayName: "倍率底",
      width: 95,
      height: 60,
      fill: Theme.colors.redMult,
      radius: 8,
    });
    redBg.position.set(155, 230);
    this.addChild(redBg);

    this.chipsText = new UIText({
      id: "hud.scorePanel.chipsText",
      displayName: "筹码数字",
      text: "0",
      style: {
        fontFamily: Theme.monoFont,
        fontSize: Theme.fontSize.value,
        fill: Theme.colors.textWhite,
        fontWeight: "bold",
      },
    });
    this.chipsText.setAnchor(0.5);
    this.chipsText.position.set(77.5, 260);
    this.addChild(this.chipsText);

    const xLabel = new UIText({
      id: "hud.scorePanel.xLabel",
      displayName: "乘号",
      text: "X",
      style: {
        fontFamily: Theme.monoFont,
        fontSize: Theme.fontSize.button,
        fill: Theme.colors.textWhite,
        fontWeight: "bold",
      },
    });
    xLabel.setAnchor(0.5);
    xLabel.position.set(140, 260);
    this.addChild(xLabel);

    this.multText = new UIText({
      id: "hud.scorePanel.multText",
      displayName: "倍率数字",
      text: "0",
      style: {
        fontFamily: Theme.monoFont,
        fontSize: Theme.fontSize.value,
        fill: Theme.colors.textWhite,
        fontWeight: "bold",
      },
    });
    this.multText.setAnchor(0.5);
    this.multText.position.set(202.5, 260);
    this.addChild(this.multText);

    // 牌型 + 预期
    this.handNameText = new UIText({
      id: "hud.scorePanel.handNameText",
      displayName: "牌型文字",
      text: "牌型: 无",
      style: {
        fontFamily: Theme.fontFamily,
        fontSize: 18,
        fill: Theme.colors.textSubtle,
        fontWeight: "bold",
      },
    });
    this.handNameText.position.set(30, 310);
    this.addChild(this.handNameText);

    this.evalScoreText = new UIText({
      id: "hud.scorePanel.evalScoreText",
      displayName: "预期得分文字",
      text: "预计获得: 0",
      style: {
        fontFamily: Theme.fontFamily,
        fontSize: Theme.fontSize.label,
        fill: Theme.colors.textMuted,
        fontWeight: "bold",
      },
    });
    this.evalScoreText.position.set(30, 340);
    this.addChild(this.evalScoreText);

    // 出牌 / 弃牌次数
    const infoPanel = new Panel({
      id: "hud.scorePanel.infoPanel",
      displayName: "出弃次数背板",
      width: 150,
      height: 70,
      fill: Theme.colors.panelBlack,
      radius: 8,
    });
    infoPanel.position.set(110, 380);
    this.addChild(infoPanel);

    const playLabel = new UIText({
      id: "hud.scorePanel.playLabel",
      displayName: "出牌标签",
      text: "出牌",
      style: {
        fontFamily: Theme.fontFamily,
        fontSize: 14,
        fill: Theme.colors.textWhite,
        fontWeight: "bold",
      },
    });
    playLabel.position.set(130, 385);
    this.addChild(playLabel);

    this.playsText = new UIText({
      id: "hud.scorePanel.playsText",
      displayName: "出牌次数",
      text: String(plays),
      style: {
        fontFamily: Theme.monoFont,
        fontSize: Theme.fontSize.value,
        fill: Theme.colors.playCount,
        fontWeight: "bold",
      },
    });
    this.playsText.position.set(135, 410);
    this.addChild(this.playsText);

    const discardLabel = new UIText({
      id: "hud.scorePanel.discardLabel",
      displayName: "弃牌标签",
      text: "弃牌",
      style: {
        fontFamily: Theme.fontFamily,
        fontSize: 14,
        fill: Theme.colors.textWhite,
        fontWeight: "bold",
      },
    });
    discardLabel.position.set(205, 385);
    this.addChild(discardLabel);

    this.discardsText = new UIText({
      id: "hud.scorePanel.discardsText",
      displayName: "弃牌次数",
      text: String(discards),
      style: {
        fontFamily: Theme.monoFont,
        fontSize: Theme.fontSize.value,
        fill: Theme.colors.discardCount,
        fontWeight: "bold",
      },
    });
    this.discardsText.position.set(210, 410);
    this.addChild(this.discardsText);
  }

  setTotalScore(score: number): void {
    this.scoreText.setText(String(score));
  }

  setChipsMult(chips: number, mult: number): void {
    this.chipsText.setText(String(chips));
    this.multText.setText(String(mult));
  }

  setHandName(name: string): void {
    this.handNameText.setText(`牌型: ${name}`);
  }

  setExpectScore(score: number): void {
    this.evalScoreText.setText(`本次预期: ${score}`);
  }

  setPlays(n: number): void {
    this.playsText.setText(String(n));
  }

  setDiscards(n: number): void {
    this.discardsText.setText(String(n));
  }
}
