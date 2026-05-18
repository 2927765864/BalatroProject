/**
 * 缓动函数集合
 *
 * 输入 t ∈ [0, 1]，输出 ∈ [0, 1]（部分函数会过冲，如 Back）。
 * 函数命名遵循 Penner 体系：In = 慢启动, Out = 慢结束, InOut = 两端慢。
 */
export type EaseFn = (t: number) => number;

export const Easing = {
  linear: ((t) => t) as EaseFn,

  quadIn: ((t) => t * t) as EaseFn,
  quadOut: ((t) => 1 - (1 - t) * (1 - t)) as EaseFn,
  quadInOut: ((t) =>
    t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2) as EaseFn,

  cubicIn: ((t) => t * t * t) as EaseFn,
  cubicOut: ((t) => 1 - Math.pow(1 - t, 3)) as EaseFn,
  cubicInOut: ((t) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2) as EaseFn,

  expoIn: ((t) => (t === 0 ? 0 : Math.pow(2, 10 * (t - 1)))) as EaseFn,
  expoOut: ((t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t))) as EaseFn,

  backOut: ((t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }) as EaseFn,

  backInOut: ((t) => {
    const c1 = 1.70158;
    const c2 = c1 * 1.525;
    return t < 0.5
      ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2
      : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2;
  }) as EaseFn,
};
