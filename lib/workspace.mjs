import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { git } from './core/flow.mjs';
import { validBranch } from './config.mjs';

export { validBranch };

function branches(baseBranch, workBranch) {
  if (!validBranch(baseBranch) || !validBranch(workBranch) || baseBranch === workBranch) {
    throw new Error('Укажите корректные разные исходную и новую рабочую ветки.');
  }
}

async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function rootRepository(repo) {
  const root = await realpath(repo);
  if (await realpath(await git(root, 'rev-parse', '--show-toplevel')) !== root) throw new Error('Укажите корень Git-репозитория.');
  return root;
}

async function verifyWorkspace(task, path, baseBranch, workBranch) {
  if (resolve(task.executionRepoPath) !== path || task.baseBranch !== baseBranch || (task.workBranch || task.sourceBranch) !== workBranch) {
    throw new Error('Рабочая копия уже связана с другими ветками. Продолжите сохранённую задачу.');
  }
  if (!await exists(path) || await realpath(path) !== path || !(await lstat(join(path, '.git'))).isDirectory() || await exists(join(path, '.git', 'objects', 'info', 'alternates'))) {
    throw new Error('Не удалось подтвердить независимость сохранённой рабочей копии.');
  }
  await rootRepository(path);
  if (await git(path, 'status', '--porcelain')) throw new Error('В сохранённой рабочей копии есть незакоммиченные изменения. Завершите их перед повтором.');
  const source = await rootRepository(task.repoPath), origin = await git(source, 'remote', 'get-url', 'origin');
  if (await git(path, 'remote', 'get-url', 'origin') !== origin || (task.workspaceOrigin && task.workspaceOrigin !== origin)) {
    throw new Error('Адрес origin сохранённой рабочей копии отличается от исходного репозитория.');
  }
}

async function finishPreparation(store, task, path, baseBranch, workBranch, reused) {
  await git(path, 'fetch', '--no-tags', 'origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`);
  const baseCommit = await git(path, 'rev-parse', '--verify', `refs/remotes/origin/${baseBranch}^{commit}`);
  await git(path, 'switch', '-c', workBranch, baseCommit);
  task.workspaceBaseCommit = baseCommit;
  delete task.workspacePreparation;
  delete task.workspaceCloneCommit;
  store.save(task);
  return { repoPath: path, branch: workBranch, baseBranch, baseCommit, reused };
}

async function reuse(store, task, path, baseBranch, workBranch) {
  await verifyWorkspace(task, path, baseBranch, workBranch);
  if (task.workspacePreparation === 'cloned') {
    const existing = await git(path, 'for-each-ref', '--format=%(refname)', `refs/heads/${workBranch}`);
    if (existing || !task.workspaceCloneCommit || await git(path, 'rev-parse', 'HEAD') !== task.workspaceCloneCommit) {
      throw new Error('История незавершённой рабочей копии изменилась. Проверьте её перед продолжением.');
    }
    return finishPreparation(store, task, path, baseBranch, workBranch, true);
  }
  if (await git(path, 'branch', '--show-current') !== workBranch) throw new Error('В сохранённой рабочей копии выбрана другая ветка.');
  if (!task.workspaceBaseCommit) throw new Error('У сохранённой рабочей копии нет подтверждённого базового коммита.');
  try { await git(path, 'merge-base', '--is-ancestor', task.workspaceBaseCommit, 'HEAD'); }
  catch { throw new Error('История рабочей ветки отличается от сохранённой базы.'); }
  return { repoPath: path, branch: workBranch, baseBranch, baseCommit: task.workspaceBaseCommit, reused: true };
}

export async function createWorkspace(store, task, { baseBranch, workBranch }) {
  branches(baseBranch, workBranch);
  if (!/^[A-Za-z0-9-]+$/.test(task.id || '')) throw new Error('Некорректный идентификатор задачи.');
  const owner = await realpath(store.dir), path = join(owner, 'workspaces', task.id);
  if (task.executionRepoPath) return reuse(store, task, path, baseBranch, workBranch);
  if (await exists(path)) throw new Error('Каталог рабочей копии уже существует без связи с задачей. Проверьте его перед продолжением.');
  const source = await rootRepository(task.repoPath);
  const localBranches = (await git(source, 'for-each-ref', '--format=%(refname)', `refs/heads/${workBranch}`)).split('\n');
  if (localBranches.some(ref => ref === `refs/heads/${workBranch}` || ref.startsWith(`refs/heads/${workBranch}/`))) throw new Error('Имя новой рабочей ветки уже занято в исходном репозитории.');
  const remote = await git(source, 'remote', 'get-url', 'origin');
  if (!remote) throw new Error('В исходном репозитории не настроен origin.');
  if (await git(source, 'ls-remote', '--heads', 'origin', `refs/heads/${workBranch}`)) throw new Error('Имя новой рабочей ветки уже занято в origin.');
  const parent = join(owner, 'workspaces');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (await realpath(parent) !== parent || (await lstat(parent)).isSymbolicLink()) throw new Error('Каталог рабочих копий не должен быть символической ссылкой.');
  // --no-local передаёт объекты через Git transport, исключая общие объекты,
  // alternates и жёсткие ссылки на хранилище исходного репозитория.
  await git(source, 'clone', '--no-local', '--no-hardlinks', '--', source, path);
  await git(path, 'remote', 'set-url', 'origin', remote);
  for (const key of ['user.name', 'user.email']) {
    const value = await git(source, 'config', '--get', key).catch(() => '');
    if (value) await git(path, 'config', key, value);
  }
  const cloneCommit = await git(path, 'rev-parse', 'HEAD');
  if (await git(path, 'status', '--porcelain')) throw new Error('Созданная рабочая копия содержит незакоммиченные изменения. Проверьте её перед продолжением.');
  Object.assign(task, {
    executionRepoPath: path, sourceBranch: workBranch, workBranch, baseBranch,
    workspacePreparation: 'cloned', workspaceOrigin: remote, workspaceCloneCommit: cloneCommit,
  });
  store.save(task);
  return finishPreparation(store, task, path, baseBranch, workBranch, false);
}

export async function inspectDiff(task, { maxBytes = 500000 } = {}) {
  const sourceBranch = task.sourceBranch || task.workBranch, targetBranch = task.targetBranch || task.baseBranch;
  if (!validBranch(sourceBranch) || !validBranch(targetBranch)) throw new Error('Укажите корректные исходную ветку и ветку назначения.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) throw new Error('Некорректный предел размера diff.');
  const repo = await rootRepository(task.executionRepoPath || task.repoPath);
  const sourceCommit = await git(repo, 'rev-parse', '--verify', `refs/heads/${sourceBranch}^{commit}`);
  const targetCommit = await git(repo, 'rev-parse', '--verify', `refs/remotes/origin/${targetBranch}^{commit}`);
  const range = `${targetCommit}...${sourceCommit}`;
  const diff = await git(repo, 'diff', '--no-ext-diff', '--no-textconv', range, '--');
  const files = (await git(repo, 'diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', range, '--')).split('\0').filter(Boolean);
  const numstat = await git(repo, 'diff', '--no-ext-diff', '--no-textconv', '--numstat', range, '--');
  const dirty = (await git(repo, 'diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', 'HEAD', '--')).split('\0').filter(Boolean);
  const untracked = (await git(repo, 'ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean);
  const bytes = Buffer.from(diff), truncated = bytes.length > maxBytes;
  return {
    sourceCommit, targetCommit, files, numstat, diff: truncated ? new TextDecoder().decode(bytes.subarray(0, maxBytes), { stream: true }) : diff,
    diffBytes: bytes.length, truncated, dirtyFiles: [...new Set([...dirty, ...untracked])].sort(),
  };
}
