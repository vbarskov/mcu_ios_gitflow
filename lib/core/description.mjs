import {isSupportingPath} from './report-policy.mjs';
const line = s => String(s || '').replace(/[\r\n]+/g, ' ').trim();
const cell = s => line(s).replaceAll('|', '\\|').replaceAll('<', '&lt;');
const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function russianLine(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Заполните ${label}.`);
  if (/[\r\n\0]/.test(value)) throw new Error(`${label}: нужна одна строка без переносов.`);
  if (!/[А-Яа-яЁё]/u.test(value)) throw new Error(`${label}: используйте русский язык; технические обозначения допустимы.`);
}
export function validateTitleFields(t) {
  russianLine(t.title, 'название задачи');
  russianLine(t.done, 'краткий итог «Что сделано»');
}
export function taskTitle(t) {
  const fullKey = String(t.key || '');
  const number = fullKey.split('-').at(-1);
  let name = line(t.title);
  let decorated = false;
  const strip = pattern => {
    const next = name.replace(pattern, '');
    if (next !== name) decorated = true;
    name = next;
  };
  strip(/^!\d+\s+/u);
  if (fullKey) strip(new RegExp(`^#?(?:${escapeRegex(fullKey)}|${escapeRegex(number)})(?=\\s|:|$)\\s*:?\\s*`, 'u'));
  strip(/^(?:(?:\[(?:💀|🐬)\]|💀|🐬|🐥[^\s\]]+)\s+)+/u);
  if (decorated && t.featureName && name.startsWith(line(t.featureName) + ' ')) name = name.slice(line(t.featureName).length + 1);
  name = name.replace(/(?:\s+№\d+)?\.\s*Контроль\s*$/u, '');
  if (decorated) name = name.replace(/\s+№\d+(?:\.\s*.*)?$/u, '').replace(/\s+reopened$/u, '');
  return name.trim();
}
function partNumber(value, fallback) {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Укажите положительный целый номер части серии.');
  return number;
}
export function title(t, kind, { iid = t[kind]?.iid, preview = false } = {}) {
  if (!['uzs', 'kzs'].includes(kind)) throw new Error('Неизвестный тип запроса для заголовка.');
  russianLine(t.title, 'название задачи');
  if (kind === 'uzs') validateTitleFields(t);
  const name = taskTitle(t);
  russianLine(name, 'название задачи');
  const jira = String(t.key || '').match(/(?:^|-)(\d+)$/)?.[1];
  if (!jira) throw new Error('Укажите номер задачи Jira для заголовка.');
  const uzsPart = partNumber(t.uzsPartNumber, 1);
  const part = kind === 'uzs' ? uzsPart : partNumber(t.kzsPartNumber, uzsPart + 1);
  const target = kind === 'kzs' ? t.kzsBaseBranch || t.targetBranch : t.targetBranch;
  const minor = String(target || '').match(/^minor\/(.+)$/)?.[1];
  if (t.featureName !== undefined && (typeof t.featureName !== 'string' || /[\r\n\0]/.test(t.featureName))) throw new Error('Имя feature должно быть одной строкой.');
  const dolphin = kind === 'kzs' && t.kzsTargetIsGzs === true && !/^(?:release(?:\/|$)|minor\/)/.test(String(target || ''));
  const reopened = t.reopened === true || Boolean(t.reopenedAt && !t.reopenClosedAt);
  const suffix = kind === 'uzs' ? t.done.trim() : 'Контроль';
  const fields = [`#${jira}`, minor && `🐥${minor}`, kind === 'uzs' ? '💀' : dolphin && '🐬', line(t.featureName), name, reopened && 'reopened', `№${part}. ${suffix}`];
  const base = fields.filter(Boolean).join(' ');
  const realIid = Number.isSafeInteger(iid) && iid > 0;
  const prefix = realIid ? `!${iid} ` : preview ? '!<номер> ' : '';
  if ([...base].length + (realIid ? [...prefix].length : 18) > 255) throw new Error('Заголовок GitLab длиннее 255 символов с номером запроса. Сократите название, feature или краткий итог; важные поля не обрезаются автоматически.');
  return prefix + base;
}
export function includedUzs(t) {
  return [...new Set([t.uzs?.iid, ...(t.additionalUzs || []).map(mr => mr.iid)].filter(Number.isSafeInteger))];
}
export function updateIncludedUzs(text, t) {
  text = text.replace(/^Заголовок\r?\n- (?:(?:!\d+|!<номер>) )?#\d+[^\r\n]*\r?\n\r?\n/u, '');
  const block = `Включает следующие УЗС:\n${includedUzs(t).map((iid, index) => `${index + 1}. !${iid}`).join('\n')}`;
  if (/^Включает следующие УЗС:\n(?:\d+\. !\d+\n?)+/m.test(text)) return text.replace(/^Включает следующие УЗС:\n(?:\d+\. !\d+\n?)+/m, `${block}\n`);
  if (/^Включает УЗС:.*$/m.test(text)) return text.replace(/^Включает УЗС:.*$/m, block);
  return `${block}\n\n${text}`;
}
export function description(t, kind, preview = false) {
  const assetLink = a => a.remote?.url || (preview ? a.previewUrl || `attachment:${a.id}` : '');
  const image = (a, width) => `![${a.kind === 'after' ? 'Стало' : a.kind === 'before' ? 'Было' : 'Код'}](${assetLink(a)}){width=${width}}`;
  const mediaLink = (label, url) => url ? `![${label}](${url.replaceAll(')', '%29')}){width=250}` : '';
  const task = `[${t.key}](${t.jiraUrl})`;
  if (kind === 'uzs') return `Было сделано:\n${t.done || ''}\n\n${t.changes.map(c => `- ${c.module}: ${c.text}`).join('\n')}\n${t.afterUrl ? `\nДемонстрация: ${mediaLink('Стало', t.afterUrl)}\n` : ''}`;
  const important=t.changes.filter(c=>!isSupportingPath(c.module));
  const reportShots = t.assets.filter(a => a.kind === 'code' && !isSupportingPath(a.codePath) && (!Array.isArray(t.keyCodePaths)||t.keyCodePaths.includes(a.codePath)) && assetLink(a));
  const modules = [...new Set(reportShots.map(a => a.module))].filter(module => important.some(c => c.module === module));
  const rows = modules.map(module => {
    const changes = important.filter(c => c.module === module).map(c => c.text).join(' ');
    const shots = reportShots.filter(a => a.module === module);
    return `| ${cell(module)} | ${cell(changes)} | ${shots.map(a => image(a, 550)).join('<br>')} |`;
  });
  if (!preview && !rows.length) throw new Error('Для таблицы КЗС нужен снимок ключевого кода из включённого УЗС.');
  const before = [...t.assets.filter(a => a.kind === 'before').map(a => image(a, 250)), mediaLink('Было', t.beforeUrl)].filter(Boolean).join('<br>');
  const after = [...t.assets.filter(a => a.kind === 'after').map(a => image(a, 250)), mediaLink('Стало', t.afterUrl)].filter(Boolean).join('<br>');
  const bullets = value => String(value || '').split(/\r?\n/).map(item => item.trim().replace(/^[-*]\s*/, '')).filter(Boolean).map(item => `- ${item}`).join('\n');
  const section = (heading, value) => { const content = bullets(value); return content ? `\n\n## ${heading}\n\n${content}` : ''; };
  const notes = bullets(t.notes) ? `\n\n## Примечания\n\nВажно учитывать следующие особенности:\n${bullets(t.notes)}` : '';
  const related = bullets(t.relatedZs);
  const uzsList = includedUzs(t).map((iid, index) => `${index + 1}. !${iid}`).join('\n');
  const changesTable = rows.length ? `## Изменения\n\n| Модуль | Изменения | Код |\n|---|---|---|\n${rows.join('\n')}\n\n` : '';
  const demonstration = !after ? '' : before
    ? `\n\n## Демонстрация\n\n| Было | Стало |\n|---|---|\n| ${before} | ${after} |${t.demo ? `\n\n${t.demo}` : ''}`
    : `\n\n## Демонстрация\n\n${after}${t.demo ? `\n\n${t.demo}` : ''}`;
  const gost = String(t.gostCode || '').trim();
  const extras = notes
    + section('Преимущества', t.advantages)
    + section('Недостатки', t.disadvantages)
    + (related ? `\n\nСвязанные ЗС из других проектов:\n${related}` : '')
    + (gost ? `\n\nКод по ГОСТу:\n\n\`${gost.replaceAll('`', '\\`')}\`` : '');
  return `Включает следующие УЗС:\n${uzsList || '- УЗС ещё не создан'}\n\nИтогом серии УЗС является:\n- ${t.result || 'Итог не указан'}\n\n${changesTable}[Задача](${t.jiraUrl})${demonstration}${extras}\n`;
}
