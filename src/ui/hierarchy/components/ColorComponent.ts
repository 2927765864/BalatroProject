/**
 * ColorComponent
 * ---------------------------------------------------------------
 * 可选组件：直接指定宿主节点**自身**显示对象的颜色。
 *
 * 设计要点（与需求对齐）：
 *   1. 直接指定色值，不是「乘上某个 tint 倍率」去改已经烘焙的多色图。
 *      - Graphics / Sprite：假定几何/纹理为白色底，用 leaf.tint = color
 *        （白 × color = color，语义上就是指定色）。
 *      - Text：写 style.fill = color，并把 leaf.tint 重置为白，避免双重相乘。
 *   2. **只**改宿主的直接非 UINode 子节点（shape / Text 等叶子），
 *      绝不写 host.tint（PIXI Container 的 tint 会下传到子树）。
 *      因此父节点挂颜色组件不会影响子 UINode。
 *   3. 跳过 ShadowComponent 注入的剪影 Sprite（label 以 __shadow_for_ 开头）。
 *
 * 与多色拼合元素的关系：
 *   调用方应先把「多色拼在一个 Graphics 里」的元素拆成多个单色 UINode，
 *   再分别挂本组件；本组件不会拆分几何，只负责上色。
 */
import { Graphics, Sprite, Text, type ContainerChild } from "pixi.js";
import { UIComponent, type SerializedComponent } from "../UIComponent";
import { uiHierarchy } from "../UIHierarchy";
import { isUINode } from "../UINode";

interface ColorData {
  /** #rrggbb */
  color: string;
}

const DEFAULT_DATA: ColorData = {
  color: "#ffffff",
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function hexToNumber(hex: string): number {
  if (!HEX_RE.test(hex)) return 0xffffff;
  return parseInt(hex.slice(1), 16);
}

function numberToHex(n: number): string {
  return "#" + (n & 0xffffff).toString(16).padStart(6, "0");
}

/** 从叶子显示对象读出当前“有效”色，用于 detach 时还原。 */
function readLeafColor(obj: ContainerChild): number | null {
  if (obj instanceof Text) {
    const fill = obj.style.fill;
    if (typeof fill === "number") return fill & 0xffffff;
    if (typeof fill === "string" && HEX_RE.test(fill)) {
      return hexToNumber(fill.toLowerCase());
    }
    // 有 fill 但无法解析时退回 tint
    return obj.tint & 0xffffff;
  }
  if (obj instanceof Graphics || obj instanceof Sprite) {
    return obj.tint & 0xffffff;
  }
  return null;
}

function applyLeafColor(obj: ContainerChild, color: number): void {
  const c = color & 0xffffff;
  if (obj instanceof Text) {
    // 直接指定 fill，避免对已有 fill 再乘 tint
    obj.style.fill = c;
    obj.tint = 0xffffff;
    return;
  }
  if (obj instanceof Graphics || obj instanceof Sprite) {
    obj.tint = c;
  }
}

function isShadowSprite(obj: ContainerChild): boolean {
  const label = (obj as { label?: string }).label;
  return typeof label === "string" && label.startsWith("__shadow_for_");
}

export class ColorComponent extends UIComponent {
  readonly type = "color";
  readonly displayName = "颜色";

  private data: ColorData = { ...DEFAULT_DATA };

  /** 首次见到各叶子时的原始色；detach 时写回。 */
  private originals = new Map<ContainerChild, number>();

  private hostChangeHandler: (() => void) | null = null;

  protected override onAttach(): void {
    // 用户刚添加 / hydrate 尚未 deserialize 时 data 仍是默认白：
    // 先从宿主叶子采样当前色，避免 apply 把画面先刷成白。
    // hydrate 随后会 deserialize 成存档色再 apply 一次。
    if (this.data.color === DEFAULT_DATA.color) {
      this.sampleColorFromHostLeaves();
    }

    this.hostChangeHandler = (): void => {
      // 子结构变了：对新叶子也上色（不重置已有 originals，保留 detach 还原能力）
      this.apply();
    };
    this.host.on("childAdded", this.hostChangeHandler);
    this.host.on("childRemoved", this.hostChangeHandler);
    this.apply();
  }

  /** 读取第一个可上色叶子的当前色，写入 data（不 apply）。 */
  private sampleColorFromHostLeaves(): void {
    for (const child of this.host.children) {
      if (isUINode(child) || isShadowSprite(child)) continue;
      const c = readLeafColor(child);
      if (c !== null) {
        this.data.color = numberToHex(c);
        return;
      }
    }
  }

  protected override onDetach(): void {
    if (this.hostChangeHandler) {
      this.host.off("childAdded", this.hostChangeHandler);
      this.host.off("childRemoved", this.hostChangeHandler);
      this.hostChangeHandler = null;
    }
    // 还原叶子颜色；不碰 UINode 子节点
    for (const [obj, color] of this.originals) {
      if (obj.destroyed) continue;
      applyLeafColor(obj, color);
    }
    this.originals.clear();
  }

  apply(): void {
    const color = hexToNumber(this.data.color);
    for (const child of this.host.children) {
      if (isUINode(child)) continue;
      if (isShadowSprite(child)) continue;
      if (!this.originals.has(child)) {
        const orig = readLeafColor(child);
        if (orig !== null) this.originals.set(child, orig);
      }
      applyLeafColor(child, color);
    }
    // 通知阴影等依赖外观的组件重烤
    this.host.notifyVisualChanged();
  }

  get color(): string {
    return this.data.color;
  }

  setColor(hex: string): void {
    const next = hex.toLowerCase();
    if (!HEX_RE.test(next)) return;
    if (this.data.color === next) return;
    this.data.color = next;
    this.apply();
    uiHierarchy.notifyComponentsChanged(this.host);
  }

  serialize(): SerializedComponent {
    return { type: this.type, data: { ...this.data } };
  }

  deserialize(d: Record<string, unknown>): void {
    if (typeof d["color"] === "string" && HEX_RE.test(d["color"])) {
      this.data.color = d["color"].toLowerCase();
    }
  }

  buildInspector(): HTMLElement {
    const root = document.createElement("div");
    root.className = "ui-comp-body";

    const row = document.createElement("div");
    row.className = "ui-comp-row";

    const lab = document.createElement("span");
    lab.className = "ui-comp-row-label";
    lab.textContent = "Color";

    const input = document.createElement("input");
    input.type = "color";
    input.value = this.data.color;
    input.addEventListener("input", () => {
      this.setColor(input.value);
    });

    row.appendChild(lab);
    row.appendChild(input);
    root.appendChild(row);
    return root;
  }
}
