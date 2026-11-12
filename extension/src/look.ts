// How a block is drawn: a role gives it a shape and a colour. Pure functions, no DOM, no vscode.
import type { Color, Graph, Look, Node, Shape } from "./ir";

export const SHAPES: readonly Shape[] = ["rect", "rounded", "trapezoid-narrow", "trapezoid-wide", "hexagon", "circle"];
export const COLORS: readonly Color[] = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "gray", "none"];

/** Roles with a fixed look. The data flow runs left to right, so "narrow" narrows to the right. */
export const ROLE_LOOKS: Record<string, { shape: Shape; color: Color }> = {
  encoder: { shape: "trapezoid-narrow", color: "blue" },
  decoder: { shape: "trapezoid-wide", color: "green" },
  discriminator: { shape: "trapezoid-narrow", color: "red" },
  attention: { shape: "hexagon", color: "purple" },
  sequence: { shape: "rect", color: "teal" },
  embedding: { shape: "rounded", color: "yellow" },
  head: { shape: "rounded", color: "orange" },
  loss: { shape: "rounded", color: "pink" },
  activation: { shape: "circle", color: "gray" },
};

/** The roles a language model may choose from; activations are decided by rule. */
export const MODEL_ROLES: readonly string[] = Object.keys(ROLE_LOOKS).filter((r) => r !== "activation");

export const MAX_ROLE_NAME = 20;

/** A role as the language model gave it: nothing in it is trusted. */
export type RoleEntry = { role: string; shape?: string; color?: string };
/** Class name → look. */
export type RoleMap = Record<string, Look>;
/** One entry of "styles" in .vscode/code-diagrammer.json. */
export type StyleOverride = { role?: string; shape?: string; color?: string };

const isShape = (x: unknown): x is Shape => typeof x === "string" && (SHAPES as readonly string[]).includes(x);
const isColor = (x: unknown): x is Color => typeof x === "string" && (COLORS as readonly string[]).includes(x);
const tableLook = (role: string): Look | undefined =>
  Object.hasOwn(ROLE_LOOKS, role) ? { role, ...ROLE_LOOKS[role] } : undefined;

/**
 * A table role always gets the table's look. Any other role is one the model invented: it uses the
 * model's shape and colour, and looks the same wherever it appears (`invented` remembers the first).
 */
export function resolveLook(entry: RoleEntry, invented: Map<string, Look>): Look | undefined {
  if (typeof entry.role !== "string") return undefined;
  const name = entry.role.trim().slice(0, MAX_ROLE_NAME).trim();
  if (!name) return undefined;
  const key = name.toLowerCase();
  const fixed = tableLook(key);
  if (fixed) return fixed;
  const known = invented.get(key);
  if (known) return known;
  const look: Look = {
    role: name,
    shape: isShape(entry.shape) ? entry.shape : "rect",
    color: isColor(entry.color) ? entry.color : "none",
  };
  invented.set(key, look);
  return look;
}

/** The user's override on top of `base`. Unknown values are reported and not applied. */
export function overrideLook(o: StyleOverride, base: Look | undefined): { look?: Look; problems: string[] } {
  const problems: string[] = [];
  let look = base;
  if (typeof o.role === "string" && o.role.trim()) {
    const name = o.role.trim().slice(0, MAX_ROLE_NAME).trim();
    look = tableLook(name.toLowerCase())
      ?? { role: name, shape: base?.shape ?? "rect", color: base?.color ?? "none" };
  }
  const plain: Look = { shape: "rect", color: "none" };
  if (o.shape !== undefined) {
    if (isShape(o.shape)) look = { ...(look ?? plain), shape: o.shape };
    else problems.push(`unknown shape ${JSON.stringify(o.shape)}`);
  }
  if (o.color !== undefined) {
    if (isColor(o.color)) look = { ...(look ?? plain), color: o.color };
    else problems.push(`unknown color ${JSON.stringify(o.color)}`);
  }
  return { look, problems };
}

const ACTIVATION_MODULES = new Set([
  "ReLU", "ReLU6", "LeakyReLU", "PReLU", "ELU", "SELU", "GELU", "SiLU", "Mish", "Sigmoid", "Tanh",
  "Softmax", "LogSoftmax", "Softplus", "Hardswish", "Hardtanh", "Hardsigmoid",
]);
const ACTIVATION_OPS = new Set([
  "relu", "relu6", "leaky_relu", "prelu", "elu", "selu", "gelu", "silu", "mish", "sigmoid", "tanh",
  "softmax", "log_softmax", "softplus", "hardswish", "hardtanh", "hardsigmoid",
]);

/** Activation functions are recognised by name, without a language model. */
export function isActivation(node: Node): boolean {
  if (node.kind === "module") return ACTIVATION_MODULES.has(node.type);
  if (node.kind === "op") return ACTIVATION_OPS.has(node.name.replace(/_$/, ""));
  return false;
}

/**
 * Sets `look` on module and concept blocks and on activation ops. Precedence: the user's override,
 * then the model's role for the class (a concept keeps the look it has), then the activation rule.
 * The graph's root is the canvas and never gets a look.
 */
export function applyStyles(
  graph: Graph, roles: RoleMap, overrides: Record<string, StyleOverride>,
): { graph: Graph; problems: string[] } {
  const problems = new Set<string>();
  const activation = tableLook("activation")!;

  const lookOf = (node: Node): Look | undefined => {
    const active = isActivation(node);
    let base: Look | undefined;
    let key: string | undefined;
    if (node.kind === "concept") {
      base = node.look;
    } else if (node.kind === "module") {
      base = (Object.hasOwn(roles, node.type) ? roles[node.type] : undefined) ?? (active ? activation : undefined);
      key = node.type;
    } else if (active) {
      base = activation;
      key = Object.hasOwn(overrides, node.name) ? node.name : node.name.replace(/_$/, "");
    }
    if (key === undefined || !Object.hasOwn(overrides, key)) return base;
    const result = overrideLook(overrides[key], base);
    for (const p of result.problems) problems.add(`${key}: ${p}`);
    return result.look;
  };

  const visit = (node: Node, isRoot: boolean): Node => {
    const { look: _old, ...rest } = node;
    const look = isRoot ? undefined : lookOf(node);
    const children = node.children.map((c) => visit(c, false));
    return look ? { ...rest, children, look } : { ...rest, children };
  };
  return { graph: { ...graph, root: visit(graph.root, true) }, problems: [...problems] };
}
