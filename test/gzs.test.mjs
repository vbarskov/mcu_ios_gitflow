import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Plugin} from '../lib/plugin.mjs';
import {tools,validateArguments} from '../lib/tools.mjs';

const parentTitle='!319 #15815 #15835 #15836 #15838 #15839 🐬 Добавить настройки мероприятий и комнат при планировании и редактировании. Гигант';
const parent=()=>({iid:319,project_id:42,source_project_id:42,target_project_id:42,title:parentTitle,web_url:'https://git.example.test/team/app/-/merge_requests/319',source_branch:'feature/parent',target_branch:'release',state:'opened',sha:'parent-sha'});

async function fixture(context,fields={}) {
  const dir=await mkdtemp(join(tmpdir(),'mcu-gzs-'));
  const settings={gitlabUrl:'https://git.example.test',jiraBaseUrl:'https://jira.example.test',project:'team/app',repoPath:dir,targetBranch:'release'};
  const calls=[];
  let remote=parent(),currentKzs;
  const api={
    project:t=>`/projects/${encodeURIComponent(t.project)}`,
    request:async(path,method='GET')=>{
      assert.equal(method,'GET','Привязка не должна менять GitLab.');calls.push({path,method});
      if(path==='/projects/team%2Fapp')return {id:42};
      if(/\/diffs\?/.test(path))return [{new_path:'App/Main.swift',diff:'@@ -0,0 +1 @@\n+let value = 1'}];
      throw new Error('Неожиданный запрос mock API.');
    },
    mr:async(_task,iid)=>{calls.push({iid,method:'GET'});return structuredClone(iid===362?currentKzs:remote);},
  };
  const plugin=new Plugin({config:{dir,get:()=>settings},gitlabFactory:()=>api});
  const task=plugin.store.create({key:'VCSMOB-15839',title:'Доработать планирование мероприятий',jiraUrl:'https://jira.example.test/browse/VCSMOB-15839',...settings,sourceBranch:'feature/current',targetBranch:'feature/parent',done:'Сохранены настройки',result:'Настройки сохраняются',changes:[{module:'Планирование',text:'Сохранение настроек'}],...fields});
  context.mock.method(globalThis,'fetch',async()=>{throw new Error('Настоящая сеть запрещена в тесте.');});
  context.after(async()=>{plugin.close();await rm(dir,{recursive:true,force:true});});
  return {plugin,task,calls,setParent:value=>{remote=value;},setKzs:value=>{currentKzs=value;}};
}

test('ГЗС с отдельной родительской Jira привязывается только локально и не меняет задачу КЗС',async context=>{
  const {plugin,task,calls,setParent}=await fixture(context,{previews:{uzs:'old',kzs:'old'}});
  const mr={...parent(),title:'!319 #15815 🐬 Добавить родительскую фичу. Гигант'};setParent(mr);
  const result=await plugin.call('mcu_attach_gzs',{taskId:task.id,iid:319});
  assert.equal(result.key,task.key);assert.equal(result.title,task.title);assert.equal(result.jiraUrl,task.jiraUrl);
  assert.deepEqual(result.gzs,{...mr,jiraNumbers:['15815'],jiraKeys:[]});
  assert.equal(result.kzsTargetIsGzs,true);assert.equal(result.previews,undefined);
  assert.equal(result.job.state,'complete');assert.equal(result.uzs,undefined);assert.equal(result.kzs,undefined);
  assert.deepEqual(calls,[{path:'/projects/team%2Fapp',method:'GET'},{iid:319,method:'GET'}]);
  const listed=await plugin.call('mcu_tasks');assert.deepEqual(listed[0].gzs,result.gzs);
});

test('исходный заголовок ГЗС и все явно написанные Jira сохраняются без primary и угаданного префикса',async context=>{
  const {plugin,task,setParent}=await fixture(context);
  const title=parentTitle+' #15815 VCSMOB-20001 #APP-7 VCSMOB-20001 APP-7';setParent({...parent(),title});
  const result=await plugin.call('mcu_attach_gzs',{taskId:task.id,iid:319});
  assert.equal(result.gzs.title,title);
  assert.deepEqual(result.gzs.jiraNumbers,['15815','15835','15836','15838','15839']);
  assert.deepEqual(result.gzs.jiraKeys,['VCSMOB-20001','APP-7']);
  assert.equal(result.gzs.primaryJiraKey,undefined);assert.equal(result.gzs.jiraKeys.includes('VCSMOB-15815'),false);
});

test('фактическое назначение свежего КЗС важнее сохранённых баз и сравнивается с source веткой ГЗС',async context=>{
  const oldKzs={iid:362,target_branch:'feature/old',state:'opened',sha:'old'};
  const {plugin,task,setKzs}=await fixture(context,{kzs:oldKzs,kzsBaseBranch:'feature/base',kzsBaseBranchConfirmed:true});
  const fresh={...oldKzs,source_branch:'kzs/current',target_branch:'feature/parent',sha:'fresh'};setKzs(fresh);
  const result=await plugin.call('mcu_attach_gzs',{taskId:task.id,iid:319});
  assert.deepEqual(result.kzs,fresh);assert.equal(result.gzs.target_branch,'release');assert.equal(result.kzsTargetIsGzs,true);
});

for(const [label,fields,branch] of [
  ['подтверждённая база',{targetBranch:'release',kzsBaseBranch:'feature/parent',kzsBaseBranchConfirmed:true},'feature/parent'],
  ['неподтверждённая база игнорируется',{targetBranch:'feature/parent',kzsBaseBranch:'feature/other',kzsBaseBranchConfirmed:false},'feature/parent'],
  ['release сохраняет связь без дельфина',{targetBranch:'release/26.0'},'release/26.0'],
  ['minor не запрещает подтверждение ГЗС',{targetBranch:'minor/20.2'},'minor/20.2'],
])test(`назначение ГЗС: ${label}`,async context=>{
  const {plugin,task,setParent}=await fixture(context,fields);setParent({...parent(),source_branch:branch});
  const result=await plugin.call('mcu_attach_gzs',{taskId:task.id,iid:319});
  assert.equal(result.gzs.source_branch,branch);assert.equal(result.kzsTargetIsGzs,!/^release(?:\/|$)/.test(branch));
});

for(const [label,fields,override,pattern] of [
  ['неверный IID ответа',{}, {iid:320},/номер|IID/i],
  ['другой проект',{}, {project_id:99,source_project_id:99,target_project_id:99},/проект/],
  ['fork',{}, {source_project_id:99},/проект/],
  ['нет source project',{}, {source_project_id:undefined},/проект/],
  ['нет маркера Гигант',{}, {title:'!319 #15815 Добавить фичу'},/Гигант/],
  ['часть слова не является маркером',{}, {title:'!319 #15815 Добавить гигантский экран'},/Гигант/],
  ['закрытый запрос',{}, {state:'closed'},/открыт|слит/],
  ['нет назначения',{targetBranch:'',kzsBaseBranch:'',kzsBaseBranchConfirmed:false},{},/назначени/],
  ['совпадает target вместо source',{}, {source_branch:'feature/other',target_branch:'feature/parent'},/исходн|source/i],
  ['уже привязанный УЗС',{uzs:{iid:319}},{},/УЗС|КЗС/],
  ['уже привязанный КЗС',{kzs:{iid:319}},{},/УЗС|КЗС/],
  ['дополнительный УЗС',{additionalUzs:[{iid:319}]},{},/УЗС|КЗС/],
])test(`недопустимая привязка ГЗС: ${label}`,async context=>{
  const {plugin,task,setParent}=await fixture(context,fields);setParent({...parent(),...override});
  await assert.rejects(plugin.call('mcu_attach_gzs',{taskId:task.id,iid:319}),pattern);
  assert.equal(plugin.task(task.id).gzs,undefined);assert.notEqual(plugin.task(task.id).kzsTargetIsGzs,true);
});

test('при неудачной привязке свежий КЗС не заменяет сохранённый snapshot',async context=>{
  const oldKzs={iid:362,target_branch:'feature/parent',state:'opened',sha:'old'};
  const {plugin,task,setKzs}=await fixture(context,{kzs:oldKzs});setKzs({...oldKzs,target_branch:'feature/other',sha:'fresh'});
  await assert.rejects(plugin.call('mcu_attach_gzs',{taskId:task.id,iid:319}),/исходн|source/i);
  assert.deepEqual(plugin.task(task.id).kzs,oldKzs);
});

test('повторная привязка обновляет snapshot, сбрасывает preview и входит в fingerprint',async context=>{
  const {plugin,task,setParent}=await fixture(context);
  let result=await plugin.call('mcu_attach_gzs',{taskId:task.id,iid:319});
  const fingerprint=await plugin.fingerprint(result,'kzs');
  result.previews={kzs:'old'};plugin.store.save(result);setParent({...parent(),state:'merged',sha:'new-parent-sha'});
  result=await plugin.call('mcu_attach_gzs',{taskId:task.id,iid:319});
  assert.equal(result.gzs.state,'merged');assert.equal(result.gzs.sha,'new-parent-sha');assert.equal(result.previews,undefined);
  assert.notEqual(await plugin.fingerprint(result,'kzs'),fingerprint);
});

test('подтверждённая связь даёт дельфина в chat и preview с Jira текущего КЗС',async context=>{
  const uzs={iid:361,state:'merged',sha:'uzs-sha'};
  const kzs={iid:362,state:'opened',title:'!362 #15839 Доработать планирование №2. Контроль',target_branch:'feature/parent',sha:'kzs-sha',web_url:'https://git.example.test/team/app/-/merge_requests/362'};
  const {plugin,task,setKzs}=await fixture(context,{uzs,kzs,kzsBaseBranch:'feature/parent',kzsBaseBranchConfirmed:true,kzsWithoutDemoConfirmed:true,keyCodePaths:['App/Main.swift']});setKzs(kzs);
  task.assets=[{id:'shot',kind:'code',module:'Планирование',codePath:'App/Main.swift',remote:{url:'/uploads/shot.png'}}];plugin.store.save(task);
  await plugin.call('mcu_attach_gzs',{taskId:task.id,iid:319});
  const preview=await plugin.call('mcu_preview',{taskId:task.id,kind:'kzs'});
  assert.equal(preview.ready,true);assert.match(preview.title,/^!362 #15839 🐬 /);assert.doesNotMatch(preview.title,/#15815/);
  const chat=await plugin.call('mcu_chat_message',{taskId:task.id,kind:'kzs',testSeconds:42});
  assert.equal(chat.needsInput,undefined);assert.match(chat.text,/^🐬 КЗС в feature\/parent:/);assert.doesNotMatch(chat.text.split('\n')[1],/🐬/);
});

for(const confirmed of [true,undefined])test(`фактическая цель КЗС заменяет устаревшую release-базу без нового подтверждения: ${confirmed}`,async context=>{
  const oldKzs={iid:362,state:'opened',target_branch:'release',sha:'old'};
  const {plugin,task,setKzs}=await fixture(context,{uzs:{iid:361,state:'merged',sha:'uzs-sha'},kzs:oldKzs,kzsBaseBranch:'release',kzsBaseBranchConfirmed:confirmed,kzsWithoutDemoConfirmed:true,keyCodePaths:['App/Main.swift']});
  setKzs({...oldKzs,target_branch:'feature/parent',sha:'fresh'});
  task.assets=[{id:'shot',kind:'code',module:'Планирование',codePath:'App/Main.swift',remote:{url:'/uploads/shot.png'}}];plugin.store.save(task);
  const result=await plugin.call('mcu_attach_gzs',{taskId:task.id,iid:319});
  assert.equal(result.kzsBaseBranch,'feature/parent');assert.equal(result.kzsBaseBranchConfirmed,confirmed);
  const preview=await plugin.call('mcu_preview',{taskId:task.id,kind:'kzs'});
  assert.match(preview.title,/^!362 #15839 🐬 /);assert.equal(preview.ready,confirmed===true);
});

test('смена назначения удаляет родителя и derived true, но сохраняет отдельный явный ответ',async context=>{
  const {plugin,task}=await fixture(context,{gzs:parent(),kzsTargetIsGzs:true,previews:{kzs:'old'}});
  let result=await plugin.call('mcu_update_task',{taskId:task.id,targetBranch:'feature/other'});
  assert.equal(result.gzs,undefined);assert.equal(result.kzsTargetIsGzs,undefined);assert.equal(result.previews,undefined);
  result.gzs=parent();result.targetBranch='feature/parent';result.kzsTargetIsGzs=true;plugin.store.save(result);
  result=await plugin.call('mcu_update_task',{taskId:task.id,targetBranch:'feature/other',kzsTargetIsGzs:true});
  assert.equal(result.gzs,undefined);assert.equal(result.kzsTargetIsGzs,true);
  result=await plugin.call('mcu_update_task',{taskId:task.id,targetBranch:'feature/third'});
  assert.equal(result.kzsTargetIsGzs,true);
});

test('явный false удаляет противоречивую связь без смены ветки',async context=>{
  const {plugin,task}=await fixture(context,{gzs:parent(),kzsTargetIsGzs:true});
  const result=await plugin.call('mcu_update_task',{taskId:task.id,kzsTargetIsGzs:false});
  assert.equal(result.gzs,undefined);assert.equal(result.kzsTargetIsGzs,false);
});

test('смена подтверждённой базы КЗС очищает связь, та же база сохраняет её',async context=>{
  const {plugin,task}=await fixture(context,{gzs:parent(),kzsTargetIsGzs:true,uzs:{iid:361,state:'merged',sha:'sha'}});
  let result=await plugin.call('mcu_confirm_kzs',{taskId:task.id,baseBranch:'feature/parent'});
  assert.equal(result.gzs.iid,319);assert.equal(result.kzsTargetIsGzs,true);
  result=await plugin.call('mcu_confirm_kzs',{taskId:task.id,baseBranch:'feature/other'});
  assert.equal(result.gzs,undefined);assert.equal(result.kzsTargetIsGzs,undefined);
});

for(const action of ['mcu_sync','mcu_attach'])test(`${action} очищает связь после изменения фактического назначения КЗС`,async context=>{
  const {plugin,task}=await fixture(context,{gzs:parent(),kzsTargetIsGzs:true,previews:{kzs:'old'},uzs:{iid:361,state:'merged'}});
  plugin.flowFactory=()=>({
    sync:async value=>{value.kzs={iid:362,target_branch:'feature/other'};plugin.store.save(value);return value;},
    attachKzs:async(value,iid)=>{value.kzs={iid,target_branch:'feature/other'};plugin.store.save(value);return value;},
  });
  const result=await plugin.call(action,{taskId:task.id,...(action==='mcu_attach'?{kind:'kzs',iid:362}:{})});
  assert.equal(result.gzs,undefined);assert.equal(result.kzsTargetIsGzs,undefined);assert.equal(result.previews,undefined);
});

test('sync сохраняет явный false при очистке устаревшей связи, включая ошибку после обновления',async context=>{
  const {plugin,task}=await fixture(context,{gzs:parent(),kzsTargetIsGzs:false,uzs:{iid:361,state:'merged'}});
  plugin.flowFactory=()=>({sync:async value=>{value.kzs={iid:362,target_branch:'feature/other'};plugin.store.save(value);throw new Error('Комментарии временно недоступны.');}});
  await assert.rejects(plugin.call('mcu_sync',{taskId:task.id}),/Комментарии/);
  const result=plugin.task(task.id);assert.equal(result.gzs,undefined);assert.equal(result.kzsTargetIsGzs,false);
});

for(const kind of ['uzs','kzs'])test(`publish ${kind} очищает родителя после внутренней синхронизации назначения КЗС`,async context=>{
  const {plugin,task}=await fixture(context,{gzs:parent(),kzsTargetIsGzs:true,uzs:{iid:361,state:'merged',sha:'uzs-sha'},kzs:{iid:362,state:'opened',target_branch:'feature/parent',sha:'kzs-sha'},kzsBaseBranch:'feature/parent',kzsBaseBranchConfirmed:true,kzsWithoutDemoConfirmed:true,keyCodePaths:['App/Main.swift']});
  task.assets=[{id:'shot',kind:'code',module:'Планирование',codePath:'App/Main.swift',remote:{url:'/uploads/shot.png'}}];plugin.store.save(task);
  let invoked=false;
  plugin.flowFactory=()=>({[kind]:async value=>{invoked=true;value.kzs.target_branch='feature/other';plugin.store.save(value);return value;}});
  const preview=await plugin.call('mcu_preview',{taskId:task.id,kind});
  assert.equal(preview.ready,true);assert.ok(preview.previewToken);
  const result=await plugin.call('mcu_publish',{taskId:task.id,kind,previewToken:preview.previewToken});
  assert.equal(invoked,true);assert.equal(result.kzs.target_branch,'feature/other');
  assert.equal(result.gzs,undefined);assert.equal(result.kzsTargetIsGzs,undefined);assert.equal(result.previews,undefined);
});

for(const reject of [false,true])test(`merge УЗС очищает родителя после sync, включая отказ слияния: ${reject}`,async context=>{
  const {plugin,task}=await fixture(context,{gzs:parent(),kzsTargetIsGzs:true,uzs:{iid:361,state:'opened',sha:'uzs-sha'},kzs:{iid:362,target_branch:'feature/parent'},previews:{kzs:'old'}});
  plugin.flowFactory=()=>({merge:async(value,confirmation,kind)=>{
    assert.equal(confirmation,'Слить !361');assert.equal(kind,'uzs');
    value.kzs.target_branch='feature/other';plugin.store.save(value);
    if(reject)throw new Error('Слияние не разрешено автору.');
    return value;
  }});
  const operation=plugin.call('mcu_merge_uzs',{taskId:task.id,confirmation:'Слить !361'});
  if(reject)await assert.rejects(operation,/не разрешено/);else await operation;
  const result=plugin.task(task.id);assert.equal(result.kzs.target_branch,'feature/other');
  assert.equal(result.gzs,undefined);assert.equal(result.kzsTargetIsGzs,undefined);assert.equal(result.previews,undefined);
  assert.equal(result.job.state,reject?'failed':'complete');
});

test('схема отдельного инструмента не расширяет kind и отклоняет неверный IID до API',async context=>{
  const {plugin,task,calls}=await fixture(context);
  assert.equal(tools.find(item=>item.name==='mcu_attach_gzs')?.annotations.readOnlyHint,false);
  await assert.rejects(plugin.call('mcu_attach_gzs',{taskId:task.id,iid:0}),/iid/);
  await assert.rejects(plugin.call('mcu_attach_gzs',{taskId:task.id,iid:'319'}),/iid/);
  assert.throws(()=>validateArguments('mcu_attach',{taskId:task.id,kind:'gzs',iid:319}),/kind/);
  assert.equal(calls.length,0);
});
