// TypeScript mirror of the analyzer's JSON IR (see analyzer/code_diagrammer/ir.py).

export type SourceRange = { file: string; startLine: number; endLine: number };

export type Edge = {
  from: string; // child id, or "$in"
  to: string; // child id, or "$out"
  outIndex: number;
  shape: number[] | null;
  dtype: string | null;
  uncertain: boolean;
};

export type Node = {
  id: string;
  name: string;
  kind: "module" | "op" | "group";
  type: string;
  source: SourceRange | null;
  params: number | null; // all parameters, including frozen ones
  trainableParams: number | null; // parameters with requires_grad=True
  shapeOnly: boolean;
  repeated: boolean;
  children: Node[];
  edges: Edge[];
};

export type InputSpec = number[] | { shape: number[]; dtype?: string } | { value: unknown };

export type Meta = {
  mode: "static" | "traced";
  analyzerVersion: string;
  entry: { file: string; className: string };
  ctorKwargs: Record<string, unknown> | null;
  inputs: Record<string, InputSpec> | null;
  device: "meta" | "cpu" | null;
  traceError: string | null;
};

export type Graph = { version: 1; meta: Meta; root: Node };

export type ParamInfo = { name: string; hasDefault: boolean };

export type ClassInfo = {
  name: string;
  line: number;
  topLevel: boolean;
  initParams: ParamInfo[];
  forwardParams: ParamInfo[];
};

export type ScannedClass = {
  name: string;
  file: string;
  line: number;
  forwardParams: string[];
  docstring: string;
  submoduleTypes: string[];
  candidate: boolean; // has forward and is no other workspace class's submodule
};

export const IN = "$in";
export const OUT = "$out";
