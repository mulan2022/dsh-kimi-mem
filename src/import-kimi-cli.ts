#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { inspectKimiVault, importKimiVault } from './import-kimi.js';
import { openIndex, closeIndex } from './index-db.js';
import { indexDbPath } from './paths.js';

const args = process.argv.slice(2);
const source = args[0];
const homeAt = args.indexOf('--home');
const home = homeAt < 0 ? process.env.DSH_HOME || join(homedir(), '.dsh') : args[homeAt + 1];
try {
  if (!source || !home) throw new Error('用法: dsh-mem-import-kimi <解压目录> [--home <dsh home>] [--preview]');
  if (args.includes('--preview')) {
    const { dir, bytes, files, sections, refs, entities } = inspectKimiVault(source);
    console.log(JSON.stringify({ source: dir, home, files: files.length, bytes, sections, sourceRefs: refs.length, entities }, null, 2));
  } else {
    const db = openIndex(indexDbPath(home));
    try { console.log(JSON.stringify(importKimiVault(home, source, db), null, 2)); }
    finally { closeIndex(db); }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
