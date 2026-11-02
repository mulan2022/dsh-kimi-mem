/** Kimi vault import: canonical files stay native, only derived files are rebuilt. */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { acquireLease, releaseLease } from './dream.js';
import { rebuildVault } from './index-db.js';
import { memRoot, spaceDir } from './paths.js';
import { parseSectionsYaml, sectionInjectCap } from './sections.js';

function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function inspectKimiVault(source: string) {
  const dir = realpathSync(resolve(source));
  const files: string[] = [];
  let bytes = 0;
  function walk(path: string): void {
    for (const entry of readdirSync(path)) {
      const full = join(path, entry);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error('导入目录不能包含符号链接或 junction');
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) {
        bytes += stat.size;
        files.push(relative(dir, full).split(sep).join('/'));
        if (bytes > 200 * 1024 * 1024 || files.length > 10000) throw new Error('导出超过 200 MB 或 10000 个文件');
      } else throw new Error('导入目录包含不支持的文件类型');
    }
  }
  walk(dir);
  const yaml = readFileSync(join(dir, 'sections.yaml'), 'utf8');
  const sections = parseSectionsYaml(yaml);
  if (!sections.length || !sections.every(s => s.file.startsWith('sections/') && contains(dir, resolve(dir, s.file)) && files.includes(s.file))) {
    throw new Error('sections.yaml 无有效分节，或指向缺失/越界文件');
  }
  if (!files.includes('observations.md') || !files.some(f => f.startsWith('entities/') && f.endsWith('.md'))) {
    throw new Error('请选择解压后的 Kimi vault 根目录（包含 sections.yaml、observations.md、entities/）');
  }
  const canonical = files.filter(f => !f.startsWith('raw/') && f.endsWith('.md'));
  const refs = new Set<number>();
  for (const file of canonical) {
    for (const match of readFileSync(join(dir, file), 'utf8').matchAll(/\[\^(\d+)\]/g)) refs.add(Number(match[1]));
  }
  if ([...refs].some(n => !Number.isSafeInteger(n) || n <= 0)) throw new Error('来源编号无效');
  const sectionChars = sections.reduce((n, s) => n + readFileSync(join(dir, s.file), 'utf8').length, 0);
  return { dir, files, bytes, sections, sectionChars, injectCharCap: sectionInjectCap(yaml), refs: [...refs].sort((a, b) => a - b),
    entities: files.filter(f => /^entities\/[^/]+\.md$/.test(f)).length };
}

/** Caller must stop other dsh processes sharing this home. Running dream is refused. */
export function importKimiVault(home: string, source: string, db?: DatabaseSync) {
  const info = inspectKimiVault(source);
  const root = memRoot(resolve(home));
  mkdirSync(root, { recursive: true });
  const actualRoot = realpathSync(root);
  if (contains(actualRoot, info.dir) || contains(info.dir, actualRoot)) throw new Error('源目录不能与目标记忆库重叠');
  const target = spaceDir(resolve(home), 'chat');
  // Refuse redirected targets before any rename/copy.
  mkdirSync(dirname(target), { recursive: true });
  if (!contains(actualRoot, realpathSync(dirname(target))) || (existsSync(target) && lstatSync(target).isSymbolicLink())) {
    throw new Error('目标聊天库不能是符号链接或 junction');
  }
  if (!acquireLease(home, 'kimi-import')) throw new Error('记忆整理正在运行，请完成后重试');
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const stage = join(actualRoot, `kimi-stage-${id}`);
  const backup = join(actualRoot, 'backups', `kimi-${id}`, 'chat');
  let moved = false;
  let installed = false;
  let transaction = false;
  try {
    cpSync(info.dir, stage, { recursive: true, preserveTimestamps: true });
    const original = join(stage, 'raw', 'kimi-original');
    mkdirSync(original, { recursive: true });
    for (const file of ['README.md', 'index.md', 'sections.yaml']) {
      if (existsSync(join(stage, file))) cpSync(join(stage, file), join(original, file));
    }
    // No Kimi transcript is present: reserve imported numbers without inventing a DSH session.
    writeFileSync(join(stage, 'raw', 'anchors.jsonl'), info.refs.map(id => JSON.stringify({
      id, session: '', turn: 0, at: '', kind: 'kimi-import',
      external: { provider: 'kimi', sourceRef: id, originalAvailable: false },
    })).join('\n') + '\n');
    const note = 'Kimi 导入资料；原始会话未随导出提供，来源角标仅保留 Kimi source_ref，不代表 DSH 会话。';
    writeFileSync(join(stage, 'README.md'), `# Memory Vault\n\n> ${note}\n\n` + info.sections.map(s =>
      `## ${s.name}\n\n${readFileSync(join(stage, s.file), 'utf8').trim()}\n`).join('\n'));
    const pages = info.files.filter(f => /^(sections|entities)\/.*\.md$/.test(f));
    writeFileSync(join(stage, 'index.md'), '# Vault Index\n\n' + pages.map(f => `- [[${f.slice(0, -3)}|${f.slice(0, -3).split('/').pop()}]]`).join('\n') + '\n');
    const report = { provider: 'kimi', importedAt: new Date().toISOString(), source: info.dir,
      target, backup: existsSync(target) ? backup : null, files: info.files.length, bytes: info.bytes,
      sections: info.sections.length, entities: info.entities, sourceRefs: info.refs.length,
      sectionChars: info.sectionChars, injectCharCap: info.injectCharCap,
      overSectionBudget: info.injectCharCap !== null && info.sectionChars > info.injectCharCap,
      originalConversationsAvailable: false,
      warnings: ['README/index 已从 canonical 文件重建；原版在 raw/kimi-original。', '不导入 RCC 对话历史；原始会话未包含在本导出中。', 'shared 常驻记忆和项目库保持原样。', 'inject_char_cap 保留为整理预算目标，不据此删除或裁切 canonical 文件；注入仍受 injectMaxChars 限制。'] };
    writeFileSync(join(stage, 'raw', 'kimi-import.json'), JSON.stringify(report, null, 2));
    if (db) { db.exec('BEGIN IMMEDIATE'); transaction = true; }
    if (existsSync(target)) {
      mkdirSync(dirname(backup), { recursive: true });
      if (!contains(actualRoot, realpathSync(dirname(backup)))) throw new Error('备份目录不能指向记忆库外部');
      renameSync(target, backup);
      moved = true;
    }
    renameSync(stage, target);
    installed = true;
    if (db) rebuildVault(db, target, 'chat', null);
    if (db) { db.exec('COMMIT'); transaction = false; }
    return report;
  } catch (error) {
    if (transaction) db!.exec('ROLLBACK');
    if (installed) rmSync(target, { recursive: true, force: true });
    if (moved) renameSync(backup, target);
    throw error;
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
    releaseLease(home);
  }
}
