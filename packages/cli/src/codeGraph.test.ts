/**
 * Tests for walkSourceFiles - the one piece of codegraph fs I/O worth a real
 * temp-directory check, since the ignore-list / extension-filter behavior is
 * new and non-trivial (unlike vault.ts's walker, which has no test file).
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { walkSourceFiles } from './codeGraph.js';

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-codegraph-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'node_modules', 'some-dep'), { recursive: true });
  mkdirSync(join(dir, 'dist'));

  writeFileSync(join(dir, 'src', 'a.ts'), `import { b } from './b';`);
  writeFileSync(join(dir, 'src', 'b.ts'), `export const b = 1;`);
  writeFileSync(join(dir, 'src', 'notes.md'), `# not source`);
  writeFileSync(join(dir, 'node_modules', 'some-dep', 'index.js'), `module.exports = {};`);
  writeFileSync(join(dir, 'dist', 'a.js'), `// build output, should be ignored`);
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('walkSourceFiles collects only source-extension files', () => {
  const files = walkSourceFiles(dir);
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['src/a.ts', 'src/b.ts']);
});

test('walkSourceFiles ignores node_modules, dist, and other default ignore dirs', () => {
  const files = walkSourceFiles(dir);
  assert.ok(!files.some((f) => f.path.includes('node_modules')));
  assert.ok(!files.some((f) => f.path.startsWith('dist/')));
});

test('walkSourceFiles returns repo-relative POSIX paths with real content', () => {
  const files = walkSourceFiles(dir);
  const a = files.find((f) => f.path === 'src/a.ts');
  assert.ok(a);
  assert.equal(a!.content, `import { b } from './b';`);
});

test('walkSourceFiles throws a clear error for a missing directory', () => {
  assert.throws(() => walkSourceFiles(join(dir, 'nope')));
});

test('walkSourceFiles throws when given a file instead of a directory', () => {
  assert.throws(() => walkSourceFiles(join(dir, 'src', 'a.ts')));
});
