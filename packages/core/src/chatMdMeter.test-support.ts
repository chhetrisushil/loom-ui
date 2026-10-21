import { parseBlocks } from "./chatMdBlock";
import type { ChatMarkdownOptions, MdDoc, MdState } from "./chatMdTypes";
import { sanitizeChatText } from "./chatText";

/**
 * `parseChatMarkdown` with a work counter, for tests that pin a step bound instead of a time. Test-only: this file is
 * excluded from the build, so the counter's entry point never ships. Keep the body in step with `parseChatMarkdown`.
 */
export function parseChatMarkdownMetered(
  text: unknown,
  options: ChatMarkdownOptions,
  meter: { steps: number }
): MdDoc {
  const st: MdState = {
    nodes: 0,
    truncated: false,
    markers: options.markers === true,
    streaming: options.streaming === true,
    meter,
  };
  const clean = sanitizeChatText(text).replace(/\t/g, "    ");
  const blocks = parseBlocks(clean.split("\n"), 0, st);
  return { blocks, truncated: st.truncated };
}
