import { jiraRequirements } from './requirements.mjs';
// Jira Data Center: описание задачи считается данными. Токен не передаётся на адреса из описания.
export function issueKey(link, baseUrl) {
  if (/^[A-Z][A-Z0-9]+-\d+$/.test(link)) return link;
  let url;
  try { url = new URL(link); } catch { throw new Error('Вставьте ссылку на задачу Jira или её номер.'); }
  const base = new URL(baseUrl);
  if (url.origin !== base.origin || url.username || url.password) throw new Error('Ссылка относится к другому серверу Jira. Проверьте настройки.');
  const prefix = base.pathname.replace(/\/$/, '');
  const path = url.pathname.slice(prefix.length);
  if (!url.pathname.startsWith(`${prefix}/`)) throw new Error('Ссылка не относится к настроенному адресу Jira.');
  const key = path.match(/^\/browse\/([A-Z][A-Z0-9]+-\d+)\/?$/)?.[1] || url.searchParams.get('selectedIssue');
  if (!key || !/^[A-Z][A-Z0-9]+-\d+$/.test(key)) throw new Error('Нужна ссылка на одну задачу, например /browse/VCSMOB-15564.');
  return key;
}
export function documentText(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  if (value.type === 'text') return value.text || '';
  if (value.type === 'hardBreak') return '\n';
  const text = (value.content || []).map(documentText).join('');
  return text + (['paragraph','heading','listItem'].includes(value.type) ? '\n' : '');
}
export class Jira {
  constructor(settings) { this.base = settings.jiraBaseUrl; this.token = process.env.JIRA_TOKEN || settings.jiraToken; }
  async request(path,method='GET',body) {
    if (!this.token) throw new Error('Добавьте токен Jira в разделе «Подключения».');
    let response;
    try {
      response = await fetch(`${this.base}/rest/api/2${path}`, {
        method,headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json',...(body?{'Content-Type':'application/json'}:{}) },body:body?JSON.stringify(body):undefined,
        redirect: 'error', signal: AbortSignal.timeout(30000),
      });
    } catch { throw new Error('Не удалось подключиться к Jira. Проверьте адрес сервера и VPN.'); }
    if (!response.ok) {
      const hints = { 401:'Токен недействителен или истёк.', 403:'Недостаточно прав.', 404:'Задача не найдена или недоступна.' };
      throw new Error(`Jira: HTTP ${response.status}. ${hints[response.status] || 'Проверьте доступность сервера.'}`);
    }
    if(response.status===204)return null;
    try { return await response.json(); } catch { throw new Error('Jira вернула не JSON. Проверьте адрес API и авторизацию.'); }
  }
  async me() { const me = await this.request('/myself'); return { name: me.displayName, username: me.name || me.key }; }
  async completionCandidates(key){
    const data=await this.request(`/issue/${encodeURIComponent(key)}/transitions?expand=transitions.fields`);
    const rows=(data.transitions||[]).map(item=>({id:String(item.id),name:item.name,status:item.to?.name||item.name,done:item.to?.statusCategory?.key==='done'||/done|closed|заверш|выполн/i.test(`${item.name||''} ${item.to?.name||''}`)})),done=rows.filter(item=>item.done);
    return (done.length?done:rows).map(({done:_,...item})=>item);
  }
  async completionState(key){
    const [issue,transitions]=await Promise.all([this.request(`/issue/${encodeURIComponent(key)}?fields=status`),this.completionCandidates(key)]),status=issue.fields?.status;
    return {transitions,status:status?.name||'',completed:status?.statusCategory?.key==='done'};
  }
  async addComment(key,text){return this.request(`/issue/${encodeURIComponent(key)}/comment`,'POST',{body:text});}
  async transition(key,id){return this.request(`/issue/${encodeURIComponent(key)}/transitions`,'POST',{transition:{id:String(id)}});}
  async import(link) {
    const key = issueKey(String(link || '').trim(), this.base);
    const data = await this.request(`/issue/${encodeURIComponent(key)}?fields=summary,description,attachment,status,assignee,fixVersions`);
    const fields = data.fields || {};
    if (!data.key || typeof fields.summary !== 'string') throw new Error('В ответе Jira нет номера или названия задачи.');
    const attachments = (fields.attachment || []).flatMap(a => {
      try {
        const url = new URL(a.content);
        if (!['https:','http:'].includes(url.protocol) || url.username || url.password) return [];
        return [{ name: String(a.filename), url: url.href, mime: a.mimeType || '', size: a.size || 0 }];
      } catch { return []; }
    });
    return {
      key: data.key, title: fields.summary, sourceBranch: `feature/${data.key}`,
      jiraUrl: `${this.base}/browse/${encodeURIComponent(data.key)}`,
      issueDescription: documentText(fields.description).trim(),
      requirements:jiraRequirements(documentText(fields.description).trim()),
      beforeUrl: attachments.find(a => /\.(mp4|mov|png|jpe?g)$/i.test(a.name))?.url || '',
      attachments,
      status: fields.status?.name || '', assignee: fields.assignee?.displayName || '',
      fixVersions: (fields.fixVersions || []).map(v => v.name),
    };
  }
}
