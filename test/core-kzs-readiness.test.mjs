import test from 'node:test';
import assert from 'node:assert/strict';
import { Flow } from '../lib/core/flow.mjs';

test('КЗС без подходящей строки со снимком останавливается до сети, загрузки и создания ветки', async () => {
  const candidates = [
    [],
    [{ id: 'tests', kind: 'code', module: 'Main', codePath: 'Modules/Main/Tests/test.swift' }],
    [{ id: 'history', kind: 'code', module: 'Main', codePath: 'history/main.swift' }],
    [{ id: 'wrong-module', kind: 'code', module: 'Other', codePath: 'Modules/Main/main.swift' }],
    [{ id: 'unselected', kind: 'code', module: 'Main', codePath: 'Modules/Main/other.swift' }],
  ];
  for (const assets of candidates) {
    const task = {
      key: 'APP-1', title: 'Исправить ошибку', result: 'Ошибка исправлена',
      uzs: { iid: 1, state: 'merged', merge_commit_sha: 'merged' },
      kzsBaseBranch: 'release', kzsBaseBranchConfirmed: true, kzsWithoutDemoConfirmed: true,
      changes: [{ module: 'Main', text: 'Исправлена основная проверка' }],
      keyCodePaths: ['Modules/Main/main.swift'], assets,
    };
    const calls = { repository: 0, upload: 0, worktree: 0 };
    const flow = new Flow({ save() {}, event() {} }, {}, {});
    flow.sync = async () => task;
    flow.validateRepository = async () => { calls.repository++; throw new Error('Была начата сеть'); };
    flow.publishAssets = async () => { calls.upload++; throw new Error('Началась загрузка'); };
    flow.worktree = async () => { calls.worktree++; throw new Error('Создана ветка'); };
    await assert.rejects(flow.kzs(task), /Для таблицы КЗС нужен снимок ключевого кода/);
    assert.deepEqual(calls, { repository: 0, upload: 0, worktree: 0 });
  }
});
