/**
 * Code import graph - a second, independent graph model alongside the note
 * graph in {@link "./graph.js"}. Turns a set of source files into a
 * dependency graph (file → file, via static `import`/`require` analysis) so
 * a caller (the CLI, an AI coding agent via the CLI) can ask "what does this
 * file depend on" / "what depends on this file" without reading every file
 * in the tree first.
 *
 * Framework-free and filesystem-free, same invariant as the rest of this
 * package: callers supply file content ({@link CodeFileInput}); nothing here
 * touches `node:fs`. The CLI's `codeGraph.ts` does the directory walking.
 *
 * Deliberately static-analysis only, not a real parser: import specifiers are
 * extracted with a regex over common JS/TS/ESM/CJS import forms. This misses
 * dynamically constructed import paths (a computed, non-literal argument to
 * a dynamic import) and does not resolve bare package specifiers (an import
 * from a package name rather than a relative path) to anything - by design,
 * since the value here is the INTRA-repo structure, not a full dependency-
 * of-dependencies resolution (that's what a real bundler is for). It also
 * cannot distinguish real code from a comment or string that merely looks
 * like an import - e.g. this very doc comment, if it quoted example import
 * syntax verbatim, would show up as a false-positive edge when this file
 * scans itself (caught by dogfooding; see the examples below, deliberately
 * written without quoted specifiers so they don't self-match).
 */

/** One source file, as read from disk by the caller. */
export interface CodeFileInput {
  /** Repo-relative POSIX path, e.g. `apps/web/lib/vault/store.ts`. */
  path: string;
  /** Raw file content. */
  content: string;
}

/** A node in the code graph: one source file. */
export interface CodeGraphNode {
  path: string;
  /** Line count - a cheap complexity signal without parsing the file. */
  lines: number;
}

/** A directed edge: `from` imports `to`. */
export interface CodeGraphEdge {
  from: string;
  /**
   * The resolved repo-relative path when the import target is one of the
   * files in this graph, otherwise the raw specifier as written (e.g. an
   * external package name, or a relative import that didn't resolve to any
   * walked file).
   */
  to: string;
  /** True when `to` resolves to another node in this same graph. */
  resolved: boolean;
}

export interface CodeGraph {
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

/**
 * Regex forms covered (checked in this order isn't significant - all run over
 * the same content). Specifiers below are written as SPEC rather than a
 * quoted string so this comment doesn't produce false-positive edges when
 * this file scans itself:
 *   import x from SPEC / import { a, b } from SPEC / import * as x from SPEC
 *   import SPEC                                     (side-effect import)
 *   export { a } from SPEC / export * from SPEC
 *   const x = require(SPEC) / require(SPEC)
 *   import(SPEC)                                     (dynamic import, static string only)
 */
const IMPORT_PATTERNS: RegExp[] = [
  /\bimport\s+(?:[\w*${},\s]+\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bexport\s+(?:[\w*${},\s]+\s+from\s+)?['"]([^'"]+)['"]/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/**
 * Extract raw import specifiers from a single file's source text, in
 * document order, without deduplication (callers decide whether repeats
 * matter). Purely textual - does not parse or execute the file.
 */
export function parseImports(content: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    // Each pattern is a fresh RegExp literal (module-level `g` flag state is
    // shared across calls otherwise), so clone with a fresh lastIndex.
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const spec = match[1];
      if (spec) specifiers.push(spec);
    }
  }
  return specifiers;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/** Join and normalize a POSIX-style relative path, collapsing `.`/`..` segments. */
function normalizePosixPath(path: string): string {
  const isAbsolute = path.startsWith('/');
  const segments = path.split('/');
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!isAbsolute) out.push('..');
      continue;
    }
    out.push(seg);
  }
  return (isAbsolute ? '/' : '') + out.join('/');
}

/** Matches a trailing JS-family extension so it can be swapped for a TS one. */
const TRAILING_JS_EXTENSION = /\.(m|c)?jsx?$/;

/**
 * Resolve a relative import specifier (`./foo`, `../bar/baz`) against the
 * importing file's directory, matching it to one of `knownPaths` - trying the
 * literal path, each source extension, each extension under an implicit
 * `/index`, and - because this is the standard TypeScript-ESM convention
 * (used throughout this very repo) - the same again with a trailing `.js`/
 * `.jsx`/`.mjs`/`.cjs` on the specifier swapped for a TS extension, since
 * `import './foo.js'` commonly resolves to a sibling `foo.ts` at compile
 * time, not a same-named `.js` file that doesn't exist on disk at all.
 * Returns `null` for bare/absolute specifiers (not attempted) or when
 * nothing in `knownPaths` matches.
 */
function resolveRelativeImport(
  fromPath: string,
  specifier: string,
  knownPaths: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith('.')) return null; // bare package specifier - not ours to resolve

  const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const joined = fromDir ? `${fromDir}/${specifier}` : specifier;
  const base = normalizePosixPath(joined);

  const jsExtMatch = base.match(TRAILING_JS_EXTENSION);
  const baseWithoutJsExt = jsExtMatch ? base.slice(0, -jsExtMatch[0].length) : null;

  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...SOURCE_EXTENSIONS.map((ext) => `${base}/index${ext}`),
    ...(baseWithoutJsExt !== null
      ? SOURCE_EXTENSIONS.map((ext) => `${baseWithoutJsExt}${ext}`)
      : []),
  ];
  for (const candidate of candidates) {
    if (knownPaths.has(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

/** Build a {@link CodeGraph} from a set of already-read source files. */
export function buildCodeGraph(files: readonly CodeFileInput[]): CodeGraph {
  const knownPaths = new Set(files.map((f) => f.path));
  const nodes: CodeGraphNode[] = files.map((f) => ({
    path: f.path,
    lines: f.content.length === 0 ? 0 : f.content.split('\n').length,
  }));

  const edges: CodeGraphEdge[] = [];
  for (const file of files) {
    for (const specifier of parseImports(file.content)) {
      const resolved = resolveRelativeImport(file.path, specifier, knownPaths);
      edges.push({
        from: file.path,
        to: resolved ?? specifier,
        resolved: resolved !== null,
      });
    }
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Files that `path` imports (resolved, intra-graph edges only), de-duplicated. */
export function findDependencies(graph: CodeGraph, path: string): string[] {
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.from === path && edge.resolved) seen.add(edge.to);
  }
  return [...seen];
}

/** Files that import `path` (resolved, intra-graph edges only), de-duplicated. */
export function findDependents(graph: CodeGraph, path: string): string[] {
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.to === path && edge.resolved) seen.add(edge.from);
  }
  return [...seen];
}
