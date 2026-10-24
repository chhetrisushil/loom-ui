// The long-document parsers (`@loom-ui/core/document`): markdown and a closed Org subset into the same bounded AST
// chat draws, with the source range of each top-level block. Their own entry, so a page that only draws chat does not
// carry them. Zod-free, like every module a browser widget bundles.
export {
  MD_DOC_MAX_NODES,
  MD_DOC_MAX_TABLE_ROWS,
  MD_DOC_MAX_TEXT,
  parseMarkdownDocument,
  type MdDocument,
  type MdRange,
} from "./mdDocument";
export { parseOrgDocument } from "./orgDocument";
