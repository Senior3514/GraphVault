/**
 * @graphvault/engine
 *
 * The GraphVault graph engine: a pure, framework-free and filesystem-free
 * library that turns a set of markdown notes into a navigable graph.
 *
 * Pipeline:
 *   1. {@link parseNote} - raw markdown → title, frontmatter, tags, links.
 *   2. {@link buildIndex} - notes → in-memory index (nodes, edges, backlinks).
 *   3. Graph API ({@link getGraph}, {@link getLocalGraph}, {@link filterGraph})
 *      - render-ready `{ nodes, edges, truncated }` payloads.
 *
 * Nothing here imports React, the DOM, or `node:fs`; callers supply note
 * content as {@link NoteInput} values.
 *
 * A second, independent graph model lives in {@link "./codeGraph.js"}: the
 * same "feed in file content, get a graph back" shape, but for a source-code
 * import graph (file → file via `import`/`require`) rather than a note graph
 * (note → note via wikilinks). See {@link buildCodeGraph}.
 */

export * from './types.js';
export { parseNote, splitFrontmatter } from './parse.js';
export { buildIndex, getBacklinks, getOutbound } from './index-build.js';
export {
  getGraph,
  getLocalGraph,
  filterGraph,
  DEFAULT_NODE_CAP,
  type GetGraphOptions,
  type GetLocalGraphOptions,
  type FilterCriteria,
} from './graph.js';
export {
  parseImports,
  buildCodeGraph,
  findDependencies,
  findDependents,
  type CodeFileInput,
  type CodeGraphNode,
  type CodeGraphEdge,
  type CodeGraph,
} from './codeGraph.js';
