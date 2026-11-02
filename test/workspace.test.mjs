import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { renameSync } from 'node:fs';
import { createWorkspace, inspectDiff } from '../lib/workspace.mjs';

const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'mcu-workspace-')), repo = join(dir, 'repo'), remote = join(dir, 'origin.git');
  await mkdir(repo); g(repo, 'init', '--initial-branch=release'); g(dir, 'init', '--bare', remote);
  g(repo, 'config', 'user.name', 'Test'); g(repo, 'config', 'user.email', 'test@example.test');
  await writeFile(join(repo, 'main.swift'), 'let base = 1\n'); g(repo, 'add', '.'); g(repo, 'commit', '-m', 'Base');
  g(repo, 'remote', 'add', 'origin', `file://${remote}`); g(repo, 'push', 'origin', 'release');
  const store = { dir: join(dir, 'state'), save: t => t };
  await mkdir(store.dir);
  const task = { id: 'task-1', repoPath: repo, targetBranch: 'release', key: 'TEST-1' };
  return { dir, repo, remote, store, task, close: () => rm(dir, { recursive: true, force: true }) };
}

test('новая ветка создаётся от свежей origin в независимой копии без изменения исходных файлов', async () => {
  const f = await fixture();
  try {
    const seed = join(f.dir, 'seed'); g(f.dir, 'clone', f.remote, seed); g(seed, 'switch', 'release');
    g(seed, 'config', 'user.name', 'Test'); g(seed, 'config', 'user.email', 'test@example.test');
    await writeFile(join(seed, 'remote.swift'), 'let remote = 2\n'); g(seed, 'add', '.'); g(seed, 'commit', '-m', 'Fresh base'); g(seed, 'push', 'origin', 'release');
    const fresh = g(seed, 'rev-parse', 'HEAD'), original = g(f.repo, 'rev-parse', 'HEAD');
    await writeFile(join(f.repo, 'uncommitted.swift'), 'user work');
    const result = await createWorkspace(f.store, f.task, { baseBranch: 'release', workBranch: 'feature/TEST-1' });
    assert.equal(result.baseCommit, fresh); assert.notEqual(fresh, original);
    assert.equal(g(result.repoPath, 'rev-parse', 'HEAD'), fresh);
    assert.equal(g(result.repoPath, 'branch', '--show-current'), 'feature/TEST-1');
    assert.equal((await lstat(join(result.repoPath, '.git'))).isDirectory(), true);
    await assert.rejects(access(join(result.repoPath, '.git', 'objects', 'info', 'alternates')));
    await assert.rejects(access(join(result.repoPath, 'uncommitted.swift')));
    assert.equal(await readFile(join(f.repo, 'uncommitted.swift'), 'utf8'), 'user work');
    assert.equal(g(f.repo, 'rev-parse', 'HEAD'), original); assert.equal(g(f.repo, 'branch', '--show-current'), 'release');
    assert.equal(g(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/feature/TEST-1'), '');
    assert.equal(f.task.executionRepoPath, result.repoPath); assert.equal(f.task.workspaceBaseCommit, fresh);
  } finally { await f.close(); }
});

test('повтор использует только сохранённую чистую ветку, не перезаписывая другие изменения', async () => {
  const f = await fixture();
  try {
    const options = { baseBranch: 'release', workBranch: 'feature/TEST-1' };
    const first = await createWorkspace(f.store, f.task, options), again = await createWorkspace(f.store, f.task, options);
    assert.equal(again.repoPath, first.repoPath); assert.equal(again.reused, true);
    await assert.rejects(createWorkspace(f.store, f.task, { ...options, workBranch: 'feature/another' }), /ветк/i);
    await writeFile(join(first.repoPath, 'unfinished.swift'), 'work');
    await assert.rejects(createWorkspace(f.store, f.task, options), /незакоммичен|чист/i);
    assert.equal(await readFile(join(first.repoPath, 'unfinished.swift'), 'utf8'), 'work');
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
    await writeFile(join(workspace.repoPath, 'draft.swift'), 'draft');
    g(workspace.repoPath, 'remote', 'set-url', 'origin', 'https://must-not-be-requested.invalid/repo');
    const diff = await inspectDiff(f.task, { maxBytes: 120 });
    assert.equal(diff.sourceCommit, g(workspace.repoPath, 'rev-parse', 'HEAD'));
    assert.equal(diff.targetCommit, f.task.workspaceBaseCommit);
    assert.deepEqual(diff.files, ['main.swift']); assert.deepEqual(diff.dirtyFiles, ['draft.swift']);
    assert.equal(diff.truncated, true); assert(diff.diffBytes > 120); assert(Buffer.byteLength(diff.diff) <= 120);
    assert.match(diff.numstat, /main.swift/); assert.match(diff.diff, /diff --git/);
  } finally { await f.close(); }
});

test('подменённый каталог рабочих копий не позволяет записывать вне хранилища', async () => {
  const f = await fixture();
  try {
    const outside = join(f.dir, 'outside'); await mkdir(outside);
    await symlink(outside, join(f.store.dir, 'workspaces'));
    await assert.rejects(createWorkspace(f.store, f.task, { baseBranch: 'release', workBranch: 'feature/TEST-1' }), /символическ/i);
    await assert.rejects(access(join(outside, f.task.id)));
    assert.equal(f.task.executionRepoPath, undefined);
  } finally { await f.close(); }
});

test('ошибка fetch оставляет связанную копию для продолжения той же задачи', async () => {
  const f = await fixture();
  try {
    let disconnect = true;
    const offline = f.remote + '.offline', options = { baseBranch: 'release', workBranch: 'feature/TEST-1' };
    f.store.save = task => {
      if (disconnect && task.workspacePreparation === 'cloned') { disconnect = false; renameSync(f.remote, offline); }
      return task;
    };
    await assert.rejects(createWorkspace(f.store, f.task, options), /Git:/);
    assert.equal(f.task.workspacePreparation, 'cloned');
    const savedPath = f.task.executionRepoPath, inode = (await lstat(join(savedPath, '.git'))).ino;
    renameSync(offline, f.remote);
    const resumed = await createWorkspace(f.store, f.task, options);
    assert.equal(resumed.repoPath, savedPath); assert.equal(resumed.reused, true);
    assert.equal((await lstat(join(savedPath, '.git'))).ino, inode);
    assert.equal(f.task.workspacePreparation, undefined);
    assert.equal(g(savedPath, 'branch', '--show-current'), 'feature/TEST-1');
    assert.equal(g(f.repo, 'branch', '--show-current'), 'release');
  } finally { await f.close(); }
});
