// Positions -> SVG, plus the details pane and the notice bar. No layout logic here.
import { ACTION_LABELS } from "../messages";
import type { Notice, NoticeAction } from "../protocol";
import type { Box, Laid } from "./layout";
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
  const g = el("g", { class: classes.join(" "), "data-id": v.id });
  g.appendChild(el("rect", {
    class: "shape", x: box.x, y: box.y, width: box.width, height: box.height,
    rx: v.kind === "op" ? 14 : 6,
  }));

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
  const params = formatParams(node.params);
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
