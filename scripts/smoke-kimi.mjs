// Import regressions use an isolated home; never write the user's actual memory.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as mem from '../lib/index.js';

const temp = mkdtempSync(join(tmpdir(), 'dsh-kimi-test-'));
const home = join(temp, 'home');
const source = join(temp, 'export');
const target = join(home, '.dsh-mem/spaces/chat');
const put = (path, text) => { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, text); };
function snapshot(dir) {
  const result = {};
  function walk(path, prefix = '') {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const rel = prefix + entry.name;
      if (entry.isDirectory()) walk(join(path, entry.name), rel + '/');
      else result[rel] = createHash('sha256').update(readFileSync(join(path, entry.name))).digest('hex');
    }
  }
  walk(dir); return result;
}
let db;
try {
  put(join(source, 'sections.yaml'), 'inject_char_cap: 6000\nsections:\n  - path: sections/personal_context.md\n    title: Personal Context\n  - path: sections/taste.md\n    title: Taste & Preferences\n');
  put(join(source, 'sections/personal_context.md'), '用户喜欢研究记忆系统。[^52]\n');
  put(join(source, 'sections/taste.md'), '喜欢有证据的回答。[^3]\n');
  put(join(source, 'observations.md'), '## 2026-10-30\n\n- 暂存观察。[^52]\n');
  put(join(source, 'entities/project.md'), '---\nname: Project\ntags:\n  - project\n  - memory_system\ncreated: "2026-10-01"\nlast_updated: "2026-10-30"\naliases:\n  - "Memory Project"\n  - \'Project: Vault\'\n---\n\n# Project\n\n聊天里提到的项目。[[entities/tool|Tool]] [^52]\n');
  put(join(source, 'entities/tool.md'), '---\nname: Tool\n---\n工具。\n');
  put(join(source, 'raw/source_52/image.png'), Buffer.from([137, 80, 78, 71, 0, 255]));
  put(join(source, 'README.md'), '[... dream context trimmed ...]');
  put(join(source, 'index.md'), 'old index');
  put(join(target, 'old.md'), 'old chat');
  put(join(home, '.dsh-mem/shared/instructions.md'), 'KEEP SHARED');
  put(join(home, '.dsh-mem/spaces/project/projects/test/sections/status.md'), 'KEEP PROJECT');
  put(join(home, '.dsh-mem/spaces/project/projects/test/entities/project.md'), '---\nname: Project\n---\nKEEP PROJECT ENTITY\n');
  put(join(home, '.dsh-mem/raw/turns/session.jsonl'), 'KEEP RAW TURNS');
  put(join(home, '.dsh-mem/workspaces.yaml'), 'KEEP REGISTRY');
  const before = snapshot(join(home, '.dsh-mem'));
  const sourceBefore = snapshot(source);
  db = mem.openIndex(join(home, '.dsh-mem/index.db'));
  mem.rebuildVault(db, target, 'chat', null);
  mem.rebuildVault(db, join(home, '.dsh-mem/shared'), 'shared', null);
  mem.rebuildVault(db, join(home, '.dsh-mem/spaces/project/projects/test'), 'project', 'test');
  const otherEntries = mem.listEntries(db).filter(e => e.space !== 'chat');
  db.prepare("INSERT INTO sessions(session_id,title) VALUES ('keep-session','keep title')").run();
  const report = mem.importKimiVault(home, source, db);
  assert.equal(report.entities, 2);
  assert.equal(readFileSync(join(report.backup, 'old.md'), 'utf8'), 'old chat');
  assert.equal(existsSync(join(target, 'old.md')), false);
  assert.deepEqual(snapshot(source), sourceBefore, 'source export unchanged');
  for (const [path, hash] of Object.entries(before)) {
    if (path.startsWith('spaces/chat/')) continue;
    assert.equal(snapshot(join(home, '.dsh-mem'))[path], hash, `non-chat untouched: ${path}`);
  }
  assert.equal(db.prepare("SELECT title FROM sessions WHERE session_id='keep-session'").get().title, 'keep title');
  assert.deepEqual(mem.listEntries(db).filter(e => e.space !== 'chat'), otherEntries, 'shared/project index rows unchanged');
  assert.equal(readFileSync(join(target, 'raw/source_52/image.png')).equals(readFileSync(join(source, 'raw/source_52/image.png'))), true);
  assert.equal(mem.readResidentSections(target).length, 2);
  const entityIndex = new mem.EntityIndex([join(home, '.dsh-mem/shared')]);
  const injectionInput = { sharedVaultDir: join(home, '.dsh-mem/shared'), maxChars: 8000, entityIndex,
    resolveLayers: (_cwd, preset) => preset === 'chat' ? [{ label: 'chat', dir: target }] : [] };
  assert.equal(mem.buildInjection(injectionInput, { cwd: null, agentPreset: 'chat' }).includes('Project'), true);
  assert.equal((mem.buildInjection(injectionInput, { cwd: 'D:/project', agentPreset: 'project' }) ?? '').includes('Project'), false, 'chat catalog is absent from project injection');
  assert.equal(entityIndex.resolve('Project').hit.length, 0, 'chat entity is absent from common automatic recall');
  assert.equal(entityIndex.resolve('Project', [target]).hit.length, 1);
  const tools = new Map();
  mem.registerMemTools(tool => tools.set(tool.name, tool), { sharedDir: join(home, '.dsh-mem/shared'), index: entityIndex,
    presetOf: agent => agent.preset,
    entityDirs: (_cwd, preset) => [preset === 'chat' ? target : join(home, '.dsh-mem/spaces/project/projects/test')] });
  const chatEntity = await tools.get('mem_entity').execute({ name: 'Project' }, { agent: { preset: 'chat' } });
  const aliasEntity = await tools.get('mem_entity').execute({ name: 'Project: Vault' }, { agent: { preset: 'chat' } });
  const projectEntity = await tools.get('mem_entity').execute({ name: 'Project' }, { agent: { preset: 'project' } });
  assert.equal(chatEntity.text.includes('聊天里提到的项目'), true);
  assert.equal(aliasEntity.ok, true, 'Kimi block-list aliases resolve through mem_entity');
  assert.equal(aliasEntity.text.includes('memory_system'), true, 'entity tags are available when reading memory');
  assert.equal(projectEntity.text.includes('KEEP PROJECT ENTITY'), true, 'explicit project entity lookup stays in its own space');
  assert.equal(projectEntity.text.includes('聊天里提到的项目'), false);
  assert.equal(mem.readAnchors(target)[1].external.originalAvailable, false);
  assert.equal(mem.appendAnchor(target, { session: 'real-dsh', turn: 1, at: new Date().toISOString(), kind: 'observe' }).id, 53);
  const pages = mem.scanEntities(target);
  assert.deepEqual(pages.find(p => p.name === 'Project').tags, ['project', 'memory_system']);
  assert.equal(pages.find(p => p.name === 'Project').kind, 'project', 'Kimi type tag supplies kind when legacy kind is absent');
  assert.equal(mem.expandOneHop([pages.find(p => p.name === 'Project')], pages)[0].name, 'Tool');
  assert.equal(mem.listEntries(db, { spaces: ['chat'] }).some(e => e.rel === 'old.md'), false);
  assert.equal(mem.listEntries(db, { spaces: ['chat'] }).some(e => e.name === 'Project'), true);
  assert.equal(readFileSync(join(target, 'README.md'), 'utf8').includes('dream context trimmed'), false);
  assert.equal(readFileSync(join(target, 'raw/kimi-original/README.md'), 'utf8').includes('dream context trimmed'), true);
  const installed = snapshot(target);
  assert.throws(() => mem.importKimiVault(home, target, db), /重叠/);
  assert.deepEqual(snapshot(target), installed);
  // Failure after directory replacement must restore both old vault and its index.
  db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON idx_entries BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  assert.throws(() => mem.importKimiVault(home, source, db), /test failure/);
  db.exec('DROP TRIGGER fail_import');
  assert.deepEqual(snapshot(target), installed);
  assert.equal(mem.listEntries(db, { spaces: ['chat'] }).some(e => e.name === 'Project'), true);
  put(join(source, 'sections.yaml'), 'sections:\n  - path: sections/../../outside.md\n    title: Escape\n');
  assert.throws(() => mem.importKimiVault(home, source, db), /越界|缺失/);
  assert.deepEqual(snapshot(target), installed);
  // HTTP import requires explicit browser header and valid body.
  const routes = [];
  const dispose = mem.registerVaultRoutes({ logger: { info() {}, warn() {} }, get: () => ({ register: r => { routes.push(r); return () => {}; } }) }, {}, {
    importKimi: path => ({ target: path }),
  });
  const route = routes.find(r => r.path === '/dsh-mem/import-kimi');
  const call = (method, headers, body) => new Promise(resolve => {
    const req = Object.assign(new EventEmitter(), { method, headers });
    const res = { statusCode: 0, setHeader() {}, end(text) { resolve({ status: this.statusCode, data: JSON.parse(text) }); } };
    route.handler(req, res);
    req.emit('data', JSON.stringify(body)); req.emit('end');
  });
  assert.equal((await call('POST', {}, { source })).status, 403);
  assert.equal((await call('GET', {}, {})).status, 405);
  assert.equal((await call('POST', { 'x-dsh-mem-import': 'overwrite-chat' }, {})).status, 400);
  assert.equal((await call('POST', { 'x-dsh-mem-import': 'overwrite-chat' }, { source })).data.ok, true);
  dispose();
  console.log('Kimi import: overwrite, backup, isolation, citations, binary preservation, graph links, index, rollback and HTTP checks passed.');
} finally {
  if (db) mem.closeIndex(db);
  rmSync(temp, { recursive: true, force: true });
}
