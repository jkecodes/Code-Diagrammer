import { expect, test } from "vitest";
import type { Look, Node } from "../src/ir";
import { applyStyles, isActivation, overrideLook, resolveLook, ROLE_LOOKS } from "../src/look";
import { e, g, n, op } from "./helpers";

const ENCODER: Look = { role: "encoder", shape: "trapezoid-narrow", color: "blue" };
const find = (node: Node, id: string): Node | undefined =>
  node.id === id ? node : node.children.map((c) => find(c, id)).find(Boolean);

test("the role table is the one in the design", () => {
  expect(ROLE_LOOKS).toEqual({
    encoder: { shape: "trapezoid-narrow", color: "blue" },
    decoder: { shape: "trapezoid-wide", color: "green" },
    discriminator: { shape: "trapezoid-narrow", color: "red" },
    attention: { shape: "hexagon", color: "purple" },
    sequence: { shape: "rect", color: "teal" },
    embedding: { shape: "rounded", color: "yellow" },
    head: { shape: "rounded", color: "orange" },
    loss: { shape: "rounded", color: "pink" },
    activation: { shape: "circle", color: "gray" },
  });
});

test("a table role always uses the table's look", () => {
  expect(resolveLook({ role: "encoder", shape: "circle", color: "pink" }, new Map())).toEqual(ENCODER);
  expect(resolveLook({ role: " Encoder " }, new Map())).toEqual(ENCODER);
});

test("an invented role uses the model's shape and colour", () => {
  expect(resolveLook({ role: "vocoder", shape: "hexagon", color: "teal" }, new Map()))
    .toEqual({ role: "vocoder", shape: "hexagon", color: "teal" });
});

test("an invented role with a bad shape or colour falls back per part", () => {
  expect(resolveLook({ role: "x", shape: "star", color: "teal" }, new Map()))
    .toEqual({ role: "x", shape: "rect", color: "teal" });
  expect(resolveLook({ role: "x2", shape: "hexagon" }, new Map()))
    .toEqual({ role: "x2", shape: "hexagon", color: "none" });
});

test("the same invented role keeps its first look", () => {
  const seen = new Map<string, Look>();
  resolveLook({ role: "vocoder", shape: "hexagon", color: "teal" }, seen);
  expect(resolveLook({ role: "vocoder", shape: "circle", color: "red" }, seen))
    .toEqual({ role: "vocoder", shape: "hexagon", color: "teal" });
});

test("role names are trimmed and cut to 20 characters; an empty one gives nothing", () => {
  expect(resolveLook({ role: "  " + "ab".repeat(30) }, new Map())?.role).toBe("ab".repeat(10));
  expect(resolveLook({ role: "   " }, new Map())).toBeUndefined();
  expect(resolveLook({ role: 3 as unknown as string }, new Map())).toBeUndefined();
});

test("isActivation: modules by type, ops by name, trailing underscore, others not", () => {
  expect(isActivation(n("x", { type: "GELU" }))).toBe(true);
  expect(isActivation(op("y", "relu"))).toBe(true);
  expect(isActivation(op("z", "relu_"))).toBe(true);
  expect(isActivation(op("s", "sigmoid"))).toBe(true);
  expect(isActivation(op("ls", "log_softmax"))).toBe(true);
  expect(isActivation(n("l", { type: "Linear" }))).toBe(false);
  expect(isActivation(op("a", "add"))).toBe(false);
  expect(isActivation(n("c", { kind: "concept", type: "concept", name: "relu" }))).toBe(false);
  expect(isActivation(n("grp", { kind: "group", type: "relu", name: "relu" }))).toBe(false);
});

test("overrideLook: a table role, a part on top of a base, unknown values reported", () => {
  expect(overrideLook({ role: "decoder" }, ENCODER)).toEqual({
    look: { role: "decoder", shape: "trapezoid-wide", color: "green" }, problems: [],
  });
  expect(overrideLook({ color: "red" }, ENCODER)).toEqual({ look: { ...ENCODER, color: "red" }, problems: [] });
  expect(overrideLook({ shape: "hexagon" }, undefined)).toEqual({ look: { shape: "hexagon", color: "none" }, problems: [] });
  expect(overrideLook({ shape: "star", color: "mauve" }, undefined)).toEqual({
    look: undefined, problems: ['unknown shape "star"', 'unknown color "mauve"'],
  });
  expect(overrideLook({ role: "decoder", shape: "circle" }, undefined).look)
    .toEqual({ role: "decoder", shape: "circle", color: "green" });
});

const model = () => g(
  [
    n("enc", { type: "Enc", children: [n("enc.inner", { type: "Enc" }), op("enc.relu", "relu")], edges: [e("enc.inner", "enc.relu")] }),
    n("blk", { type: "Blk" }),
    n("act", { type: "GELU" }),
    op("add", "add"),
    { ...n("stage", { kind: "concept", type: "concept" }), look: { role: "head", shape: "rounded", color: "orange" } as Look },
  ],
  [e("$in", "enc"), e("enc", "blk"), e("blk", "act"), e("act", "add"), e("add", "stage"), e("stage", "$out")],
);

test("applyStyles: model role by class name at every depth", () => {
  const out = applyStyles(model(), { Enc: ENCODER }, {}).graph;
  expect(find(out.root, "enc")?.look).toEqual(ENCODER);
  expect(find(out.root, "enc.inner")?.look).toEqual(ENCODER);
});

test("applyStyles: activations get the activation look without any role", () => {
  const out = applyStyles(model(), {}, {}).graph;
  const look = { role: "activation", shape: "circle", color: "gray" };
  expect(find(out.root, "enc.relu")?.look).toEqual(look);
  expect(find(out.root, "act")?.look).toEqual(look);
});

test("applyStyles: an override wins over the model and over the activation rule", () => {
  const out = applyStyles(model(), { Enc: ENCODER }, { Enc: { role: "decoder" }, relu: { color: "red" } }).graph;
  expect(find(out.root, "enc")?.look).toEqual({ role: "decoder", shape: "trapezoid-wide", color: "green" });
  expect(find(out.root, "enc.relu")?.look).toEqual({ role: "activation", shape: "circle", color: "red" });
});

test("applyStyles: shape/colour-only override on a class without a role", () => {
  const out = applyStyles(model(), {}, { Blk: { shape: "hexagon" } }).graph;
  expect(find(out.root, "blk")?.look).toEqual({ shape: "hexagon", color: "none" });
});

test("applyStyles: unknown override values are reported once each and not applied", () => {
  const twice = g([n("b1", { type: "Blk" }), n("b2", { type: "Blk" })], [e("b1", "b2")]);
  const out = applyStyles(twice, {}, { Blk: { shape: "star", color: "blue" } });
  expect(find(out.graph.root, "b1")?.look).toEqual({ shape: "rect", color: "blue" });
  expect(out.problems).toEqual(['Blk: unknown shape "star"']);
});

test("applyStyles: a concept keeps its look; plain blocks, plain ops and the root get none", () => {
  const out = applyStyles(model(), {}, { add: { color: "red" } }).graph;
  expect(find(out.root, "stage")?.look).toEqual({ role: "head", shape: "rounded", color: "orange" });
  expect(find(out.root, "blk")?.look).toBeUndefined();
  expect(find(out.root, "add")?.look).toBeUndefined();
  expect(out.root.look).toBeUndefined();
});

test("applyStyles does not mutate its input", () => {
  const graph = model();
  const before = JSON.stringify(graph);
  applyStyles(graph, { Enc: ENCODER }, { Blk: { shape: "hexagon" } });
  expect(JSON.stringify(graph)).toBe(before);
});
