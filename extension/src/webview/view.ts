// IR + view state -> the graph that is actually drawn. Pure functions, no DOM.
import { type Edge, type Graph, IN, type Node, OUT } from "../ir";

export type ViewState = { expanded: Set<string>; showShapeOps: boolean };

export type VEdge = { from: string; to: string; label: string; uncertain: boolean };

export type VNode = {
  id: string;
  label: string;
  sublabel: string;
  kind: "module" | "op" | "group" | "concept" | "terminal";
  expandable: boolean;
  expanded: boolean;
  node: Node | null; // null for terminals
  children: VNode[];
  edges: VEdge[];
};

export function formatShape(shape: number[] | null): string {
  return shape ? "[" + shape.join(", ") + "]" : "";
}

function shortCount(n: number): string {
  const trim = (x: number) => x.toFixed(1).replace(/\.0$/, "");
  if (n >= 1e9) return trim(n / 1e9) + "B";
  if (n >= 1e6) return trim(n / 1e6) + "M";
  if (n >= 1e3) return trim(n / 1e3) + "K";
  return String(n);
}

/** Total parameter count; the trainable count is added when some parameters are frozen. */
export function formatParams(n: number | null, trainable: number | null = null): string {
  if (n === null) return "";
  const total = shortCount(n) + " params";
  if (trainable === null || trainable === n) return total;
  return total + " (" + shortCount(trainable) + " trainable)";
}

function labels(node: Node, isRoot: boolean): { label: string; sublabel: string } {
  if (node.repeated) return { label: node.type + " x N", sublabel: "" };
  if (node.kind === "concept") {
    const size = formatParams(node.params, node.trainableParams);
    return { label: node.name, sublabel: node.children.length + " blocks" + (size ? " · " + size : "") };
  }
  if (node.kind === "module" && !isRoot && node.type !== node.name) {
    return { label: node.name, sublabel: node.type };
  }
  return { label: node.name, sublabel: "" };
}

function joinShapes(entering: string, leaving: string): string {
  if (entering === leaving || leaving === "") return entering;
  if (entering === "") return leaving;
  return entering + " → " + leaving;
}

/** Replace chains of shape-only nodes (one edge in, one edge out) by a single labeled edge. */
function foldShapeOps(node: Node): { children: Node[]; edges: VEdge[] } {
  const incoming = new Map<string, Edge[]>();
  const outgoing = new Map<string, Edge[]>();
  for (const edge of node.edges) {
    (outgoing.get(edge.from) ?? outgoing.set(edge.from, []).get(edge.from)!).push(edge);
    (incoming.get(edge.to) ?? incoming.set(edge.to, []).get(edge.to)!).push(edge);
  }
  const foldable = new Set(
    node.children
      .filter((c) => c.shapeOnly && incoming.get(c.id)?.length === 1 && outgoing.get(c.id)?.length === 1)
      .map((c) => c.id),
  );
  const edges: VEdge[] = [];
  for (const edge of node.edges) {
    if (foldable.has(edge.from)) continue; // consumed by the walk that entered the chain
    let last = edge;
    let uncertain = edge.uncertain;
    const visited = new Set<string>();
    while (foldable.has(last.to) && !visited.has(last.to)) {
      visited.add(last.to);
      last = outgoing.get(last.to)![0];
      uncertain = uncertain || last.uncertain;
    }
    edges.push({
      from: edge.from, to: last.to,
      label: joinShapes(formatShape(edge.shape), formatShape(last.shape)),
      uncertain,
    });
  }
  return { children: node.children.filter((c) => !foldable.has(c.id)), edges };
}

function build(node: Node, state: ViewState, isRoot: boolean): VNode {
  const expandable = node.children.length > 0;
  const expanded = expandable && (isRoot || state.expanded.has(node.id));
  const v: VNode = {
    id: node.id, ...labels(node, isRoot), kind: node.kind, expandable, expanded, node,
    children: [], edges: [],
  };
  if (!expanded) return v;

  const { children, edges } = state.showShapeOps
    ? {
        children: node.children,
        edges: node.edges.map((e) => ({
          from: e.from, to: e.to, label: formatShape(e.shape), uncertain: e.uncertain,
        })),
      }
    : foldShapeOps(node);

  const inId = node.id + "/" + IN;
  const outId = node.id + "/" + OUT;
  v.edges = edges.map((e) => ({
    ...e, from: e.from === IN ? inId : e.from, to: e.to === OUT ? outId : e.to,
  }));
  const terminal = (id: string): VNode => ({
    id, label: "", sublabel: "", kind: "terminal", expandable: false, expanded: false,
    node: null, children: [], edges: [],
  });
  if (v.edges.some((e) => e.from === inId)) v.children.push(terminal(inId));
  for (const child of children) v.children.push(build(child, state, false));
  if (v.edges.some((e) => e.to === outId)) v.children.push(terminal(outId));
  return v;
}

/** The root is always expanded. */
export function buildView(graph: Graph, state: ViewState): VNode {
  return build(graph.root, state, true);
}

/** Every node id in the IR, used to drop expanded ids that no longer exist. */
export function allIds(node: Node, into: Set<string> = new Set()): Set<string> {
  into.add(node.id);
  for (const c of node.children) allIds(c, into);
  return into;
}
