// Paper-style grouping: a language model proposes named groups of top-level blocks; this file
// validates them and builds the "paper view". Edges and shapes always come from the IR.
import { type Edge, type Graph, IN, type Node, OUT } from "../ir";
import { LlmError } from "./provider";
import { extractJson, type LlmService } from "./service";

export type Group = { name: string; description: string; nodeIds: string[] };
export type Rejection = { name: string; reason: string };
export type ReadLines = (file: string, start: number, end: number) => string[];

const MAX_NAME = 40;
const MAX_EXCERPT_LINES = 15;
const MAX_NODES_WITH_EXCERPTS = 150;
const MIN_NODES = 4;
const KIND = "grouping";

// ---- describing the graph to the model ------------------------------------------------------

function shapeText(shape: number[] | null): string {
  return shape ? "[" + shape.join(", ") + "]" : "?";
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function describeGraph(graph: Graph, readLines: ReadLines): string {
  const { root } = graph;
  const withExcerpts = root.children.length <= MAX_NODES_WITH_EXCERPTS;
  const blocks = root.children.map((node) => {
    const entering = root.edges.filter((e) => e.to === node.id);
    const leaving = root.edges.filter((e) => e.from === node.id);
    const lines = [
      `- id: ${node.id}`,
      `  kind: ${node.kind}, type: ${node.type}` + (node.params !== null ? `, params: ${node.params}` : ""),
      `  in: ${unique(entering.map((e) => shapeText(e.shape))).join(", ") || "-"}`,
      `  out: ${unique(leaving.map((e) => shapeText(e.shape))).join(", ") || "-"}`,
      `  from: ${unique(entering.map((e) => e.from)).join(", ") || "-"}`,
      `  to: ${unique(leaving.map((e) => e.to)).join(", ") || "-"}`,
    ];
    if (withExcerpts && node.source) {
      const { file, startLine, endLine } = node.source;
      const code = readLines(file, startLine, Math.min(endLine, startLine + MAX_EXCERPT_LINES - 1));
      if (code.length > 0) lines.push("  code:", ...code.slice(0, MAX_EXCERPT_LINES).map((l) => "    " + l));
    }
    return lines.join("\n");
  });
  return [`Model: ${root.type}`, "Blocks in forward order ($in / $out are the model's input / output):", ...blocks].join("\n");
}

export function groupingPrompt(description: string, errors?: Rejection[]): string {
  const lines = [
    "Below is the forward pass of a PyTorch model as a list of blocks with tensor shapes.",
    "Group neighbouring blocks into the 3 to 8 conceptual stages a paper's architecture figure would show,",
    'and give each stage a short name (at most 40 characters), e.g. "Frequency Pooling", "Regression Head".',
    "Rules: use only the listed ids; a block belongs to at most one group; a group has at least two blocks;",
    "the blocks of a group must be directly connected to each other; do not put everything in one group;",
    "leave a block ungrouped when it is a stage on its own.",
    "",
    description,
    "",
    'Answer with JSON only: {"groups": [{"name": "...", "description": "one sentence", "nodeIds": ["id", "id"]}]}',
  ];
  if (errors !== undefined) {
    lines.push("", "Your previous answer could not be used:");
    if (errors.length === 0) lines.push("- it was not JSON in the requested format");
    for (const r of errors) lines.push(`- ${r.name}: ${r.reason}`);
    lines.push("Answer again, following the rules.");
  }
  return lines.join("\n");
}

// ---- validating the model's answer ----------------------------------------------------------

function connected(members: string[], edges: Edge[]): boolean {
  const inGroup = new Set(members);
  const seen = new Set([members[0]]);
  const queue = [members[0]];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const e of edges) {
      const next = e.from === current ? e.to : e.to === current ? e.from : undefined;
      if (next !== undefined && inGroup.has(next) && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen.size === inGroup.size;
}

/** Whether the top-level graph has a cycle once every group is collapsed into one node. */
function cyclic(edges: Edge[], owner: Map<string, string>): boolean {
  const next = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.from === IN || e.to === OUT) continue;
    const from = owner.get(e.from) ?? e.from;
    const to = owner.get(e.to) ?? e.to;
    if (from === to) continue;
    (next.get(from) ?? next.set(from, new Set()).get(from)!).add(to);
  }
  const state = new Map<string, 1 | 2>(); // 1 = on the current path, 2 = done
  const visit = (node: string): boolean => {
    if (state.get(node) === 1) return true;
    if (state.get(node) === 2) return false;
    state.set(node, 1);
    for (const target of next.get(node) ?? []) if (visit(target)) return true;
    state.set(node, 2);
    return false;
  };
  return [...next.keys()].some(visit);
}

/**
 * Keeps the groups that are safe to draw. Throws LlmError("invalid-output") when nothing usable
 * is left. Only the graph's top-level blocks can be grouped.
 */
export function validateGroups(raw: unknown, graph: Graph): { groups: Group[]; rejected: Rejection[] } {
  const list = (raw as { groups?: unknown } | null)?.groups;
  if (!raw || typeof raw !== "object" || !Array.isArray(list)) {
    throw new LlmError("invalid-output", "The language model did not return a list of groups");
  }
  const { root } = graph;
  const top = new Set(root.children.map((c) => c.id));
  const taken = new Set<string>();
  const owner = new Map<string, string>();
  const names = new Map<string, number>();
  const groups: Group[] = [];
  const rejected: Rejection[] = [];
  const alreadyCyclic = cyclic(root.edges, owner);

  for (const entry of list) {
    const item = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const name = typeof item.name === "string" ? item.name.trim().slice(0, MAX_NAME).trim() : "";
    if (!name) {
      rejected.push({ name: "(unnamed)", reason: "has no name" });
      continue;
    }
    const wanted = Array.isArray(item.nodeIds) ? item.nodeIds : [];
    const nodeIds = unique(wanted.filter((id): id is string => typeof id === "string" && top.has(id) && !taken.has(id)));
    if (nodeIds.length < 2) {
      rejected.push({ name, reason: "needs at least two blocks" });
      continue;
    }
    if (!connected(nodeIds, root.edges)) {
      rejected.push({ name, reason: "blocks are not adjacent in the data flow" });
      continue;
    }
    const key = `group:${groups.length}`;
    const trial = new Map(owner);
    for (const id of nodeIds) trial.set(id, key);
    if (!alreadyCyclic && cyclic(root.edges, trial)) {
      rejected.push({ name, reason: "would create a cycle" });
      continue;
    }
    for (const id of nodeIds) {
      taken.add(id);
      owner.set(id, key);
    }
    const count = (names.get(name) ?? 0) + 1;
    names.set(name, count);
    groups.push({
      name: count === 1 ? name : `${name} ${count}`,
      description: typeof item.description === "string" ? item.description.trim() : "",
      nodeIds,
    });
  }
  if (groups.length === 0) {
    throw new LlmError("invalid-output", "The language model proposed no usable group");
  }
  if (groups.length === 1 && groups[0].nodeIds.length === top.size) {
    throw new LlmError("invalid-output", "The language model put every block into one group");
  }
  return { groups, rejected };
}

// ---- building the paper view ----------------------------------------------------------------

function sum(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
}

function pushUnique(into: Edge[], edge: Edge): void {
  const same = (x: Edge) => x.from === edge.from && x.to === edge.to && x.outIndex === edge.outIndex
    && JSON.stringify(x.shape) === JSON.stringify(edge.shape);
  if (!into.some(same)) into.push(edge);
}

/** Pure: wraps each group's blocks in a "concept" node. `groups` must come from validateGroups. */
export function applyGrouping(graph: Graph, groups: Group[]): Graph {
  const { root } = graph;
  const owner = new Map<string, number>();
  groups.forEach((group, index) => group.nodeIds.forEach((id) => owner.set(id, index)));
  const conceptId = (index: number) => `root/concept:${index}`;

  const concepts = groups.map((group, index): Node => {
    const members = root.children.filter((c) => owner.get(c.id) === index);
    const entering: Edge[] = [];
    const internal: Edge[] = [];
    const leaving: Edge[] = [];
    for (const edge of root.edges) {
      const fromIn = owner.get(edge.from) === index;
      const toIn = owner.get(edge.to) === index;
      if (fromIn && toIn) internal.push({ ...edge });
      else if (toIn) pushUnique(entering, { ...edge, from: IN });
      else if (fromIn) pushUnique(leaving, { ...edge, to: OUT });
    }
    return {
      id: conceptId(index), name: group.name, kind: "concept", type: "concept",
      description: group.description,
      source: members[0]?.source ?? null,
      params: sum(members.map((m) => m.params)),
      trainableParams: sum(members.map((m) => m.trainableParams)),
      shapeOnly: false, repeated: false,
      children: members,
      edges: [...entering, ...internal, ...leaving],
    };
  });

  const children: Node[] = [];
  const placed = new Set<number>();
  for (const child of root.children) {
    const index = owner.get(child.id);
    if (index === undefined) {
      children.push(child);
    } else if (!placed.has(index)) {
      placed.add(index);
      children.push(concepts[index]);
    }
  }

  const edges: Edge[] = [];
  for (const edge of root.edges) {
    const from = owner.get(edge.from);
    const to = owner.get(edge.to);
    if (from !== undefined && from === to) continue; // inside one concept
    pushUnique(edges, {
      ...edge,
      from: from === undefined ? edge.from : conceptId(from),
      to: to === undefined ? edge.to : conceptId(to),
    });
  }
  return { ...graph, meta: { ...graph.meta }, root: { ...root, children, edges } };
}

// ---- asking the model -----------------------------------------------------------------------

type Checked = { groups: Group[]; rejected: Rejection[] };

function check(text: string, graph: Graph): Checked | undefined {
  try {
    return validateGroups(extractJson(text), graph);
  } catch (e) {
    if (e instanceof LlmError && e.kind === "invalid-output") return undefined;
    throw e;
  }
}

/**
 * Throws LlmError. With `cacheOnly` it never calls the model, shows no UI and returns undefined
 * unless a usable answer is already cached.
 */
export async function groupGraph(
  graph: Graph, llm: LlmService, readLines: ReadLines,
  opts: { regenerate?: boolean; signal?: AbortSignal; cacheOnly?: boolean } = {},
): Promise<{ paper: Graph; groups: Group[] } | undefined> {
  if (graph.root.children.length < MIN_NODES) {
    if (opts.cacheOnly) return undefined;
    throw new LlmError("invalid-output", "Too small to group");
  }
  const description = describeGraph(graph, readLines);
  const get = async (prompt: string): Promise<string | undefined> => {
    if (opts.cacheOnly) return (await llm.cached(prompt, KIND))?.text;
    return (await llm.ask(prompt, { kind: KIND, regenerate: opts.regenerate, signal: opts.signal })).text;
  };
  const done = (checked: Checked) => ({ paper: applyGrouping(graph, checked.groups), groups: checked.groups });

  const firstText = await get(groupingPrompt(description));
  if (firstText === undefined) return undefined;
  const first = check(firstText, graph);
  if (first && !(first.rejected.length > 0 && first.groups.length < 2)) return done(first);

  // one retry, telling the model what was wrong
  const secondText = await get(groupingPrompt(description, first?.rejected ?? []));
  const second = secondText === undefined ? undefined : check(secondText, graph);
  if (second && (!first || second.groups.length >= first.groups.length)) return done(second);
  if (first) return done(first);
  if (opts.cacheOnly) return undefined;
  throw new LlmError("invalid-output", "The language model's grouping could not be used");
}
