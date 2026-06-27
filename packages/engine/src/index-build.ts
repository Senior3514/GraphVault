/**
 * Build an in-memory graph index from a set of notes.
 *
 * Resolution rules (most specific first):
 *  1. Exact vault-relative path match (with or without `.md` extension).
 *  2. Path relative to the source note's folder.
 *  3. Basename match (filename without extension), case-insensitive.
 *  4. Title match, case-insensitive.
 * Links that resolve to nothing are kept as edges with `resolved: false` and the
 * raw target text preserved, so the host can surface "missing note" affordances.
 */

import type { FilePath } from '@graphvault/shared';
import { parseNote } from './parse.js';
import type {
  GraphEdge,
  GraphIndex,
  GraphNode,
  NoteInput,
  ParsedLink,
  ParsedNote,
} from './types.js';

/**
 * NFC-normalize a path/target so two Unicode encodings of the same string
 * compare equal (spec §2.1). An NFD `[[café]]` link must resolve to an NFC
 * `café.md` note; without this they would be treated as distinct identities.
 */
function nfc(s: string): string {
  return s.normalize('NFC');
}

/** Vault-relative folder of a path (`''` for a root-level note). */
function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** Basename without a trailing `.md`/markdown extension, NFC + lowercased. */
function basenameKey(path: string): string {
  const base = path.split('/').pop() ?? path;
  return nfc(base.replace(/\.(md|markdown)$/i, '').toLowerCase());
}

/** Normalise a path: collapse `./` and `../` segments, strip leading `/`. */
function normalizePath(path: string): string {
  const segments = path.replace(/^\/+/, '').split('/');
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/** Append `.md` if the target has no markdown-ish extension. */
function withMdExtension(path: string): string {
  return /\.(md|markdown)$/i.test(path) ? path : `${path}.md`;
}

interface ResolutionMaps {
  byPath: Map<string, string>;
  byBasename: Map<string, string[]>;
  byTitle: Map<string, string[]>;
}

function buildResolutionMaps(nodes: Map<string, GraphNode>): ResolutionMaps {
  const byPath = new Map<string, string>();
  const byBasename = new Map<string, string[]>();
  const byTitle = new Map<string, string[]>();

  for (const node of nodes.values()) {
    const path = nfc(node.path);
    byPath.set(path, node.id);
    const noExt = path.replace(/\.(md|markdown)$/i, '');
    byPath.set(noExt, node.id);

    const bn = basenameKey(node.path);
    (byBasename.get(bn) ?? byBasename.set(bn, []).get(bn)!).push(node.id);

    const titleKey = nfc(node.title.toLowerCase());
    (byTitle.get(titleKey) ?? byTitle.set(titleKey, []).get(titleKey)!).push(node.id);
  }
  return { byPath, byBasename, byTitle };
}

/** Resolve a single parsed link to a target note id, or `null` if unresolved. */
function resolveTarget(link: ParsedLink, sourcePath: string, maps: ResolutionMaps): string | null {
  // NFC-normalize the target and source so an NFD link (`[[café]]`) resolves to
  // an NFC note (`café.md`) - paths are a single canonical identity (spec §2.1).
  const rawTarget = nfc(link.target.trim());
  sourcePath = nfc(sourcePath);
  if (rawTarget === '') return null;

  const candidates: string[] = [];

  if (link.type === 'markdown') {
    // Markdown links are path-like; resolve relative to the source folder.
    const relToFolder = normalizePath(`${folderOf(sourcePath)}/${rawTarget}`);
    candidates.push(relToFolder, withMdExtension(relToFolder));
    const abs = normalizePath(rawTarget);
    candidates.push(abs, withMdExtension(abs));
  } else {
    // Wikilinks and typed relations: try as a path first, then basename/title.
    const abs = normalizePath(rawTarget);
    candidates.push(abs, withMdExtension(abs));
    const relToFolder = normalizePath(`${folderOf(sourcePath)}/${rawTarget}`);
    candidates.push(relToFolder, withMdExtension(relToFolder));
  }

  for (const candidate of candidates) {
    const hit = maps.byPath.get(candidate);
    if (hit) return hit;
  }

  // Basename match (deterministic: first by sorted id when ambiguous).
  const bn = basenameKey(withMdExtension(rawTarget));
  const byBn = maps.byBasename.get(bn);
  if (byBn && byBn.length > 0) return [...byBn].sort()[0]!;

  // Title match.
  const byTitle = maps.byTitle.get(nfc(rawTarget.toLowerCase()));
  if (byTitle && byTitle.length > 0) return [...byTitle].sort()[0]!;

  return null;
}

/** Convert a parsed note into a graph node. */
function toNode(parsed: ParsedNote, input: NoteInput): GraphNode {
  const node: GraphNode = {
    id: parsed.path,
    path: parsed.path,
    title: parsed.title,
    tags: parsed.tags,
    folder: folderOf(parsed.path),
  };
  if (input.createdAt !== undefined) node.createdAt = input.createdAt;
  if (input.updatedAt !== undefined) node.updatedAt = input.updatedAt;
  return node;
}

/**
 * Build the full {@link GraphIndex} from a list of note inputs.
 *
 * The build is deterministic and pure: same inputs always yield the same index.
 */
export function buildIndex(notes: readonly NoteInput[]): GraphIndex {
  // 1. Parse every note and create nodes. De-duplicate by path with last-write-
  //    wins, keeping a single parsed entry per path so the edge pass below stays
  //    consistent with the node map. Building edges from ALL parsed entries
  //    would let a discarded duplicate's links survive as phantom edges from a
  //    node that no longer contains them.
  const parsedByPath = new Map<string, { parsed: ParsedNote; input: NoteInput }>();
  const nodes = new Map<string, GraphNode>();
  for (const input of notes) {
    const p = parseNote(input.path as FilePath, input.content);
    const node = toNode(p, input);
    // Last write wins on duplicate paths; nodes map keeps a single entry, and
    // parsedByPath keeps the matching links so nodes and edges agree.
    nodes.set(node.id, node);
    parsedByPath.set(p.path, { parsed: p, input });
  }
  const parsed = [...parsedByPath.values()];

  // 2. Build resolution maps once, then resolve all links into edges.
  const maps = buildResolutionMaps(nodes);
  const edges: GraphEdge[] = [];
  const outbound = new Map<string, GraphEdge[]>();
  const backlinks = new Map<string, GraphEdge[]>();
  const seen = new Set<string>();

  for (const { parsed: p } of parsed) {
    const source = p.path;
    for (const link of p.links) {
      // Skip empty link targets (e.g. `[[]]` / `[[ ]]`): they would otherwise
      // create a junk edge with an empty target.
      if (link.target.trim() === '') continue;
      const resolvedId = resolveTarget(link, source, maps);
      const target = resolvedId ?? link.target.trim();
      const resolved = resolvedId !== null;

      // De-duplicate identical edges (same source/target/type/heading).
      const dedupeKey = `${source}${target}${link.type}${link.heading ?? ''}${resolved ? '1' : '0'}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const edge: GraphEdge = { source, target, type: link.type, resolved };
      if (link.heading !== undefined) edge.heading = link.heading;
      if (link.alias !== undefined) edge.alias = link.alias;

      edges.push(edge);
      (outbound.get(source) ?? outbound.set(source, []).get(source)!).push(edge);
      if (resolved) {
        (backlinks.get(target) ?? backlinks.set(target, []).get(target)!).push(edge);
      }
    }
  }

  return { nodes, edges, outbound, backlinks };
}

/** Convenience: resolved backlink edges pointing at `noteId`. */
export function getBacklinks(index: GraphIndex, noteId: string): GraphEdge[] {
  return index.backlinks.get(noteId) ?? [];
}

/** Convenience: outbound edges from `noteId`. */
export function getOutbound(index: GraphIndex, noteId: string): GraphEdge[] {
  return index.outbound.get(noteId) ?? [];
}
