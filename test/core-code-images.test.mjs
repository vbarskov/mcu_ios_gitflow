import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffPages,prepareCodeImages,loadCodeDiffs,loadMergeRequestDiffs } from '../lib/core/code-images.mjs';
import { Flow } from '../lib/core/flow.mjs';
test('снимки: номера строк, страницы и отсутствие повторов',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'code-images-'));try{
 const diff='@@ -10,2 +10,2 @@\n-old\n+new\n context';const rows=diffPages(diff)[0];
 assert.match(rows[1].text,/10\s+- old/);assert.match(rows[2].text,/10 \+ new/);
 assert.ok(diffPages('@@ -1 +1 @@\n+'+'x'.repeat(6000)).length>1);
 const t={id:'one',uzs:{iid:97},changes:[{module:'Modules/M'}],assets:[]};
 let renders=0;const store={dir,save:()=>{}},api={list:async()=>[{new_path:'Modules/M/a.swift',diff}]};
 const render=async()=>{renders++;return Buffer.from('png');};
 await prepareCodeImages(store,api,t,render);await prepareCodeImages(store,api,t,render);
 assert.equal(renders,1);assert.equal(t.assets[0].module,'Modules/M');assert.equal(t.assets[0].codePath,'Modules/M/a.swift');
 api.list=async()=>[{new_path:'Modules/M/a.swift',too_large:true}];await assert.rejects(prepareCodeImages(store,api,t,render),/полный diff/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('слияние КЗС требует его номер и использует его SHA',async()=>{
 const t={uzs:{iid:97,state:'merged'},kzs:{iid:98,state:'opened',sha:'kzs-sha',author:{id:7}},verification:'Проверено'};let sent;
 const api={mr:async(t,id)=>id===98?t.kzs:t.uzs,project:()=>'/projects/1',squashSetting:async()=>true,list:async()=>[{},{}],request:async(p,m,b)=>{if(p==='/user')return {id:7};sent={p,b};t.kzs.state='merged';}};
 const f=new Flow({save:()=>{},event:()=>{},list:()=>[]},{},api);
 await assert.rejects(f.merge(t,'Слить !97','kzs'),/Слить !98/);assert.equal(sent,undefined);
 await f.merge(t,'Слить !98','kzs');assert.equal(sent.p,'/projects/1/merge_requests/98/merge');assert.equal(sent.b.sha,'kzs-sha');assert.equal(sent.b.squash,true);assert.equal(t.stage,'complete');
});

test('резервное чтение изменений при ошибке сервера; неполные данные запрещены',async()=>{
 const api={list:async()=>{throw new Error('GitLab: HTTP 500');},project:()=>'/projects/1',request:async()=>({changes:[{diff:'code'}]})};
 assert.equal((await loadCodeDiffs(api,{uzs:{iid:97}}))[0].diff,'code');
 api.request=async()=>({overflow:true,changes:[]});await assert.rejects(loadCodeDiffs(api,{uzs:{iid:97}}),/неполные/);
});
test('резервное чтение поддерживает пустой diff КЗС',async()=>{
 const calls=[];const api={list:async()=>{throw new Error('GitLab: HTTP 500');},project:()=>'/projects/1',request:async path=>{calls.push(path);return {changes:[]};}};
 assert.deepEqual(await loadMergeRequestDiffs(api,{project:'1'},106),[]);
 assert.equal(calls[0],'/projects/1/merge_requests/106/changes');
});

test('Снимки ограничены ключевыми файлами; тесты и history исключены',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'key-images-'));try{
 const paths=['Modules/M/Tests/a.swift','history/change.swift','Modules/M/main.swift','Modules/M/helper.swift'];
 const t={id:'key',uzs:{iid:1},changes:[{module:'M'},{module:'history'}],keyCodePaths:paths.slice(0,3),assets:[]};
 await prepareCodeImages({dir,save(){}},{list:async()=>paths.map(new_path=>({new_path,diff:'@@ -1 +1 @@\n-old\n+new'}))},t,async()=>Buffer.from('png'));
 assert.deepEqual(t.assets.map(a=>a.codePath),['Modules/M/main.swift']);
 const {description}=await import('../lib/core/description.mjs');
 t.key='TEST-1';t.title='Исправить главное поведение';t.changes.push({module:'Tests',text:'служебное'});t.demo='баннер';
 const text=description(t,'kzs',true);assert.ok(!text.includes('| Tests |'));assert.ok(!text.includes('| history |'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('снимок сопоставляется с модулем во вложенном каталоге',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nested-module-image-'));try{
 const path='Modules/M5Media/M5MediaPIPContent/src/File.swift';
 const t={id:'nested',uzs:{iid:1},changes:[{module:'M5MediaPIPContent',text:'Главное изменение'}],keyCodePaths:[path],assets:[]};
 await prepareCodeImages({dir,save(){}},{list:async()=>[{new_path:path,diff:'@@ -1 +1 @@\n-old\n+new'}]},t,async()=>Buffer.from('png'));
 assert.equal(t.assets[0].module,'M5MediaPIPContent');
 const {description}=await import('../lib/core/description.mjs');
 t.key='TEST-2';t.title='Исправить модуль';t.demo='проверка';
 const text=description(t,'kzs',true);
 assert.match(text,/\| M5MediaPIPContent \|.*!\[Код\]/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('снимок сопоставляется с перечислением модулей в одной строке',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'grouped-module-image-'));try{
  const path='Modules/PickUsers/src/PickUsers.L.swift';
  const group='PickUsers, PickUsersGroup, M5PUsers';
  const t={id:'grouped',uzs:{iid:119},changes:[{module:group,text:'Исправлен выбор'}],keyCodePaths:[path],assets:[]};
  await prepareCodeImages({dir,save(){}},{list:async()=>[{new_path:path,diff:'@@ -1 +1 @@\n-old\n+new'}]},t,async()=>Buffer.from('png'));
  assert.equal(t.assets[0].module,group);
  const {description}=await import('../lib/core/description.mjs');
  t.key='TEST-3';t.title='Исправить выбор пользователей';t.jiraUrl='https://jira.example.test/TEST-3';
  assert.match(description(t,'kzs',true),/\| PickUsers, PickUsersGroup, M5PUsers \|.*!\[Код\]/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('снимки сопоставляются с именем Swift-файла без расширения и вложенным модулем',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'file-module-image-'));try{
  const paths=['Modules/C3/C3NavBar/src/C3NavBar.Aux.swift','Modules/C3/C3NavBar/src/C3NavBar.Shoulds.swift','Modules/M5PUsers/M5PUsersAddBtn/src/Permissions.swift'];
  const modules=['C3NavBar.Aux','C3NavBar.Shoulds','M5PUsers/M5PUsersAddBtn'];
  const t={id:'files',uzs:{iid:1},changes:modules.map(module=>({module})),keyCodePaths:paths,assets:[]};
  await prepareCodeImages({dir,save(){}},{list:async()=>paths.map(new_path=>({new_path,diff:'@@ -1 +1 @@\n-old\n+new'}))},t,async()=>Buffer.from('png'));
  assert.deepEqual(t.assets.map(a=>a.module),modules);
  t.changes=[{module:'Unrelated'}];
  await assert.rejects(prepareCodeImages({dir,save(){}},{list:async()=>paths.map(new_path=>({new_path,diff:'@@ -1 +1 @@\n-old\n+new'}))},t,async()=>Buffer.from('png')),/Не удалось подготовить снимки/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('Публикация вложений без снимков не запрашивает diff и не запускает генератор', async () => {
  const task = { assets: [], uzs: { iid: 1 }, changes: [{ module: 'M' }] };
  let diffRequests = 0;
  const flow = new Flow({ save() {} }, {}, {
    list: async () => { diffRequests++; throw new Error('Генератор вызван неявно'); },
  });
  await flow.publishAssets(task);
  assert.equal(diffRequests, 0);
  assert.deepEqual(task.assets, []);
});
