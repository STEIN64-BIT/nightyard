// Bundle the vendored Sleepy CLI (vendor/sleepy) into dist/sleepy/, which the
// packaged app ships as Resources/sleepy/ (electron-builder extraResources).
//
// Layout matters: Sleepy finds its plugin and its own bin relative to
// `import.meta.url` of a file in cli/dist/commands/, so the bundle lives there:
//
//   dist/sleepy/cli/bin/sleepy.mjs           entry (what Nightyard runs)
//   dist/sleepy/cli/dist/commands/sleepy.js  the whole CLI + dependencies
//   dist/sleepy/plugin/                      Claude Code plugin (skills)
//
// Sleepy pins zod 3 and commander 12 while Nightyard itself uses zod 4, so the
// bundle resolves them through the `sleepy-zod` / `sleepy-commander` aliases.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'vendor', 'sleepy');
const out = path.join(root, 'dist', 'sleepy');
const { version } = JSON.parse(readFileSync(path.join(src, 'cli', 'package.json'), 'utf-8'));

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, 'cli', 'bin'), { recursive: true });

await build({
  entryPoints: [path.join(src, 'cli', 'src', 'index.ts')],
  outfile: path.join(out, 'cli', 'dist', 'commands', 'sleepy.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  alias: { zod: 'sleepy-zod', commander: 'sleepy-commander' },
  // CommonJS dependencies (proper-lockfile) call require() for Node built-ins.
  banner: { js: "import { createRequire as __sleepyCreateRequire } from 'node:module'; const require = __sleepyCreateRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});

writeFileSync(
  path.join(out, 'cli', 'bin', 'sleepy.mjs'),
  "#!/usr/bin/env node\nimport('../dist/commands/sleepy.js').then((m) => m.main(process.argv));\n",
);
chmodSync(path.join(out, 'cli', 'bin', 'sleepy.mjs'), 0o755);
writeFileSync(
  path.join(out, 'cli', 'package.json'),
  JSON.stringify({ name: '@sleepy/cli', version, type: 'module', private: true }, null, 2) + '\n',
);
cpSync(path.join(src, 'plugin'), path.join(out, 'plugin'), { recursive: true });
cpSync(path.join(src, 'LICENSE'), path.join(out, 'LICENSE'));

console.log(`bundled Sleepy v${version} into dist/sleepy/`);
