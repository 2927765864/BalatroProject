/**
 * UI 全局主题
 *
 * 颜色、字号、字体一处定义，方便未来做"换肤"或与卡牌皮肤联动。
 */
export const Theme = {
  fontFamily: "Microsoft YaHei",
  monoFont: "Arial",

  colors: {
    panelDark: 0x2b2d31,
    panelBlack: 0x222222,
    targetBg: 0x4d3900,
    targetBorder: 0xcc9900,
    blueChip: 0x0077ff,
    redMult: 0xff3333,
    playBtn: 0x0088ff,
    discardBtn: 0xff3333,
    btnIdle: 0x444444,
    textWhite: 0xffffff,
    textSubtle: 0xaaaaaa,
    textMuted: 0x888888,
    danger: 0xff5555,
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
