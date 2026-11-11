// Visible graph -> ELK layout -> absolute positions.
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import type { VEdge, VNode } from "./view";

export type Box = {
  id: string; x: number; y: number; width: number; height: number; v: VNode; children: Box[];
};

export type Path = {
  points: { x: number; y: number }[];
  label: string;
  labelAt: { x: number; y: number }; // center of the label
  uncertain: boolean;
};

export type Laid = { width: number; height: number; root: Box; paths: Path[] };

const CHAR = 8;
const HEADER = 34; // room for an expanded block's own label

function leafSize(v: VNode): { width: number; height: number } {
  if (v.kind === "terminal") return { width: 12, height: 12 };
  const longest = Math.max(v.label.length, v.sublabel.length);
  const toggle = v.expandable ? 22 : 0;
  return { width: Math.max(96, CHAR * longest + 24 + toggle), height: v.kind === "op" ? 28 : 44 };
}

function edgeId(parentId: string, index: number): string {
  return parentId + "|" + index;
}

export function toElk(v: VNode): ElkNode {
  const node: ElkNode = { id: v.id };
  if (!v.expanded) {
    Object.assign(node, leafSize(v));
    return node;
  }
  node.children = v.children.map(toElk);
  node.edges = v.edges.map((e, i): ElkExtendedEdge => ({
    id: edgeId(v.id, i),
    sources: [e.from],
    targets: [e.to],
    labels: e.label ? [{ text: e.label, width: 7 * e.label.length + 8, height: 16 }] : [],
  }));
  node.layoutOptions = {
    "elk.algorithm": "layered",
    "elk.direction": "RIGHT",
    "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    "elk.padding": `[top=${HEADER + 10},left=14,bottom=14,right=14]`,
    "elk.spacing.nodeNode": "22",
    "elk.layered.spacing.nodeNodeBetweenLayers": "34",
    "elk.spacing.edgeLabel": "4",
    "elk.edgeLabels.inline": "false",
    "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  };
  return node;
}

const elk = new ELK();

export async function layoutView(v: VNode): Promise<Laid> {
  const result = await elk.layout(toElk(v));
  const paths: Path[] = [];

  function walk(elkNode: ElkNode, view: VNode, ox: number, oy: number): Box {
    const x = ox + (elkNode.x ?? 0);
    const y = oy + (elkNode.y ?? 0);
    const box: Box = {
      id: view.id, x, y, width: elkNode.width ?? 0, height: elkNode.height ?? 0, v: view, children: [],
    };
    const byId = new Map(view.children.map((c) => [c.id, c]));
    for (const child of elkNode.children ?? []) {
      const childView = byId.get(child.id);
      if (childView) box.children.push(walk(child, childView, x, y));
    }
    (elkNode.edges ?? []).forEach((edge) => {
      const index = Number(edge.id.slice(edge.id.lastIndexOf("|") + 1));
      const viewEdge: VEdge | undefined = view.edges[index];
      const section = edge.sections?.[0];
      if (!viewEdge || !section) return;
      const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]
        .map((p) => ({ x: x + p.x, y: y + p.y }));
      const label = edge.labels?.[0];
      const mid = points[Math.floor(points.length / 2)];
      const labelAt = label && label.x !== undefined && label.y !== undefined
        ? { x: x + label.x + (label.width ?? 0) / 2, y: y + label.y + (label.height ?? 0) / 2 }
        : mid;
      paths.push({ points, label: viewEdge.label, labelAt, uncertain: viewEdge.uncertain });
    });
    return box;
  }

  const root = walk(result, v, 0, 0);
  return { width: root.width, height: root.height, root, paths };
}
