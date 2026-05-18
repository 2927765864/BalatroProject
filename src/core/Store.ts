/**
 * 极简中心化状态容器
 *
 * 设计要点：
 *   - 状态对象本身保持普通对象（便于 TS 推导与序列化）。
 *   - 通过 setState(patch) 触发订阅；patch 可以是部分对象或函数。
 *   - 配合 EventBus 使用：业务模块"看变化"用 store.subscribe，"听动作"用 bus.on。
 *
 * 之所以不直接用 MobX/Redux：当前规模下自己写 30 行就够，零运行时依赖，
 * 后续若状态体量上来再无痛替换底层。
 */
export type StateUpdater<S> = (prev: Readonly<S>) => Partial<S>;
export type Subscriber<S> = (state: Readonly<S>, prev: Readonly<S>) => void;

export class Store<S extends object> {
  private state: S;
  private readonly subscribers = new Set<Subscriber<S>>();

  constructor(initialState: S) {
    this.state = initialState;
  }

  getState(): Readonly<S> {
    return this.state;
  }

  setState(patch: Partial<S> | StateUpdater<S>): void {
    const prev = this.state;
    const delta = typeof patch === "function" ? patch(prev) : patch;
    this.state = { ...prev, ...delta };
    for (const sub of [...this.subscribers]) {
      sub(this.state, prev);
    }
  }

  subscribe(sub: Subscriber<S>): () => void {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }
}
