import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { git, inspectZsRange, zsDestination } from './core/flow.mjs';
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

function verifyTaskWorkspace(task, path, baseBranch, workBranch) {
  if (resolve(task.executionRepoPath) !== path || task.baseBranch !== baseBranch || (task.workBranch || task.sourceBranch) !== workBranch) {
    throw new Error('Рабочая копия уже связана с другими ветками. Продолжите сохранённую задачу.');
  }
}

async function verifyWorkspace(task, path, baseBranch, workBranch) {
  verifyTaskWorkspace(task, path, baseBranch, workBranch);
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

async function finishLegacyPreparation(store, task, path, baseBranch, workBranch) {
  await git(path, 'fetch', '--no-tags', 'origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`);
  const baseCommit = await git(path, 'rev-parse', '--verify', `refs/remotes/origin/${baseBranch}^{commit}`);
  await git(path, 'switch', '-c', workBranch, baseCommit);
  task.workspaceBaseCommit = baseCommit;
  delete task.workspacePreparation;
  delete task.workspaceCloneCommit;
  store.save(task);
  return { repoPath: path, branch: workBranch, baseBranch, baseCommit, reused: true };
}

async function reuseLegacyWorkspace(store, task, baseBranch, workBranch) {
  const path = join(await realpath(store.dir), 'workspaces', task.id);
  await verifyWorkspace(task, path, baseBranch, workBranch);
  if (task.workspacePreparation === 'cloned') {
    const existing = await git(path, 'for-each-ref', '--format=%(refname)', `refs/heads/${workBranch}`);
    if (existing || !task.workspaceCloneCommit || await git(path, 'rev-parse', 'HEAD') !== task.workspaceCloneCommit) {
      throw new Error('История незавершённой рабочей копии изменилась. Проверьте её перед продолжением.');
    }
    return finishLegacyPreparation(store, task, path, baseBranch, workBranch);
  }
  if (await git(path, 'branch', '--show-current') !== workBranch) throw new Error('В сохранённой рабочей копии выбрана другая ветка.');
  if (!task.workspaceBaseCommit) throw new Error('У сохранённой рабочей копии нет подтверждённого базового коммита.');
  try { await git(path, 'merge-base', '--is-ancestor', task.workspaceBaseCommit, 'HEAD'); }
  catch { throw new Error('История рабочей ветки отличается от сохранённой базы.'); }
  return { repoPath: path, branch: workBranch, baseBranch, baseCommit: task.workspaceBaseCommit, reused: true };
}

async function mainCheckout(path) {
  const gitDir = await git(path, 'rev-parse', '--absolute-git-dir');
  const commonDir = await git(path, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (await realpath(gitDir) !== await realpath(commonDir)) {
    throw new Error('В настройках укажите основную рабочую копию проекта, открытую в SourceTree и Xcode.');
  }
  for (const state of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_START', 'rebase-apply', 'rebase-merge', 'sequencer']) {
    if (await exists(join(gitDir, state))) throw new Error('Основная рабочая копия занята незавершённой операцией Git. Завершите её перед продолжением.');
  }
  const branch = await git(path, 'branch', '--show-current');
  if (!branch) throw new Error('В основной рабочей копии выберите ветку перед продолжением.');
  return { branch, commit: await git(path, 'rev-parse', '--verify', 'HEAD^{commit}') };
}

async function requireCleanCheckout(path) {
  if (await git(path, 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none')) {
    throw new Error('В основной рабочей копии есть незакоммиченные изменения. Сохраните их перед переключением ветки.');
  }
}

const switchSafety = ['switch', '--no-overwrite-ignore', '--no-recurse-submodules'];

async function finishMainPreparation(store, task, path, checkout, reused) {
  const { workBranch: branch, baseBranch, baseCommit } = task.workspacePreparation;
  if (checkout.branch !== branch) {
    await requireCleanCheckout(path);
    await git(path, ...switchSafety, '--no-track', '-c', branch, baseCommit);
  }
  const active = await mainCheckout(path);
  if (active.branch !== branch || active.commit !== baseCommit) throw new Error('Ветка переключилась на неожиданный коммит. Проверьте её перед продолжением задачи.');
  await requireCleanCheckout(path);
  Object.assign(task, {
    executionRepoPath: path, sourceBranch: branch, workBranch: branch, baseBranch,
    workspaceMode: 'main', workspaceBaseCommit: baseCommit,
  });
  delete task.workspacePreparation;
  store.save(task);
  return { repoPath: path, branch, baseBranch, baseCommit, reused };
}

async function reuseMainWorkspace(task, path, baseBranch, workBranch, checkout) {
  verifyTaskWorkspace(task, path, baseBranch, workBranch);
  const baseCommit = task.workspaceBaseCommit;
  if (!baseCommit) throw new Error('У сохранённой рабочей копии нет подтверждённого базового коммита.');
  const ref = `refs/heads/${workBranch}`;
  try { await git(path, 'merge-base', '--is-ancestor', baseCommit, ref); }
  catch { throw new Error('Сохранённая рабочая ветка отсутствует или её история отличается от сохранённой базы.'); }
  if (checkout.branch !== workBranch) {
    await requireCleanCheckout(path);
    await git(path, ...switchSafety, '--no-guess', workBranch);
    if (await git(path, 'branch', '--show-current') !== workBranch) throw new Error('Не удалось подтвердить переключение на ветку задачи.');
    await requireCleanCheckout(path);
  }
  return { repoPath: path, branch: workBranch, baseBranch, baseCommit, reused: true };
}

export async function createWorkspace(store, task, { baseBranch, workBranch }) {
  branches(baseBranch, workBranch);
  if (!/^[A-Za-z0-9-]+$/.test(task.id || '')) throw new Error('Некорректный идентификатор задачи.');
  if (task.executionRepoPath && task.workspaceMode !== 'main') return reuseLegacyWorkspace(store, task, baseBranch, workBranch);

  const path = await rootRepository(task.repoPath);
  const checkout = await mainCheckout(path);
  if (task.executionRepoPath) return reuseMainWorkspace(task, path, baseBranch, workBranch, checkout);
  const pending = task.workspacePreparation;
  if (pending?.mode === 'main' && pending.workBranch === checkout.branch) {
    if (pending.path !== path || pending.baseBranch !== baseBranch || pending.workBranch !== workBranch) {
      throw new Error('Завершите подготовку ветки с сохранёнными параметрами задачи.');
    }
    return finishMainPreparation(store, task, path, checkout, true);
  }
  await requireCleanCheckout(path);
  const workRef = `refs/heads/${workBranch}`;
  const localRefs = (await git(path, 'for-each-ref', '--format=%(refname)', 'refs/heads')).split('\n');
  if (localRefs.some(ref => ref && (ref === workRef || ref.startsWith(`${workRef}/`) || workRef.startsWith(`${ref}/`)))) {
    throw new Error('Имя новой рабочей ветки уже занято в основном репозитории.');
  }
  if (await git(path, 'ls-remote', '--heads', 'origin', workRef)) throw new Error('Имя новой рабочей ветки уже занято в origin.');
  const baseRef = `refs/remotes/origin/${baseBranch}`;
  await git(path, 'fetch', '--no-tags', '--no-prune', '--no-recurse-submodules', '--no-write-fetch-head', '--refmap=', 'origin', `+refs/heads/${baseBranch}:${baseRef}`);
  const baseCommit = await git(path, 'rev-parse', '--verify', `${baseRef}^{commit}`);
  const current = await mainCheckout(path);
  if (current.branch !== checkout.branch || current.commit !== checkout.commit) {
    throw new Error('Основная рабочая копия изменилась при обновлении origin. Проверьте текущую ветку и повторите запрос.');
  }
  await requireCleanCheckout(path);
  task.workspacePreparation = { mode: 'main', path, workBranch, baseBranch, baseCommit };
  store.save(task);
  return finishMainPreparation(store, task, path, current, false);
}

export async function inspectDiff(task, { maxBytes = 500000, kind } = {}) {
  const sourceBranch = task.sourceBranch || task.workBranch;
  const targetBranch = kind === 'zs' ? zsDestination(task) : task.targetBranch || task.baseBranch;
  if (!validBranch(sourceBranch) || !validBranch(targetBranch)) throw new Error('Укажите корректные исходную ветку и ветку назначения.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) throw new Error('Некорректный предел размера diff.');
  const repo = await rootRepository(task.executionRepoPath || task.repoPath);
  const sourceCommit = await git(repo, 'rev-parse', '--verify', `refs/heads/${sourceBranch}^{commit}`);
  const targetCommit = await git(repo, 'rev-parse', '--verify', `refs/remotes/origin/${targetBranch}^{commit}`);
  const range = `${targetCommit}...${sourceCommit}`;
  const diff = await git(repo, 'diff', '--no-ext-diff', '--no-textconv', range, '--');
  const zs = kind === 'zs' ? await inspectZsRange(repo, targetCommit, sourceCommit) : null;
  const files = zs?.files || (await git(repo, 'diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', range, '--')).split('\0').filter(Boolean);
  const numstat = await git(repo, 'diff', '--no-ext-diff', '--no-textconv', '--numstat', range, '--');
  const staged = (await git(repo, 'diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', '--cached', 'HEAD', '--')).split('\0').filter(Boolean);
  const unstaged = (await git(repo, 'diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', '--')).split('\0').filter(Boolean);
  const untracked = (await git(repo, 'ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean);
  const checkedOutBranch = await git(repo, 'branch', '--show-current');
  const bytes = Buffer.from(diff), truncated = bytes.length > maxBytes;
  return {
    ...zs, ...(zs ? {sourceBranch, targetBranch} : {}),
    sourceCommit, targetCommit, checkedOutBranch, files, numstat, diff: truncated ? new TextDecoder().decode(bytes.subarray(0, maxBytes), { stream: true }) : diff,
    diffBytes: bytes.length, truncated, dirtyFiles: [...new Set([...staged, ...unstaged, ...untracked])].sort(),
  };
}
