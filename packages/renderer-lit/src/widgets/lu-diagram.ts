import {
  type DiagramValue,
  type OutlineLine,
  type TimeFormat,
  diagramOutline,
  isTimeFormat,
  useDiagramContracts,
} from "@loomwork/ui-core/browser";
import { type TemplateResult, css, html, nothing, svg } from "lit";
import { diagramSummary } from "../a11y.js";
import {
  type DiagramGeometry,
  type PlacedNode,
  displayLabel,
  edgeMidpoint,
  edgePath,
  layoutDiagram,
} from "../charts/diagramLayout.js";
import { SERIES_COLORS } from "../charts/svg.js";
import { cssomStyle } from "../cssomStyle.js";
import { timeLabel } from "../format.js";
import { formattingLocale } from "../i18n.js";
import { refStyles } from "../refStyles.js";
import { dirFor } from "../rtl.js";
import { say } from "../say.js";
import { LuWidget } from "./base.js";

// A diagram bound to data (tree, flow, timeline or network), drawn as SVG in the shadow root at its
// NATURAL size inside a scroll container (no zoom). The layout math is `charts/diagramLayout.ts`
// (pure, unit-tested). Labels are DATA: only ever Lit text bindings, never markup. The SVG is hidden
// from assistive technology; the same structure is offered as a visually hidden outline (core's
// `diagramOutline`, shared with the terminal), nested for a tree and flat otherwise.

const ARROW = "lu-diagram-arrow";

export class LuDiagram extends LuWidget {
  readonly kind = "Diagram";

  static styles = css`
    ${refStyles}
    :host {
      display: block;
      padding: 4px 10px;
      box-sizing: border-box;
    }
    .diagram {
      position: relative;
    }
    .title {
      font-size: 12px;
      font-weight: 600;
      color: var(--lu-text-dim, #8b949e);
      margin-bottom: 4px;
    }
    .scroll {
      overflow: auto;
      max-width: 100%;
    }
    svg {
      display: block;
    }
    .node rect {
      fill: var(--lu-panel, #161b22);
      stroke: var(--lu-border, #30363d);
      stroke-width: 1.5;
    }
    .node text {
      fill: var(--lu-text, #e6edf3);
      font-size: 12px;
      font-family: inherit;
      text-anchor: middle;
      dominant-baseline: central;
    }
    .edge path {
      fill: none;
      stroke: var(--lu-text-dim, #8b949e);
      stroke-width: 1.25;
    }
    .edge.back path {
      stroke-dasharray: 5 4;
    }
    .edge text {
      fill: var(--lu-text-dim, #8b949e);
      font-size: 10px;
      text-anchor: middle;
      paint-order: stroke;
      stroke: var(--lu-panel, #161b22);
      stroke-width: 3px;
    }
    .arrowhead {
      fill: var(--lu-text-dim, #8b949e);
    }
    .axis line {
      stroke: var(--lu-grid, rgba(139, 148, 158, 0.4));
    }
    .axis text {
      fill: var(--lu-text-dim, #8b949e);
      font-size: 10px;
      text-anchor: middle;
    }
    .outline,
    .outline ul {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .outline {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }
  `;

  connectedCallback(): void {
    // The value contract is deferred in core: load it here too, so a host that registers this class
    // under its own tag (not through defineX()) still checks values. Idempotent.
    useDiagramContracts();
    super.connectedCallback();
    // Pinned to `ltr` inside a mirrored page, like the charts: the plot's coordinates are its own (a
    // timeline reads left to right in every language); the frame around it mirrors normally.
    const dir = dirFor(this.tagName);
    if (dir !== undefined) this.setAttribute("dir", dir);
  }

  // The layout is a pure function of the value: kept while the same value is redrawn (a status tick).
  private placed?: { value: DiagramValue; geometry: DiagramGeometry };
  private geometryOf(v: DiagramValue): DiagramGeometry {
    if (this.placed?.value !== v) this.placed = { value: v, geometry: layoutDiagram(v) };
    return this.placed.geometry;
  }

  /** value timeFormat › widget props.timeFormat (unchecked, so a malformed one is ignored) › day. */
  private timeFormatOf(v: DiagramValue): TimeFormat {
    const prop = (this.widget.props as { timeFormat?: unknown }).timeFormat;
    return v.timeFormat ?? (isTimeFormat(prop) ? prop : { granularity: "day" });
  }

  protected renderReady(): TemplateResult | typeof nothing {
    const v = this.value as DiagramValue;
    const geo = this.geometryOf(v);
    const groupColor = new Map<string, string>();
    for (const n of v.nodes)
      if (n.group !== undefined && !groupColor.has(n.group))
        groupColor.set(n.group, SERIES_COLORS[groupColor.size % SERIES_COLORS.length] as string);
    const summary = diagramSummary(v);
    return html`<div class="diagram" data-layout=${v.layout}>
      ${v.title ? html`<div class="title">${v.title}</div>` : nothing}
      ${this.renderOutline({ ...v, timeFormat: this.timeFormatOf(v) })}
      <div class="scroll" role="region" tabindex="0" aria-label=${summary}>
        <svg
          aria-hidden="true"
          focusable="false"
          width=${geo.width}
          height=${geo.height}
          viewBox="0 0 ${geo.width} ${geo.height}"
        >
          <defs>
            <marker
              id=${ARROW}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path class="arrowhead" d="M0,0L10,5L0,10z" />
            </marker>
          </defs>
          ${this.renderAxis(v, geo)}
          ${geo.edges.map((e) => {
            const edge = v.edges[e.edge] as DiagramValue["edges"][number];
            const mid = edgeMidpoint(e);
            return svg`<g class=${e.back ? "edge back" : "edge"} data-kind=${edge.kind ?? nothing}>
              <path d=${edgePath(e)} marker-end="url(#${ARROW})" />
              ${edge.label ? svg`<text x=${mid.x} y=${mid.y}>${edge.label}</text>` : nothing}
            </g>`;
          })}
          ${geo.nodes.map((p) => this.renderNode(v, p, groupColor))}
        </svg>
      </div>
    </div>`;
  }

  private renderNode(
    v: DiagramValue,
    p: PlacedNode,
    groupColor: ReadonlyMap<string, string>
  ): TemplateResult {
    const n = v.nodes[p.index] as DiagramValue["nodes"][number];
    const color = n.group === undefined ? undefined : groupColor.get(n.group);
    return svg`<g class="node" data-kind=${n.kind ?? nothing} data-group=${n.group ?? nothing}>
      <title>${n.label}</title>
      <rect
        x=${p.x}
        y=${p.y}
        width=${p.w}
        height=${p.h}
        rx="6"
        ${cssomStyle({ stroke: color })}
      />
      <text x=${p.x + p.w / 2} y=${p.y + p.h / 2}>${displayLabel(n.label)}</text>
    </g>`;
  }

  private renderAxis(v: DiagramValue, geo: DiagramGeometry): TemplateResult | typeof nothing {
    if (v.layout !== "timeline" || geo.axisY === undefined || geo.ticks.length === 0)
      return nothing;
    const tf = this.timeFormatOf(v);
    const first = geo.ticks[0] as { x: number; iso: string };
    const last = geo.ticks[geo.ticks.length - 1] as { x: number; iso: string };
    const span = new Date(last.iso).getTime() - new Date(first.iso).getTime();
    // A coarse granularity labels many ticks the same (several in one month): the first of each run only.
    let prev: string | undefined;
    const labelled = geo.ticks.flatMap((t) => {
      const text = timeLabel(t.iso, span, tf);
      if (text === prev) return [];
      prev = text;
      return [{ x: t.x, text }];
    });
    const y = geo.axisY;
    return svg`<g class="axis">
      <line x1=${first.x} x2=${last.x} y1=${y} y2=${y} />
      ${labelled.map(
        (t) =>
          svg`<line x1=${t.x} x2=${t.x} y1=${y - 3} y2=${y + 3} /><text x=${t.x} y=${y + 16}>${t.text}</text>`
      )}
    </g>`;
  }

  /** The shared outline as a visually hidden list: nested for a tree, flat otherwise. */
  private renderOutline(v: DiagramValue): TemplateResult {
    const lines: OutlineLine[] = diagramOutline(v, formattingLocale(), say);
    const label = say("lu.diagram.outline");
    if (v.layout !== "tree")
      return html`<ul class="outline" role="list" aria-label=${label} data-outline>
        ${lines.map((l) => html`<li>${l.text}</li>`)}
      </ul>`;
    // Lines are a preorder walk with depths: the parent of a line is the nearest earlier line one
    // level up. Items are built children-first (reverse order), so no recursion over the tree.
    const parent: number[] = [];
    const stack: number[] = [];
    lines.forEach((l, i) => {
      stack.length = Math.min(stack.length, l.depth);
      parent[i] = stack.length > 0 ? (stack[stack.length - 1] as number) : -1;
      stack[l.depth] = i;
    });
    const kids: number[][] = lines.map(() => []);
    parent.forEach((p, i) => void (p >= 0 && (kids[p] as number[]).push(i)));
    const item: TemplateResult[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const own = kids[i] as number[];
      item[i] =
        own.length === 0
          ? html`<li>${(lines[i] as OutlineLine).text}</li>`
          : html`<li>${(lines[i] as OutlineLine).text}<ul role="list">${own.map((k) => item[k])}</ul></li>`;
    }
    const roots = lines.flatMap((_, i) => (parent[i] === -1 ? [i] : []));
    return html`<ul class="outline" role="list" aria-label=${label} data-outline>
      ${roots.map((r) => item[r])}
    </ul>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-diagram": LuDiagram;
  }
}
