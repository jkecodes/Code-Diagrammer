// Small builders for hand-written IR graphs used by the webview tests.
import type { Edge, Graph, Node } from "../src/ir";

export function n(id: string, extra: Partial<Node> = {}): Node {
  const name = id.includes(".") ? id.slice(id.lastIndexOf(".") + 1) : id;
  return {
    id, name, kind: "module", type: "Linear", source: null, params: null, trainableParams: null,
    shapeOnly: false, repeated: false, children: [], edges: [], ...extra,
  };
}

export function op(id: string, name: string, extra: Partial<Node> = {}): Node {
  return n(id, { name, kind: "op", type: name, ...extra });
}

export function e(from: string, to: string, shape: number[] | null = null, uncertain = false): Edge {
  return { from, to, outIndex: 0, shape, dtype: null, uncertain };
}

export function g(children: Node[], edges: Edge[]): Graph {
  return {
    version: 1,
    meta: {
      mode: "traced", analyzerVersion: "0.1.0", entry: { file: "m.py", className: "Net" },
      ctorKwargs: null, inputs: null, device: "meta", traceError: null,
    },
    root: n("root", { name: "Net", type: "Net", children, edges }),
  };
}
