import {isSupportingPath} from './report-policy.mjs';
const line = s => String(s || '').replace(/[\r\n]+/g, ' ').trim();
const cell = s => line(s).replaceAll('|', '\\|').replaceAll('<', '&lt;');
const shorten = (s, limit) => [...s].length <= limit ? s : [...s].slice(0, limit - 1).join('').trimEnd() + '…';
export function taskTitle(t) {
  const key = String(t.key || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return line(t.title)
    .replace(new RegExp(`^#?${key}(?=\\s|:|$)\\s*:?\\s*`, 'i'), '')
    .replace(/(?:\s*№2[.:]?\s*)?[.\s]+Контроль\s*$/i, '')
    .trim();
}
export function title(t, kind) {
  return shorten(`#${t.key.split('-').at(-1)} ${kind === 'uzs' ? '💀 ' : '[🐬] '}${shorten(taskTitle(t), 150)} №${kind === 'uzs' ? '1' : '2'}${kind === 'kzs' ? '. Контроль' : ''}`, 240);
}
export function includedUzs(t) {
  return [...new Set([t.uzs?.iid, ...(t.additionalUzs || []).map(mr => mr.iid)].filter(Number.isSafeInteger))];
}
export function updateIncludedUzs(text, t) {
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
  const titleLine = `${t.kzs?.iid ? `!${t.kzs.iid} ` : ''}${title(t, 'kzs')}`;
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
  return `Заголовок\n- ${titleLine}\n\nВключает следующие УЗС:\n${uzsList || '- УЗС ещё не создан'}\n\nИтогом серии УЗС является:\n- ${t.result || 'Итог не указан'}\n\n${changesTable}[Задача](${t.jiraUrl})${demonstration}${extras}\n`;
}
