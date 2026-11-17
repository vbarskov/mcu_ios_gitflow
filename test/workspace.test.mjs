import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, lstat, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorkspace, inspectDiff } from '../lib/workspace.mjs';

const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'mcu-workspace-'))), repo = join(dir, 'repo'), remote = join(dir, 'origin.git');
  await mkdir(repo); g(repo, 'init', '--initial-branch=release'); g(dir, 'init', '--bare', remote);
  g(repo, 'config', 'user.name', 'Test'); g(repo, 'config', 'user.email', 'test@example.test');
  await writeFile(join(repo, 'main.swift'), 'let base = 1\n'); g(repo, 'add', '.'); g(repo, 'commit', '-m', 'Base');
  g(repo, 'remote', 'add', 'origin', `file://${remote}`); g(repo, 'push', 'origin', 'release');
  const store = { dir: join(dir, 'state'), save: t => t };
  await mkdir(store.dir);
  const task = { id: 'task-1', repoPath: repo, targetBranch: 'release', key: 'TEST-1' };
  return { dir, repo, remote, store, task, close: () => rm(dir, { recursive: true, force: true }) };
}

test('новая ветка создаётся от свежей origin в основной копии проекта', async () => {
  const f = await fixture();
  try {
    const seed = join(f.dir, 'seed'); g(f.dir, 'clone', f.remote, seed); g(seed, 'switch', 'release');
    g(seed, 'config', 'user.name', 'Test'); g(seed, 'config', 'user.email', 'test@example.test');
    await writeFile(join(seed, 'remote.swift'), 'let remote = 2\n'); g(seed, 'add', '.'); g(seed, 'commit', '-m', 'Fresh base'); g(seed, 'push', 'origin', 'release');
    const fresh = g(seed, 'rev-parse', 'HEAD'), original = g(f.repo, 'rev-parse', 'HEAD');
    const fetchHead = join(f.repo, '.git', 'FETCH_HEAD');
    await writeFile(fetchHead, 'previous fetch');
    const result = await createWorkspace(f.store, f.task, { baseBranch: 'release', workBranch: 'feature/TEST-1' });
    assert.equal(result.repoPath, f.repo);
    assert.equal(result.baseCommit, fresh); assert.notEqual(fresh, original);
    assert.equal(g(f.repo, 'rev-parse', 'HEAD'), fresh);
    assert.equal(g(f.repo, 'branch', '--show-current'), 'feature/TEST-1');
    assert.equal(g(f.repo, 'rev-parse', 'refs/heads/release'), original);
    assert.equal(await readFile(fetchHead, 'utf8'), 'previous fetch');
    assert.equal(await readFile(join(f.repo, 'remote.swift'), 'utf8'), 'let remote = 2\n');
    await writeFile(join(result.repoPath, 'main.swift'), 'visible work');
    assert.equal(await readFile(join(f.repo, 'main.swift'), 'utf8'), 'visible work');
    assert.equal(f.task.executionRepoPath, result.repoPath); assert.equal(f.task.workspaceBaseCommit, fresh);
    assert.equal(f.task.workspaceMode, 'main');
  } finally { await f.close(); }
});

test('повтор сохраняет правки текущей задачи и возвращает её ветку из чистой основной копии', async () => {
  const f = await fixture();
  try {
    const options = { baseBranch: 'release', workBranch: 'feature/TEST-1' };
    const first = await createWorkspace(f.store, f.task, options), again = await createWorkspace(f.store, f.task, options);
    assert.equal(again.repoPath, first.repoPath); assert.equal(again.reused, true);
    await assert.rejects(createWorkspace(f.store, f.task, { ...options, workBranch: 'feature/another' }), /ветк/i);
    await writeFile(join(first.repoPath, 'unfinished.swift'), 'work');
    assert.equal((await createWorkspace(f.store, f.task, options)).reused, true);
    assert.equal(await readFile(join(first.repoPath, 'unfinished.swift'), 'utf8'), 'work');
    g(f.repo, 'switch', 'release');
    await assert.rejects(createWorkspace(f.store, f.task, options), /незакоммичен|чист/i);
    assert.equal(g(f.repo, 'branch', '--show-current'), 'release');
    assert.equal(await readFile(join(f.repo, 'unfinished.swift'), 'utf8'), 'work');
    await rm(join(f.repo, 'unfinished.swift'));
    g(f.repo, 'remote', 'set-url', 'origin', 'https://must-not-be-requested.invalid/repo');
    assert.equal((await createWorkspace(f.store, f.task, options)).reused, true);
    assert.equal(g(f.repo, 'branch', '--show-current'), options.workBranch);
  } finally { await f.close(); }
});

test('чужие индексированные и новые файлы блокируют начало задачи', async () => {
  const f = await fixture();
  try {
    const options = { baseBranch: 'release', workBranch: 'feature/TEST-1' };
    await writeFile(join(f.repo, 'new.swift'), 'untracked work');
    await assert.rejects(createWorkspace(f.store, f.task, options), /незакоммичен|чист/i);
    assert.equal(await readFile(join(f.repo, 'new.swift'), 'utf8'), 'untracked work');
    await rm(join(f.repo, 'new.swift'));
    const path = join(f.repo, 'main.swift');
    const original = await readFile(path, 'utf8');
    await writeFile(path, 'staged work');
    g(f.repo, 'add', 'main.swift');
    await writeFile(path, original);
    await assert.rejects(createWorkspace(f.store, f.task, options), /незакоммичен|чист/i);
    assert.equal(g(f.repo, 'show', ':main.swift'), 'staged work');
    assert.equal(await readFile(path, 'utf8'), original);
    assert.equal(g(f.repo, 'branch', '--show-current'), 'release');
    assert.equal(f.task.executionRepoPath, undefined);
  } finally { await f.close(); }
});

test('создание задачи сохраняет файлы из локального списка игнорирования при конфликте путей', async () => {
  const f = await fixture();
  try {
    const seed = join(f.dir, 'seed');
    g(f.dir, 'clone', '--branch', 'release', f.remote, seed);
    g(seed, 'config', 'user.name', 'Test'); g(seed, 'config', 'user.email', 'test@example.test');
    await writeFile(join(seed, 'settings.swift'), 'remote'); g(seed, 'add', '.'); g(seed, 'commit', '-m', 'New file'); g(seed, 'push', 'origin', 'release');
    await writeFile(join(f.repo, '.git', 'info', 'exclude'), 'settings.swift\n');
    await writeFile(join(f.repo, 'settings.swift'), 'local ignored');
    await assert.rejects(createWorkspace(f.store, f.task, { baseBranch: 'release', workBranch: 'feature/TEST-1' }), /Git:/);
    assert.equal(await readFile(join(f.repo, 'settings.swift'), 'utf8'), 'local ignored');
    assert.equal(g(f.repo, 'branch', '--show-current'), 'release');
    assert.equal(f.task.executionRepoPath, undefined);
    await rm(join(f.repo, 'settings.swift'));
    g(f.repo, 'switch', '-c', 'other');
    const newer = await createWorkspace(f.store, f.task, { baseBranch: 'release', workBranch: 'feature/TEST-1-retry' });
    assert.equal(g(f.repo, 'branch', '--show-current'), newer.branch);
    assert.equal(f.task.workspacePreparation, undefined);
  } finally { await f.close(); }
});

test('новая задача требует основную рабочую копию с активной веткой и без незавершённого merge', async () => {
  const f = await fixture();
  try {
    const options = { baseBranch: 'release', workBranch: 'feature/TEST-1' };
    const linked = join(f.dir, 'linked');
    g(f.repo, 'worktree', 'add', '-b', 'feature/linked', linked);
    await assert.rejects(createWorkspace(f.store, { ...f.task, repoPath: linked }, options), /основн/i);
    g(f.repo, 'switch', '--detach');
    await assert.rejects(createWorkspace(f.store, f.task, options), /ветк/i);
    g(f.repo, 'switch', 'release');
    await writeFile(join(f.repo, '.git', 'MERGE_HEAD'), `${g(f.repo, 'rev-parse', 'HEAD')}\n`);
    await assert.rejects(createWorkspace(f.store, f.task, options), /операцией Git/i);
    assert.equal(g(f.repo, 'branch', '--show-current'), 'release');
    assert.equal(f.task.executionRepoPath, undefined);
  } finally { await f.close(); }
});

test('повтор привязывает уже переключённую ветку после ошибки сохранения карточки', async () => {
  const f = await fixture();
  try {
    const options = { baseBranch: 'release', workBranch: 'feature/TEST-1' };
    let saved;
    f.store.save = task => {
      if (!task.workspacePreparation) throw new Error('Не удалось сохранить карточку');
      saved = structuredClone(task);
    };
    await assert.rejects(createWorkspace(f.store, f.task, options), /Не удалось сохранить карточку/);
    assert.equal(saved.executionRepoPath, undefined);
    assert.equal(g(f.repo, 'branch', '--show-current'), options.workBranch);
    g(f.repo, 'remote', 'set-url', 'origin', 'https://must-not-be-requested.invalid/repo');
    f.store.save = task => task;
    const resumed = await createWorkspace(f.store, saved, options);
    assert.equal(resumed.reused, true);
    assert.equal(saved.executionRepoPath, f.repo);
    assert.equal(saved.workspacePreparation, undefined);
  } finally { await f.close(); }
});

test('занятое имя локальной или опубликованной ветки блокирует создание новой копии', async () => {
  const f = await fixture();
  try {
    g(f.repo, 'branch', 'feature/local');
    await assert.rejects(createWorkspace(f.store, f.task, { baseBranch: 'release', workBranch: 'feature/local' }), /уже|занят/i);
    g(f.repo, 'push', 'origin', 'release:feature/remote');
    await assert.rejects(createWorkspace(f.store, f.task, { baseBranch: 'release', workBranch: 'feature/remote' }), /уже|занят/i);
    await assert.rejects(createWorkspace(f.store, f.task, { baseBranch: 'release', workBranch: '--bad' }), /ветк/i);
    assert.equal(f.task.executionRepoPath, undefined);
  } finally { await f.close(); }
});

test('анализ возвращает закоммиченный diff, SHA и незакоммиченные файлы без запросов к origin', async () => {
  const f = await fixture();
  try {
    const workspace = await createWorkspace(f.store, f.task, { baseBranch: 'release', workBranch: 'feature/TEST-1' });
    await writeFile(join(workspace.repoPath, 'main.swift'), 'let fixed = true\n'.repeat(100)); g(workspace.repoPath, 'add', '.'); g(workspace.repoPath, 'commit', '-m', 'Fix');
    const previous = await readFile(join(workspace.repoPath, 'main.swift'), 'utf8');
    await writeFile(join(workspace.repoPath, 'main.swift'), 'staged work'); g(workspace.repoPath, 'add', 'main.swift');
    await writeFile(join(workspace.repoPath, 'main.swift'), previous);
    await writeFile(join(workspace.repoPath, 'draft.swift'), 'draft');
    g(workspace.repoPath, 'remote', 'set-url', 'origin', 'https://must-not-be-requested.invalid/repo');
    const diff = await inspectDiff(f.task, { maxBytes: 120 });
    assert.equal(diff.sourceCommit, g(workspace.repoPath, 'rev-parse', 'HEAD'));
    assert.equal(diff.targetCommit, f.task.workspaceBaseCommit);
    assert.equal(diff.checkedOutBranch, workspace.branch);
    assert.deepEqual(diff.files, ['main.swift']); assert.deepEqual(diff.dirtyFiles, ['draft.swift', 'main.swift']);
    assert.equal(diff.truncated, true); assert(diff.diffBytes > 120); assert(Buffer.byteLength(diff.diff) <= 120);
    assert.match(diff.numstat, /main.swift/); assert.match(diff.diff, /diff --git/);
  } finally { await f.close(); }
});

test('подменённый каталог не используется для продолжения задачи в старой рабочей копии', async () => {
  const f = await fixture();
  try {
    const outside = join(f.dir, 'outside'); await mkdir(outside);
    await symlink(outside, join(f.store.dir, 'workspaces'));
    const options = { baseBranch: 'release', workBranch: 'feature/TEST-1' };
    Object.assign(f.task, options, { executionRepoPath: join(f.store.dir, 'workspaces', f.task.id) });
    await assert.rejects(createWorkspace(f.store, f.task, options), /независим/i);
    await assert.rejects(access(join(outside, f.task.id)));
  } finally { await f.close(); }
});

test('сохранённая отдельная копия продолжает подготовку после ошибки fetch', async () => {
  const f = await fixture();
  try {
    const options = { baseBranch: 'release', workBranch: 'feature/TEST-1' };
    const savedPath = join(f.store.dir, 'workspaces', f.task.id);
    await mkdir(join(f.store.dir, 'workspaces'));
    g(f.repo, 'clone', '--no-local', '--no-hardlinks', f.repo, savedPath);
    const origin = g(f.repo, 'remote', 'get-url', 'origin');
    g(savedPath, 'remote', 'set-url', 'origin', origin);
    Object.assign(f.task, options, {
      executionRepoPath: savedPath, sourceBranch: options.workBranch, workspacePreparation: 'cloned',
      workspaceOrigin: origin, workspaceCloneCommit: g(savedPath, 'rev-parse', 'HEAD'),
    });
    await rm(f.remote, { recursive: true });
    await assert.rejects(createWorkspace(f.store, f.task, options), /Git:/);
    assert.equal(f.task.workspacePreparation, 'cloned');
    const inode = (await lstat(join(savedPath, '.git'))).ino;
    g(f.dir, 'init', '--bare', f.remote); g(f.repo, 'push', 'origin', 'release');
    const resumed = await createWorkspace(f.store, f.task, options);
    assert.equal(resumed.repoPath, savedPath); assert.equal(resumed.reused, true);
    assert.equal((await lstat(join(savedPath, '.git'))).ino, inode);
    assert.equal(f.task.workspacePreparation, undefined);
    assert.equal(g(savedPath, 'branch', '--show-current'), 'feature/TEST-1');
    assert.equal(g(f.repo, 'branch', '--show-current'), 'release');
  } finally { await f.close(); }
});
