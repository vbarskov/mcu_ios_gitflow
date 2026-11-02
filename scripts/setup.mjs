#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { Config } from '../lib/config.mjs';

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write('Настройка MCU iOS GitFlow: node scripts/setup.mjs\nКаталог данных: MCU_IOS_GITFLOW_DATA_DIR (по умолчанию ~/.mcu-ios-gitflow).\nТокены вводятся скрыто в терминале; не передавайте их аргументами.\n');
    return;
  }
  if (process.argv.length > 2) throw new Error('Настройка не принимает аргументы. Каталог данных задаётся через MCU_IOS_GITFLOW_DATA_DIR.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Запустите настройку в интерактивном терминале. Токены нельзя передавать через аргументы или pipe.');
  const config = new Config(), current = config.public();
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const ask = async (label, value) => (await rl.question(`${label}${value ? ` [${value}]` : ''}: `)).trim() || value;
  const secret = async label => {
    process.stdout.write(label + ': '); muted = true;
    try { return await rl.question(''); } finally { muted = false; process.stdout.write('\n'); }
  };
  try {
    process.stdout.write('MCU iOS GitFlow — автономная настройка. Пустой ввод сохраняет прежнее значение.\n');
    const input = {};
    for (const [key, label] of [
      ['repoPath', 'Абсолютный путь к репозиторию'], ['gitlabUrl', 'Адрес GitLab HTTPS'], ['project', 'GitLab project ID или namespace/project'],
      ['targetBranch', 'Ветка назначения'], ['jiraBaseUrl', 'Адрес Jira HTTPS'],
    ]) input[key] = await ask(label, current[key]);
    if (!input.repoPath || !input.project) throw new Error('Укажите папку репозитория и проект GitLab.');
    config.save(input);
    const gitlabToken = await secret('Токен GitLab (ввод скрыт; пусто — сохранить для того же сервера)');
    const jiraToken = await secret('Токен Jira (ввод скрыт; пусто — сохранить для того же сервера)');
    config.saveCredentials({ gitlabToken, jiraToken });
    const saved = config.public();
    process.stdout.write(`Настройки сохранены в ${config.dir}.\nGitLab: ${saved.hasGitlabToken ? 'токен доступен' : 'токен не задан'}; Jira: ${saved.hasJiraToken ? 'токен доступен' : 'токен не задан'}.\nПодключение не проверялось; проверьте его инструментом плагина.\n`);
  } finally { rl.close(); }
}

main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
