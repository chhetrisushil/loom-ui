// The DEFERRED chat contracts (see kindValues.ts): a transcript is a ChatValue and a
// MultiSelectInput binds its options and choice; the shared checkers live in `chatValue.ts`.
import { chatValueIssues, multiSelectValueIssues } from "./chatValue";
import { installDeferredContracts, issuesContract } from "./kindValues";

/**
 * Load the Chat and MultiSelectInput contracts into `checkKindValue`. Idempotent; renderer-lit's
 * `defineChat()` / `defineInputs()` and hydration's `connectConversation` call it.
 */
export function useChatContracts(): void {
  installDeferredContracts({
    Chat: issuesContract(chatValueIssues),
    MultiSelectInput: issuesContract(multiSelectValueIssues),
  });
}
