import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  buildCodeGraph,
  findDependencies,
  findDependents,
  parseImports,
  type CodeFileInput,
} from './codeGraph.js';

const file = (path: string, content: string): CodeFileInput => ({ path, content });

// ---------------------------------------------------------------------------
// parseImports
// ---------------------------------------------------------------------------

test('parseImports extracts default, named, and namespace ESM imports', () => {
  const content = `
    import Foo from './foo';
    import { a, b } from '../bar';
    import * as ns from './baz';
  `;
  assert.deepEqual(parseImports(content), ['./foo', '../bar', './baz']);
});

test('parseImports extracts side-effect-only imports', () => {
  assert.deepEqual(parseImports(`import './styles.css';`), ['./styles.css']);
});

test('parseImports extracts re-exports', () => {
  const content = `export { thing } from './thing';\nexport * from './everything';`;
  assert.deepEqual(parseImports(content), ['./thing', './everything']);
});

test('parseImports extracts CJS require and dynamic import', () => {
  const content = `
    const x = require('./x');
    const y = await import('./y');
  `;
  assert.deepEqual(parseImports(content), ['./x', './y']);
});

test('parseImports ignores non-import strings', () => {
  assert.deepEqual(parseImports(`const s = "not an import from anywhere";`), []);
});

test('parseImports returns an empty array for content with no imports', () => {
  assert.deepEqual(parseImports('export const x = 1;'), []);
});

// ---------------------------------------------------------------------------
// buildCodeGraph
// ---------------------------------------------------------------------------

test('buildCodeGraph resolves a relative import to its exact-extension file', () => {
  const graph = buildCodeGraph([
    file('a.ts', `import { b } from './b';`),
    file('b.ts', `export const b = 1;`),
  ]);
  assert.equal(graph.nodes.length, 2);
  assert.deepEqual(graph.edges, [{ from: 'a.ts', to: 'b.ts', resolved: true }]);
});

test('buildCodeGraph resolves a .js-extension specifier to a sibling .ts file (TS-ESM convention)', () => {
  // Found by dogfooding this very tool against this very repo: every import
  // in this codebase is written as `from './foo.js'` and resolves to
  // `foo.ts` at compile time - the standard TypeScript-ESM convention. The
  // first version of this resolver only tried the literal specifier plus
  // appending extensions, never swapping an existing .js for .ts, so it
  // resolved 0% of this repo's own intra-repo imports.
  const graph = buildCodeGraph([
    file('a.ts', `import { b } from './b.js';`),
    file('b.ts', `export const b = 1;`),
  ]);
  assert.deepEqual(graph.edges, [{ from: 'a.ts', to: 'b.ts', resolved: true }]);
});

test('buildCodeGraph resolves a directory import to its index file', () => {
  const graph = buildCodeGraph([
    file('a.ts', `import { b } from './sub';`),
    file('sub/index.ts', `export const b = 1;`),
  ]);
  assert.deepEqual(graph.edges, [{ from: 'a.ts', to: 'sub/index.ts', resolved: true }]);
});

test('buildCodeGraph resolves imports across sibling directories (../)', () => {
  const graph = buildCodeGraph([
    file('lib/a.ts', `import { b } from '../other/b';`),
    file('other/b.ts', `export const b = 1;`),
  ]);
  assert.deepEqual(graph.edges, [{ from: 'lib/a.ts', to: 'other/b.ts', resolved: true }]);
});

test('buildCodeGraph leaves bare package specifiers unresolved, not dropped', () => {
  const graph = buildCodeGraph([file('a.ts', `import React from 'react';`)]);
  assert.deepEqual(graph.edges, [{ from: 'a.ts', to: 'react', resolved: false }]);
});

test('buildCodeGraph marks a relative import that matches no known file as unresolved', () => {
  const graph = buildCodeGraph([file('a.ts', `import { z } from './missing';`)]);
  assert.deepEqual(graph.edges, [{ from: 'a.ts', to: './missing', resolved: false }]);
});

test('buildCodeGraph counts lines per node', () => {
  const graph = buildCodeGraph([file('a.ts', 'line1\nline2\nline3')]);
  assert.equal(graph.nodes[0]?.lines, 3);
});

test('buildCodeGraph gives an empty file zero lines', () => {
  const graph = buildCodeGraph([file('empty.ts', '')]);
  assert.equal(graph.nodes[0]?.lines, 0);
});

// ---------------------------------------------------------------------------
// findDependencies / findDependents
// ---------------------------------------------------------------------------

test('findDependencies returns only resolved outbound edges, de-duplicated', () => {
  const graph = buildCodeGraph([
    file(
      'a.ts',
      `import { b } from './b';\nimport { b as b2 } from './b';\nimport x from 'external';`,
    ),
    file('b.ts', `export const b = 1;`),
  ]);
  assert.deepEqual(findDependencies(graph, 'a.ts'), ['b.ts']);
});

test('findDependents returns every file that imports the target', () => {
  const graph = buildCodeGraph([
    file('a.ts', `import { c } from './c';`),
    file('b.ts', `import { c } from './c';`),
    file('c.ts', `export const c = 1;`),
  ]);
  assert.deepEqual(findDependents(graph, 'c.ts').sort(), ['a.ts', 'b.ts']);
});

test('findDependents is empty for a file nothing imports', () => {
  const graph = buildCodeGraph([file('island.ts', 'export const x = 1;')]);
  assert.deepEqual(findDependents(graph, 'island.ts'), []);
});
