import { describeRendererConformance } from "@loom-ui/renderer-conformance/vitest";
import { litAdapter } from "./conformanceAdapter.test-support";

// U16: the Lit web renderer through the shared renderer conformance kit.
describeRendererConformance(litAdapter, { forbidSkips: true });
