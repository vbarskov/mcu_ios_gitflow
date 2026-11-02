import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '../lib/config.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mcu-config-'));
  return { dir, config: new Config(join(dir, 'state')), close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('настройки отделяют секреты от публичных данных и ограничивают права файлов', () => {
  const f = fixture();
  try {
    f.config.save({ repoPath: f.dir, project: 'mobile/ios', gitlabUrl: 'https://git.example.test/', jiraBaseUrl: 'https://jira.example.test/' });
    f.config.saveCredentials({ gitlabToken: 'private-gitlab', jiraToken: 'private-jira' });
    assert.equal(f.config.get().token, 'private-gitlab');
    assert.equal(f.config.get().jiraToken, 'private-jira');
    assert.equal(f.config.public().hasGitlabToken, true);
    assert.equal(f.config.public().hasJiraToken, true);
    assert.doesNotMatch(JSON.stringify(f.config.public()), /private-gitlab|private-jira/);
    assert.doesNotMatch(readFileSync(join(f.config.dir, 'config.json'), 'utf8'), /Token|token|private-/);
    assert.equal(statSync(f.config.dir).mode & 0o777, 0o700);
    for (const name of ['config.json', 'credentials.json']) assert.equal(statSync(join(f.config.dir, name)).mode & 0o777, 0o600);
    assert.equal(new Config(f.config.dir).get().project, 'mobile/ios');
  } finally { f.close(); }
});

test('смена сервера исключает отправку старого сохранённого токена новому серверу', () => {
  const f = fixture();
  try {
    f.config.saveCredentials({ gitlabToken: 'old-gitlab', jiraToken: 'old-jira' });
    f.config.saveCredentials({ gitlabToken: '', jiraToken: '' });
    assert.equal(f.config.get().token, 'old-gitlab');
    f.config.save({ gitlabUrl: 'https://different.example.test' });
    assert.equal(f.config.public().hasGitlabToken, false);
    assert.equal(f.config.get().jiraToken, 'old-jira');
    f.config.save({ jiraBaseUrl: 'https://other-jira.example.test' });
    assert.equal(f.config.public().hasJiraToken, false);
  } finally { f.close(); }
});

test('токены окружения имеют приоритет и не сохраняются на диске', () => {
  const f = fixture(), oldGitlab = process.env.GITLAB_TOKEN, oldJira = process.env.JIRA_TOKEN;
  try {
    f.config.saveCredentials({ gitlabToken: 'stored-gitlab', jiraToken: 'stored-jira' });
    process.env.GITLAB_TOKEN = 'env-gitlab'; process.env.JIRA_TOKEN = 'env-jira';
    assert.equal(f.config.get().token, 'env-gitlab');
    assert.equal(f.config.get().jiraToken, 'env-jira');
    assert.doesNotMatch(readFileSync(join(f.config.dir, 'credentials.json'), 'utf8'), /env-gitlab|env-jira/);
  } finally {
    if (oldGitlab === undefined) delete process.env.GITLAB_TOKEN; else process.env.GITLAB_TOKEN = oldGitlab;
    if (oldJira === undefined) delete process.env.JIRA_TOKEN; else process.env.JIRA_TOKEN = oldJira;
    f.close();
  }
});

test('несовпадение привязки сервера в файлах конфигурации исключает раскрытие токена', () => {
  const f = fixture();
  try {
    f.config.save({ project: '1' });
    f.config.saveCredentials({ gitlabToken: 'old-server-secret' });
    const configPath = join(f.config.dir, 'config.json'), changed = JSON.parse(readFileSync(configPath, 'utf8'));
    changed.gitlabUrl = 'https://new-server.example.test';
    writeFileSync(configPath, JSON.stringify(changed));
    assert.equal(f.config.get().token, '');
    assert.equal(f.config.public().hasGitlabToken, false);
  } finally { f.close(); }
});

test('настройки отклоняют секреты, неизвестные поля и небезопасные адреса', () => {
  const f = fixture();
  try {
    assert.throws(() => f.config.save({ token: 'secret' }), /поле|секрет/i);
    assert.throws(() => f.config.save({ unexpected: true }), /поле/i);
    for (const url of ['http://remote.example.test', 'https://user:secret@git.example.test', 'https://git.example.test?token=x', 'file:///tmp/project']) {
      assert.throws(() => f.config.save({ gitlabUrl: url }), /HTTPS|адрес/i);
    }
    assert.throws(() => f.config.save({ repoPath: './relative' }), /абсолют/i);
    assert.throws(() => f.config.save({ targetBranch: '--bad' }), /ветк/i);
    assert.equal(f.config.save({ gitlabUrl: 'http://127.0.0.1:12345' }).gitlabUrl, 'http://127.0.0.1:12345');
  } finally { f.close(); }
});
