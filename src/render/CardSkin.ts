/**
 * 卡牌的视觉参数（尺寸、配色、字体）
 *
 * 集中放这里，避免数字魔法散落到每个绘制函数里。
 * 未来切到位图素材时，把这套参数对应改成纹理 key 即可。
 */
export const CardSkin = {
  width: 100,
  height: 140,
  cornerRadius: 10,
  borderColor: 0x222222,
  borderWidth: 2,
  faceColor: 0xffffff,

  // 颜色
  redColor: 0xdd2222,
  blackColor: 0x222222,

  // 字体
  cornerFontSize: 24,
  centerFontSize: 50,
  fontFamily: "Arial",

  // 选中弹起像素数（世界坐标）
  selectedRiseY: 30,
  // 悬浮弹起像素数
  hoverRiseY: 10,
} as const;

export type CardSkinType = typeof CardSkin;
