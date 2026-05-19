export const GameFonts = {
  numberFamily: "M6x11plus",
  get numberStack() {
    return `"${this.numberFamily}", monospace`;
  },
  get textStack() {
    return `"${this.numberFamily}", "Microsoft YaHei", sans-serif`;
  },
} as const;
