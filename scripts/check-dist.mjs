/**
 * Fail when dist/ is not the output of the current src/.
 * npx github:josephcake/swarmscope runs the committed dist/, so a drift ships.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const committed = join(root, 'dist');
const tmp = mkdtempSync(join(tmpdir(), 'swarmscope-dist-'));
const built = join(tmp, 'dist');

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function files(dir) {
  const out = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

try {
  const tsc = join(root, 'node_modules/typescript/bin/tsc');
  const vite = join(root, 'node_modules/vite/bin/vite.js');
  run([tsc, '-p', 'tsconfig.json', '--outDir', built]);
  run([vite, 'build', '--outDir', join(built, 'public'), '--emptyOutDir']);

  const left = files(committed);
  const right = files(built);
  const onlyCommitted = left.filter((f) => !right.includes(f));
  const onlyBuilt = right.filter((f) => !left.includes(f));
  const changed = left.filter((f) => right.includes(f) && !readFileSync(join(committed, f)).equals(readFileSync(join(built, f))));
  if (onlyCommitted.length || onlyBuilt.length || changed.length) {
    console.error('dist/ does not match a fresh build. Run npm run build and commit dist/.');
    for (const f of onlyCommitted) console.error(`  only in dist/: ${f}`);
    for (const f of onlyBuilt) console.error(`  missing from dist/: ${f}`);
    for (const f of changed) console.error(`  content differs: ${f}`);
    process.exit(1);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
