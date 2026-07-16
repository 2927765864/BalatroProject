import { GameFonts } from "./fonts";

/**
 * UI 全局主题
 *
 * 颜色、字号、字体一处定义，方便未来做"换肤"或与卡牌皮肤联动。
 */
export const Theme = {
  fontFamily: GameFonts.textStack,
  monoFont: GameFonts.numberStack,

  colors: {
    /**
     * 左侧侧栏底色（参考图：中灰，非纯黑）。
     * 外围描边见 panelBorder；子面板用分层「底」而不是描边。
     */
    panelDark: 0x3a3f47,
    panelBlack: 0x22262c,
    /** 侧栏最外围蓝色边框 */
    panelBorder: 0x4a8ec8,
    /** 近黑底（出牌/弃牌/金钱等外壳底） */
    panelInset: 0x1a1c22,
    /** 数字灰底（压在近黑底上的那一层，例如「5」下面） */
    valueBg: 0x3a3f48,
    /** 顶部小丑牌槽位长条背景 */
    jokerBar: 0x1a1c20,
    /** 盲注标题栏蓝 */
    blindTitle: 0x2e5f9e,
    /**
     * 盲注区外底（近黑，包住蓝标题 + 深蓝内容卡；
     * 标题与内容卡之间的细缝露出此色）。
     */
    blindOuter: 0x1c2428,
    /** 盲注内容卡底（深蓝灰，徽章与「至少得分」所在层） */
    blindCard: 0x213b52,
    /** 圆形 SMALL BLIND 徽章 */
    blindBadge: 0x2a5fd4,
    /** 回合分值条（暗灰底，无描边） */
    scoreBar: 0x2c3138,
    /** 筹码×倍率区大底（近黑，无描边） */
    chipMultFrame: 0x1c1f24,
    targetBg: 0x4d3900,
    targetBorder: 0xcc9900,
    blueChip: 0x2f7bff,
    redMult: 0xe83a3a,
    playBtn: 0x0088ff,
    discardBtn: 0xff3333,
    /** 比赛信息按钮（红） */
    runInfoBtn: 0xd4433a,
    /** 选项按钮（橙） */
    optionsBtn: 0xe89020,
    /** 奖励 / 金钱黄 */
    rewardYellow: 0xf0c040,
    moneyYellow: 0xf0c040,
    /** 理牌「点数」按钮 */
    sortRankBtn: 0x6b5ce7,
    /** 理牌「花色」按钮 */
    sortSuitBtn: 0xd47b2f,
    btnIdle: 0x444444,
    textWhite: 0xffffff,
    textSubtle: 0xaaaaaa,
    textMuted: 0x888888,
    danger: 0xe84a4a,
    playCount: 0x44aaff,
    discardCount: 0xff4444,
  },

  fontSize: {
    label: 16,
    title: 20,
    value: 32,
    big: 40,
    button: 24,
  },
} as const;
