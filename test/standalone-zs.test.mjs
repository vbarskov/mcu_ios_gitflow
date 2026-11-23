import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '../lib/config.mjs';
import { Flow, git } from '../lib/core/flow.mjs';
import { GitLab } from '../lib/core/gitlab.mjs';
import { Plugin } from '../lib/plugin.mjs';

const targetBranch = 'minor/9.1';
const workBranch = 'feature/APP-123';
const codePath = 'App/main.swift';
const demo = { afterUrl: 'https://demo.example.test/after.mp4', demo: 'Значение изменилось на два.' };

async function fixture(t, technicalLines, { existingBranch = false, technicalOnly = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mcu-zs-'));
  const repo = join(dir, 'source');
  const origin = join(dir, 'origin.git');
  let plugin;
  t.after(async () => {
    plugin?.close();
    await rm(dir, { recursive: true, force: true });
  });

  await mkdir(join(repo, 'App'), { recursive: true });
  await git(dir, 'init', '--bare', origin);
  await git(repo, 'init', '-b', targetBranch);
  await git(repo, 'config', 'user.name', 'Тест');
  await git(repo, 'config', 'user.email', 'test@example.test');
  await writeFile(join(repo, codePath), 'let value = 1\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'База');
  await git(repo, 'branch', 'release');
  await writeFile(join(repo, 'App', 'minor.swift'), 'let minorVersion = "9.1"\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'Изменение в minor');
  await git(repo, 'remote', 'add', 'origin', origin);
  await git(repo, 'push', 'origin', targetBranch, 'release');
  const config = new Config(join(dir, 'data'));
  config.save({ gitlabUrl: 'https://git.example.test', jiraBaseUrl: 'https://jira.example.test', project: 'team/app', repoPath: repo, targetBranch: 'release' });

  const writes = [];
  let mr;
  const api = new GitLab(config.get());
  api.request = async (path, method = 'GET', body) => {
    const requests = `${api.project({ project: 'team/app' })}/merge_requests`;
    if (path === '/user' && method === 'GET') return { id: 7 };
    if (path === '/projects/team%2Fapp' && method === 'GET') return {};
    if (path.startsWith(`${requests}?`) && method === 'GET') return mr ? [mr] : [];
    if (path === `${requests}/10` && method === 'GET') return mr;
    if (path.startsWith(`${requests}/10/discussions?`) && method === 'GET') return [];
    if (path.startsWith(`${requests}/10/commits?`) && method === 'GET') {
      const commits = await git(origin, 'rev-list', `refs/heads/${mr.target_branch}..${mr.sha}`);
      return commits.split('\n').filter(Boolean).map(id => ({ id }));
    }
    if (path === '/projects/team%2Fapp/uploads' && method === 'POST') {
      writes.push({ method, path });
      return { url: '/uploads/code.png' };
    }
    if (path === requests && method === 'POST') {
      writes.push({ method, path, body });
      const sha = await git(origin, 'rev-parse', `refs/heads/${body.source_branch}`);
      mr = { iid: 10, state: 'opened', sha, author: { id: 7 }, web_url: 'https://git.example.test/team/app/-/merge_requests/10', ...body };
      return mr;
    }
    if (path === `${requests}/10` && method === 'PUT') {
      writes.push({ method, path, body });
      mr = { ...mr, ...body };
      return mr;
    }
    if (path === `${requests}/10/merge` && method === 'PUT') {
      writes.push({ method, path, body });
      assert.equal(body.sha, mr.sha);
      await git(origin, 'update-ref', `refs/heads/${mr.target_branch}`, mr.sha);
      mr = { ...mr, state: 'merged', merged_at: '2026-11-23T12:00:00.000Z', merge_commit_sha: mr.sha };
      return mr;
    }
    assert.fail(`Неожиданный запрос ${method} ${path}`);
  };

  class TestFlow extends Flow {
    async validateRepository(task, target = task.targetBranch) {
      await git(task.executionRepoPath || task.repoPath, 'fetch', 'origin', `+refs/heads/${target}:refs/remotes/origin/${target}`);
      return `refs/remotes/origin/${target}`;
    }
  }
  plugin = new Plugin({ config, flowFactory: (store, settings) => new TestFlow(store, settings, api), gitlabFactory: () => api });
  const card = plugin.store.create({
    ...config.public(), key: 'APP-123', jiraUrl: 'https://jira.example.test/browse/APP-123', title: 'Исправить значение',
    sourceBranch: workBranch,
    featureName: 'Звонки', expectedResult: 'Значение равно двум', done: 'Изменено значение', result: 'Возвращается два',
    changes: [{ module: 'App', text: technicalOnly ? 'Добавлены проверки значения' : 'Изменено значение' }],
    keyCodePaths: technicalOnly ? [] : [codePath], verification: 'Локальный тест пройден',
  });
  const call = (name, args = {}) => plugin.call(name, { taskId: card.id, ...args });
  if (existingBranch) await git(repo, 'switch', '-c', workBranch);
  else await call('mcu_create_workspace', { baseBranch: targetBranch, workBranch });
  const baseCommit = await git(repo, 'rev-parse', 'HEAD');
  if (!technicalOnly) await writeFile(join(repo, codePath), 'let value = 2\n');
  await mkdir(join(repo, 'Tests'));
  await writeFile(join(repo, 'Tests', 'MainTests.swift'), '// technical change\n'.repeat(technicalLines));
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'Исправить значение');
  const sourceCommit = await git(repo, 'rev-parse', 'HEAD');
  if (!existingBranch) await call('mcu_record_commit', { kind: 'zs' });
  if (!technicalOnly) {
    const image = join(dir, 'code.png');
    await writeFile(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await call('mcu_upload', { kind: 'code', path: image, module: 'App', codePath });
  }

  return { dir, repo, origin, sourceCommit, baseCommit, call, writes };
}

test('ЗС с 499 добавленными строками требует демо и открывается с кодом в фактическую ветку назначения', async t => {
  const { dir, repo, origin, sourceCommit, baseCommit, call, writes } = await fixture(t, 498);
  const diff = await call('mcu_diff', { kind: 'zs' });
  assert.equal(diff.addedLines, 499);
  assert.equal(diff.deletedLines, 1);
  assert.equal(diff.changedLines, 500);
  assert.equal(diff.eligibleForZs, true);
  const missingDemo = await call('mcu_preview', { kind: 'zs' });
  assert.equal(missingDemo.ready, false);
  assert.equal(missingDemo.previewToken, undefined);
  assert.match(missingDemo.blockers.join('\n'), /демонстрац/i);
  assert.deepEqual(writes, []);

  await call('mcu_update_task', demo);
  const preview = await call('mcu_preview', { kind: 'zs' });
  assert.equal(preview.ready, true, preview.blockers.join('\n'));
  assert.equal(preview.title, '!<номер> #123 Звонки Исправить значение');
  assert.match(preview.description, /## Изменения[\s\S]*Изменено значение/);
  assert.match(preview.description, /## Демонстрация[\s\S]*Значение изменилось на два/);
  assert.doesNotMatch(preview.description, /Включает следующие УЗС|Локальный тест пройден/);

  const published = await call('mcu_publish', { kind: 'zs', previewToken: preview.previewToken });
  assert.equal(published.zs.state, 'opened');
  assert.equal(published.zs.target_branch, targetBranch);
  assert.equal(published.zs.title, '!10 #123 Звонки Исправить значение');
  assert.match(published.zs.description, /\/uploads\/code\.png/);
  assert.match(published.zs.description, /https:\/\/demo\.example\.test\/after\.mp4/);
  assert.equal(published.uzs, undefined);
  assert.equal(published.kzs, undefined);
  assert.equal(writes.filter(write => write.path.endsWith('/merge_requests') && write.method === 'POST').length, 1);
  assert.equal(await git(origin, 'rev-parse', `refs/heads/${targetBranch}`), baseCommit);
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), sourceCommit);
  assert.equal(await git(origin, 'rev-list', '--count', `${baseCommit}..${published.zs.sha}`), '2');
  assert.equal(await git(origin, 'rev-parse', `${published.zs.sha}^`), sourceCommit);
  assert.equal(await git(origin, 'log', '-1', '--format=%s', published.zs.sha), 'Отступ');
  assert.equal(await git(origin, 'diff', '--name-only', `${baseCommit}..${published.zs.sha}`), `${codePath}\nTests/MainTests.swift`);
  assert.equal(await git(origin, 'rev-parse', `${published.zs.sha}^{tree}`), await git(repo, 'rev-parse', `${sourceCommit}^{tree}`));

  await assert.rejects(call('mcu_merge_zs', { confirmation: 'Слить !11' }), /Слить !10/);
  assert.equal(writes.some(write => write.path.endsWith('/merge')), false);
  const merged = await call('mcu_merge_zs', { confirmation: 'Слить !10' });
  assert.equal(merged.zs.state, 'merged');
  assert.equal(merged.stage, 'complete');
  assert.equal(merged.kzs, undefined);
  assert.equal(await git(origin, 'rev-parse', `refs/heads/${targetBranch}`), published.zs.sha);
  const [codeImage] = merged.assets;
  assert.equal(codeImage.remote.url, '/uploads/code.png');
  await assert.rejects(access(join(dir, 'data', 'uploads', codeImage.id)), { code: 'ENOENT' });
});

test('Ровно 500 добавленных строк с учётом технических блокируют публикацию прямого ЗС', async t => {
  const { call, writes } = await fixture(t, 499);
  const diff = await call('mcu_diff', { kind: 'zs' });
  assert.equal(diff.addedLines, 500);
  assert.equal(diff.changedLines, 501);
  assert.equal(diff.eligibleForZs, false);
  await call('mcu_update_task', { ...demo, featureName: '' });
  const preview = await call('mcu_preview', { kind: 'zs' });
  assert.equal(preview.title, '!<номер> #123 Исправить значение');
  assert.equal(preview.ready, false);
  assert.equal(preview.previewToken, undefined);
  assert.match(preview.blockers.join('\n'), /500/);
  await assert.rejects(call('mcu_publish', { kind: 'zs', previewToken: 'invented' }), /предпросмотр/);
  assert.deepEqual(writes, []);
});

test('Для готовой ветки без сохранённой базы ЗС использует только явно выбранное назначение', async t => {
  const { call, writes } = await fixture(t, 1, { existingBranch: true });
  await assert.rejects(call('mcu_diff', { kind: 'zs' }), /ветк/i);
  await call('mcu_update_task', { ...demo, targetBranch });
  await call('mcu_record_commit', { kind: 'zs' });
  const diff = await call('mcu_diff', { kind: 'zs' });
  assert.equal(diff.addedLines, 2);
  const preview = await call('mcu_preview', { kind: 'zs' });
  assert.equal(preview.ready, true, preview.blockers.join('\n'));
  assert.deepEqual(writes, []);
});

test('Обновление origin после предпросмотра останавливает ЗС до загрузки вложений', async t => {
  const { dir, repo, origin, baseCommit, call, writes } = await fixture(t, 1);
  await call('mcu_update_task', demo);
  const preview = await call('mcu_preview', { kind: 'zs' });
  assert.equal(preview.ready, true, preview.blockers.join('\n'));

  const other = join(dir, 'other');
  await git(dir, 'clone', '--branch', targetBranch, origin, other);
  await git(other, 'config', 'user.name', 'Тест');
  await git(other, 'config', 'user.email', 'test@example.test');
  await git(other, 'commit', '--allow-empty', '-m', 'Новый коммит в целевой ветке');
  await git(other, 'push', 'origin', targetBranch);
  assert.equal(await git(repo, 'rev-parse', `refs/remotes/origin/${targetBranch}`), baseCommit);

  await assert.rejects(call('mcu_publish', { kind: 'zs', previewToken: preview.previewToken }), /предпросмотр/i);
  assert.deepEqual(writes, []);
  const refreshed = await call('mcu_preview', { kind: 'zs' });
  assert.equal(refreshed.ready, true, refreshed.blockers.join('\n'));
  assert.notEqual(refreshed.previewToken, preview.previewToken);
  const published = await call('mcu_publish', { kind: 'zs', previewToken: refreshed.previewToken });
  assert.equal(published.zs.target_branch, targetBranch);
});

test('ЗС только с тестами описывает изменения и требует явного разрешения на вариант без демо', async t => {
  const { call, origin, baseCommit } = await fixture(t, 2, { technicalOnly: true });
  const missingDemo = await call('mcu_preview', { kind: 'zs' });
  assert.equal(missingDemo.ready, false);
  assert.match(missingDemo.blockers.join('\n'), /демонстрац/i);
  await assert.rejects(call('mcu_confirm_zs', { confirmation: 'Продолжай' }), /Создать ЗС без демонстрации/);
  await call('mcu_confirm_zs', { confirmation: 'Создать ЗС без демонстрации' });
  const preview = await call('mcu_preview', { kind: 'zs' });
  assert.equal(preview.ready, true, preview.blockers.join('\n'));
  const published = await call('mcu_publish', { kind: 'zs', previewToken: preview.previewToken });
  assert.match(published.zs.description, /## Изменения\n\n- App — Добавлены проверки значения/);
  assert.equal(await git(origin, 'diff', '--name-only', `${baseCommit}..${published.zs.sha}`), 'Tests/MainTests.swift');
});
