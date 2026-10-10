import { describeRendererConformance } from "@loom-ui/renderer-conformance/vitest";
import { terminalAdapter } from "./conformanceAdapter.test-support";

// U16: the terminal renderer through the shared renderer conformance kit.
describeRendererConformance(terminalAdapter, { forbidSkips: true });
