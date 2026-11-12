// Which diagram nodes correspond to the editor cursor. Pure functions.
import type { Graph, Node } from "../ir";
import { normalizePath } from "../locate";
import type { VNode } from "./view";

export { normalizePath };

/**
 * Ids of the innermost nodes whose source range contains `line` (1-based).
 * Several instances of one class share a range, so all of them are returned.
 */
export function nodesAtLine(graph: Graph, file: string, line: number): string[] {
  const wanted = normalizePath(file);
  let best = Infinity;
  let ids: string[] = [];
  const visit = (node: Node) => {
    const s = node.source;
    if (s && s.startLine <= line && line <= s.endLine && normalizePath(s.file) === wanted) {
      const size = s.endLine - s.startLine;
      if (size < best) {
        best = size;
        ids = [node.id];
      } else if (size === best) {
        ids.push(node.id);
      }
    }
    node.children.forEach(visit);
  };
  visit(graph.root);
  return ids;
}

/** Each id itself if it is drawn, otherwise its nearest drawn ancestor. The view is not changed. */
export function visibleTargets(graph: Graph, view: VNode, ids: string[]): string[] {
  const parent = new Map<string, string>();
  const index = (node: Node) => {
    for (const child of node.children) {
      parent.set(child.id, node.id);
      index(child);
    }
  };
  index(graph.root);

  const visible = new Set<string>();
  const collect = (v: VNode) => {
    if (v.kind !== "terminal") visible.add(v.id);
    v.children.forEach(collect);
  };
  collect(view);

  const out: string[] = [];
  for (const id of ids) {
    let current: string | undefined = id;
    while (current !== undefined && !visible.has(current)) current = parent.get(current);
    if (current !== undefined && !out.includes(current)) out.push(current);
  }
  return out;
}
