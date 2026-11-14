import { useChatContracts } from "@loomwork/ui-core/browser";
import { defineElement } from "../define.js";
import { LuFormInput, LuSelectInput, LuTextInput } from "../widgets/lu-inputs.js";
import { LuMultiSelectInput } from "../widgets/lu-multi-select.js";

/** Register `<lu-text-input>`, `<lu-form-input>`, `<lu-select-input>`, `<lu-multi-select-input>`. Idempotent. */
export function defineInputs(): void {
  // the value contracts these widgets check are deferred in core: load them first
  useChatContracts();
  defineElement("lu-text-input", LuTextInput);
  defineElement("lu-form-input", LuFormInput);
  defineElement("lu-select-input", LuSelectInput);
  defineElement("lu-multi-select-input", LuMultiSelectInput);
}
