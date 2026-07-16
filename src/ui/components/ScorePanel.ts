import { Graphics, Sprite } from "pixi.js";
import { Theme } from "../theme";
import { GameFonts } from "../fonts";
import { Panel, PanelBackground } from "./Panel";
import { Button } from "./Button";
import { BlindChipBadge } from "./BlindChipBadge";
import { UINode, BounceTextComponent, TextJitterComponent } from "@ui/hierarchy";
import { UIText } from "./UIText";
import { assets } from "@core/AssetManager";

/**
 * 左侧得分 / 盲注 / 比赛信息面板（严格对照 Balatro 左侧 UI 参考图）
 *
 * 层级（父子关系 = Hierarchy 树，也是渲染父先子后）：
 *
 * hud.scorePanel（得分面板）
 * ├── blindSection（盲注区外底：近黑，包住标题+内容卡）
 * │   ├── titleBar（蓝标题「小盲注」）
 * │   └── contentCard（深蓝内容卡底）→ badge / targetBox
 * ├── roundScoreSection（回合分区外底：暗色底，包住标签+分值条）
 * │   ├── scoreLabel
 * │   └── scoreBar（灰分值条）→ chip + scoreText
 * ├── chipMultSection（近黑大底）
 * └── matchInfoSection
 *     ├── playsBox / discardsBox / anteBox / roundBox（暗黑底 + 灰数字底）
 *     └── moneyBox（暗黑底 + 灰金额底 + $4）
 *
 * 子面板用分层填色做「底」，不加描边。
 * 侧栏外壳在 HUD.leftPanel。
 */

const CONTENT_W = 248;
const PAD_X = 16;
/** 子模块圆角 */
const SECTION_R = 10;
/** 内嵌小框圆角 */
const INSET_R = 8;

// ---- 筹码小图标：优先 chips.png 第一行第一列；素材未就绪时回退矢量 ----------
//
//   chipIcon
//   └── sprite | disc/ring/center/ticks

/** 单色矢量叶子：几何白底，颜色用 tint 直接指定。 */
class MonoShapeNode extends UINode {
  readonly g = new Graphics();

  constructor(id: string, displayName: string, color: number) {
    super({ id, displayName });
    this.g.label = "shape";
    this.g.tint = color & 0xffffff;
    this.addChild(this.g);
  }
}

class ChipIcon extends UINode {
  constructor(id: string, size = 18) {
    super({ id, displayName: "筹码图标" });

    const tex = assets.getUiChipTexture();
    if (tex) {
      const sprite = new Sprite(tex);
      sprite.label = "chipSprite";
      sprite.width = size;
      sprite.height = size;
      this.addChild(sprite);
      return;
    }

    // 贴图未加载时的程序化回退（与旧版同款白筹码几何）
    const r = size / 2;

    const disc = new MonoShapeNode(`${id}.disc`, "外圆", 0xffffff);
    disc.g.circle(r, r, r);
    disc.g.fill({ color: 0xffffff });
    this.addChild(disc);

    const ring = new MonoShapeNode(`${id}.ring`, "内环", 0xd8d8d8);
    ring.g.circle(r, r, r * 0.72);
    ring.g.stroke({ width: Math.max(1.5, size * 0.12), color: 0xffffff });
    this.addChild(ring);

    const center = new MonoShapeNode(`${id}.center`, "中心", 0xe8e8e8);
    center.g.circle(r, r, r * 0.28);
    center.g.fill({ color: 0xffffff });
    this.addChild(center);

    const ticks = new MonoShapeNode(`${id}.ticks`, "刻度", 0xc8c8c8);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const x0 = r + Math.cos(a) * r * 0.55;
      const y0 = r + Math.sin(a) * r * 0.55;
      const x1 = r + Math.cos(a) * r * 0.88;
      const y1 = r + Math.sin(a) * r * 0.88;
      ticks.g.moveTo(x0, y0);
      ticks.g.lineTo(x1, y1);
      ticks.g.stroke({ width: 1.2, color: 0xffffff });
    }
    this.addChild(ticks);
  }
}

export class ScorePanel extends UINode {
  private readonly scoreText: UIText;
  private readonly chipsText: UIText;
  private readonly multText: UIText;
  private readonly handNameText: UIText;
  private readonly evalScoreText: UIText;
  private readonly playsText: UIText;
  private readonly discardsText: UIText;
  private readonly moneyText: UIText;
  private readonly anteText: UIText;
  private readonly roundText: UIText;
  private readonly targetScoreText: UIText;
  private readonly rewardText: UIText;
  private readonly blindTitleText: UIText;

  private readonly chipsJitterComp: TextJitterComponent;
  private readonly chipsBounceComp: BounceTextComponent;
  private readonly multBounceComp: BounceTextComponent;
  private readonly handNameBounceComp: BounceTextComponent;
  private readonly evalScoreBounceComp: BounceTextComponent;

  /**
   * 盲注徽章归位锚点（留在 contentCard 内，供 UI 编辑与世界坐标同步）。
   * 真正的可交互徽章运行时会被提到 cardLayer，高于 UI。
   */
  readonly blindChipHomeAnchor: UINode;
  /** 盲注徽章本体（交互 / 伪3D / 阴影）；挂载由 GameController 负责。 */
  readonly blindChipBadge: BlindChipBadge;

  constructor(targetScore: number, plays: number, discards: number) {
    super({ id: "hud.scorePanel", displayName: "得分面板" });

    // ============================================================
    // 1. 盲注区：近黑外底 → 蓝标题 + 深蓝内容卡（徽章 / 目标）
    //    对照参考图：内容卡为独立深蓝底，标题与内容卡之间细缝露出外底。
    // ============================================================
    const titleH = 38;
    const titleInset = 6;
    const contentGap = 4; // 标题与内容卡之间的缝（露出外底）
    const contentH = 112;
    const bottomPad = 6;
    const blindH =
      titleInset + titleH + contentGap + contentH + bottomPad;
    const blindSection = new Panel({
      id: "hud.scorePanel.blindSection",
      displayName: "盲注区",
      width: CONTENT_W,
      height: blindH,
      fill: Theme.colors.blindOuter,
      radius: SECTION_R,
    });
    blindSection.position.set(PAD_X, 18);
    this.addChild(blindSection);

    // 1.1 标题栏「小盲注」：叠在外底顶部（略内缩，露出外底圆角）
    const titleBar = new Panel({
      id: "hud.scorePanel.blindSection.titleBar",
      displayName: "标题栏",
      width: CONTENT_W - titleInset * 2,
      height: titleH,
      fill: Theme.colors.blindTitle,
      radius: SECTION_R - 2,
    });
    titleBar.position.set(titleInset, titleInset);
    blindSection.addChild(titleBar);

    this.blindTitleText = new UIText({
      id: "hud.scorePanel.blindSection.titleText",
      displayName: "盲注标题",
      text: "小盲注",
      style: {
        fontFamily: Theme.fontFamily,
        fontSize: 22,
        fill: Theme.colors.textWhite,
        fontWeight: "bold",
      },
    });
    this.blindTitleText.setAnchor(0.5);
    this.blindTitleText.position.set((CONTENT_W - titleInset * 2) / 2, titleH / 2);
    titleBar.addChild(this.blindTitleText);

    // 1.2 深蓝内容卡：参考图箭头所指的深蓝色底，承载徽章 + 目标框
    const contentY = titleInset + titleH + contentGap;
    const contentCard = new Panel({
      id: "hud.scorePanel.blindSection.contentCard",
      displayName: "内容卡",
      width: CONTENT_W - titleInset * 2,
      height: contentH,
      fill: Theme.colors.blindCard,
      radius: SECTION_R - 2,
    });
    contentCard.position.set(titleInset, contentY);
    blindSection.addChild(contentCard);

    const contentInnerW = CONTENT_W - titleInset * 2;

    // 1.2.1 盲注徽章锚点 + 徽章本体
    //   - home 锚点留在 contentCard，记录归位圆心（UI hierarchy / shipping 可调）
    //   - badge 初始挂 contentCard，GameController.start 后 reparent 到 cardLayer（高于 UI）
    //   - 交互对齐手牌：拖拽/回正/伪3D/阴影；不可选中、不出牌
    const badgeSize = 72;
    const badgeHomeX = 10 + badgeSize / 2;
    const badgeHomeY = contentH / 2;
    this.blindChipHomeAnchor = new UINode({
      id: "hud.scorePanel.blindSection.badgeHome",
      displayName: "盲注徽章锚点",
    });
    this.blindChipHomeAnchor.eventMode = "none";
    this.blindChipHomeAnchor.position.set(badgeHomeX, badgeHomeY);
    contentCard.addChild(this.blindChipHomeAnchor);

    this.blindChipBadge = new BlindChipBadge({
      id: "hud.scorePanel.blindSection.badge",
      displayName: "盲注徽章",
      size: badgeSize,
    });
    this.blindChipBadge.setHome(badgeHomeX, badgeHomeY, { snap: true });
    contentCard.addChild(this.blindChipBadge);

    // 1.2.2 目标信息框：近黑内底
    const targetBoxW = 140;
    const targetBoxH = 88;
    const targetBox = new Panel({
      id: "hud.scorePanel.blindSection.targetBox",
      displayName: "目标信息框",
      width: targetBoxW,
      height: targetBoxH,
      fill: Theme.colors.panelInset,
      radius: INSET_R,
    });
    targetBox.position.set(
      contentInnerW - targetBoxW - 10,
      (contentH - targetBoxH) / 2,
    );
    contentCard.addChild(targetBox);

    const minScoreLabel = new UIText({
      id: "hud.scorePanel.blindSection.minScoreLabel",
      displayName: "至少得分标签",
      text: "至少得分",
      style: {
        fontFamily: Theme.fontFamily,
        fontSize: 13,
        fill: Theme.colors.textWhite,
        fontWeight: "bold",
      },
    });
    minScoreLabel.setAnchor(0.5, 0);
    minScoreLabel.position.set(targetBoxW / 2, 8);
    targetBox.addChild(minScoreLabel);

    const targetScoreRow = new UINode({
      id: "hud.scorePanel.blindSection.targetScoreRow",
      displayName: "目标分行",
    });
    targetScoreRow.position.set(targetBoxW / 2, 36);
    targetBox.addChild(targetScoreRow);

    const targetChip = new ChipIcon("hud.scorePanel.blindSection.targetChip", 18);
    targetChip.position.set(-48, -9);
    targetScoreRow.addChild(targetChip);

    this.targetScoreText = new UIText({
      id: "hud.scorePanel.blindSection.targetScoreText",
      displayName: "目标分数字",
      text: String(targetScore),
      style: {
        fontFamily: GameFonts.textFxStack,
        fontSize: 28,
        fill: Theme.colors.danger,
        fontWeight: "bold",
      },
    });
    this.targetScoreText.setAnchor(0, 0.5);
    this.targetScoreText.position.set(-24, 0);
    targetScoreRow.addChild(this.targetScoreText);

    this.rewardText = new UIText({
      id: "hud.scorePanel.blindSection.rewardText",
      displayName: "奖励文字",
      text: "奖励: $$$",
      style: {
        fontFamily: GameFonts.textFxStack,
        fontSize: 14,
        fill: Theme.colors.rewardYellow,
        fontWeight: "bold",
      },
    });
    this.rewardText.setAnchor(0.5, 0);
    this.rewardText.position.set(targetBoxW / 2, 62);
    targetBox.addChild(this.rewardText);

    // ============================================================
    // 2. 回合分数区：外底包住「回合分数」标签 + 分值条
    // ============================================================
    const roundScoreH = 52;
    const roundScoreSection = new Panel({
      id: "hud.scorePanel.roundScoreSection",
      displayName: "回合分数区",
      width: CONTENT_W,
      height: roundScoreH,
      fill: Theme.colors.panelInset,
      radius: SECTION_R,
    });
    roundScoreSection.position.set(PAD_X, 18 + blindH + 12);
    this.addChild(roundScoreSection);

    const scoreLabel = new UIText({
      id: "hud.scorePanel.roundScoreSection.scoreLabel",
      displayName: "回合分标签",
      text: "回合\n分数",
      style: {
        fontFamily: Theme.fontFamily,
        fontSize: 15,
        fill: Theme.colors.textWhite,
        fontWeight: "bold",
        align: "center",
        lineHeight: 17,
      },
    });
    scoreLabel.setAnchor(0.5, 0.5);
    scoreLabel.position.set(30, roundScoreH / 2);
    roundScoreSection.addChild(scoreLabel);

    // 分值条：灰底，叠在外底上
    const scoreBar = new Panel({
      id: "hud.scorePanel.roundScoreSection.scoreBar",
      displayName: "分值条",
      width: 178,
      height: 40,
      fill: Theme.colors.valueBg,
      radius: INSET_R,
    });
    scoreBar.position.set(62, (roundScoreH - 40) / 2);
    roundScoreSection.addChild(scoreBar);

    const scoreChip = new ChipIcon("hud.scorePanel.roundScoreSection.chipIcon", 18);
    scoreChip.position.set(16, 11);
    scoreBar.addChild(scoreChip);

    this.scoreText = new UIText({
      id: "hud.scorePanel.roundScoreSection.scoreText",
      displayName: "回合分数字",
      text: "0",
      style: {
        fontFamily: Theme.monoFont,
        fontSize: 28,
        fill: Theme.colors.textWhite,
        fontWeight: "bold",
      },
    });
    this.scoreText.setAnchor(0, 0.5);
    this.scoreText.position.set(44, 20);
    scoreBar.addChild(this.scoreText);

    // ============================================================
    // 3. 筹码 × 倍率区：大块近黑底框（红箭头中部右侧指向的大空区）
    //    上方留白供牌型 / 预期得分，下方放 0 × 0
    // ============================================================
    // 大块近黑底，无描边；0×0 贴下沿
    const chipMultH = 148;
    const chipMultY =
      18 + blindH + 12 + roundScoreH + 12;
    const chipMultSection = new Panel({
      id: "hud.scorePanel.chipMultSection",
      displayName: "筹码倍率区",
      width: CONTENT_W,
      height: chipMultH,
      fill: Theme.colors.chipMultFrame,
      radius: SECTION_R,
    });
    chipMultSection.position.set(PAD_X, chipMultY);
    this.addChild(chipMultSection);

    // 牌型 / 预期分：底框上半居中（默认隐藏）
    this.handNameText = new UIText({
      id: "hud.scorePanel.chipMultSection.handNameText",
      displayName: "牌型文字",
      text: "",
      style: {
        fontFamily: Theme.fontFamily,
        fontSize: 20,
        fill: Theme.colors.textWhite,
        fontWeight: "bold",
      },
    });
    this.handNameText.visible = false;
    this.handNameText.setAnchor(0.5, 0.5);
    this.handNameText.position.set(CONTENT_W / 2, 36);
    this.handNameBounceComp = new BounceTextComponent("handNameBounce");
    this.handNameText.addComponent(this.handNameBounceComp);
    chipMultSection.addChild(this.handNameText);

    this.evalScoreText = new UIText({
      id: "hud.scorePanel.chipMultSection.evalScoreText",
      displayName: "预期得分文字",
      text: "0",
      style: {
        fontFamily: Theme.monoFont,
        fontSize: 22,
        fill: Theme.colors.textWhite,
        fontWeight: "bold",
      },
    });
    this.evalScoreText.visible = false;
    this.evalScoreText.setAnchor(0.5, 0.5);
    this.evalScoreText.position.set(CONTENT_W / 2, 14);
    this.evalScoreBounceComp = new BounceTextComponent("evalScoreBounce");
    this.evalScoreText.addComponent(this.evalScoreBounceComp);
    chipMultSection.addChild(this.evalScoreText);

    const chipBoxW = 100;
    const chipBoxH = 56;
    const multBoxW = 100;
    const multBoxH = 56;
    const gapCenter = CONTENT_W / 2;
    // 0×0 贴底框下沿，与参考图一致
    const chipsRowY = chipMultH - chipBoxH - 14;

    const chipBg = new PanelBackground({
      id: "hud.scorePanel.chipMultSection.chipBg",
      displayName: "筹码底",
      width: chipBoxW,
      height: chipBoxH,
      fill: Theme.colors.blueChip,
      radius: 12,
    });
    chipBg.position.set(gapCenter - chipBoxW - 18, chipsRowY);
    chipMultSection.addChild(chipBg);

    this.chipsText = new UIText({
      id: "hud.scorePanel.chipMultSection.chipsText",
      displayName: "筹码数字",
      text: "0",
      style: {
        fontFamily: Theme.monoFont,
        fontSize: 32,
        fill: Theme.colors.textWhite,
        fontWeight: "bold",
      },
    });
    // 右对齐：最右位钉在蓝框靠 X 一侧，位数增加时向左扩展
    // position.x = chipBg 右缘内缩（默认兜底；shipping 可覆盖 transform）
    this.chipsText.setAnchor(1, 0.5);
    this.chipsText.position.set(
      gapCenter - 18 - 12,
      chipsRowY + chipBoxH / 2,
    );
    // 先挂常态抖动，再挂触发式弹弹（底噪 + 脉冲）。
    this.chipsJitterComp = new TextJitterComponent("textJitter");
    this.chipsText.addComponent(this.chipsJitterComp);
    this.chipsBounceComp = new BounceTextComponent("chipsBounce");
    this.chipsText.addComponent(this.chipsBounceComp);
    chipMultSection.addChild(this.chipsText);

    const xLabel = new UIText({
      id: "hud.scorePanel.chipMultSection.xLabel",
      displayName: "乘号",
      text: "X",
      style: {
        fontFamily: Theme.monoFont,
        fontSize: 26,
        fill: Theme.colors.textWhite,
        fontWeight: "bold",
      },
    });
    xLabel.setAnchor(0.5);
    xLabel.position.set(gapCenter, chipsRowY + chipBoxH / 2);
    chipMultSection.addChild(xLabel);

    const multBg = new PanelBackground({
      id: "hud.scorePanel.chipMultSection.multBg",
      displayName: "倍率底",
      width: multBoxW,
      height: multBoxH,
      fill: Theme.colors.redMult,
      radius: 12,
    });
    multBg.position.set(gapCenter + 18, chipsRowY);
    chipMultSection.addChild(multBg);

    this.multText = new UIText({
      id: "hud.scorePanel.chipMultSection.multText",
      displayName: "倍率数字",
      text: "0",
      style: {
        fontFamily: Theme.monoFont,
        fontSize: 32,
        fill: Theme.colors.textWhite,
        fontWeight: "bold",
      },
    });
    // 左对齐：最左位钉在红框靠 X 一侧，位数增加时向右扩展
    // position.x = multBg 左缘内缩（默认兜底；shipping 可覆盖 transform）
    this.multText.setAnchor(0, 0.5);
    this.multText.position.set(
      gapCenter + 18 + 12,
      chipsRowY + multBoxH / 2,
    );
    this.multBounceComp = new BounceTextComponent("multBounce");
    this.multText.addComponent(this.multBounceComp);
    chipMultSection.addChild(this.multText);

    // ============================================================
    // 4. 比赛信息区
    // ============================================================
    const matchInfoSection = new UINode({
      id: "hud.scorePanel.matchInfoSection",
      displayName: "比赛信息区",
    });
    matchInfoSection.position.set(PAD_X, chipMultY + chipMultH + 14);
    this.addChild(matchInfoSection);

    const sideBtnW = 72;
    const sideBtnH = 72;
    const rightColX = 86;
    const statBoxW = 76;
    const statBoxH = 58;
    const statGap = 8;

    // 4.1 比赛信息按钮（红）
    const runInfoBtn = new Button({
      id: "hud.scorePanel.matchInfoSection.runInfoBtn",
      displayName: "比赛信息按钮",
      text: "比赛\n信息",
      width: sideBtnW,
      height: sideBtnH,
      activeColor: Theme.colors.runInfoBtn,
      onClick: () => {
        /* 预留：打开比赛信息 */
      },
    });
    // 覆盖按钮默认字号，两行竖排更贴近参考图
    runInfoBtn.position.set(0, 0);
    matchInfoSection.addChild(runInfoBtn);
    this.restyleSideButtonLabel(runInfoBtn, 16);

    // 4.2 出牌 / 弃牌：暗黑底 + 标签 + 灰数字底 + 数字（无描边）
    const playsBuilt = this.buildLabeledValueBox({
      id: "hud.scorePanel.matchInfoSection.playsBox",
      displayName: "出牌框",
      labelId: "hud.scorePanel.matchInfoSection.playLabel",
      labelName: "出牌标签",
      label: "出牌",
      valueId: "hud.scorePanel.matchInfoSection.playsText",
      valueName: "出牌次数",
      value: String(plays),
      valueColor: Theme.colors.playCount,
      width: statBoxW,
      height: statBoxH,
    });
    playsBuilt.box.position.set(rightColX, 0);
    matchInfoSection.addChild(playsBuilt.box);
    this.playsText = playsBuilt.valueText;

    const discardsBuilt = this.buildLabeledValueBox({
      id: "hud.scorePanel.matchInfoSection.discardsBox",
      displayName: "弃牌框",
      labelId: "hud.scorePanel.matchInfoSection.discardLabel",
      labelName: "弃牌标签",
      label: "弃牌",
      valueId: "hud.scorePanel.matchInfoSection.discardsText",
      valueName: "弃牌次数",
      value: String(discards),
      valueColor: Theme.colors.discardCount,
      width: statBoxW,
      height: statBoxH,
    });
    discardsBuilt.box.position.set(rightColX + statBoxW + statGap, 0);
    matchInfoSection.addChild(discardsBuilt.box);
    this.discardsText = discardsBuilt.valueText;

    // 4.3 金钱：暗黑外底 + 灰金额底 + $4（与出牌同构分层）
    const moneyBoxW = statBoxW * 2 + statGap;
    const moneyBoxH = 40;
    const moneyBox = new Panel({
      id: "hud.scorePanel.matchInfoSection.moneyBox",
      displayName: "金钱框",
      width: moneyBoxW,
      height: moneyBoxH,
      fill: Theme.colors.panelInset,
      radius: INSET_R,
    });
    moneyBox.position.set(rightColX, 66);
    matchInfoSection.addChild(moneyBox);

    const moneyPad = 4;
    const moneyValueBg = new Panel({
      id: "hud.scorePanel.matchInfoSection.moneyBox.valueBg",
      displayName: "金额灰底",
      width: moneyBoxW - moneyPad * 2,
      height: moneyBoxH - moneyPad * 2,
      fill: Theme.colors.valueBg,
      radius: 6,
    });
    moneyValueBg.position.set(moneyPad, moneyPad);
    moneyBox.addChild(moneyValueBg);

    this.moneyText = new UIText({
      id: "hud.scorePanel.matchInfoSection.moneyText",
      displayName: "金钱数字",
      text: "$4",
      style: {
        fontFamily: Theme.monoFont,
        fontSize: 26,
        fill: Theme.colors.moneyYellow,
        fontWeight: "bold",
      },
    });
    this.moneyText.setAnchor(0.5);
    this.moneyText.position.set(
      (moneyBoxW - moneyPad * 2) / 2,
      (moneyBoxH - moneyPad * 2) / 2,
    );
    moneyValueBg.addChild(this.moneyText);

    // 4.4 选项按钮（橙）
    const optionsBtn = new Button({
      id: "hud.scorePanel.matchInfoSection.optionsBtn",
      displayName: "选项按钮",
      text: "选项",
      width: sideBtnW,
      height: sideBtnH,
      activeColor: Theme.colors.optionsBtn,
      onClick: () => {
        /* 预留：打开选项 */
      },
    });
    optionsBtn.position.set(0, 116);
    matchInfoSection.addChild(optionsBtn);
    this.restyleSideButtonLabel(optionsBtn, 18);

    // 4.5 底注 / 回合：同出牌结构（暗黑底 + 灰数字底）；数字用普通字
    const anteBuilt = this.buildLabeledValueBox({
      id: "hud.scorePanel.matchInfoSection.anteBox",
      displayName: "底注框",
      labelId: "hud.scorePanel.matchInfoSection.anteLabel",
      labelName: "底注标签",
      label: "底注",
      valueId: "hud.scorePanel.matchInfoSection.anteText",
      valueName: "底注数字",
      value: "1/8",
      valueColor: Theme.colors.textWhite,
      width: statBoxW,
      height: statBoxH,
      valueFontSize: 22,
      valueFontFamily: GameFonts.textFxStack,
    });
    anteBuilt.box.position.set(rightColX, 116);
    matchInfoSection.addChild(anteBuilt.box);
    this.anteText = anteBuilt.valueText;

    const roundBuilt = this.buildLabeledValueBox({
      id: "hud.scorePanel.matchInfoSection.roundBox",
      displayName: "回合框",
      labelId: "hud.scorePanel.matchInfoSection.roundLabel",
      labelName: "回合标签",
      label: "回合",
      valueId: "hud.scorePanel.matchInfoSection.roundText",
      valueName: "回合数字",
      value: "1",
      valueColor: Theme.colors.optionsBtn,
      width: statBoxW,
      height: statBoxH,
      valueFontFamily: GameFonts.textFxStack,
    });
    roundBuilt.box.position.set(rightColX + statBoxW + statGap, 116);
    matchInfoSection.addChild(roundBuilt.box);
    this.roundText = roundBuilt.valueText;
  }

  /**
   * 原版小统计格：
   *   暗黑底 → 标签「出牌」→ 灰底 → 数字「5」
   * 无描边，层次只靠填色。
   */
  private buildLabeledValueBox(opts: {
    id: string;
    displayName: string;
    labelId: string;
    labelName: string;
    label: string;
    valueId: string;
    valueName: string;
    value: string;
    valueColor: number;
    width: number;
    height: number;
    valueFontSize?: number;
    /** 默认像素字 monoFont；底注/回合等用普通字 textFxStack */
    valueFontFamily?: string;
  }): { box: Panel; valueText: UIText } {
    const box = new Panel({
      id: opts.id,
      displayName: opts.displayName,
      width: opts.width,
      height: opts.height,
      fill: Theme.colors.panelInset,
      radius: INSET_R,
    });

    const label = new UIText({
      id: opts.labelId,
      displayName: opts.labelName,
      text: opts.label,
      style: {
        fontFamily: Theme.fontFamily,
        fontSize: 13,
        fill: Theme.colors.textWhite,
        fontWeight: "bold",
      },
    });
    label.setAnchor(0.5, 0);
    label.position.set(opts.width / 2, 4);
    box.addChild(label);

    // 灰数字底：贴在暗黑底下半
    const padX = 5;
    const valueBgH = 30;
    const valueBgY = opts.height - valueBgH - 5;
    const valueBg = new Panel({
      id: `${opts.id}.valueBg`,
      displayName: "数字灰底",
      width: opts.width - padX * 2,
      height: valueBgH,
      fill: Theme.colors.valueBg,
      radius: 6,
    });
    valueBg.position.set(padX, valueBgY);
    box.addChild(valueBg);

    const valueText = new UIText({
      id: opts.valueId,
      displayName: opts.valueName,
      text: opts.value,
      style: {
        fontFamily: opts.valueFontFamily ?? Theme.monoFont,
        fontSize: opts.valueFontSize ?? 28,
        fill: opts.valueColor,
        fontWeight: "bold",
      },
    });
    valueText.setAnchor(0.5);
    valueText.position.set((opts.width - padX * 2) / 2, valueBgH / 2);
    valueBg.addChild(valueText);

    return { box, valueText };
  }

  /** 侧栏方按钮：缩小字号、允许两行、居中 */
  private restyleSideButtonLabel(btn: Button, fontSize: number): void {
    const label = btn.listUIChildren().find((c) => c.nodeId.endsWith(".label"));
    if (!(label instanceof UIText)) return;
    const pixi = label.getPixiText();
    pixi.style.fontSize = fontSize;
    pixi.style.align = "center";
    pixi.style.lineHeight = fontSize + 4;
    // 触发一次 setText 让布局刷新
    label.setText(label.getText());
  }

  // ---- GameController API ---------------------------------------

  setTotalScore(score: number): void {
    this.scoreText.setText(String(score));
  }

  setChipsMult(chips: number, mult: number): void {
    this.chipsText.setText(String(chips));
    this.multText.setText(String(mult));
  }

  getChips(): number {
    return parseInt(this.chipsText.getText(), 10) || 0;
  }

  getMult(): number {
    return parseInt(this.multText.getText(), 10) || 0;
  }

  setHandName(name: string): void {
    this.handNameText.setText(name === "无" ? "" : name);
  }

  setExpectScore(score: number): void {
    this.evalScoreText.setText(String(score));
  }

  setPlays(n: number): void {
    this.playsText.setText(String(n));
  }

  setDiscards(n: number): void {
    this.discardsText.setText(String(n));
  }

  setTargetScore(n: number): void {
    this.targetScoreText.setText(String(n));
  }

  setReward(text: string): void {
    this.rewardText.setText(text);
  }

  setBlindTitle(text: string): void {
    this.blindTitleText.setText(text);
  }

  setMoney(amount: number): void {
    this.moneyText.setText(`$${amount}`);
  }

  setAnte(current: number, max: number): void {
    this.anteText.setText(`${current}/${max}`);
  }

  setRound(n: number): void {
    this.roundText.setText(String(n));
  }

  triggerChipsBounce(): void {
    this.chipsBounceComp.trigger();
  }

  triggerMultBounce(): void {
    this.multBounceComp.trigger();
  }

  triggerHandNameBounce(): void {
    this.handNameBounceComp.trigger();
  }

  triggerEvalScoreBounce(): void {
    this.evalScoreBounceComp.trigger();
  }

  setHandNameVisible(visible: boolean): void {
    this.handNameText.visible = visible;
  }

  setExpectScoreVisible(visible: boolean): void {
    this.evalScoreText.visible = visible;
  }

}
