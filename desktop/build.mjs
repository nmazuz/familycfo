// Bundles the desktop app into build/desktop/: main.cjs + preload.cjs (Electron), server.mjs (src/server/desktop.ts)
// and mcp.mjs (the chat's read-only MCP server). npm packages stay external: electron-builder ships node_modules.
import { build } from 'esbuild';
import { readFile } from 'fs/promises';

const OUT = 'build/desktop';

// `if (import.meta.url === \`file://${process.argv[1]}\`)` marks a module's CLI entry (pipeline, migrate, imports).
// In one bundle every module shares the bundle's import.meta.url, so all of them would run. Turn them off.
const noCliEntries = {
  name: 'no-cli-entries',
  setup(b) {
    b.onLoad({ filter: /[\\/]src[\\/].*\.ts$/ }, async args => ({
      contents: (await readFile(args.path, 'utf8')).replaceAll('import.meta.url === `file://${process.argv[1]}`', 'false'),
      loader: 'ts',
    }));
  },
};

const common = { bundle: true, platform: 'node', target: 'node22', packages: 'external', sourcemap: 'linked', logLevel: 'info' };

await Promise.all([
  build({ ...common, entryPoints: ['desktop/main.ts'], outfile: `${OUT}/main.cjs`, format: 'cjs' }),
  // a sandboxed preload can only require('electron'), so bundle everything else (there is nothing else)
  build({ ...common, entryPoints: ['desktop/preload.ts'], outfile: `${OUT}/preload.cjs`, format: 'cjs', packages: undefined, external: ['electron'] }),
  build({ ...common, entryPoints: ['src/server/desktop.ts'], outfile: `${OUT}/server.mjs`, format: 'esm', plugins: [noCliEntries] }),
  build({ ...common, entryPoints: ['src/agent/mcp.ts'], outfile: `${OUT}/mcp.mjs`, format: 'esm', plugins: [noCliEntries] }),
]);
