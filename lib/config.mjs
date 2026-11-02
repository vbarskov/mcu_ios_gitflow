import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const defaults = {
  gitlabUrl: 'https://git.hi-tech.org', project: '', repoPath: '', targetBranch: 'release', jiraBaseUrl: 'https://jira.iva.ru',
};
const fields = new Set(Object.keys(defaults));

export function dataDir() {
  return process.env.MCU_IOS_GITFLOW_DATA_DIR || join(homedir(), '.mcu-ios-gitflow');
}

export function validBranch(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 && value !== 'HEAD'
    && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && !value.includes('..') && !value.includes('//')
    && !value.endsWith('/') && !value.endsWith('.')
    && value.split('/').every(part => !part.startsWith('.') && !part.endsWith('.lock'));
}

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Настройки должны быть объектом JSON.');
  return value;
}

function serverUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Укажите корректный адрес HTTPS.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new Error('Нужен адрес HTTPS без логина, пароля, параметров и фрагмента.');
  }
  return url.href.replace(/\/+$/, '');
}

function settings(input, { resolveRepo = false } = {}) {
  object(input);
  for (const key of Object.keys(input)) if (!fields.has(key)) throw new Error(`Неизвестное или секретное поле настроек: ${key}.`);
  const result = { ...defaults, ...input };
  for (const [key, value] of Object.entries(result)) {
    if (typeof value !== 'string' || value.length > 10000 || /[\r\n\0]/.test(value)) throw new Error(`Некорректное поле настроек: ${key}.`);
    result[key] = value.trim();
  }
  result.gitlabUrl = serverUrl(result.gitlabUrl);
  result.jiraBaseUrl = serverUrl(result.jiraBaseUrl);
  if (!validBranch(result.targetBranch)) throw new Error('Укажите корректную ветку назначения.');
  if (result.repoPath) {
    if (!isAbsolute(result.repoPath)) throw new Error('Путь репозитория должен быть абсолютным.');
    if (resolveRepo) {
      try {
        result.repoPath = realpathSync(result.repoPath);
        if (!lstatSync(result.repoPath).isDirectory()) throw new Error();
      } catch { throw new Error('Папка репозитория не существует или недоступна.'); }
    }
  }
  return result;
}

function readObject(path) {
  if (!existsSync(path)) return {};
  if (lstatSync(path).isSymbolicLink()) throw new Error('Файл настроек не должен быть символической ссылкой.');
  chmodSync(path, 0o600);
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('Не удалось прочитать локальные настройки JSON.'); }
  return object(parsed);
}

function writeObject(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export class Config {
  constructor(dir = dataDir()) {
    if (!isAbsolute(dir)) throw new Error('Каталог данных должен быть абсолютным.');
    this.dir = resolve(dir);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (lstatSync(this.dir).isSymbolicLink()) throw new Error('Каталог данных не должен быть символической ссылкой.');
    chmodSync(this.dir, 0o700);
  }

  get() {
    const config = settings(readObject(join(this.dir, 'config.json')));
    const credentials = readObject(join(this.dir, 'credentials.json'));
    const storedGitlab = credentials.gitlabUrl === config.gitlabUrl ? credentials.gitlabToken : '';
    const storedJira = credentials.jiraBaseUrl === config.jiraBaseUrl ? credentials.jiraToken : '';
    return { ...config, token: process.env.GITLAB_TOKEN || storedGitlab || '', jiraToken: process.env.JIRA_TOKEN || storedJira || '' };
  }

  public() {
    const current = this.get();
    return { ...Object.fromEntries([...fields].map(key => [key, current[key]])), hasGitlabToken: Boolean(current.token), hasJiraToken: Boolean(current.jiraToken) };
  }

  save(input) {
    object(input);
    for (const key of Object.keys(input)) if (!fields.has(key)) throw new Error(`Неизвестное или секретное поле настроек: ${key}.`);
    const current = settings(readObject(join(this.dir, 'config.json')));
    const next = settings({ ...current, ...input }, { resolveRepo: true });
    // Каждый сохранённый токен привязан к адресу. Даже прерывание между записями
    // не позволяет использовать старый токен для другого сервера.
    const credentials = readObject(join(this.dir, 'credentials.json'));
    if (next.gitlabUrl !== current.gitlabUrl) delete credentials.gitlabToken;
    if (next.jiraBaseUrl !== current.jiraBaseUrl) delete credentials.jiraToken;
    writeObject(join(this.dir, 'config.json'), next);
    if (existsSync(join(this.dir, 'credentials.json'))) writeObject(join(this.dir, 'credentials.json'), credentials);
    return this.public();
  }

  saveCredentials(input) {
    object(input);
    for (const [key, value] of Object.entries(input)) {
      if (!['gitlabToken', 'jiraToken'].includes(key) || typeof value !== 'string' || value.length > 10000 || /[\r\n\0]/.test(value)) {
        throw new Error('Некорректные поля локальных учётных данных.');
      }
    }
    const config = settings(readObject(join(this.dir, 'config.json'))), previous = readObject(join(this.dir, 'credentials.json'));
    const credentials = {
      gitlabUrl: config.gitlabUrl, jiraBaseUrl: config.jiraBaseUrl,
      gitlabToken: previous.gitlabUrl === config.gitlabUrl ? previous.gitlabToken || '' : '',
      jiraToken: previous.jiraBaseUrl === config.jiraBaseUrl ? previous.jiraToken || '' : '',
    };
    for (const key of ['gitlabToken', 'jiraToken']) if (input[key]?.trim()) credentials[key] = input[key].trim();
    writeObject(join(this.dir, 'credentials.json'), credentials);
    return this.public();
  }
}
