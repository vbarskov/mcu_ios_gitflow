import { cleanupMergedAssets } from './asset-cleanup.mjs';
import {isSupportingPath} from './report-policy.mjs';
import { execFile } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { prepareCodeImages, loadCodeDiffs } from './code-images.mjs';
import { GitLab } from './gitlab.mjs';
import { title, description, updateIncludedUzs } from './description.mjs';
const exec = promisify(execFile);
const gitPermissions = new AsyncLocalStorage();
export function withGitPermissions({ allowSsh = false } = {}, operation) {
  if (typeof operation !== 'function') throw new Error('Укажите операцию Git для разового разрешения.');
  return gitPermissions.run({ allowSsh: allowSsh === true }, operation);
}
function gitEnvironment() {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: gitPermissions.getStore()?.allowSsh ? 'https:http:file:ssh' : 'https:http:file' };
}
async function additionalUnavailable() {
  throw new Error('Автоматическая подготовка дополнительных УЗС недоступна. Подготовьте отдельную карточку по готовой ветке.');
}
async function ensureAdditionalPadding(settings, input, dir) {
  const repo = settings.repoPath;
  const source = `refs/heads/${input.sourceBranch}`;
  const base = `refs/remotes/origin/${input.targetBranch}`;
  if (Number(await git(repo, 'rev-list', '--count', `${base}..${source}`)) !== 1) return;
  if (!(await git(repo, 'diff', '--no-ext-diff', '--no-textconv', `${base}...${source}`)).trim()) return;
  const tree = await git(repo, 'rev-parse', `${source}^{tree}`);
  const previous = await git(repo, 'rev-parse', source);
  const padded = await git(repo, 'commit-tree', tree, '-p', previous, '-m', 'Отступ');
  if (await git(repo, 'branch', '--show-current') === input.sourceBranch && await git(repo, 'status', '--porcelain')) throw new Error('Перед добавлением «Отступ» сохраните изменения.');
  await git(repo, 'update-ref', source, padded, previous);
}

export async function git(repo, ...args) {
  try {
    const { stdout } = await exec('git', ['-C', repo, ...args], { timeout: 120000, maxBuffer: 8 * 1024 * 1024, env: gitEnvironment() });
    return stdout.trim();
  } catch (e) {
    const message = String(e.stderr || e.message).replace(/https?:\/\/[^\s@]+@/g, 'https://***@');
    throw new Error(`Git: ${message.slice(0, 1600)}`);
  }
}
export function remoteProject(remote) {
  const scp = remote.match(/^(?:[^@]+@)?([^/:]+):([^/].*)$/);
  if (scp && !remote.includes('://')) return { host: scp[1], path: scp[2].replace(/\.git$/, '') };
  const u = new URL(remote);
  return { host: u.hostname, path: u.pathname.replace(/^\//, '').replace(/\.git$/, '') };
}
export function uzsSizeWarning(added) {
  return added > 500
    ? `УЗС содержит ${added} добавленных строк. Для удобства ревью при возможности разделите изменения. Создание УЗС не блокируется.`
    : '';
}
export function validateKzsEvidence(t) {
  const hasDemo=Boolean(t.afterUrl)||(t.assets||[]).some(a=>a.kind==='after');
  if(!String(t.result||'').trim())throw new Error('Заполните поле «Итог задачи».');
  if(hasDemo&&!String(t.demo||'').trim())throw new Error('Заполните поле «Что происходит на демонстрации».');
  if(!hasDemo&&t.kzsWithoutDemoConfirmed!==true)throw new Error('Демонстрация не загружена. Подтвердите создание КЗС без демонстрации.');
  return {hasDemo};
}
export function reviewDiscussions(mr, discussions) {
  return discussions.map(discussion => {
    const notes = (discussion.notes || []).filter(note => !note.system).map(note => ({
      id: note.id,
      author: { name: note.author?.name || note.author?.username || 'Пользователь', username: note.author?.username || '' },
      body: String(note.body || '').slice(0, 20000),
      createdAt: note.created_at,
      resolvable: Boolean(note.resolvable),
      resolved: Boolean(note.resolved),
      path: note.position?.new_path || note.position?.old_path || '',
      line: note.position?.new_line || note.position?.old_line || null,
      url: mr.web_url ? `${mr.web_url}#note_${note.id}` : '',
    }));
    return {
      id: discussion.id,
      notes,
      resolvable: notes.some(note => note.resolvable),
      resolved: notes.some(note => note.resolvable) && notes.filter(note => note.resolvable).every(note => note.resolved),
    };
  }).filter(discussion => discussion.notes.length);
}
export class Flow {
  constructor(store, settings, client = new GitLab(settings), options = {}) { this.store = store; this.settings = settings; this.api = client; this.analyzeAdditional = options.analyzeAdditional || additionalUnavailable; this.workingAdditional = options.workingAdditional || additionalUnavailable; this.commitAdditional = options.commitAdditional || additionalUnavailable; this.padMerge = options.padMerge || this.ensureMergePadding.bind(this); }
  async ensureMergePadding(t, mr, label) {
    if (mr.source_project_id && mr.target_project_id && mr.source_project_id !== mr.target_project_id) throw new Error('Автоматический «Отступ» поддерживается только для ветки в том же проекте GitLab.');
    const repo = t.executionRepoPath || t.repoPath;
    await git(repo, 'check-ref-format', '--branch', mr.source_branch);
    await this.validateRepository(t, mr.target_branch);
    const sourceRef = `refs/heads/${mr.source_branch}`;
    const fetchedRef = `refs/iva-flow/merge-padding/${t.id}/${mr.iid}`;
    await git(repo, 'fetch', '--no-tags', 'origin', `+${sourceRef}:${fetchedRef}`);
    try {
      const head = await git(repo, 'rev-parse', fetchedRef);
      if (head !== mr.sha) throw new Error(`Исходная ветка ${label} !${mr.iid} изменилась. Обновите статус и повторите слияние.`);
      const subject = await git(repo, 'log', '-1', '--format=%s', head);
      const parent = await git(repo, 'rev-parse', `${head}^`);
      if (subject === 'Отступ' && await git(repo, 'rev-parse', `${head}^{tree}`) === await git(repo, 'rev-parse', `${parent}^{tree}`)) throw new Error(`«Отступ» уже есть в ${label} !${mr.iid}. Дождитесь обновления списка коммитов GitLab и повторите слияние.`);
      const tree = await git(repo, 'rev-parse', `${head}^{tree}`);
      const padded = await git(repo, 'commit-tree', tree, '-p', head, '-m', 'Отступ');
      await git(repo, 'push', 'origin', `${padded}:${sourceRef}`);
      this.store.event(t, `Добавлен пустой коммит «Отступ» в ${label} !${mr.iid} и отправлен в GitLab.`);
      const updated = await this.api.mr(t, mr.iid);
      if (updated.sha !== padded) throw new Error(`«Отступ» отправлен в ${label} !${mr.iid}, но GitLab ещё не обновил запрос. Повторите слияние после обновления статуса.`);
      const commits = await this.api.list(t, `/merge_requests/${mr.iid}/commits`);
      if (commits.length < 2) throw new Error(`«Отступ» отправлен в ${label} !${mr.iid}, но GitLab пока показывает ${commits.length} коммитов. Повторите слияние после обновления статуса.`);
      return updated;
    } finally {
      await git(repo, 'update-ref', '-d', fetchedRef).catch(() => {});
    }
  }
  async syncComments(t, { maxAge = 0 } = {}) {
    t.reviewComments ||= {};
    const now = Date.now();
    for (const [kind, mr] of [['uzs', t.uzs], ['kzs', t.kzs], ...(t.additionalUzs || []).map(extra => [`uzs-${extra.iid}`, extra])]) {
      if (!mr) { delete t.reviewComments[kind]; continue; }
      const cached = t.reviewComments[kind];
      if (maxAge && cached?.iid === mr.iid && now - Date.parse(cached.updatedAt) < maxAge) continue;
      try {
        const rows = this.api.discussions ? await this.api.discussions(t, mr.iid) : [];
        t.reviewComments[kind] = { iid: mr.iid, updatedAt: new Date().toISOString(), discussions: reviewDiscussions(mr, rows) };
      } catch (error) {
        t.reviewComments[kind] = { iid: mr.iid, updatedAt: new Date().toISOString(), discussions: cached?.discussions || [], error: error.message };
      }
      this.store.save(t);
    }
    return t;
  }
  async validateRepository(t, targetBranch = t.targetBranch) {
    const root = await git((t.executionRepoPath || t.repoPath), 'rev-parse', '--show-toplevel');
    if (await realpath(root) !== await realpath((t.executionRepoPath || t.repoPath))) throw new Error('Укажите корень Git-репозитория.');
    const remote = remoteProject(await git((t.executionRepoPath || t.repoPath), 'config', '--get', 'remote.origin.url'));
    const project = await this.api.request(this.api.project(t));
    if (remote.host !== new URL(this.settings.gitlabUrl).hostname || remote.path !== project.path_with_namespace) throw new Error('origin репозитория не совпадает с проектом GitLab.');
    const pushUrls = await git((t.executionRepoPath || t.repoPath), 'config', '--get-regexp', '^remote\\.origin\\.(url|pushurl)$');
    for (const row of pushUrls.split('\n')) {
      const candidate = remoteProject(row.slice(row.indexOf(' ') + 1));
      if (candidate.host !== remote.host || candidate.path !== remote.path) throw new Error('Адрес отправки origin отличается от проекта GitLab.');
    }
    await git((t.executionRepoPath || t.repoPath), 'fetch', 'origin', `+refs/heads/${targetBranch}:refs/remotes/origin/${targetBranch}`);
    return `refs/remotes/origin/${targetBranch}`;
  }
  async worktree(t, kind, base) {
    const branchKey = `${kind}Branch`;
    t[branchKey] ||= `feature/${t.key}-${kind}-${t.id.slice(0, 8)}`;
    this.store.save(t);
    const path = join(this.store.dir, 'worktrees', t.id, kind);
    if (!existsSync(path)) {
      await mkdir(join(this.store.dir, 'worktrees', t.id), { recursive: true });
      const refs = await git((t.executionRepoPath || t.repoPath), 'for-each-ref', '--format=%(refname)', `refs/heads/${t[branchKey]}`);
      if (refs) await git((t.executionRepoPath || t.repoPath), 'worktree', 'add', path, t[branchKey]);
      else await git((t.executionRepoPath || t.repoPath), 'worktree', 'add', '-b', t[branchKey], path, base);
    }
    if ((await git(path, 'branch', '--show-current')) !== t[branchKey]) throw new Error('В рабочей копии выбрана другая ветка.');
    if (await git(path, 'status', '--porcelain')) throw new Error(`Рабочая копия содержит незавершённые изменения: ${path}`);
    return path;
  }
  async sync(t) {
    if (t.uzs) t.uzs = await this.api.mr(t, t.uzs.iid);
    if (t.kzs) t.kzs = await this.api.mr(t, t.kzs.iid);
    if (t.additionalUzs?.length) t.additionalUzs = await Promise.all(t.additionalUzs.map(async mr => await this.api.mr(t, mr.iid)));
    await this.syncComments(t);
    t.stage = t.kzs ? (t.kzs.state === 'merged' ? 'complete' : 'kzs') : t.uzs ? (t.uzs.state === 'merged' ? 'uzs_merged' : 'uzs') : 'draft';
    if (t.reopenedAt && !t.reopenClosedAt) t.stage = 'reopened';
    if(t.stage==='complete')t.completedAt ||= t.kzs.merged_at||new Date().toISOString();
    this.store.save(t);
    await cleanupMergedAssets(this.store, t);
    return t;
  }
  async reopen(t) {
    await this.sync(t);
    if (!t.kzs || t.kzs.state !== 'merged') throw new Error('Переоткрыть можно задачу со слитым КЗС.');
    if (t.reopenedAt && !t.reopenClosedAt) return t;
    t.reopenedAt = new Date().toISOString();
    t.reopenClosedAt = null;
    t.reopenBaseCount = (t.additionalUzs || []).length;
    delete t.additionalUzsDraft;delete t.additionalUzsPendingCommit;t.additionalUzsProgress=[];
    t.stage = 'reopened';
    this.store.event(t, 'Задача переоткрыта после возврата тестировщиками.');
    return t;
  }
  async prepareAdditionalUzs(t, { sourceBranch, targetBranch }) {
    if (!t.reopenedAt || t.reopenClosedAt) throw new Error('Сначала переоткройте задачу.');
    for (const branch of [sourceBranch, targetBranch]) if (typeof branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..') || branch.endsWith('.lock')) throw new Error('Укажите корректные ветки УЗС.');
    await this.sync(t);
    if (t.additionalUzs?.some(mr => mr.source_branch === sourceBranch && mr.target_branch === targetBranch)) throw new Error('УЗС из этой ветки уже добавлен в задачу.');
    const context = { ...t, targetBranch };
    const existing = await this.api.find(context, sourceBranch);
    if (existing?.state === 'closed') throw new Error('УЗС из выбранной ветки закрыт без слияния.');
    if (existing && (existing.source_project_id && existing.target_project_id && existing.source_project_id !== existing.target_project_id)) throw new Error('УЗС относится к другому проекту.');
    if (existing && !new RegExp(`(^|\\s)#${t.key.split('-').at(-1)}(?=\\s|$)`).test(existing.title || '')) throw new Error('УЗС из выбранной ветки относится к другой задаче.');
    if (!existing) {
      const pending=await this.workingAdditional({...this.settings,repoPath:t.executionRepoPath||t.repoPath},sourceBranch,targetBranch);
      if(pending.dirty){
        delete t.additionalUzsDraft;t.additionalUzsProgress=[];
        t.additionalUzsPendingCommit={sourceBranch,targetBranch,files:pending.files,fingerprint:pending.fingerprint};
        this.store.event(t,`В ветке ${sourceBranch} есть незакоммиченные изменения. Проверьте файлы и подтвердите коммит.`);
        return t;
      }
    }
    delete t.additionalUzsPendingCommit;
    delete t.additionalUzsDraft;t.additionalUzsProgress=[];this.store.save(t);
    const onEvent=event=>{if(!event?.message)return;t.additionalUzsProgress.push({at:new Date().toISOString(),message:String(event.message).slice(0,500)});t.additionalUzsProgress=t.additionalUzsProgress.slice(-20);this.store.save(t);};
    const analysis = existing ? {done:existing.title,description:existing.description,existingIid:existing.iid} : await this.analyzeAdditional(this.settings,t,sourceBranch,targetBranch,join(this.store.dir,'additional-uzs',t.id),onEvent);
    const number=(t.kzsPartNumber??((t.uzsPartNumber??1)+1))+1+(t.additionalUzs||[]).length;
    const heading=existing?.title||title({...t,targetBranch,done:analysis.done,uzsPartNumber:number},'uzs',{iid:0});
    const draft={sourceBranch,targetBranch,...analysis,uzsPartNumber:number,title:heading,description:existing?String(existing.description||''): `Было сделано:\n${analysis.done}\n\n${analysis.changes.map(c=>`- ${c.module}: ${c.text}`).join('\n')}\n\nВключается в КЗС: !${t.kzs.iid}.`};
    t.additionalUzsDraft=draft;
    this.store.event(t,`Подготовлен дополнительный УЗС из diff ${sourceBranch} → ${targetBranch}.`);
    return t;
  }
  async commitAdditionalUzs(t, fingerprint) {
    if(!t.reopenedAt||t.reopenClosedAt)throw new Error('Сначала переоткройте задачу.');
    const pending=t.additionalUzsPendingCommit;
    if(!pending||typeof fingerprint!=='string'||fingerprint!==pending.fingerprint)throw new Error('Подтверждение коммита устарело. Повторите подготовку УЗС.');
    await this.commitAdditional({...this.settings,repoPath:t.executionRepoPath||t.repoPath},{key:t.key,sourceBranch:pending.sourceBranch,targetBranch:pending.targetBranch},fingerprint);
    delete t.additionalUzsPendingCommit;
    this.store.event(t,`Изменения ветки ${pending.sourceBranch} закоммичены после подтверждения.`);
    return this.prepareAdditionalUzs(t,{sourceBranch:pending.sourceBranch,targetBranch:pending.targetBranch});
  }
  async addAdditionalUzs(t) {
    if (!t.reopenedAt || t.reopenClosedAt) throw new Error('Сначала переоткройте задачу.');
    const draft=t.additionalUzsDraft;
    if (!draft) throw new Error('Сначала подготовьте и проверьте описание дополнительного УЗС.');
    const {sourceBranch,targetBranch}=draft;
    const context={...t,targetBranch,done:draft.done,uzsPartNumber:draft.uzsPartNumber};
    if(!draft.existingIid)title(context,'uzs',{iid:0});
    await this.sync(t);
    if (t.additionalUzs?.some(mr => mr.source_branch === sourceBranch && mr.target_branch === targetBranch)) { await this.updateKzsUzsList(t);delete t.additionalUzsDraft;this.store.save(t);return t; }
    const existing=await this.api.find(context,sourceBranch);
    if(draft.existingIid && existing?.iid!==draft.existingIid)throw new Error('Существующий УЗС изменился. Подготовьте описание заново.');
    if(!draft.existingIid && existing && draft.createdIid!==existing.iid)throw new Error('Для ветки уже появился УЗС. Подготовьте описание заново.');
    if (draft.sourceCommit) {
      const repo=t.executionRepoPath||t.repoPath;
      const local=await git(repo,'rev-parse','--verify',`refs/heads/${sourceBranch}^{commit}`).catch(()=>null);
      const remote=String(await git(repo,'ls-remote','origin',`refs/heads/${sourceBranch}`)).split('\t')[0];
      const current=local||remote;
      if(current!==draft.sourceCommit)throw new Error('Ветка изменилась после анализа. Подготовьте дополнительный УЗС заново.');
      if(local&&!draft.existingIid){
        await this.validateRepository(t,targetBranch);
        await ensureAdditionalPadding({...this.settings,repoPath:repo},{sourceBranch,targetBranch},join(this.store.dir,'additional-uzs',t.id));
        const padded=await git(repo,'rev-parse',`refs/heads/${sourceBranch}`);
        if(padded!==draft.sourceCommit){draft.sourceCommit=padded;this.store.save(t);}
        if(remote!==padded){
          await git(repo,'push','origin',`refs/heads/${sourceBranch}:refs/heads/${sourceBranch}`);
          this.store.event(t,`Ветка ${sourceBranch} отправлена в origin с ${Number(await git(repo,'rev-list','--count',`refs/remotes/origin/${targetBranch}..refs/heads/${sourceBranch}`))} коммитами.`);
        }
      }
    }
    let mr = existing;
    if (!mr) {
      const sourcePath = `${this.api.project(t)}/repository/branches/${encodeURIComponent(sourceBranch)}`;
      try { await this.api.request(sourcePath); }
      catch (error) {
        if (!/GitLab: HTTP 404\b/.test(error.message)) throw error;
        const repo = t.executionRepoPath || t.repoPath;
        const local = await git(repo, 'show-ref', '--verify', `refs/heads/${sourceBranch}`).catch(() => '');
        if (!local) throw new Error('Выбранная ветка отсутствует и в GitLab, и в локальном проекте.');
        await this.validateRepository(t, targetBranch);
        await git(repo, 'push', 'origin', `refs/heads/${sourceBranch}:refs/heads/${sourceBranch}`);
        this.store.event(t, `Локальная ветка ${sourceBranch} отправлена в origin для дополнительного УЗС.`);
      }
      await this.api.request(`${this.api.project(t)}/repository/branches/${encodeURIComponent(targetBranch)}`);
      const user = await this.api.request('/user');
      mr = await this.api.request(`${this.api.project(t)}/merge_requests`, 'POST', {
        source_branch: sourceBranch, target_branch: targetBranch,
        title: title(context,'uzs',{iid:0}),
        description: draft.description,
        assignee_id: user.id, remove_source_branch: true,
      });
      draft.createdIid=mr.iid;this.store.save(t);
    }
    if(draft.createdIid===mr.iid)mr=await this.api.update(context,mr.iid,{title:title(context,'uzs',{iid:mr.iid})});
    t.additionalUzs ||= [];
    t.additionalUzs.push(mr);
    this.store.event(t, `Добавлен УЗС !${mr.iid} из ветки ${sourceBranch} → ${targetBranch}.`);
    await this.updateKzsUzsList(t);
    delete t.additionalUzsDraft;this.store.save(t);
    return t;
  }
  async updateKzsUzsList(t) {
    if (!t.kzs) return t;
    const current = await this.api.mr(t, t.kzs.iid);
    const next = updateIncludedUzs(current.description || '', t);
    if (next !== current.description) t.kzs = await this.api.update(t, current.iid, { description: next });
    else t.kzs = current;
    this.store.save(t);
    return t;
  }
  async finalizeKzsDescription(t) {
    if (!t.kzs?.iid) return t;
    const next = description({ ...t, kzs: t.kzs }, 'kzs');
    if (next !== t.kzs.description) t.kzs = await this.api.update(t, t.kzs.iid, { description: next });
    this.store.save(t);
    return t;
  }
  async finishReopen(t) {
    await this.sync(t);
    if (!t.reopenedAt || t.reopenClosedAt) throw new Error('Задача не переоткрыта.');
    const added = (t.additionalUzs || []).slice(t.reopenBaseCount || 0);
    if (!added.length) throw new Error('Добавьте хотя бы один УЗС с исправлением.');
    if (added.some(mr => mr.state !== 'merged')) throw new Error('Сначала слейте все добавленные УЗС.');
    await this.updateKzsUzsList(t);
    t.reopenClosedAt = new Date().toISOString();
    t.stage = 'complete';
    this.store.event(t, 'Повторный цикл задачи завершён; список УЗС в КЗС обновлён.');
    return t;
  }
  async mergeAdditionalUzs(t, iid, confirmation) {
    if (!Number.isSafeInteger(iid)) throw new Error('Укажите номер дополнительного УЗС.');
    await this.sync(t);
    let mr = (t.additionalUzs || []).find(item => item.iid === iid);
    if (!mr) throw new Error('Дополнительный УЗС не привязан к этой задаче.');
    if (mr.state === 'merged') return t;
    if (mr.state !== 'opened') throw new Error('УЗС закрыт без слияния.');
    const review = t.reviewComments?.[`uzs-${iid}`];
    if (review?.error) throw new Error('Не удалось проверить комментарии УЗС. Обновите статус и повторите.');
    const unresolved = (review?.discussions || []).filter(d => d.resolvable && !d.resolved);
    if (unresolved.length) throw new Error(`Сначала устраните открытые замечания в УЗС: ${unresolved.length}.`);
    if (confirmation !== `Слить !${iid}`) throw new Error(`Для слияния введите: Слить !${iid}`);
    const user = await this.api.request('/user');
    if (user.id !== mr.author?.id) throw new Error('Слить запрос может только его автор.');
    const commits = await this.api.list(t, `/merge_requests/${iid}/commits`);
    if (commits.length === 1) mr = await this.padMerge(t, mr, 'УЗС');
    else if (commits.length < 2) throw new Error(`В УЗС !${iid} нет коммитов с исправлением. Проверьте исходную ветку.`);
    const squash = typeof this.api.squashSetting === 'function' ? await this.api.squashSetting(t) : undefined;
    await this.api.request(`${this.api.project(t)}/merge_requests/${iid}/merge`, 'PUT', { sha: mr.sha, should_remove_source_branch: true, ...(typeof squash === 'boolean' ? { squash } : {}) });
    this.store.event(t, `Запрошено слияние дополнительного УЗС !${iid}.`);
    return this.sync(t);
  }
  async uzs(t) {
    if(t.targetBranchConfirmed===false)throw new Error('Сначала выберите ветку назначения для УЗС.');
    if (t.uzs) return this.sync(t);
    title(t,'uzs',{iid:0});
    const base = await this.validateRepository(t);
    const recovered = t.uzsBranch && await this.api.find(t, t.uzsBranch);
    if (recovered) {
      t.uzs = await this.api.ensureMR(t, t.uzsBranch, title(t, 'uzs'), description(t, 'uzs'), 'uzs');
      return this.sync(t);
    }
    await git((t.executionRepoPath || t.repoPath), 'check-ref-format', '--branch', t.sourceBranch);
    const source = await git((t.executionRepoPath || t.repoPath), 'rev-parse', '--verify', `refs/heads/${t.sourceBranch}^{commit}`);
    if(t.analyzedCommit&&t.analyzedCommit!==source)throw new Error('Исходная ветка изменилась после анализа diff. Подготовьте описание заново.');
    const path = await this.worktree(t, 'uzs', source);
    try { await git(path, 'merge', '--no-edit', base); }
    catch (e) { try { await git(path, 'merge', '--abort'); } catch {} throw e; }
    const stats = await git(path, 'diff', '--numstat', `${base}...HEAD`);
    if (!stats) throw new Error('УЗС не содержит изменений относительно целевой ветки.');
    const added = stats.split('\n').reduce((n, s) => n + (Number(s.split('\t')[0]) || 0), 0);
    const previousWarning = t.uzsWarning;
    t.uzsAddedLines = added;
    t.uzsWarning = uzsSizeWarning(added);
    if (t.uzsWarning && t.uzsWarning !== previousWarning) this.store.event(t, `Предупреждение: ${t.uzsWarning}`);
    else this.store.save(t);
    for (let count = Number(await git(path, 'rev-list', '--count', `${base}..HEAD`)); count < 2; count++) await git(path, 'commit', '--allow-empty', '-m', 'Отступ');
    await git(path, 'push', '-u', 'origin', t.uzsBranch);
    t.uzs = await this.api.ensureMR(t, t.uzsBranch, title(t, 'uzs'), description(t, 'uzs'), 'uzs');
    this.store.event(t, `Создан УЗС !${t.uzs.iid}`);
    return this.sync(t);
  }
  async attach(t, iid) {
    if (t.uzs || t.kzs || t.uzsBranch) throw new Error('У задачи уже есть УЗС или подготовленная ветка.');
    const mr = await this.api.mr(t, iid);
    if (mr.target_branch !== t.targetBranch || mr.source_project_id !== mr.target_project_id) throw new Error('УЗС должен относиться к этому проекту и целевой ветке.');
    if (!new RegExp(`(^|\\s)#${t.key.split('-').at(-1)}(?=\\s|$)`).test(mr.title)) throw new Error('Номер задачи не найден в заголовке УЗС.');
    if (mr.state === 'closed') throw new Error('УЗС закрыт без слияния.');
    t.uzs = mr;
    this.store.event(t, `Привязан существующий УЗС !${iid}`);
    return this.sync(t);
  }
  async attachKzs(t, iid) {
    if (!t.uzs) throw new Error('Сначала привяжите УЗС.');
    if (t.kzs || t.kzsBranch) throw new Error('У задачи уже есть КЗС или подготовленная ветка.');
    const mr = await this.api.mr(t, iid);
    if (t.kzsBaseBranchConfirmed === true && mr.target_branch !== t.kzsBaseBranch || mr.source_project_id !== mr.target_project_id) throw new Error('КЗС относится к другому проекту или целевой ветке.');
    if (!new RegExp(`(^|\\s)#${t.key.split('-').at(-1)}(?=\\s|$)`).test(mr.title) || !mr.title.includes('Контроль')) throw new Error('Проверьте номер задачи и тип запроса.');
    if (!new RegExp(`!${t.uzs.iid}\\b`).test(mr.description || '')) throw new Error('В описании КЗС нет ссылки на привязанный УЗС.');
    if (mr.state === 'closed') throw new Error('КЗС закрыт без слияния.');
    t.kzsBaseBranch = mr.target_branch;
    t.kzsBaseBranchConfirmed = true;
    t.kzs = mr;
    this.store.event(t, `Привязан существующий КЗС !${iid}`);
    return this.sync(t);
  }
  async merge(t, confirmation, kind = 'uzs') {
    if (!['uzs','kzs'].includes(kind)) throw new Error('Неизвестный тип запроса.');
    if (!t[kind]) throw new Error(`Сначала создайте ${kind === 'uzs' ? 'УЗС' : 'КЗС'}.`);
    await this.sync(t);
    let mr=t[kind];const label=kind==='uzs'?'УЗС':'КЗС';
    if (mr.state === 'merged') return t;
    if (mr.state !== 'opened') throw new Error('Запрос закрыт без слияния.');
    const reviewedKinds = kind === 'kzs' ? ['uzs', 'kzs'] : ['uzs'];
    const reviewError = reviewedKinds.find(name => t.reviewComments?.[name]?.error);
    if (reviewError) throw new Error(`Не удалось проверить комментарии ${reviewError === 'uzs' ? 'УЗС' : 'КЗС'}. Обновите статус и повторите.`);
    const unresolved = reviewedKinds.flatMap(name => t.reviewComments?.[name]?.discussions || []).filter(d => d.resolvable && !d.resolved);
    if (unresolved.length) throw new Error(`Сначала устраните открытые замечания в ${kind === 'kzs' ? 'УЗС и КЗС' : 'УЗС'}: ${unresolved.length}.`);
    if (confirmation !== `Слить !${mr.iid}`) throw new Error(`Для слияния введите: Слить !${mr.iid}`);
    const user = await this.api.request('/user');
    if (user.id !== mr.author.id) throw new Error('Слить запрос может только его автор.');
    const commits = await this.api.list(t, `/merge_requests/${mr.iid}/commits`);
    if (commits.length === 1) mr = await this.padMerge(t, mr, label);
    else if (commits.length < 2) throw new Error(`В ${label} !${mr.iid} нет коммитов. Проверьте исходную ветку.`);
    const squash = typeof this.api.squashSetting === 'function' ? await this.api.squashSetting(t) : undefined;
    const mergeBody = { sha: mr.sha, should_remove_source_branch: true, ...(typeof squash === 'boolean' ? { squash } : {}) };
    try {
      await this.api.request(`${this.api.project(t)}/merge_requests/${mr.iid}/merge`, 'PUT', mergeBody);
    } catch (error) {
      if (/GitLab: HTTP 422\b/.test(error.message)) {
        if (/squash/i.test(error.message)) throw error;
        const fresh = await this.api.mr(t, mr.iid).catch(() => mr);
        const pipeline = fresh.head_pipeline || fresh.pipeline;
        if (fresh.detailed_merge_status === 'ci_must_pass' && pipeline?.status === 'manual') throw new Error(`GitLab отклонил слияние ${label} !${mr.iid}: pipeline #${pipeline.id} заблокирован и ожидает ручного задания. Запустите обязательный job в pipeline, дождитесь успешного завершения и повторите слияние.`);
        if (fresh.detailed_merge_status === 'ci_still_running' && pipeline) throw new Error(`GitLab отклонил слияние ${label} !${mr.iid}: pipeline #${pipeline.id} имеет статус ${pipeline.status}. Дождитесь успешного завершения и повторите.`);
        throw new Error(`GitLab отклонил слияние ${label} !${mr.iid}. Текущий статус готовности: ${fresh.detailed_merge_status || 'не определён'}. Обновите запрос в GitLab и повторите после устранения блокировки.`);
      }
      throw error;
    }
    this.store.event(t, `Запрошено слияние ${label} !${mr.iid}`);
    return this.sync(t);
  }
  async screenshots(t) {
    await this.sync(t);
    await prepareCodeImages(this.store,this.api,t);
    this.store.event(t,'Подготовлены снимки изменений включённого УЗС.');
    return t;
  }
  async publishAssets(t) {
    t.assets ||= [];
    const code = t.assets.filter(a => a.kind === 'code'&&!isSupportingPath(a.codePath));
    if (code.length) {
      const diffs = await loadCodeDiffs(this.api,t);
      const paths = new Set(diffs.flatMap(d => [d.old_path, d.new_path]));
      for (const a of code) if (!paths.has(a.codePath)) throw new Error(`Снимок ${a.name}: файл ${a.codePath} отсутствует в УЗС !${t.uzs.iid}.`);
    }
    for (const a of t.assets) if (!a.remote && !(a.kind==='code'&&(isSupportingPath(a.codePath)||(Array.isArray(t.keyCodePaths)&&!t.keyCodePaths.includes(a.codePath))))) {
      a.remote = await this.api.upload(t, a, await readFile(join(this.store.dir, 'uploads', a.id)));
      this.store.save(t);
    }
  }
  async kzs(t) {
    await this.sync(t);
    if (t.kzs) return t;
    if (t.uzs?.state !== 'merged') throw new Error('КЗС создаётся после слияния УЗС.');
    if (t.kzsBranch && t.kzsBaseBranchConfirmed === undefined) { t.kzsBaseBranch=t.targetBranch;t.kzsBaseBranchConfirmed=true;this.store.save(t); }
    if (t.kzsBaseBranchConfirmed !== true || !t.kzsBaseBranch) throw new Error('Перед созданием КЗС выберите и подтвердите базовую ветку.');
    const kzsTask={...t,targetBranch:t.kzsBaseBranch};
    if (t.kzsBranch) {
      const recovered = await this.api.find(kzsTask, t.kzsBranch);
      if (recovered) {
        t.kzs = await this.api.ensureMR(kzsTask, t.kzsBranch, title(t, 'kzs'), description(t, 'kzs'), 'kzs');
        await this.finalizeKzsDescription(t);
        return this.sync(t);
      }
    }
    validateKzsEvidence(t);
    description({ ...t, assets: (t.assets || []).map(asset => ({ ...asset, remote: asset.remote || { url: `attachment:${asset.id}` } })) }, 'kzs');
    const base = await this.validateRepository(t, t.kzsBaseBranch);
    this.store.event(t, `Обновлена базовая ветка КЗС: origin/${t.kzsBaseBranch}.`);
    // Поддерживаем и обычное, и выполненное вручную сжатое слияние.
    const mergedSha = t.uzs.merge_commit_sha || t.uzs.squash_commit_sha || t.uzs.sha;
    await git((t.executionRepoPath || t.repoPath), 'merge-base', '--is-ancestor', mergedSha, base);
    await this.publishAssets(t);
    const path = await this.worktree(t, 'kzs', base);
    if (await git(path, 'diff', '--name-only', `${base}...HEAD`)) throw new Error('В КЗС обнаружены изменения файлов.');
    const count = Number(await git(path, 'rev-list', '--count', `${base}..HEAD`));
    if (count > 2) throw new Error('В ветке КЗС больше двух коммитов. Проверьте её вручную.');
    for (let i = count; i < 2; i++) await git(path, 'commit', '--allow-empty', '-m', 'Отступ');
    await git(path, 'push', '-u', 'origin', t.kzsBranch);
    t.kzs = await this.api.ensureMR(kzsTask, t.kzsBranch, title(t, 'kzs'), description(t, 'kzs'), 'kzs');
    await this.finalizeKzsDescription(t);
    this.store.event(t, `Создан КЗС !${t.kzs.iid}`);
    return this.sync(t);
  }
}
