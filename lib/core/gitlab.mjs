import { title } from './description.mjs';
export class GitLab {
  constructor(settings) { this.settings = settings; this.token = process.env.GITLAB_TOKEN || settings.token; }
  async request(path, method = 'GET', body) {
    if (!this.token) throw new Error('Укажите токен GitLab в настройках.');
    if (body?.title && [...body.title].length > 255) throw new Error('Заголовок GitLab длиннее 255 символов. Сократите название или поле «Что сделано».');
    const multipart = body instanceof FormData;
    const response = await fetch(`${this.settings.gitlabUrl}/api/v4${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { 'PRIVATE-TOKEN': this.token, ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? multipart ? body : JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      // Показываем только известные причины, не публикуем произвольное тело ответа.
      const payload = await response.json().catch(() => null);
      const details = JSON.stringify(payload?.message ?? payload?.error ?? '');
      let hint = 'Проверьте параметры запроса и состояние веток в GitLab.';
      if (/title/i.test(details) && /too long|255/.test(details)) hint = 'Заголовок слишком длинный: допустимо не больше 255 символов.';
      else if (/squash/i.test(details)) hint = 'Проект требует squash-коммитов. Повторите слияние с включённым squash.';
      else if (/already exists|already been taken/i.test(details)) hint = 'Такой запрос уже существует. Проверьте открытые запросы для исходной ветки.';
      else if (/source branch.*(not exist|invalid|blank)/i.test(details)) hint = 'Исходная ветка отсутствует или указана неверно.';
      else if (/target branch.*(not exist|invalid|blank)/i.test(details)) hint = 'Целевая ветка отсутствует или указана неверно.';
      else if (response.status === 401 || response.status === 403) hint = 'Проверьте токен GitLab и права на проект.';
      throw new Error(`GitLab: HTTP ${response.status} (${method} ${path.split('?')[0]}). ${hint}`);
    }
    return response.status === 204 ? null : response.json();
  }
  project(t) { return `/projects/${encodeURIComponent(t.project)}`; }
  async squashSetting(t) {
    const project = await this.request(this.project(t));
    if (project?.squash_option === 'always') return true;
    if (project?.squash_option === 'never') return false;
    return undefined;
  }
  mr(t, iid) { return this.request(`${this.project(t)}/merge_requests/${iid}`); }
  discussions(t, iid) { return this.list(t, `/merge_requests/${iid}/discussions`); }
  update(t, iid, body) { return this.request(`${this.project(t)}/merge_requests/${iid}`, 'PUT', body); }
  async list(t, suffix) {
    const all = [];
    for (let page = 1; page <= 100; page++) {
      const rows = await this.request(`${this.project(t)}${suffix}${suffix.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      all.push(...rows);
      if (rows.length < 100) return all;
    }
    throw new Error('Слишком много страниц ответа GitLab.');
  }
  async find(t, branch) {
    const rows = await this.list(t, `/merge_requests?state=all&source_branch=${encodeURIComponent(branch)}`);
    return rows.find(m => m.source_branch === branch && m.target_branch === t.targetBranch);
  }
  async ensureMR(t, branch, previousHeading, description, kind) {
    title(t, kind, { iid: t[kind]?.iid || 1 });
    const squash = await this.squashSetting(t);
    const squashBody = typeof squash === 'boolean' ? { squash } : {};
    let mr = await this.find(t, branch);
    if (mr?.state === 'closed') throw new Error('Запрос слияния закрыт. Откройте его вручную перед продолжением.');
    if (!mr) {
      const initialTitle = title(t, kind, { iid: 0 });
      const user = await this.request('/user');
      mr = await this.request(`${this.project(t)}/merge_requests`, 'POST', {
        source_branch: branch, target_branch: t.targetBranch, title: initialTitle, description,
        assignee_id: user.id, remove_source_branch: true, ...squashBody,
        ...(kind === 'kzs' ? { labels: 'КЗС' } : {}),
      });
    }
    if (mr.state === 'opened') mr = await this.update(t, mr.iid, { title: title(t, kind, { iid: mr.iid }), description, ...squashBody, ...(kind === 'kzs' ? { add_labels: 'КЗС' } : {}) });
    return mr;
  }
  async upload(t, asset, bytes) {
    const data = new FormData();
    data.append('file', new Blob([bytes], { type: asset.mime }), asset.name);
    return this.request(`${this.project(t)}/uploads`, 'POST', data);
  }
}
