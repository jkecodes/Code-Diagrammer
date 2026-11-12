// Webview entry point: holds view state and wires messages, layout and rendering together.
import type { Graph } from "../ir";
import { ancestorsOf } from "../locate";
import { modelIdOf } from "../project/projectGraph";
import type { HostMessage, Notice, NoticeAction, WebviewMessage } from "../protocol";
import { nodesAtLine, visibleTargets } from "./cursor";
import { type Box, type Laid, layoutView } from "./layout";
import { focusBox } from "./viewport";
import { applyCursorHighlight, renderDetails, renderDiagram, renderNotice } from "./render";
import { allIds, buildView, formatParams, type ViewState, type VNode } from "./view";

declare function acquireVsCodeApi(): { postMessage(message: WebviewMessage): void };

const vscode = acquireVsCodeApi();
const send = (message: WebviewMessage) => vscode.postMessage(message);

const svg = document.getElementById("diagram") as unknown as SVGSVGElement;
const details = document.getElementById("details") as HTMLElement;
const noticeBar = document.getElementById("notice") as HTMLElement;
const title = document.getElementById("title") as HTMLElement;
const menu = document.getElementById("menu") as HTMLElement;
const showShapeOps = document.getElementById("showShapeOps") as HTMLInputElement;

type Mode = "code" | "paper";

let codeGraph: Graph | null = null;
let paperGraph: Graph | null = null; // the paper view of codeGraph, when the host has sent one
let mode: Mode = "code";
let wantPaper = false; // the user's preference; the paper view is shown whenever one is available
let grouping = false; // the host is working on a paper view (its busy text is shown)
let graph: Graph | null = null; // the graph that is drawn: codeGraph or paperGraph
let view: VNode | null = null;
let laid: Laid | null = null;
let selectedId: string | null = null;
let cursor: { file: string; line: number } | null = null;
let located: string[] = []; // the blocks the host last pointed at (the active file's blocks)
let paperScope: string | undefined; // project graphs: the model the stages were last asked for
const states: Record<Mode, ViewState> = {
  code: { expanded: new Set(), showShapeOps: false },
  paper: { expanded: new Set(), showShapeOps: false },
};
let state: ViewState = states.code;
const viewCode = document.getElementById("viewCode") as HTMLButtonElement;
const viewPaper = document.getElementById("viewPaper") as HTMLButtonElement;
const busy = document.getElementById("busy") as HTMLElement;
const viewFile = document.getElementById("viewFile") as HTMLButtonElement;
const viewProject = document.getElementById("viewProject") as HTMLButtonElement;
const locateButton = document.getElementById("locate") as HTMLButtonElement;
const traceButton = document.getElementById("trace") as HTMLButtonElement;
const isProject = (g: Graph | null): boolean => g?.meta.project !== undefined;
let viewBox = { x: 0, y: 0, width: 800, height: 400 };
let renderToken = 0;

function find(v: VNode, id: string, parent: VNode | null = null): { node: VNode; parent: VNode | null } | null {
  if (v.id === id) return { node: v, parent };
  for (const child of v.children) {
    const hit = find(child, id, v);
    if (hit) return hit;
  }
  return null;
}

function setViewBox(): void {
  svg.setAttribute("viewBox", `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`);
}

function fit(): void {
  if (!laid) return;
  const pad = 24;
  viewBox = { x: -pad, y: -pad, width: laid.width + pad * 2, height: laid.height + pad * 2 };
  setViewBox();
}

function showDetails(): void {
  const hit = view && selectedId ? find(view, selectedId) : null;
  if (!hit) {
    renderDetails(details, null, [], []);
    return;
  }
  const edges = hit.parent?.edges ?? [];
  renderDetails(
    details, hit.node,
    edges.filter((e) => e.to === hit.node.id).map((e) => e.label),
    edges.filter((e) => e.from === hit.node.id).map((e) => e.label),
  );
}

function highlightCursor(): void {
  if (!graph || !view || (!cursor && located.length === 0)) {
    applyCursorHighlight(svg, []);
    return;
  }
  // the block under the editor cursor; without one, the blocks the host located
  const underCursor = cursor ? nodesAtLine(graph, cursor.file, cursor.line) : [];
  applyCursorHighlight(svg, visibleTargets(graph, view, underCursor.length > 0 ? underCursor : located));
}

function findBox(box: Box, id: string): Box | null {
  if (box.id === id) return box;
  for (const child of box.children) {
    const hit = findBox(child, id);
    if (hit) return hit;
  }
  return null;
}

/** Opens the diagram down to these blocks and zooms to the first; with none, shows everything. */
async function locate(ids: string[]): Promise<void> {
  located = ids;
  if (!graph) return;
  if (ids.length === 0) {
    await render(true);
    return;
  }
  for (const id of ancestorsOf(graph, ids)) state.expanded.add(id);
  await render(false);
  const box = laid ? findBox(laid.root, ids[0]) : null;
  if (!box) {
    fit();
    return;
  }
  viewBox = focusBox(box, { width: svg.clientWidth || 0, height: svg.clientHeight || 0 });
  setViewBox();
}

async function render(refit: boolean): Promise<void> {
  if (!graph) return;
  const token = ++renderToken;
  view = buildView(graph, state);
  const next = await layoutView(view);
  if (token !== renderToken) return; // a newer render started while laying out
  laid = next;
  renderDiagram(svg, laid, selectedId, {
    onSelect: (id) => {
      selectedId = id;
      for (const node of svg.querySelectorAll("g.node")) {
        node.classList.toggle("selected", node.getAttribute("data-id") === id);
      }
      showDetails();
    },
    onOpen: (id) => openSource(id),
    onToggle: (id) => {
      if (state.expanded.has(id)) state.expanded.delete(id);
      else state.expanded.add(id);
      void render(false);
    },
  });
  if (refit) fit();
  showDetails();
  highlightCursor();
}

function openSource(id: string): void {
  const hit = view ? find(view, id) : null;
  const source = hit?.node.node?.source;
  if (source) send({ type: "openSource", source });
}

/** Draws the code view or the paper view. Falls back to the code view without a paper graph. */
function show(next: Mode, refit: boolean): void {
  mode = next === "paper" && paperGraph ? "paper" : "code";
  graph = mode === "paper" ? paperGraph : codeGraph;
  state = states[mode];
  viewCode.setAttribute("aria-pressed", String(mode === "code"));
  viewPaper.setAttribute("aria-pressed", String(mode === "paper"));
  if (!graph) return;
  const ids = allIds(graph.root);
  for (const id of [...state.expanded]) if (!ids.has(id)) state.expanded.delete(id);
  if (selectedId && !ids.has(selectedId)) selectedId = null;
  void render(refit);
}

/** A project graph is grouped one model at a time: the selected block's, else the located one, else the first. */
function stagesScope(): string | undefined {
  if (!graph || !codeGraph || !isProject(codeGraph)) return undefined;
  return (selectedId ? modelIdOf(graph, selectedId) : undefined)
    ?? (located.length > 0 ? modelIdOf(graph, located[0]) : undefined)
    ?? codeGraph.root.children[0]?.id;
}

function choosePaper(regenerate: boolean): void {
  wantPaper = true;
  const scopeId = stagesScope();
  if (paperGraph && !regenerate && scopeId === paperScope) {
    show("paper", true);
    return;
  }
  paperScope = scopeId;
  send(scopeId === undefined ? { type: "requestPaper", regenerate } : { type: "requestPaper", regenerate, scopeId });
}

function setBusy(text: string | null): void {
  grouping = text !== null;
  busy.textContent = text ?? "";
}

function chooseCode(): void {
  wantPaper = false;
  if (grouping) send({ type: "cancelPaper" });
  if (mode !== "code") show("code", true);
}

function setGraph(next: Graph): void {
  const project = isProject(next);
  const first = codeGraph === null || isProject(codeGraph) !== project
    || codeGraph.meta.entry.className !== next.meta.entry.className
    || codeGraph.meta.entry.file !== next.meta.entry.file;
  const wasPaper = mode === "paper";
  codeGraph = next;
  paperGraph = null; // a grouping belongs to exactly one graph; the host re-sends it if it still applies
  paperScope = undefined;
  located = []; // the host locates again after a new graph
  setBusy(null); // so is a grouping in flight: the host has dropped it

  viewFile.setAttribute("aria-pressed", String(!project));
  viewProject.setAttribute("aria-pressed", String(project));
  traceButton.hidden = project; // shapes are traced one model at a time
  locateButton.hidden = !project;

  title.replaceChildren(next.root.name);
  const meta = document.createElement("span");
  meta.className = "meta";
  const count = next.meta.project?.models.length ?? 0;
  const parts = project
    ? [count === 1 ? "1 model" : count + " models"]
    : [formatParams(next.root.params, next.root.trainableParams)];
  if (next.meta.mode === "traced") parts.push("shapes traced on " + next.meta.device);
  meta.textContent = parts.filter(Boolean).join(" · ");
  title.appendChild(meta);
  show("code", first || wasPaper);
}

function setPaper(next: Graph): void {
  paperGraph = next;
  if (wantPaper) show("paper", true);
}

// ---- messages from the extension ----

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  if (message.type === "graph") setGraph(message.graph);
  else if (message.type === "notice") showNotice(message);
  else if (message.type === "clearNotice") showNotice(null);
  else if (message.type === "paper") setPaper(message.graph);
  else if (message.type === "busy") setBusy(message.text);
  else if (message.type === "toggleView") {
    if (mode === "paper") chooseCode();
    else choosePaper(false);
  } else if (message.type === "locate") {
    void locate(message.ids);
  } else if (message.type === "cursor") {
    cursor = { file: message.file, line: message.line };
    highlightCursor();
  }
});

function showNotice(notice: Notice | null): void {
  renderNotice(noticeBar, notice, (action: NoticeAction) => send({ type: "action", action }));
}

// ---- toolbar ----

showShapeOps.addEventListener("change", () => {
  states.code.showShapeOps = showShapeOps.checked;
  states.paper.showShapeOps = showShapeOps.checked;
  void render(false);
});
viewCode.addEventListener("click", chooseCode);
viewPaper.addEventListener("click", () => choosePaper(false));
document.getElementById("regroup")!.addEventListener("click", () => choosePaper(true));
traceButton.addEventListener("click", () => send({ type: "action", action: "trace" }));
viewFile.addEventListener("click", () => send({ type: "switchView", view: "file" }));
viewProject.addEventListener("click", () => send({ type: "switchView", view: "project" }));
locateButton.addEventListener("click", () => send({ type: "locate" }));
document.getElementById("fit")!.addEventListener("click", fit);

// ---- pan (drag) and zoom (ctrl + wheel) ----

let drag: { x: number; y: number; moved: boolean } | null = null;

svg.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  drag = { x: event.clientX, y: event.clientY, moved: false };
});
window.addEventListener("pointermove", (event) => {
  if (!drag) return;
  const rect = svg.getBoundingClientRect();
  const scale = Math.max(viewBox.width / rect.width, viewBox.height / rect.height);
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  svg.classList.add("panning");
  viewBox.x -= dx * scale;
  viewBox.y -= dy * scale;
  drag.x = event.clientX;
  drag.y = event.clientY;
  setViewBox();
});
window.addEventListener("pointerup", () => {
  drag = null;
  svg.classList.remove("panning");
});
svg.addEventListener("wheel", (event) => {
  event.preventDefault();
  const rect = svg.getBoundingClientRect();
  if (event.ctrlKey || event.metaKey) {
    const factor = event.deltaY > 0 ? 1.12 : 1 / 1.12;
    const px = (event.clientX - rect.left) / rect.width;
    const py = (event.clientY - rect.top) / rect.height;
    const width = viewBox.width * factor;
    const height = viewBox.height * factor;
    viewBox = {
      x: viewBox.x + (viewBox.width - width) * px,
      y: viewBox.y + (viewBox.height - height) * py,
      width, height,
    };
  } else {
    const scale = Math.max(viewBox.width / rect.width, viewBox.height / rect.height);
    viewBox.x += (event.shiftKey ? event.deltaY : event.deltaX) * scale;
    viewBox.y += (event.shiftKey ? 0 : event.deltaY) * scale;
  }
  setViewBox();
}, { passive: false });

// clicking the empty canvas clears the selection
svg.addEventListener("click", () => {
  selectedId = null;
  for (const node of svg.querySelectorAll("g.node.selected")) node.classList.remove("selected");
  showDetails();
});

// ---- context menu ----

function hideMenu(): void {
  menu.hidden = true;
  menu.replaceChildren();
}

svg.addEventListener("contextmenu", (event) => {
  const target = (event.target as Element).closest("g.node");
  if (!target) return;
  event.preventDefault();
  const id = target.getAttribute("data-id")!;
  menu.replaceChildren();
  const open = document.createElement("button");
  open.textContent = "Open source";
  open.addEventListener("click", () => {
    hideMenu();
    openSource(id);
  });
  const ask = document.createElement("button");
  ask.textContent = "Ask Claude about this block";
  ask.disabled = true;
  ask.title = "Coming in a later version";
  menu.append(open, ask);
  const model = codeGraph?.meta.project?.models.find((m) => m.id === id);
  if (model) {
    const single = document.createElement("button");
    single.textContent = "Open as single model";
    single.title = "Open this model's own diagram, where tensor shapes can be traced";
    single.addEventListener("click", () => {
      hideMenu();
      send({ type: "openModel", file: model.file, className: model.name });
    });
    menu.append(single);
  }
  menu.style.left = event.clientX + "px";
  menu.style.top = event.clientY + "px";
  menu.hidden = false;
});
window.addEventListener("click", hideMenu);
window.addEventListener("blur", hideMenu);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideMenu();
});

showNotice(null);
renderDetails(details, null, [], []);
setViewBox();
send({ type: "ready" });
