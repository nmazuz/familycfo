import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, basename, resolve } from 'node:path';

// Playwright may terminate the entire server process group, bypassing its SIGTERM handler.
// Clean up only the exact directory recorded by this run, not other concurrent test runs.
export default function teardown() {
  const marker = 'test-results/e2e-directory.txt';
  if (!existsSync(marker)) return;
  const dir = resolve(readFileSync(marker, 'utf8').trim());
  if (dirname(dir) !== resolve(tmpdir()) || !basename(dir).startsWith('familycfo-e2e-')) {
    throw new Error('Refusing cleanup of an unexpected E2E directory');
  }
  rmSync(dir, { recursive: true, force: true });
  rmSync(marker, { force: true });
}
