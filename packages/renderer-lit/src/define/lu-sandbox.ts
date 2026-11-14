import { defineElement } from "../define.js";
import { LuSandbox } from "../widgets/lu-sandbox.js";

/** Register `<lu-sandbox>`. Idempotent. */
export function defineSandbox(): void {
  defineElement("lu-sandbox", LuSandbox);
}
