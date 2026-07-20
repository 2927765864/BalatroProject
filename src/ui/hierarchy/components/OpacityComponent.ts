/**
 * OpacityComponent
 * ---------------------------------------------------------------
 * 控制宿主 UINode 的整体透明度（PIXI Container.alpha）。
 * 挂到任意 UI 节点上即可在 Hierarchy Inspector 里拖改，并随 uiNodes 持久化。
 *
 * 注意：宿主自身若在运行时直接写 Container.alpha，会与本组件互相覆盖。
 * Button 状态反馈已不再改 alpha（按下位移+隐影，禁用只变灰），可与本组件共存。
 */
import { UIComponent, type SerializedComponent } from "../UIComponent";
import { uiHierarchy } from "../UIHierarchy";
import { attachDragScrub } from "@/debug/dragScrub";

interface OpacityData {
  /** 0..1 */
  alpha: number;
}

const DEFAULT_DATA: OpacityData = {
  alpha: 1,
};

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export class OpacityComponent extends UIComponent {
  readonly type = "opacity";
  readonly displayName = "透明度";

  private data: OpacityData = { ...DEFAULT_DATA };

  protected override onAttach(): void {
    this.apply();
  }

  apply(): void {
    this.host.alpha = clamp(this.data.alpha, 0, 1);
  }

  get alpha(): number {
    return this.data.alpha;
  }

  setAlpha(value: number): void {
    const next = clamp(value, 0, 1);
    if (this.data.alpha === next) return;
    this.data.alpha = next;
    this.apply();
    uiHierarchy.notifyComponentsChanged(this.host);
  }

  serialize(): SerializedComponent {
    return { type: this.type, data: { ...this.data } };
  }

  deserialize(d: Record<string, unknown>): void {
    if (typeof d["alpha"] === "number") {
      this.data.alpha = clamp(d["alpha"], 0, 1);
    }
  }

  buildInspector(): HTMLElement {
    const root = document.createElement("div");
    root.className = "ui-comp-body";

    const row = document.createElement("div");
    row.className = "ui-comp-row";

    const lab = document.createElement("span");
    lab.className = "ui-comp-row-label";
    lab.textContent = "Alpha";

    const input = document.createElement("input");
    input.type = "number";
    input.className = "panel-number";
    input.min = "0";
    input.max = "1";
    input.step = "0.01";
    input.value = this.data.alpha.toFixed(2);
    attachDragScrub(input, { step: 0.01, min: 0, max: 1, digits: 2 });

    input.addEventListener("input", () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      this.setAlpha(v);
    });
    input.addEventListener("change", () => {
      input.value = this.data.alpha.toFixed(2);
    });

    row.appendChild(lab);
    row.appendChild(input);
    root.appendChild(row);
    return root;
  }
}
