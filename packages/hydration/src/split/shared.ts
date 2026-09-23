import type { Finding } from "@loom-ui/core";
import type { HandleLoadResult } from "../scheduler";

// What both halves of split hydration mint: kept free of any server import, so the client half
// (`./client`) stays browser-safe.

export const reservedFinding = (handle: string): Finding => ({
  code: "invalid-handle",
  severity: "error",
  message: `handle "${handle}" is reserved`,
});

export const refuse = (code: string, message: string): HandleLoadResult => ({
  state: "error",
  finding: { code, severity: "error", message },
});

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
