// One graph for the whole project: every main model is a top-level block. Pure functions.
import { type Graph, IN, type Node, OUT, type ProjectModelRef } from "../ir";

/** `graph` is null when the model could not be analysed. */
export type ProjectPart = { name: string; file: string; line: number; summary: string; graph: Graph | null };

export const MAX_PROJECT_MODELS = 12;

function prefixed(node: Node, prefix: string): Node {
  const id = (x: string) => (x === IN || x === OUT ? x : prefix + x);
  return {
    ...node,
    id: prefix + node.id,
    children: node.children.map((c) => prefixed(c, prefix)),
    edges: node.edges.map((e) => ({ ...e, from: id(e.from), to: id(e.to) })),
  };
}

function leaf(part: ProjectPart, id: string): Node {
  return {
    id, name: part.name, kind: "module", type: part.name,
    source: { file: part.file, startLine: part.line, endLine: part.line },
    params: null, trainableParams: null, shapeOnly: false, repeated: false, children: [], edges: [],
  };
}

/** Models are laid side by side; nothing connects them (that wiring lives in training code). */
export function buildProjectGraph(projectName: string, parts: ProjectPart[]): Graph {
  if (parts.length === 0) throw new Error("buildProjectGraph needs at least one model");
  const models: ProjectModelRef[] = [];
  const children = parts.map((part, index): Node => {
    const prefix = `m${index}/`;
    const node = part.graph ? prefixed(part.graph.root, prefix) : leaf(part, prefix + "root");
    models.push({ id: node.id, name: part.name, file: part.file, summary: part.summary });
    return part.summary ? { ...node, name: part.name, description: part.summary } : { ...node, name: part.name };
  });
  return {
    version: 1,
    meta: {
      mode: "static",
      analyzerVersion: parts.find((p) => p.graph)?.graph?.meta.analyzerVersion ?? "",
      entry: { file: parts[0].file, className: parts[0].name },
      ctorKwargs: null, inputs: null, device: null, traceError: null,
      project: { models },
    },
    root: {
      id: "root", name: projectName, kind: "group", type: "project", source: null,
      params: null, trainableParams: null, shapeOnly: false, repeated: false, children, edges: [],
    },
  };
}

/** The id of the top-level model block that contains `nodeId` (or is it). */
export function modelIdOf(graph: Graph, nodeId: string): string | undefined {
  const contains = (node: Node): boolean => node.id === nodeId || node.children.some(contains);
  return graph.root.children.find(contains)?.id;
}
