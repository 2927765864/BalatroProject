/**
 * 卡牌的视觉参数（尺寸、配色、字体）
 *
 * 集中放这里，避免数字魔法散落到每个绘制函数里。
 * 未来切到位图素材时，把这套参数对应改成纹理 key 即可。
 */
export const CardSkin = {
  width: 100,
  height: 140,
  cornerRadius: 6,
  borderColor: 0x333333,
  borderWidth: 2,
  faceColor: 0xffffff,

  // 四种花色的颜色 (根据 Balatro 风格调整)
  spadesColor: 0x36454F,   // 黑桃：深灰/黑
  heartsColor: 0xed2121,   // 红桃：红
  clubsColor: 0x2278d4,    // 梅花：蓝
  diamondsColor: 0xeda807, // 方块：橙黄

  // 字体
  cornerFontSize: 20,
  centerFontSize: 46,
  fontFamily: "'Jersey 10', 'VT323', monospace",

  // 选中弹起像素数（世界坐标）
  selectedRiseY: 30,
  // 悬浮弹起像素数
  hoverRiseY: 10,
} as const;

export type CardSkinType = typeof CardSkin;
