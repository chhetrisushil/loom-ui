import { defineElement } from "../define";
import { LuFormInput, LuSelectInput, LuTextInput } from "../widgets/lu-inputs";
import { LuMultiSelectInput } from "../widgets/lu-multi-select";

/** Register `<lu-text-input>`, `<lu-form-input>`, `<lu-select-input>`, `<lu-multi-select-input>`. Idempotent. */
export function defineInputs(): void {
  defineElement("lu-text-input", LuTextInput);
  defineElement("lu-form-input", LuFormInput);
  defineElement("lu-select-input", LuSelectInput);
  defineElement("lu-multi-select-input", LuMultiSelectInput);
}
