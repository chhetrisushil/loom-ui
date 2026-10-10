import { defineElement } from "../define";
import { LuSandbox } from "../widgets/lu-sandbox";

/** Register `<lu-sandbox>`. Idempotent. */
export function defineSandbox(): void {
  defineElement("lu-sandbox", LuSandbox);
}
