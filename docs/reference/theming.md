# Theming reference

Every `lu-*` element reads `--lu-*` CSS custom properties. Set them on any ancestor of the mounted
tree. The renderers ship dark defaults, so an unset token still draws. The Lit elements themselves
are described in [`@loom-ui/renderer-lit`](../../packages/renderer-lit/README.md).

## Colour, surface and shape

| Token | Used for |
| --- | --- |
| `--lu-text` | Primary text |
| `--lu-text-dim` | Secondary text |
| `--lu-text-caption` | A Kpi caption; defaults to `--lu-text-dim` |
| `--lu-border` | Borders and rules |
| `--lu-panel`, `--lu-panel-2` | Widget surfaces (the second is the raised or tooltip surface) |
| `--lu-grid` | Chart grid lines |
| `--lu-accent` | Accent colour |
| `--lu-radius` | Corner radius |

## Deltas and status

| Token | Used for |
| --- | --- |
| `--lu-delta-up`, `--lu-delta-up-bg` | An upward Kpi delta (foreground, background) |
| `--lu-delta-down`, `--lu-delta-down-bg` | A downward delta |
| `--lu-delta-flat`, `--lu-delta-flat-bg` | A delta that reads as unchanged |
| `--lu-status-ok`, `--lu-status-warning`, `--lu-status-critical` | `StatusCard` levels and status markers |

## Sizing

| Token | Default | Used for |
| --- | --- | --- |
| `--lu-chart-aspect` | `16 / 9` | Aspect ratio of a chart in an auto-height container |
| `--lu-chart-min-height` | `120px` | Floor for that chart; set `0` for the pre-floor behaviour |
| `--lu-entry-h` | `96px` | Intrinsic-size hint for an off-screen `lu-chat` turn |

`--lu-row-h` is set by the table virtualizer itself and is not a theming hook.
