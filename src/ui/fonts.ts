export const GameFonts = {
  numberFamily: "M6x11plus",
  textFxFamily: "NotoSans-Bold",
  get numberStack() {
    return `"${this.numberFamily}", monospace`;
  },
  get textStack() {
    return `"${this.numberFamily}", "Microsoft YaHei", sans-serif`;
  },
  get textFxStack() {
    return `"${this.textFxFamily}", sans-serif`;
  },
} as const;
