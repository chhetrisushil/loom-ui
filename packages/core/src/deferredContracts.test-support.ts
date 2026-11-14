// Import for its effect: loads every DEFERRED contract (chat, media, diagram) into the zod-free
// checker, the way renderer-lit's defineX() does in a page. A test that checks those kinds through
// `./kindValues` or `./browser` imports this first; `kindValuesDeferred.test.ts` covers the
// unloaded (fail-closed) state and must NOT import it.
import { useChatContracts } from "./contractsChat";
import { useDiagramContracts } from "./contractsDiagram";
import { useMediaContracts } from "./contractsMedia";

useChatContracts();
useMediaContracts();
useDiagramContracts();
