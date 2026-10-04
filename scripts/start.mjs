#!/usr/bin/env node
// With DATABASE_URL: apply migrations, then serve the site and the parcel API.
// Without it: serve the install page and browser-only workspace, as before.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiEntry = path.join(root, 'api', 'main.js');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('DATABASE_URL is not set; parcels stay in each browser.');
    const { start } = await import('../server.mjs');
    await start();
    return;
  }
  if (!existsSync(apiEntry)) {
    throw new Error('api/main.js is missing. Run `npm run build` before `npm start`.');
  }
  const prismaCli = path.join(root, 'node_modules', 'prisma', 'build', 'index.js');
  const migrate = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], { cwd: root, stdio: 'inherit' });
  if (migrate.status !== 0) throw new Error('prisma migrate deploy failed.');
  const { bootstrap } = await import(apiEntry);
  await bootstrap();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
