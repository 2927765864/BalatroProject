import { Easing, type EaseFn } from "./Easing";

/**
 * 极简补间
 *
 * 用法：
 *   tweenManager.create(card)
 *     .to({ x: 200, y: 100, rotation: 0 }, 350)
 *     .easing(Easing.cubicOut)
 *     .onComplete(() => ...)
 *     .start();
 *
 * 限制：
 *   - 仅支持数值字段。
 *   - 同一对象同时存在的多条 tween 由 TweenManager 自行隔离，但若两条 tween
 *     操作同一字段，会按启动顺序后到的覆盖前者（自动停止旧的同字段 tween）。
 */
export type NumericKeys<T> = {
  [K in keyof T]: T[K] extends number ? K : never;
}[keyof T];

export type TweenTarget<T> = Partial<{ [K in NumericKeys<T>]: number }>;

export class Tween<T extends object> {
  private startValues: TweenTarget<T> = {};
  private endValues: TweenTarget<T> = {};
  private duration = 0;
  private elapsed = 0;
  private easeFn: EaseFn = Easing.linear;
  private delay = 0;
  private running = false;
  private completed = false;
  private onCompleteFn?: () => void;
  private onUpdateFn?: () => void;

  constructor(
    public readonly target: T,
    private readonly onFinish: (tween: Tween<T>) => void
  ) {}

  /** 设置终值（毫秒）。 */
  to(values: TweenTarget<T>, durationMS: number): this {
    this.endValues = { ...values };
    this.duration = Math.max(0, durationMS);
    return this;
  }

  easing(fn: EaseFn): this {
    this.easeFn = fn;
    return this;
  }

  withDelay(ms: number): this {
    this.delay = Math.max(0, ms);
    return this;
  }

  onUpdate(fn: () => void): this {
    this.onUpdateFn = fn;
    return this;
  }

  onComplete(fn: () => void): this {
    this.onCompleteFn = fn;
    return this;
  }

  start(): this {
    // 锁定起点。
    for (const k of Object.keys(this.endValues) as Array<NumericKeys<T>>) {
      this.startValues[k] = this.target[k] as unknown as number;
    }
    this.elapsed = -this.delay;
    this.running = true;
    this.completed = false;
    return this;
  }

  /** 由 TweenManager 调用。dt 单位毫秒。 */
  step(dtMS: number): void {
    if (!this.running || this.completed) return;
    this.elapsed += dtMS;
    if (this.elapsed < 0) return; // delay 阶段

    const t =
      this.duration <= 0 ? 1 : Math.min(1, this.elapsed / this.duration);
    const eased = this.easeFn(t);

    for (const k of Object.keys(this.endValues) as Array<NumericKeys<T>>) {
      const from = this.startValues[k] as number;
      const to = this.endValues[k] as number;
      (this.target[k] as unknown as number) = from + (to - from) * eased;
    }

    this.onUpdateFn?.();

    if (t >= 1) {
      this.completed = true;
      this.running = false;
      this.onCompleteFn?.();
      this.onFinish(this);
    }
  }

  /** 提前结束（不触发 onComplete）。 */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.onFinish(this);
  }

  isRunning(): boolean {
    return this.running;
  }

  /** 该 tween 涉及的字段集合，用于冲突检测。 */
  getKeys(): Array<NumericKeys<T>> {
    return Object.keys(this.endValues) as Array<NumericKeys<T>>;
  }
}
