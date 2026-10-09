/**
 * Nothing imports pi-ai's `/compat` entrypoint. pi-ai marks it temporary
 * ("deleted with the coding-agent ModelManager migration"), and a missing
 * subpath would surface through Cortex's lazy imports as a misleading
 * "pi-ai is not installed". Requests go through model-runtime.ts instead.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const ROOTS = [
  'packages/cortex/src',
  'packages/cortex/tests',
  'packages/cortex-code/src',
  'packages/cortex-code/tests',
  'tools',
];
// Built at runtime so this file does not match itself.
const COMPAT = ['@earendil-works', 'pi-ai', 'compat'].join('/');
// Any quoted specifier: static and dynamic imports, mocks, and the string
// constants Cortex passes to import() to keep bundlers off a path.
const IMPORT = new RegExp(`['"\`]${COMPAT.replace(/[/.]/g, '\\$&')}['"\`]`);

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(?:ts|tsx|mts|mjs|js)$/.test(entry)) files.push(path);
  }
  return files;
}

describe('pi-ai entrypoints', () => {
  it('scans the source it guards', () => {
    expect(sourceFiles(join(REPO, 'packages/cortex/src')).length).toBeGreaterThan(50);
    expect(IMPORT.test(`import { complete } from '${COMPAT}';`)).toBe(true);
    expect(IMPORT.test(`await import('${COMPAT}')`)).toBe(true);
    expect(IMPORT.test(`const path = '${COMPAT}';`)).toBe(true);
  });

  it('has no import of the /compat entrypoint', () => {
    const offenders = ROOTS
      .flatMap((root) => sourceFiles(join(REPO, root)))
      .filter((file) => IMPORT.test(readFileSync(file, 'utf8')))
      .map((file) => relative(REPO, file));
    expect(offenders).toEqual([]);
  });
});
