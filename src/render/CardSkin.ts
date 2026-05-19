import { GameFonts } from "@ui/fonts";

/**
 * 卡牌的静态视觉参数（尺寸、字体）
 *
 * 集中放这里，避免数字魔法散落到每个绘制函数里。
 * 未来切到位图素材时，把这套参数对应改成纹理 key 即可。
 */
export const CardSkin = {
  width: 100,
  height: 140,

  // 注：圆角 / 卡面底色 / 外缘描边色已迁到 CONFIG.cardArt（运行时可调），见 src/game/config.ts。

  // 四种花色的颜色 (根据 Balatro 风格调整)
  spadesColor: 0x36454F,   // 黑桃：深灰/黑
  heartsColor: 0xed2121,   // 红桃：红
  clubsColor: 0x2278d4,    // 梅花：蓝
  diamondsColor: 0xeda807, // 方块：橙黄

  // 字体
  cornerFontSize: 20,
  centerFontSize: 46,
  fontFamily: GameFonts.numberStack,

  // 选中弹起像素数（世界坐标）
  selectedRiseY: 30,
  // 悬浮弹起像素数
  hoverRiseY: 10,
} as const;

export type CardSkinType = typeof CardSkin;

/**
 * 精灵图集参数
 *
 * 两张资源的具体尺寸：
 *   - 8BitDeck_opt2.png : 923 × 380，按 13 列 × 4 行切片，每格 71×95（不整除会被 PIXI 自动裁剪到整像素）。
 *     列：rank 2..A（自左向右）；行：suit 顺序见 FRONT_SUIT_ROWS。
 *   - Enhancers.png     : 497 × 475，按 7 列 × 5 行切片，每格 71×95。第 3 行第 1 列（0 基为 row=2,col=0）是默认背面。
 *
 * 这里只放"几何切片参数"。具体把哪一格映射到哪张牌，由 AssetManager 在加载时执行。
 */
export const CardAtlas = {
  front: {
    /** 精灵图路径（Vite 会处理为最终 URL） */
    src: "../../resources/textures/8BitDeck_opt2.png",
    cols: 13,
    rows: 4,
    /** 自左向右的 rank 顺序 */
    rankOrder: ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"] as const,
    /**
     * 每一行对应的花色。
     * 8BitDeck 的常见行顺序为 ♥ ♣ ♦ ♠（红桃-梅花-方块-黑桃）；
     * 如果在游戏内发现花色对不上，把这一行顺序调一下即可。
     */
    suitRows: ["♥", "♣", "♦", "♠"] as const,
  },
  back: {
    src: "../../resources/textures/Enhancers.png",
    cols: 7,
    rows: 5,
    /** 默认背面在 (row, col) 上的位置。第 3 行第 1 列 = (2, 0)。 */
    defaultRow: 2,
    defaultCol: 0,
  },
} as const;

export type CardAtlasType = typeof CardAtlas;
