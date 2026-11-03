/**
 * GitHub installs (`npx github:josephcake/swarmscope`) run this script.
 * When devDependencies are present, rebuild. When they are not (a consumer
 * install that only has the committed dist/), keep the committed build.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const haveTsc = existsSync(new URL('../node_modules/typescript/package.json', import.meta.url));
const haveVite = existsSync(new URL('../node_modules/vite/package.json', import.meta.url));
const haveDist = existsSync(new URL('../dist/cli.js', import.meta.url));
const haveViewer = existsSync(new URL('../dist/public/index.html', import.meta.url));

if (haveTsc && haveVite) {
  const run = (args) => {
    const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
  };
  const tsc = new URL('../node_modules/typescript/bin/tsc', import.meta.url);
  const vite = new URL('../node_modules/vite/bin/vite.js', import.meta.url);
  run([tsc.pathname, '-p', 'tsconfig.json']);
  run([vite.pathname, 'build']);
  process.exit(0);
}

if (haveDist && haveViewer) process.exit(0);

console.error('swarmscope: dist/ is missing and the build tools are not installed.');
console.error('Run npm install, then npm run build.');
process.exit(1);
