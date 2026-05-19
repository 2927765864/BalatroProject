/**
 * TransformComponent
 * ---------------------------------------------------------------
 * 每个 UINode 默认挂载、不可删除的组件。
 * 把节点的 position / rotation / scale 暴露成数据，统一走 inspector / 序列化路径。
 *
 * 设计上：
 *   - 不强制覆盖宿主的初始位姿。第一次 attach 时把宿主现有 x/y/rotation/scale 读进来，
 *     之后 inspector 改值或者反序列化才会真正回写到宿主。
 *   - apply() 把组件字段写回宿主 PIXI 的 transform。
 */
import { UIComponent, type SerializedComponent } from "../UIComponent";
import { uiHierarchy } from "../UIHierarchy";
import { attachDragScrub } from "@/debug/dragScrub";

interface TransformData {
  x: number;
  y: number;
  rotation: number; // 弧度
  scaleX: number;
  scaleY: number;
}

export class TransformComponent extends UIComponent {
  readonly type = "transform";
  readonly displayName = "Transform";
  override readonly removable = false;

  private data: TransformData = {
    x: 0,
    y: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
  };

  /**
   * 是否已经被反序列化（即数据来自存档而非宿主自身）。
   * 一旦为 true，captureFromHost 不再覆盖字段——存档值优先。
   */
  private hydratedFromSave = false;

  /**
   * 用宿主当前的 x/y/rotation/scale 覆盖组件字段。
   * 仅在还没"从存档加载过"时生效。UINode 在节点首次被挂到父上时调用，
   * 用来抓住调用方刚 position.set / scale.set 写下的初始值。
   */
  captureFromHost(): void {
    if (this.hydratedFromSave) return;
    const h = this.host;
    this.data = {
      x: h.x,
      y: h.y,
      rotation: h.rotation,
      scaleX: h.scale.x,
      scaleY: h.scale.y,
    };
  }

  apply(): void {
    const h = this.host;
    h.position.set(this.data.x, this.data.y);
    h.rotation = this.data.rotation;
    h.scale.set(this.data.scaleX, this.data.scaleY);
  }

  // ---- 字段读写（inspector 用）-------------------------------

  get x(): number { return this.data.x; }
  get y(): number { return this.data.y; }
  get rotation(): number { return this.data.rotation; }
  get scaleX(): number { return this.data.scaleX; }
  get scaleY(): number { return this.data.scaleY; }

  setField(key: keyof TransformData, value: number): void {
    if (!Number.isFinite(value)) return;
    if (this.data[key] === value) return;
    this.data[key] = value;
    this.apply();
    uiHierarchy.notifyTransformChanged(this.host);
  }

  // ---- 序列化 ----------------------------------------------------

  serialize(): SerializedComponent {
    return { type: this.type, data: { ...this.data } };
  }

  deserialize(d: Record<string, unknown>): void {
    const next: TransformData = { ...this.data };
    if (typeof d["x"] === "number") next.x = d["x"];
    if (typeof d["y"] === "number") next.y = d["y"];
    if (typeof d["rotation"] === "number") next.rotation = d["rotation"];
    if (typeof d["scaleX"] === "number") next.scaleX = d["scaleX"];
    if (typeof d["scaleY"] === "number") next.scaleY = d["scaleY"];
    this.data = next;
    this.hydratedFromSave = true;
  }

  // ---- inspector DOM --------------------------------------------

  buildInspector(): HTMLElement {
    const root = document.createElement("div");
    root.className = "ui-comp-body";

    const addRow = (
      label: string,
      key: keyof TransformData,
      step: number,
      digits: number,
    ): void => {
      const row = document.createElement("div");
      row.className = "ui-comp-row";

      const lab = document.createElement("span");
      lab.className = "ui-comp-row-label";
      lab.textContent = label;

      const input = document.createElement("input");
      input.type = "number";
      input.className = "panel-number";
      input.step = String(step);
      input.value = Number(this.data[key]).toFixed(digits);
      attachDragScrub(input, { step, digits });

      const commit = (raw: string): void => {
        const v = Number(raw);
        if (!Number.isFinite(v)) return;
        this.setField(key, v);
      };
      input.addEventListener("input", () => commit(input.value));
      input.addEventListener("change", () => {
        input.value = Number(this.data[key]).toFixed(digits);
      });

      row.appendChild(lab);
      row.appendChild(input);
      root.appendChild(row);
    };

    addRow("X", "x", 1, 1);
    addRow("Y", "y", 1, 1);
    addRow("Rotation", "rotation", 0.01, 3);
    addRow("Scale X", "scaleX", 0.01, 3);
    addRow("Scale Y", "scaleY", 0.01, 3);

    return root;
  }
}
