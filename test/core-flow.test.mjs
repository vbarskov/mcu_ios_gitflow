import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../lib/core/store.mjs';
import { Flow, git, remoteProject, reviewDiscussions, uzsSizeWarning } from '../lib/core/flow.mjs';
import { description, updateIncludedUzs, title as requestTitle } from '../lib/core/description.mjs';
const g=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
class FakeAPI {
  constructor(){this.mrs=[];this.uploads=0;this.failCreate=false;}
  project(){return '/projects/1';}
  async request(path){if(path==='/user')return {id:7};return {path_with_namespace:'demo/repo'};}
  async find(t,branch){return this.mrs.find(m=>m.source_branch===branch);}
  async ensureMR(t,branch,title,description,kind){if(this.failCreate){this.failCreate=false;throw new Error('Временный сбой API');}let m=await this.find(t,branch);if(!m){m={iid:this.mrs.length+1,state:'opened',source_branch:branch,target_branch:t.targetBranch,author:{id:7},title:requestTitle(t,kind,{iid:this.mrs.length+1}),description,kind};this.mrs.push(m);}return {...m};}
  async update(t,iid,body){const mr=this.mrs.find(item=>item.iid===iid);Object.assign(mr,body);return {...mr};}
  async mr(t,iid){return {...this.mrs.find(m=>m.iid===iid)};}
  async list(){return [{old_path:'Modules/Example/file.swift',new_path:'Modules/Example/file.swift'}];}
  async upload(){this.uploads++;return {url:'/uploads/demo.mp4'};}
}
test('Git: УЗС → внешний merge → КЗС с фото «Стало»; повторные запуски и ошибка API',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'flow-git-')),repo=join(dir,'repo'),remote=join(dir,'remote.git');
  await mkdir(repo);g(repo,'init','--initial-branch=release');g(dir,'init','--bare',remote);
  g(repo,'config','user.name','Test');g(repo,'config','user.email','test@example.test');
  await writeFile(join(repo,'README'),'base');g(repo,'add','.');g(repo,'commit','-m','base');
  g(repo,'remote','add','origin','https://git.example.test/demo/repo.git');
  g(repo,'config',`url.file://${remote}.insteadOf`,'https://git.example.test/demo/repo.git');
  g(repo,'push','origin','release');g(repo,'switch','-c','feature/VCSMOB-1');
  await writeFile(join(repo,'change.swift'),Array.from({length:501},(_,i)=>`let value${i} = ${i}`).join('\n')+'\n');g(repo,'add','.');g(repo,'commit','-m','fix');
  // Незакоммиченная работа автора остаётся в исходной копии.
  await writeFile(join(repo,'untracked.txt'),'work in progress');
  const store=new Store(join(dir,'data')),api=new FakeAPI(),flow=new Flow(store,{gitlabUrl:'https://git.example.test'},api);
  const t=store.create({key:'VCSMOB-1',title:'Исправить сценарий',done:'Исправлен сценарий',result:'Работает',demo:'Смена сервера',verification:'Проверено',changes:[{module:'Example',text:'Исправлено'}],jiraUrl:'https://jira.example.test/browse/VCSMOB-1',project:'1',repoPath:repo,targetBranch:'release',sourceBranch:'feature/VCSMOB-1'});
  try{
    api.failCreate=true;
    await assert.rejects(()=>flow.uzs(t),/Временный сбой/);
    await flow.uzs(t);await flow.uzs(t);
    assert.equal(api.mrs.length,1);assert.equal(g(repo,'branch','--show-current'),'feature/VCSMOB-1');assert.equal(g(repo,'status','--porcelain'),'?? untracked.txt');
    assert.equal(t.uzsAddedLines,501);assert.match(t.uzsWarning,/не блокируется/);
    const wp=join(store.dir,'worktrees',t.id,'uzs');
    assert.equal(Number(await git(wp,'rev-list','--count','origin/release..HEAD')),2);
    await assert.rejects(()=>flow.kzs(t),/после слияния/);
    await assert.rejects(()=>flow.merge(t,'wrong'),/Для слияния/);
    g(wp,'push','origin','HEAD:release');api.mrs[0].state='merged';api.mrs[0].merge_commit_sha=g(wp,'rev-parse','HEAD');
    await assert.rejects(()=>flow.kzs(t),/подтвердите базовую ветку/);
    g(repo,'fetch','origin','release');g(repo,'branch','control','origin/release');g(repo,'push','origin','control');
    t.kzsBaseBranch='control';t.kzsBaseBranchConfirmed=true;
    await assert.rejects(()=>flow.kzs(t),/без демонстрации/);
    await mkdir(join(store.dir,'uploads'));await writeFile(join(store.dir,'uploads','video'),'demo');
    t.assets=[{id:'video',kind:'after',mime:'image/png',name:'after.png'}];
    t.assets.push({id:'bad',kind:'code',module:'Example',codePath:'Modules/Other/missing.swift'});
    await assert.rejects(()=>flow.kzs(t),/отсутствует в УЗС/);assert.equal(api.uploads,0);
    t.assets=t.assets.filter(a=>a.id!=='bad');
    await writeFile(join(store.dir,'uploads','code'),'png');
    t.assets.push({id:'code',kind:'code',mime:'image/png',name:'code.png',module:'Example',codePath:'Modules/Example/file.swift'});
    await flow.kzs(t);await flow.kzs(t);
    assert.equal(api.mrs.length,2);assert.equal(api.mrs[1].target_branch,'control');assert.equal(api.uploads,2);
    const kp=join(store.dir,'worktrees',t.id,'kzs');
    assert.equal(g(kp,'diff','--name-only','origin/control...HEAD'),'');
    assert.equal(g(kp,'log','--format=%s','origin/control..HEAD'),'Отступ\nОтступ');
    assert.equal(t.stage,'kzs');assert.equal(api.mrs[1].title,'!2 #1 Исправить сценарий №2. Контроль');assert.doesNotMatch(api.mrs[1].description,/^Заголовок$/m);assert.match(api.mrs[1].description,/^Включает следующие УЗС:\n1\. !1/);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('размер УЗС после 500 строк является предупреждением',()=>{
  assert.equal(uzsSizeWarning(500),'');
  assert.match(uzsSizeWarning(771),/771 добавленных строк/);
});
test('возврат задачи: дополнительный УЗС из выбранной ветки дополняет КЗС без потери текста',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'flow-reopen-')),store=new Store(dir),updates=[];
  const original={iid:10,state:'merged',source_branch:'feature/original',target_branch:'release',title:'#1 Исправить',web_url:'https://git.test/10'};
  const kzs={iid:20,state:'merged',description:'Включает УЗС: !10.\n\nОписание от автора.\n',web_url:'https://git.test/20'};
  const extra={iid:30,state:'opened',source_branch:'feature/fix',target_branch:'release',title:'#1 Дополнительное исправление',web_url:'https://git.test/30'};
  const api={project:()=>'/projects/1',mr:async(_,iid)=>({10:original,20:kzs,30:extra})[iid],find:async()=>extra,update:async(_,iid,body)=>{updates.push(body);Object.assign(kzs,body);return {...kzs};}};
  const flow=new Flow(store,{},api),t=store.create({key:'TEST-1',title:'Исправить ошибку',result:'Исправлено',changes:[],assets:[],uzs:original,kzs});
  try{
    await flow.reopen(t);assert.equal(t.stage,'reopened');
    await flow.prepareAdditionalUzs(t,{sourceBranch:'feature/fix',targetBranch:'release'});
    assert.equal(t.additionalUzsDraft.existingIid,30);
    await flow.addAdditionalUzs(t);
    assert.deepEqual(t.additionalUzs.map(mr=>mr.iid),[30]);
    assert.equal(updates.length,1);assert.match(kzs.description,/Включает следующие УЗС:\n1\. !10\n2\. !30/);assert.match(kzs.description,/Описание от автора/);
    await assert.rejects(()=>flow.addAdditionalUzs(t),/Сначала подготовьте/);
    assert.equal(t.additionalUzs.length,1);assert.equal(updates.length,1);
    await assert.rejects(()=>flow.finishReopen(t),/Сначала слейте/);
    extra.state='merged';await flow.finishReopen(t);assert.equal(t.stage,'complete');
    assert.match(description(t,'kzs',true),/Включает следующие УЗС:\n1\. !10\n2\. !30/);
    assert.equal(updateIncludedUzs('Текст без списка',t).startsWith('Включает следующие УЗС:\n1. !10\n2. !30'),true);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('возврат задачи: новый УЗС создаётся только из существующей ветки GitLab',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'flow-reopen-create-')),store=new Store(dir),requests=[];
  const uzs={iid:10,state:'merged'},kzs={iid:20,state:'merged',description:'Включает УЗС: !10.'};
  let extra;
  const api={project:()=>'/projects/1',mr:async(_,iid)=>({10:uzs,20:kzs,30:extra})[iid],find:async()=>null,update:async(_,iid,body)=>Object.assign(iid===30?extra:kzs,body),request:async(path,method,body)=>{requests.push({path,method,body});if(path==='/user')return {id:7};if(method==='POST'){extra={iid:30,state:'opened',source_branch:body.source_branch,target_branch:body.target_branch,web_url:'https://git.test/30'};return extra;}return {name:'branch'};}};
  const flow=new Flow(store,{},api,{workingAdditional:async()=>({dirty:false}),analyzeAdditional:async()=>({done:'Убран повторный сбой',result:'Работает',changes:[{module:'PickUsers',text:'Исправлена проверка'}]})}),t=store.create({key:'TEST-1',title:'Исправить ошибку',uzs,kzs,assets:[]});
  try{
    await flow.reopen(t);
    await flow.prepareAdditionalUzs(t,{sourceBranch:'feature/TEST-1-fix',targetBranch:'release'});
    assert.match(t.additionalUzsDraft.description,/Убран повторный сбой/);
    await flow.addAdditionalUzs(t);
    assert.equal(requests.filter(row=>row.path.includes('/repository/branches/')).length,2);
    assert.equal(requests.find(row=>row.method==='POST').body.source_branch,'feature/TEST-1-fix');
    assert.match(kzs.description,/Включает следующие УЗС:\n1\. !10\n2\. !30/);
    assert.equal(t.additionalUzs.length,1);
    assert.equal(t.additionalUzs[0].title,'!30 #1 💀 Исправить ошибку reopened №3. Убран повторный сбой');
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('незакоммиченные изменения после возврата требуют просмотра файлов и подтверждения',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'flow-reopen-dirty-')),store=new Store(dir),uzs={iid:10,state:'merged'},kzs={iid:20,state:'merged'};
  let dirty=true,commits=0,analyses=0;
  const api={mr:async(_,iid)=>({10:uzs,20:kzs})[iid],find:async()=>null};
  const flow=new Flow(store,{},api,{workingAdditional:async()=>dirty?{dirty:true,files:['Modules/Fix.swift'],fingerprint:'snapshot'}:{dirty:false},commitAdditional:async(_settings,input,fingerprint)=>{assert.equal(input.sourceBranch,'feature/fix');assert.equal(fingerprint,'snapshot');commits++;dirty=false;},analyzeAdditional:async()=>{analyses++;return {done:'Исправлено',changes:[{module:'Fix',text:'Убран сбой'}]};}});
  const t=store.create({key:'TEST-1',title:'Исправить ошибку',uzs,kzs,assets:[]});
  try{
    await flow.reopen(t);
    await flow.prepareAdditionalUzs(t,{sourceBranch:'feature/fix',targetBranch:'release'});
    assert.deepEqual(t.additionalUzsPendingCommit.files,['Modules/Fix.swift']);assert.equal(analyses,0);
    await assert.rejects(()=>flow.commitAdditionalUzs(t,'old'),/устарело/);assert.equal(commits,0);
    await flow.commitAdditionalUzs(t,'snapshot');assert.equal(commits,1);assert.equal(analyses,1);
    assert.match(t.additionalUzsDraft.description,/Убран сбой/);assert.equal(t.additionalUzsPendingCommit,undefined);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('ветка только в локальном проекте публикуется при создании дополнительного УЗС',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'flow-reopen-local-')),repo=join(dir,'repo'),remote=join(dir,'remote.git');
  await mkdir(repo);g(repo,'init','--initial-branch=release');g(dir,'init','--bare',remote);
  g(repo,'config','user.name','Test');g(repo,'config','user.email','test@example.test');
  await writeFile(join(repo,'README'),'base');g(repo,'add','.');g(repo,'commit','-m','base');
  g(repo,'remote','add','origin','https://git.example.test/demo/repo.git');
  g(repo,'config',`url.file://${remote}.insteadOf`,'https://git.example.test/demo/repo.git');
  g(repo,'push','origin','release');g(repo,'switch','-c','feature/TEST-1-followup');
  await writeFile(join(repo,'fix.swift'),'fix');g(repo,'add','.');g(repo,'commit','-m','fix');
  const store=new Store(join(dir,'data')),uzs={iid:10,state:'merged'},kzs={iid:20,state:'merged',description:'Включает УЗС: !10.'};let extra;
  const api={project:()=>'/projects/1',mr:async(_,iid)=>({10:uzs,20:kzs,30:extra})[iid],find:async()=>null,update:async(_,iid,body)=>Object.assign(iid===30?extra:kzs,body),request:async(path,method,body)=>{
    if(path==='/user')return {id:7};
    if(path==='/projects/1')return {path_with_namespace:'demo/repo'};
    if(path.includes('/repository/branches/feature%2F')){try{g(remote,'show-ref','--verify','refs/heads/feature/TEST-1-followup');}catch{throw new Error('GitLab: HTTP 404');}}
    if(method==='POST'){extra={iid:30,state:'opened',source_branch:body.source_branch,target_branch:body.target_branch};return extra;}
    return {name:'branch'};
  }};
  const flow=new Flow(store,{gitlabUrl:'https://git.example.test'},api,{workingAdditional:async()=>({dirty:false}),analyzeAdditional:async()=>({sourceCommit:g(repo,'rev-parse','HEAD'),done:'Исправлен повторный случай',changes:[{module:'M',text:'Исправлено'}]})}),t=store.create({key:'TEST-1',title:'Исправить',repoPath:repo,uzs,kzs,assets:[]});
  try{
    await flow.reopen(t);
    await flow.prepareAdditionalUzs(t,{sourceBranch:'feature/TEST-1-followup',targetBranch:'release'});
    assert.throws(()=>g(remote,'show-ref','--verify','refs/heads/feature/TEST-1-followup'));
    await flow.addAdditionalUzs(t);
    assert.equal(g(remote,'rev-parse','refs/heads/feature/TEST-1-followup'),g(repo,'rev-parse','HEAD'));
    assert.equal(g(repo,'rev-list','--count','origin/release..HEAD'),'2');
    assert.equal(g(repo,'log','-1','--format=%s'),'Отступ');
    assert.equal(t.additionalUzs[0].iid,30);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('дополнительный УЗС сливается только после подтверждения автора',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'flow-extra-merge-')),store=new Store(dir);
  const uzs={iid:10,state:'merged'},kzs={iid:20,state:'merged'},extra={iid:30,state:'opened',sha:'extra-sha',author:{id:7},source_branch:'feature/fix',target_branch:'release'};
  let mergeBody,commitCount=2;
  const api={project:()=>'/projects/1',mr:async(_,iid)=>({10:uzs,20:kzs,30:extra})[iid],list:async()=>Array.from({length:commitCount},()=>({})),squashSetting:async()=>true,request:async(path,method,body)=>{if(path==='/user')return {id:7};mergeBody=body;extra.state='merged';return extra;}};
  let padded=0;
  const flow=new Flow(store,{},api,{padMerge:async()=>{padded++;commitCount=2;return {...extra,sha:'padded-sha'};}}),t=store.create({key:'TEST-1',uzs,kzs,additionalUzs:[extra],reopenedAt:new Date().toISOString(),assets:[]});
  try{
    await assert.rejects(()=>flow.mergeAdditionalUzs(t,30,'Слить !31'),/Слить !30/);
    assert.equal(mergeBody,undefined);
    commitCount=1;
    await flow.mergeAdditionalUzs(t,30,'Слить !30');
    assert.equal(padded,1);assert.equal(mergeBody.sha,'padded-sha');assert.equal(mergeBody.squash,true);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('разбор адресов origin',()=>{assert.deepEqual(remoteProject('git@git.hi-tech.org:mobile/apple/messenger.git'),{host:'git.hi-tech.org',path:'mobile/apple/messenger'});assert.equal(remoteProject('https://git.example.test/group/repo.git').path,'group/repo');});
test('комментарии ревью: системные скрыты, позиция и статус обсуждения сохранены',()=>{
  const mr={web_url:'https://git.example.test/demo/repo/-/merge_requests/7'};
  const rows=reviewDiscussions(mr,[{id:'discussion-1',notes:[
    {id:10,system:true,body:'added label'},
    {id:11,body:'Исправить условие',author:{name:'Иван',username:'ivan'},created_at:'2026-09-11T08:00:00Z',resolvable:true,resolved:false,position:{new_path:'Modules/M/file.swift',new_line:42}},
    {id:12,body:'Исправлено',author:{username:'victor'},resolvable:true,resolved:true},
  ]}]);
  assert.equal(rows.length,1);assert.equal(rows[0].notes.length,2);assert.equal(rows[0].resolved,false);
  assert.equal(rows[0].notes[0].path,'Modules/M/file.swift');assert.equal(rows[0].notes[0].line,42);
  assert.equal(rows[0].notes[0].url,'https://git.example.test/demo/repo/-/merge_requests/7#note_11');
});
test('привязка существующих УЗС и КЗС не меняет GitLab и проверяет точный номер задачи',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'flow-import-')),store=new Store(dir);
  const api=new FakeAPI();api.mrs=[{iid:94,title:'!94 #10 💀 Исправить сценарий',target_branch:'release',state:'merged'}, {iid:95,title:'!95 #1 Исправить сценарий №2. Контроль',description:'Включает УЗС: !94.',target_branch:'release',state:'merged'}];
  const flow=new Flow(store,{},api),t=store.create({key:'VCSMOB-1',targetBranch:'release'});
  try {
    await assert.rejects(()=>flow.attach(t,94),/Номер задачи/);
    api.mrs[0].title='!94 #1 💀 Исправить сценарий';await flow.attach(t,94);
    api.mrs[1].description='Включает УЗС: !940.';
    await assert.rejects(()=>flow.attachKzs(t,95),/нет ссылки/);
    api.mrs[1].description='Включает УЗС: !94.';await flow.attachKzs(t,95);
    assert.equal(t.stage,'complete');assert.equal(api.mrs.length,2);assert.equal(api.uploads,0);
  } finally {store.close();await rm(dir,{recursive:true,force:true});}
});
test('слияние требует автора, подтверждение и учитывает обязательный squash',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'flow-merge-')),store=new Store(dir),api=new FakeAPI();
  api.mrs=[{iid:1,author:{id:7},state:'opened',sha:'abc123'}];let sent,commitCount=2;
  api.list=async()=>Array.from({length:commitCount},(_,i)=>({id:i}));
  api.squashSetting=async()=>true;
  api.request=async(path,method,body)=>{if(path==='/user')return {id:7};sent=body;api.mrs[0].state='merged';return api.mrs[0];};
  let padded=0;
  const flow=new Flow(store,{},api,{padMerge:async()=>{padded++;commitCount=2;return {...api.mrs[0],sha:'padded-sha'};}}),t=store.create({uzs:api.mrs[0],verification:''});
  try{
    await assert.rejects(()=>flow.merge(t,'Слить !2'),/Для слияния/);
    assert.equal(sent,undefined);api.mrs[0].author.id=9;await assert.rejects(()=>flow.merge(t,'Слить !1'),/только его автор/);api.mrs[0].author.id=7;
    commitCount=1;await flow.merge(t,'Слить !1');
    assert.equal(padded,1);assert.equal(sent.sha,'padded-sha');assert.equal(sent.squash,true);assert.equal(t.stage,'uzs_merged');
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('при слиянии один коммит дополняется пустым «Отступ» в GitLab без изменения рабочей ветки',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'flow-merge-padding-')),repo=join(dir,'repo'),remote=join(dir,'remote.git');
  await mkdir(repo);g(repo,'init','--initial-branch=release');g(dir,'init','--bare',remote);
  g(repo,'config','user.name','Test');g(repo,'config','user.email','test@example.test');
  await writeFile(join(repo,'README'),'base');g(repo,'add','.');g(repo,'commit','-m','base');
  g(repo,'remote','add','origin','https://git.example.test/demo/repo.git');
  g(repo,'config',`url.file://${remote}.insteadOf`,'https://git.example.test/demo/repo.git');
  g(repo,'push','origin','release');g(repo,'switch','-c','feature/TEST-1');
  await writeFile(join(repo,'fix.swift'),'let fixed = true\n');g(repo,'add','.');g(repo,'commit','-m','Исправить');g(repo,'push','origin','feature/TEST-1');
  const original=g(repo,'rev-parse','HEAD'),tree=g(repo,'rev-parse','HEAD^{tree}');
  const mr={iid:1,state:'opened',sha:original,source_branch:'feature/TEST-1',target_branch:'release',source_project_id:1,target_project_id:1};
  const api={project:()=>'/projects/1',request:async()=>({path_with_namespace:'demo/repo'}),mr:async()=>({...mr,sha:g(remote,'rev-parse','refs/heads/feature/TEST-1')}),list:async()=>Array.from({length:Number(g(remote,'rev-list','--count','refs/heads/release..refs/heads/feature/TEST-1'))},()=>({}))};
  const store=new Store(join(dir,'data')),flow=new Flow(store,{gitlabUrl:'https://git.example.test'},api),t=store.create({key:'TEST-1',project:'1',repoPath:repo,assets:[]});
  try {
    const updated=await flow.ensureMergePadding(t,mr,'УЗС');
    assert.notEqual(updated.sha,original);
    assert.equal(g(remote,'rev-list','--count','refs/heads/release..refs/heads/feature/TEST-1'),'2');
    assert.equal(g(remote,'log','-1','--format=%s','refs/heads/feature/TEST-1'),'Отступ');
    assert.equal(g(remote,'rev-parse','refs/heads/feature/TEST-1^{tree}'),tree);
    assert.equal(g(repo,'rev-parse','HEAD'),original);
    assert.equal(g(repo,'for-each-ref','--format=%(refname)','refs/iva-flow/merge-padding'),'');
    await assert.rejects(()=>flow.ensureMergePadding(t,updated,'УЗС'),/уже есть/);
    assert.equal(g(remote,'rev-list','--count','refs/heads/release..refs/heads/feature/TEST-1'),'2');
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('слияние блокируется открытым замечанием ревью',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'flow-review-')),store=new Store(dir),api=new FakeAPI();
  api.mrs=[{iid:1,author:{id:7},state:'opened',sha:'abc123',web_url:'https://git.example.test/mr/1'}];
  api.discussions=async()=>[{id:'d1',notes:[{id:1,body:'Исправить',author:{username:'reviewer'},resolvable:true,resolved:false}]}];
  api.request=async path=>path==='/user'?{id:7}:{};
  const flow=new Flow(store,{},api),t=store.create({uzs:api.mrs[0],verification:'Проверено'});
  try { await assert.rejects(()=>flow.merge(t,'Слить !1'),/открытые замечания.*1/); }
  finally { store.close();await rm(dir,{recursive:true,force:true}); }
});
test('ошибка слияния объясняет заблокированный ручной pipeline',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'flow-pipeline-')),store=new Store(dir);
  const mr={iid:1,author:{id:7},state:'opened',sha:'abc123',detailed_merge_status:'ci_must_pass',head_pipeline:{id:353688,status:'manual'}};
  const api={mr:async()=>({...mr}),discussions:async()=>[],list:async()=>[{},{}],project:()=>'/projects/1',request:async(path)=>{if(path==='/user')return {id:7};throw new Error('GitLab: HTTP 422 (PUT /projects/1/merge_requests/1/merge).');}};
  const flow=new Flow(store,{},api),t=store.create({uzs:mr,verification:'Проверено'});
  try { await assert.rejects(()=>flow.merge(t,'Слить !1'),/pipeline #353688.*ручного задания/); }
  finally { store.close();await rm(dir,{recursive:true,force:true}); }
});

test('дополнительный УЗС с повреждённым черновиком блокируется до сети и отправки ветки',async()=>{
  const task={key:'APP-42',title:'Исправить ошибку',reopenedAt:'2026-11-03',additionalUzsDraft:{sourceBranch:'feature/fix',targetBranch:'release',uzsPartNumber:3,done:''}};
  let remoteCalls=0;
  const flow=new Flow({save(){},event(){}},{},{});
  flow.sync=async()=>{remoteCalls++;throw new Error('Началась сеть');};
  await assert.rejects(flow.addAdditionalUzs(task),/Заполните|краткий итог/);
  assert.equal(remoteCalls,0);
});
