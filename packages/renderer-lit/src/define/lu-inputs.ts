import { defineElement } from "../define";
import { LuFormInput, LuSelectInput, LuTextInput } from "../widgets/lu-inputs";

/** Register `<lu-text-input>`, `<lu-form-input>`, `<lu-select-input>`. Idempotent. */
export function defineInputs(): void {
  defineElement("lu-text-input", LuTextInput);
  defineElement("lu-form-input", LuFormInput);
  defineElement("lu-select-input", LuSelectInput);
}
