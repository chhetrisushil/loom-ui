// ── Diagram text: the ONE outline every renderer and the accessible fallback read ─────────────────
// Zod-free. A tree reads as an indented outline, a flow or network as one arrow per edge, a timeline
// as dated lines. Labels are DATA: copied as written, never translated, never parsed as markup.

import { diagramGraph } from "./diagramGraph";
import { type TimeLabelWords, formatTimeLabel } from "./timeWords";
import type { DiagramValue } from "./values";

export interface OutlineLine {
  /** Nesting depth (a tree's depth; 0 for every other layout). */
  readonly depth: number;
  readonly text: string;
}

/** The arrow between two labels of an edge line. */
export const OUTLINE_ARROW = "→";
/** Between a timeline date and its label. */
export const OUTLINE_DASH = "—";

const edgeText = (from: string, to: string, label: string | undefined): string =>
  `${from} ${OUTLINE_ARROW} ${to}${label === undefined || label === "" ? "" : ` (${label})`}`;

/**
 * The diagram as text lines. `locale` and `words` format a timeline's dates (`formatTimeLabel`, the
 * value's `timeFormat`, else day granularity). Total on any value, a checked one in particular.
 */
export function diagramOutline(
  value: DiagramValue,
  locale: string,
  words: TimeLabelWords
): OutlineLine[] {
  const { nodes, edges } = value;
  const label = (i: number): string => (nodes[i] as { label: string }).label;
  switch (value.layout) {
    case "timeline": {
      const format = value.timeFormat ?? { granularity: "day" as const };
      return nodes
        .map((node, i) => ({ i, time: Date.parse(node.at ?? "") }))
        .sort((a, b) => (a.time || 0) - (b.time || 0) || a.i - b.i)
        .map(({ i }) => {
          const at = (nodes[i] as { at?: string }).at ?? "";
          const when = formatTimeLabel(at, format, locale, words) ?? at;
          return { depth: 0, text: `${when} ${OUTLINE_DASH} ${label(i)}` };
        });
    }
    case "tree": {
      const g = diagramGraph(value);
      const children: number[][] = Array.from({ length: nodes.length }, () => []);
      const hasParent = new Array<boolean>(nodes.length).fill(false);
      for (const e of g.edges) {
        (children[e.from] as number[]).push(e.to);
        hasParent[e.to] = true;
      }
      const lines: OutlineLine[] = [];
      const seen = new Array<boolean>(nodes.length).fill(false);
      // Depth-first, children in edge order. Iterative: a stack of [node, depth], pushed reversed.
      const walk = (root: number): void => {
        const stack: [number, number][] = [[root, 0]];
        while (stack.length > 0) {
          const [u, depth] = stack.pop() as [number, number];
          if (seen[u]) continue;
          seen[u] = true;
          lines.push({ depth, text: label(u) });
          const kids = children[u] as number[];
          for (let k = kids.length - 1; k >= 0; k--) stack.push([kids[k] as number, depth + 1]);
        }
      };
      for (let i = 0; i < nodes.length; i++) if (!hasParent[i]) walk(i);
      for (let i = 0; i < nodes.length; i++) if (!seen[i]) walk(i); // only an unchecked value gets here
      return lines;
    }
    default: {
      const g = diagramGraph(value);
      const ordered =
        value.layout === "flow"
          ? g.edges
              .map((e, k) => ({ e, k }))
              .sort(
                (a, b) =>
                  (g.layers[a.e.from] as number) - (g.layers[b.e.from] as number) || a.k - b.k
              )
              .map(({ e }) => e)
          : g.edges;
      const lines: OutlineLine[] = ordered.map((e) => ({
        depth: 0,
        text: edgeText(label(e.from), label(e.to), (edges[e.edge] as { label?: string }).label),
      }));
      const touched = new Set<number>();
      for (const e of g.edges) {
        touched.add(e.from);
        touched.add(e.to);
      }
      for (let i = 0; i < nodes.length; i++)
        if (!touched.has(i)) lines.push({ depth: 0, text: label(i) });
      return lines;
    }
  }
}
