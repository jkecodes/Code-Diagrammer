// Which blocks of a diagram the active editor file defines. Pure functions, shared by host and webview.
import type { Graph, Node } from "./ir";

/** Forward slashes; Windows drive paths compare case-insensitively. */
export function normalizePath(p: string): string {
  const slashed = p.replace(/\\/g, "/");
  return /^[a-zA-Z]:\//.test(slashed) ? slashed.toLowerCase() : slashed;
}

export const MAX_LOCATE_EXPAND = 20;

/**
 * Ids, in diagram order, of the module blocks whose class is defined in `file`. With the cursor
 * (`line`, 1-based) inside such a class: the blocks of the innermost class around it. Otherwise:
 * the outermost blocks the file defines. The graph's root is the canvas and never a target.
 */
export function locateTargets(graph: Graph, file: string, line: number): string[] {
  const wanted = normalizePath(file);
  type Candidate = { id: string; size: number; hit: boolean; nested: boolean };
  const candidates: Candidate[] = [];
  const visit = (node: Node, insideCandidate: boolean) => {
    for (const child of node.children) {
      const s = child.source;
      const mine = child.kind === "module" && s !== null && normalizePath(s.file) === wanted;
      if (mine) {
        candidates.push({
          id: child.id, size: s.endLine - s.startLine,
          hit: s.startLine <= line && line <= s.endLine, nested: insideCandidate,
        });
      }
      visit(child, insideCandidate || mine);
    }
  };
  visit(graph.root, false);

  const hits = candidates.filter((c) => c.hit);
  if (hits.length > 0) {
    const smallest = Math.min(...hits.map((c) => c.size));
    return hits.filter((c) => c.size === smallest).map((c) => c.id);
  }
  return candidates.filter((c) => !c.nested).map((c) => c.id);
}

/** Every block that must be expanded to show the first targets; the root is always expanded. */
export function ancestorsOf(graph: Graph, ids: string[]): string[] {
  const parent = new Map<string, string>();
  const index = (node: Node) => {
    for (const child of node.children) {
      parent.set(child.id, node.id);
      index(child);
    }
  };
  index(graph.root);
  const out: string[] = [];
  for (const id of ids.slice(0, MAX_LOCATE_EXPAND)) {
    const chain: string[] = [];
    for (let p = parent.get(id); p !== undefined && p !== graph.root.id; p = parent.get(p)) chain.unshift(p);
    for (const p of chain) if (!out.includes(p)) out.push(p);
  }
  return out;
}
