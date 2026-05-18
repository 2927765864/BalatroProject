import { Container, Graphics, Text } from "pixi.js";
import { Theme } from "../theme";
import { Panel } from "./Panel";

/**
 * 左侧得分面板
 *
 * 把"目标分 / 回合分 / 筹码×倍率 / 牌型 / 预期 / 出牌次数 / 弃牌次数"集中显示。
 * 仅暴露 set* 系列方法供 GameController 调用，自身不读 GameState。
 */
export class ScorePanel extends Container {
  private readonly scoreText: Text;
  private readonly chipsText: Text;
  private readonly multText: Text;
  private readonly handNameText: Text;
  private readonly evalScoreText: Text;
  private readonly playsText: Text;
  private readonly discardsText: Text;

  constructor(targetScore: number, plays: number, discards: number) {
    super();

    // 目标分（盲注）
    const targetPanel = new Panel({
      width: 240,
      height: 100,
      fill: Theme.colors.targetBg,
      borderColor: Theme.colors.targetBorder,
      borderWidth: 4,
    });
    targetPanel.position.set(20, 20);
    this.addChild(targetPanel);

    const targetLabel = new Text({
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

    const targetScoreText = new Text({
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
      width: 240,
      height: 60,
      fill: Theme.colors.panelBlack,
    });
    scorePanel.position.set(20, 140);
    this.addChild(scorePanel);

    const scoreLabel = new Text({
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

    this.scoreText = new Text({
      text: "0",
      style: {
        fontFamily: Theme.monoFont,
        fontSize: Theme.fontSize.value,
        fill: Theme.colors.textWhite,
        fontWeight: "bold",
      },
    });
    this.scoreText.anchor.set(1, 0);
    this.scoreText.position.set(240, 150);
    this.addChild(this.scoreText);

    // chips × mult
    const chipMultPanel = new Panel({
      width: 240,
      height: 80,
      fill: Theme.colors.panelBlack,
    });
    chipMultPanel.position.set(20, 220);
    this.addChild(chipMultPanel);

    const blueBg = new Graphics();
    blueBg.roundRect(30, 230, 95, 60, 8);
    blueBg.fill({ color: Theme.colors.blueChip });
    this.addChild(blueBg);

    const redBg = new Graphics();
    redBg.roundRect(155, 230, 95, 60, 8);
    redBg.fill({ color: Theme.colors.redMult });
    this.addChild(redBg);

    this.chipsText = new Text({
      text: "0",
      style: {
        fontFamily: Theme.monoFont,
        fontSize: Theme.fontSize.value,
        fill: Theme.colors.textWhite,
        fontWeight: "bold",
      },
    });
    this.chipsText.anchor.set(0.5);
    this.chipsText.position.set(77.5, 260);
    this.addChild(this.chipsText);

    const xLabel = new Text({
      text: "X",
      style: {
        fontFamily: Theme.monoFont,
        fontSize: Theme.fontSize.button,
        fill: Theme.colors.textWhite,
        fontWeight: "bold",
      },
    });
    xLabel.anchor.set(0.5);
    xLabel.position.set(140, 260);
    this.addChild(xLabel);

    this.multText = new Text({
      text: "0",
      style: {
        fontFamily: Theme.monoFont,
        fontSize: Theme.fontSize.value,
        fill: Theme.colors.textWhite,
        fontWeight: "bold",
      },
    });
    this.multText.anchor.set(0.5);
    this.multText.position.set(202.5, 260);
    this.addChild(this.multText);

    // 牌型 + 预期
    this.handNameText = new Text({
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

    this.evalScoreText = new Text({
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
      width: 150,
      height: 70,
      fill: Theme.colors.panelBlack,
      radius: 8,
    });
    infoPanel.position.set(110, 380);
    this.addChild(infoPanel);

    const playLabel = new Text({
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

    this.playsText = new Text({
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

    const discardLabel = new Text({
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

    this.discardsText = new Text({
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
    this.scoreText.text = String(score);
  }

  setChipsMult(chips: number, mult: number): void {
    this.chipsText.text = String(chips);
    this.multText.text = String(mult);
  }

  setHandName(name: string): void {
    this.handNameText.text = `牌型: ${name}`;
  }

  setExpectScore(score: number): void {
    this.evalScoreText.text = `本次预期: ${score}`;
  }

  setPlays(n: number): void {
    this.playsText.text = String(n);
  }

  setDiscards(n: number): void {
    this.discardsText.text = String(n);
  }
}
