import {mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import {basename,isAbsolute,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {Config} from './config.mjs';
import {Store} from './core/store.mjs';
import {Flow,git,remoteProject,withGitPermissions,validateKzsEvidence} from './core/flow.mjs';
import {GitLab} from './core/gitlab.mjs';
import {Jira,issueKey} from './core/jira.mjs';
import {title,description} from './core/description.mjs';
import {isSupportingPath} from './core/report-policy.mjs';
import {createWorkspace,inspectDiff,validBranch} from './workspace.mjs';
import {withLock} from './lock.mjs';
import {validateArguments} from './tools.mjs';

const sshPhrase='Разрешаю SSH для этой операции';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function requireTitle(value) {
  if(!/^[А-Яа-яЁё]+(?:ть|ти|чь)(?=\s|$)/u.test(value)) throw new Error('Название должно отвечать на вопрос «Что сделать?» и начинаться глаголом в инфинитиве.');
}
function mediaUrl(value) {
  if(!value) return '';
  const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password) throw new Error('Для демонстрации нужна HTTPS-ссылка без логина и пароля.');
  return u.href;
}
function summary(t) {
  return Object.fromEntries(['id','key','title','stage','sourceBranch','targetBranch','executionRepoPath','expectedResult','job','uzs','kzs'].map(k=>[k,t[k]]));
}
export class Plugin {
  constructor({config=new Config(),store,flowFactory,jiraFactory}={}) {
    this.config=config;this.store=store||new Store(config.dir);
    this.flowFactory=flowFactory||((s,c)=>new Flow(s,c));
    this.jiraFactory=jiraFactory||(c=>new Jira(c));
  }
  close(){this.store.close();}
  task(id) {const t=this.store.get(id);if(!t?.key)throw new Error('Карточка задачи не найдена.');return t;}
  settings(t) {
    const s=this.config.get();
    if(t&&['gitlabUrl','project','repoPath','jiraBaseUrl'].some(k=>t[k]!==s[k])) throw new Error('Подключение изменилось. Верните настройки проекта карточки перед сетевой операцией.');
    return s;
  }
  redact(error) {
    let message=String(error?.message||error);
    try {for(const token of [this.config.get().token,this.config.get().jiraToken]) if(token) message=message.replaceAll(token,'***');}catch{}
    return message.replace(/https?:\/\/[^\s@]+@/g,'https://***@').slice(0,3000);
  }
  async call(name,args={}) {
    const tool=validateArguments(name,args);
    if(args.sshConfirmation!==undefined&&args.sshConfirmation!==sshPhrase) throw new Error(`Для SSH требуется отдельное разрешение человека: ${sshPhrase}.`);
    const action=async()=>withGitPermissions({allowSsh:args.sshConfirmation===sshPhrase},async()=>{
      if(!tool.annotations.readOnlyHint&&args.taskId) {
        const t=this.task(args.taskId);t.job={action:name,state:'running',startedAt:new Date().toISOString()};this.store.save(t);
      }
      try {
        let value=await this.invoke(name,args);
        if(!tool.annotations.readOnlyHint&&args.taskId) {
          const t=this.task(args.taskId);t.job={...t.job,state:'complete',finishedAt:new Date().toISOString()};this.store.save(t);
          if(value?.id===t.id)value=t;
        }
        return value;
      } catch(error) {
        const message=this.redact(error);
        if(!tool.annotations.readOnlyHint&&args.taskId) {
          const t=this.store.get(args.taskId);if(t?.key){t.job={...t.job,state:'failed',error:message,finishedAt:new Date().toISOString()};this.store.save(t);}
        }
        throw new Error(message);
      }
    });
    return tool.annotations.readOnlyHint?await action():await withLock(this.config.dir,action);
  }
  async invoke(name,a) {
    if(name==='mcu_status')return {standalone:true,settings:this.config.public(),tasks:this.store.list('task').length,dataDir:this.config.dir};
    if(name==='mcu_configure')return this.config.save(a);
    if(name==='mcu_check_connections')return this.checkConnections();
    if(name==='mcu_tasks')return this.store.list('task').map(summary);
    if(name==='mcu_task')return this.task(a.taskId);
    if(name==='mcu_import_jira')return this.importJira(a.url);
    if(name==='mcu_branches')return this.branches();
    const t=this.task(a.taskId);
    switch(name) {
      case 'mcu_update_task':return this.updateTask(t,a);
      case 'mcu_create_workspace':
        if(!t.expectedResult?.trim())throw new Error('Заполните ОР — «Ожидаемый результат» до начала исправления.');
        if(t.uzs||t.uzsBranch)throw new Error('Git Flow уже начат; рабочая копия для исправления больше не создаётся.');
        this.settings(t);return createWorkspace(this.store,t,a);
      case 'mcu_diff':return inspectDiff(t);
      case 'mcu_record_commit':return this.recordCommit(t);
      case 'mcu_preview':return this.preview(t,a.kind);
      case 'mcu_upload':return this.upload(t,a);
      case 'mcu_confirm_kzs':return this.confirmKzs(t,a);
      case 'mcu_publish':return this.publish(t,a);
      case 'mcu_sync':return this.flowFactory(this.store,this.settings(t)).sync(t);
      case 'mcu_attach':return this.flowFactory(this.store,this.settings(t))[a.kind==='uzs'?'attach':'attachKzs'](t,a.iid);
      case 'mcu_merge_uzs':
        if(!t.uzs)throw new Error('Сначала создайте или привяжите УЗС.');
        if(a.confirmation!==`Слить !${t.uzs.iid}`)throw new Error(`Нужна отдельная явная команда автора: Слить !${t.uzs.iid}.`);
        return this.flowFactory(this.store,this.settings(t)).merge(t,a.confirmation,'uzs');
      case 'mcu_screenshots':
        if(a.compileConfirmation!=='Разрешаю компиляцию генератора снимков')throw new Error('Получите разрешение человека на компиляцию генератора снимков.');
        if(!Array.isArray(t.keyCodePaths)||!t.keyCodePaths.length)throw new Error('Сначала выберите до трёх ключевых файлов keyCodePaths.');
        return this.flowFactory(this.store,this.settings(t)).screenshots(t);
      case 'mcu_publish_description':return this.publishDescription(t,a);
    }
    throw new Error('Неизвестная операция.');
  }
  async checkConnections() {
    const s=this.settings(),api=new GitLab(s);
    const [gitlab,jira,project]=await Promise.all([api.request('/user'),this.jiraFactory(s).me(),api.request(`/projects/${encodeURIComponent(s.project)}`)]);
    const remote=remoteProject(await git(s.repoPath,'config','--get','remote.origin.url'));
    if(remote.host!==new URL(s.gitlabUrl).hostname||remote.path!==project.path_with_namespace)throw new Error('origin не совпадает с выбранным проектом GitLab.');
    return {gitlab:{name:gitlab.name,username:gitlab.username},jira,project:{id:project.id,path:project.path_with_namespace},originMatches:true};
  }
  async branches() {
    const s=this.settings();
    const rows=await git(s.repoPath,'for-each-ref','--format=%(refname:short)','refs/heads','refs/remotes/origin');
    return {branches:rows.split('\n').filter(Boolean),note:'Сохранённые локальные refs; origin будет обновлён при создании рабочей копии или публикации.'};
  }
  async importJira(url) {
    const s=this.settings();
    if(!s.project||!s.repoPath)throw new Error('Сначала настройте проект и репозиторий.');
    const key=issueKey(url,s.jiraBaseUrl);
    const existing=this.store.list('task').find(t=>t.key===key&&t.project===s.project&&t.gitlabUrl===s.gitlabUrl&&t.repoPath===s.repoPath);
    if(existing)return existing;
    const issue=await this.jiraFactory(s).import(url);
    if(issue.key!==key)throw new Error('Jira вернула другой номер задачи.');
    return this.store.create({key,title:issue.title,jiraUrl:issue.jiraUrl,issueDescription:issue.issueDescription,actualResult:issue.requirements?.actualResult||'',expectedResult:issue.requirements?.expectedResult||'',jiraAttachments:issue.attachments||[],sourceBranch:issue.sourceBranch,repoPath:s.repoPath,project:s.project,gitlabUrl:s.gitlabUrl,jiraBaseUrl:s.jiraBaseUrl,targetBranch:s.targetBranch,done:'',result:'',verification:'',demo:'',changes:[],keyCodePaths:[]});
  }
  updateTask(t,a) {
    const fields=Object.fromEntries(Object.entries(a).filter(([k])=>k!=='taskId'));
    if(!Object.keys(fields).length)throw new Error('Укажите поля для сохранения.');
    if(fields.title!==undefined)requireTitle(fields.title);
    for(const k of ['sourceBranch','targetBranch'])if(fields[k]!==undefined) {
      if(!validBranch(fields[k]))throw new Error('Некорректное имя ветки.');
      if(t.uzs||t.uzsBranch)throw new Error('После начала Git Flow исходная ветка и назначение не меняются.');
      if(t.executionRepoPath&&k==='sourceBranch'&&fields[k]!==t.sourceBranch)throw new Error('Для задачи уже создана рабочая ветка.');
    }
    if(fields.keyCodePaths) {
      if(new Set(fields.keyCodePaths).size!==fields.keyCodePaths.length||fields.keyCodePaths.some(p=>isAbsolute(p)||p.split('/').includes('..')||isSupportingPath(p)))throw new Error('Выберите до трёх ключевых файлов кода без тестов, history и служебных путей.');
    }
    for(const k of ['beforeUrl','afterUrl'])if(fields[k]!==undefined)fields[k]=mediaUrl(fields[k]);
    Object.assign(t,fields);delete t.previews;
    if(fields.sourceBranch||fields.targetBranch)delete t.analyzedCommit;
    this.store.event(t,'Сохранены постановка и фактический отчёт задачи.');return t;
  }
  reportReady(t) {
    requireTitle(t.title);
    if(!t.done?.trim()||!t.result?.trim()||!t.changes?.length)throw new Error('Заполните суть исправления, итоговое поведение и изменения по модулям.');
    if(!t.sourceBranch||!t.targetBranch)throw new Error('Выберите исходную ветку и назначение.');
  }
  async recordCommit(t) {
    this.reportReady(t);
    if(t.executionRepoPath&&!t.expectedResult?.trim())throw new Error('ОР обязателен для исправления.');
    const d=await inspectDiff(t);
    if(d.dirtyFiles.length)throw new Error('Есть незакоммиченные изменения. Сначала создайте чистый коммит в выбранной рабочей ветке.');
    if(!d.files.length)throw new Error('Ветка не содержит исправления относительно назначения.');
    if((t.keyCodePaths||[]).some(p=>!d.files.includes(p)))throw new Error('Ключевой файл отсутствует в закоммиченном diff.');
    t.analyzedCommit=d.sourceCommit;t.stage='ready';delete t.previews;
    this.store.event(t,`Зафиксирован готовый коммит ${d.sourceCommit}. Git Flow запускается отдельной командой.`);return t;
  }
  async fingerprint(t,kind) {
    const source=kind==='uzs'?(t.uzs?.sha||await git(t.executionRepoPath||t.repoPath,'rev-parse','--verify',`refs/heads/${t.sourceBranch}^{commit}`)):t.uzs?.merge_commit_sha||t.uzs?.squash_commit_sha||t.uzs?.sha||'';
    const fields=['key','title','done','result','changes','keyCodePaths','demo','notes','beforeUrl','afterUrl','sourceBranch','targetBranch','kzsBaseBranch','kzsBaseBranchConfirmed','kzsWithoutDemoConfirmed','jiraUrl','uzs','kzs'];
    const assets=(t.assets||[]).map(a=>({id:a.id,kind:a.kind,name:a.name,module:a.module,codePath:a.codePath,remote:a.remote}));
    return hash({kind,source,fields:Object.fromEntries(fields.map(k=>[k,t[k]])),assets});
  }
  async preview(t,kind) {
    this.reportReady(t);
    const previewTask={...t,assets:t.assets.map(a=>({...a,previewUrl:a.remote?.url||pathToFileURL(join(this.store.dir,'uploads',a.id)).href}))};
    const blockers=[];
    if(kind==='kzs') {
      if(t.uzs?.state!=='merged')blockers.push('Сначала подтвердите слияние УЗС через mcu_sync.');
      if(t.kzsBaseBranchConfirmed!==true||!t.kzsBaseBranch)blockers.push('Выберите базовую ветку КЗС через mcu_confirm_kzs.');
      try{validateKzsEvidence(t);}catch(error){blockers.push(error.message);}
      try{description({...previewTask,assets:previewTask.assets.map(a=>({...a,remote:a.remote||{url:a.previewUrl}}))},kind);}catch(error){blockers.push(error.message);}
    }
    const rendered={taskId:t.id,kind,title:title(t,kind),description:description(previewTask,kind,true),verification:t.verification||'',ready:!blockers.length,blockers,note:'Проверки хранятся отдельно и не добавляются в описание MR. Локальные ссылки вложений будут заменены ссылками GitLab при загрузке.'};
    if(blockers.length){if(t.previews)delete t.previews[kind];this.store.save(t);return rendered;}
    const token=await this.fingerprint(t,kind);
    t.previews={...t.previews,[kind]:token};this.store.save(t);
    return {...rendered,previewToken:token};
  }
  async requirePreview(t,kind,token) {
    if(!t.previews?.[kind]||t.previews[kind]!==token||await this.fingerprint(t,kind)!==token)throw new Error('Нет актуального предпросмотра. Выполните mcu_preview и проверьте его перед публикацией.');
  }
  async publish(t,a) {
    await this.requirePreview(t,a.kind,a.previewToken);
    this.reportReady(t);
    if(a.kind==='uzs'&&!t.uzs) {
      if(!t.analyzedCommit)throw new Error('Сначала прочитайте diff и выполните mcu_record_commit.');
      const d=await inspectDiff(t);
      if(d.sourceCommit!==t.analyzedCommit||d.dirtyFiles.length)throw new Error('Коммит изменился или появились незакоммиченные файлы. Обновите отчёт и предпросмотр.');
    }
    return this.flowFactory(this.store,this.settings(t))[a.kind](t);
  }
  confirmKzs(t,a) {
    if(t.uzs?.state!=='merged')throw new Error('База КЗС выбирается после подтверждённого слияния УЗС. Выполните mcu_sync.');
    if(t.kzsBranch||t.kzs)throw new Error('КЗС уже подготовлен; база не меняется.');
    if(!validBranch(a.baseBranch))throw new Error('Некорректное имя базовой ветки КЗС.');
    if(a.withoutDemo===true&&a.confirmation!=='Создать КЗС без демонстрации')throw new Error('Нужно отдельное подтверждение человека: Создать КЗС без демонстрации.');
    t.kzsBaseBranch=a.baseBranch;t.kzsBaseBranchConfirmed=true;t.kzsWithoutDemoConfirmed=a.withoutDemo===true;delete t.previews;
    this.store.event(t,`Выбрана база КЗС: ${a.baseBranch}.`);return t;
  }
  async upload(t,a) {
    if(!isAbsolute(a.path))throw new Error('Укажите абсолютный путь файла.');
    const info=await stat(a.path);
    if(!info.isFile()||info.size>50*1024*1024)throw new Error('Нужен обычный файл до 50 МБ.');
    const bytes=await readFile(a.path);
    let mime;
    if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))mime='image/png';
    else if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)mime='image/jpeg';
    else if(a.kind!=='code'&&/\.(mp4|mov)$/i.test(a.path)&&bytes.length>=12&&bytes.toString('ascii',4,8)==='ftyp')mime=/\.mov$/i.test(a.path)?'video/quicktime':'video/mp4';
    else throw new Error('Нужен PNG/JPEG; для демонстрации также MP4/MOV.');
    if(a.kind==='code') {
      if(!a.module||!a.codePath||isSupportingPath(a.codePath)||!t.changes.some(c=>c.module===a.module)||!t.keyCodePaths?.includes(a.codePath))throw new Error('Укажите модуль из отчёта и точный путь ключевого кода из keyCodePaths.');
      const paths=new Set(t.assets.filter(x=>x.kind==='code').map(x=>x.codePath));paths.add(a.codePath);
      if(paths.size>3)throw new Error('Для снимков выберите не больше трёх ключевых файлов.');
    }
    const asset={id:randomUUID(),kind:a.kind,name:basename(a.path),mime,size:bytes.length,...(a.kind==='code'?{module:a.module,codePath:a.codePath}:{})};
    await mkdir(join(this.store.dir,'uploads'),{recursive:true,mode:0o700});
    await writeFile(join(this.store.dir,'uploads',asset.id),bytes,{mode:0o600});
    t.assets.push(asset);delete t.previews;this.store.event(t,`Добавлено вложение: ${asset.name}.`);return t;
  }
  async publishDescription(t,a) {
    await this.requirePreview(t,a.kind,a.previewToken);
    const api=new GitLab(this.settings(t)),mr=t[a.kind];
    if(!mr)throw new Error('Запрос ещё не привязан.');
    const fresh=await api.mr(t,mr.iid);
    if(fresh.state!=='opened')throw new Error('Описание обновляется только у открытого запроса.');
    if(fresh.sha!==mr.sha||fresh.description!==mr.description||fresh.title!==mr.title)throw new Error('Запрос изменился в GitLab после предпросмотра. Выполните mcu_sync, учтите новые изменения и проверьте новый preview.');
    if(a.kind==='kzs')await this.flowFactory(this.store,this.settings(t)).publishAssets(t);
    t[a.kind]=await api.update(t,mr.iid,{title:`!${mr.iid} ${title(t,a.kind)}`,description:description(t,a.kind)});
    this.store.event(t,`Обновлено описание ${a.kind==='uzs'?'УЗС':'КЗС'} !${mr.iid}.`);return t;
  }
}
