// Positions -> SVG, plus the details pane and the notice bar. No layout logic here.
import { ACTION_LABELS } from "../messages";
import type { Notice, NoticeAction } from "../protocol";
import type { Look } from "../ir";
import type { Box, Laid } from "./layout";
import type { Rect } from "./viewport";
import { formatParams, type VNode } from "./view";

const SVG = "http://www.w3.org/2000/svg";

export type Handlers = {
  onSelect(id: string): void;
  onOpen(id: string): void;
  onToggle(id: string): void;
};

function el<K extends keyof SVGElementTagNameMap>(
  tag: K, attrs: Record<string, string | number> = {}, text?: string,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [k, value] of Object.entries(attrs)) node.setAttribute(k, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The outline of a block, always inside its layout box. A collapsed block with a look gets the
 * look's shape; an expanded block stays a rectangle, because its children must fit inside.
 */
export function shapeElement(look: Look | undefined, kind: VNode["kind"], expanded: boolean, box: Rect): SVGElement {
  const { x, y, width: w, height: h } = box;
  const shape = expanded ? "rect" : look?.shape ?? "rect";
  const polygon = (points: [number, number][]) =>
    el("polygon", { class: "shape", points: points.map(([px, py]) => `${px},${py}`).join(" ") });
  if (shape === "trapezoid-narrow") {
    return polygon([[x, y], [x + w, y + h * 0.2], [x + w, y + h * 0.8], [x, y + h]]);
  }
  if (shape === "trapezoid-wide") {
    return polygon([[x, y + h * 0.2], [x + w, y], [x + w, y + h], [x, y + h * 0.8]]);
  }
  if (shape === "hexagon") {
    const inset = Math.min(14, w / 5);
    return polygon([
      [x + inset, y], [x + w - inset, y], [x + w, y + h / 2],
      [x + w - inset, y + h], [x + inset, y + h], [x, y + h / 2],
    ]);
  }
  if (shape === "circle") {
    return el("ellipse", { class: "shape", cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 });
  }
  const rx = shape === "rounded" ? h / 2 : kind === "op" ? 14 : 6;
  return el("rect", { class: "shape", x, y, width: w, height: h, rx });
}

function drawBox(parent: SVGElement, box: Box, selectedId: string | null, handlers: Handlers): void {
  const v = box.v;
  if (v.kind === "terminal") {
    parent.appendChild(el("circle", {
      class: "terminal", "data-id": v.id,
      cx: box.x + box.width / 2, cy: box.y + box.height / 2, r: Math.min(box.width, box.height) / 2,
    }));
    return;
  }
  const classes = ["node", "node-" + v.kind];
  if (v.expanded) classes.push("expanded");
  if (v.id === selectedId) classes.push("selected");
  const look = v.node?.look;
  if (look && look.color !== "none") classes.push("look-" + look.color);
  const g = el("g", { class: classes.join(" "), "data-id": v.id });
  g.appendChild(shapeElement(look, v.kind, v.expanded, box));

  const toggleSpace = v.expandable ? 22 : 0;
  if (v.expanded) {
    // header in the top-left corner of the container
    const text = v.sublabel ? `${v.label}  ·  ${v.sublabel}` : v.label;
    g.appendChild(el("text", { class: "label header", x: box.x + 12, y: box.y + 21 }, text));
  } else {
    const cx = box.x + (box.width - toggleSpace) / 2;
    const cy = box.y + box.height / 2;
    g.appendChild(el("text", {
      class: "label", x: cx, y: v.sublabel ? cy - 3 : cy + 4, "text-anchor": "middle",
    }, v.label));
    if (v.sublabel) {
      g.appendChild(el("text", { class: "sublabel", x: cx, y: cy + 12, "text-anchor": "middle" }, v.sublabel));
    }
  }

  if (v.expandable) {
    const size = 16;
    const tx = box.x + box.width - size - 6;
    const ty = v.expanded ? box.y + 9 : box.y + (box.height - size) / 2;
    const toggle = el("g", { class: "toggle", "data-id": v.id });
    toggle.appendChild(el("rect", { x: tx, y: ty, width: size, height: size, rx: 3 }));
    toggle.appendChild(el("text", { x: tx + size / 2, y: ty + 12, "text-anchor": "middle" },
      v.expanded ? "−" : "+"));
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      handlers.onToggle(v.id);
    });
    toggle.addEventListener("dblclick", (event) => event.stopPropagation());
    g.appendChild(toggle);
  }

  g.addEventListener("click", (event) => {
    event.stopPropagation(); // do not also select the enclosing block
    handlers.onSelect(v.id);
  });
  g.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    handlers.onOpen(v.id);
  });

  parent.appendChild(g);
  for (const child of box.children) drawBox(g, child, selectedId, handlers);
}

export function renderDiagram(
  svg: SVGSVGElement, laid: Laid, selectedId: string | null, handlers: Handlers,
): void {
  svg.replaceChildren();
  const defs = el("defs");
  const marker = el("marker", {
    id: "arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7,
    orient: "auto-start-reverse",
  });
  marker.appendChild(el("path", { class: "arrowhead", d: "M 0 0 L 10 5 L 0 10 z" }));
  defs.appendChild(marker);
  svg.appendChild(defs);

  const scene = el("g", { class: "scene" });
  svg.appendChild(scene);
  // The root container is the canvas itself: draw its children, not a box around everything.
  for (const child of laid.root.children) drawBox(scene, child, selectedId, handlers);

  const edges = el("g", { class: "edges" });
  for (const p of laid.paths) {
    const d = p.points.map((pt, i) => `${i === 0 ? "M" : "L"} ${pt.x} ${pt.y}`).join(" ");
    edges.appendChild(el("path", {
      class: p.uncertain ? "edge uncertain" : "edge", d, "marker-end": "url(#arrow)",
    }));
    if (p.label) {
      edges.appendChild(el("text", {
        class: "edge-label", x: p.labelAt.x, y: p.labelAt.y + 4, "text-anchor": "middle",
      }, p.label));
    }
  }
  scene.appendChild(edges);
}

/** Marks exactly these nodes as being under the editor cursor. */
export function applyCursorHighlight(svg: SVGSVGElement, ids: string[]): void {
  const wanted = new Set(ids);
  for (const node of svg.querySelectorAll("g.node")) {
    node.classList.toggle("cursor", wanted.has(node.getAttribute("data-id") ?? ""));
  }
}

function row(label: string, value: string): HTMLElement {
  const div = document.createElement("div");
  div.className = "row";
  const key = document.createElement("span");
  key.className = "key";
  key.textContent = label;
  const val = document.createElement("span");
  val.className = "value";
  val.textContent = value;
  div.append(key, val);
  return div;
}

function baseName(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}

export function renderDetails(
  container: HTMLElement, v: VNode | null, inShapes: string[], outShapes: string[],
): void {
  container.replaceChildren();
  if (!v || !v.node) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Click a block to see its details. Double-click to open its code.";
    container.appendChild(hint);
    return;
  }
  const node = v.node;
  const title = document.createElement("h2");
  title.textContent = node.name;
  container.appendChild(title);
  container.appendChild(row("Type", node.type));
  container.appendChild(row("Kind", node.kind));
  if (node.look?.role) container.appendChild(row("Role", node.look.role));
  if (node.description) container.appendChild(row("About", node.description));
  const params = formatParams(node.params, node.trainableParams);
  if (params) container.appendChild(row("Size", params));
  const shapesIn = inShapes.filter(Boolean);
  const shapesOut = outShapes.filter(Boolean);
  if (shapesIn.length) container.appendChild(row("Input", shapesIn.join("\n")));
  if (shapesOut.length) container.appendChild(row("Output", shapesOut.join("\n")));
  if (node.source) {
    container.appendChild(row("Code", `${baseName(node.source.file)}:${node.source.startLine}`));
  }
}

export function renderNotice(
  container: HTMLElement, notice: Notice | null, onAction: (action: NoticeAction) => void,
): void {
  container.replaceChildren();
  container.className = "notice";
  container.hidden = notice === null;
  if (!notice) return;
  container.classList.add("notice-" + notice.level);
  const text = document.createElement("span");
  text.textContent = notice.text;
  container.appendChild(text);
  if (notice.action) {
    const action = notice.action;
    const button = document.createElement("button");
    button.textContent = ACTION_LABELS[action];
    button.addEventListener("click", () => onAction(action));
    container.appendChild(button);
  }
}
