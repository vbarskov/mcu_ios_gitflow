import test from 'node:test';
import assert from 'node:assert/strict';
import {Plugin} from '../lib/plugin.mjs';
import {tools,validateArguments} from '../lib/tools.mjs';
import {GitLab} from '../lib/core/gitlab.mjs';

function fixture(overrides={},list=async()=>[{diff:'@@ -1,2 +1,3 @@\n-old\n+first\n+second\n context'}]) {
 const task={id:'task-1',key:'APP-1',title:'Исправить загрузку файла',done:'Исправлена загрузка файла',targetBranch:'release',gitlabUrl:'https://git.example.test',project:'team/app',repoPath:'/unused/repo',jiraBaseUrl:'https://jira.example.test',uzs:{iid:10,web_url:'https://git.example.test/10',target_branch:'minor/20.2',description:'Было сделано:\nИсправлено открытие большого файла. Сохранён выбранный путь.\n\n- Main: исправление'},assets:[],previews:{uzs:'keep-token'},job:{state:'failed',error:'keep-error'},...overrides};
 let writes=0,apiReads=0;
 const store={get:id=>id===task.id?task:null,save(){writes++;throw new Error('Запись запрещена для черновика');},event(){writes++;throw new Error('Запись события запрещена');},close(){}};
 const settings={gitlabUrl:task.gitlabUrl,project:task.project,repoPath:task.repoPath,jiraBaseUrl:task.jiraBaseUrl};
 const config={dir:'/unused/no-lock-file',get:()=>settings};
 const plugin=new Plugin({store,config,gitlabFactory:()=>({list:async(...args)=>{apiReads++;return list(...args);}})});
 return {plugin,task,counters:()=>({writes,apiReads})};
}

test('mcu_chat_message объявлен чтением; формат УЗС совпадает с кнопкой без изменения карточки',async()=>{
 const item=tools.find(tool=>tool.name==='mcu_chat_message');
 assert.ok(item);assert.equal(item.annotations.readOnlyHint,true);
 assert.equal(item.annotations.destructiveHint,false);
 const {plugin,task,counters}=fixture();const before=structuredClone(task);
 const result=await plugin.call('mcu_chat_message',{taskId:task.id,kind:'uzs',testSeconds:42});
 assert.equal(result.text,'Сливаю УЗС-1: Исправлено открытие большого файла.\nhttps://git.example.test/10\n√2,💀, minor/20.2 >= 2, тест (42 сек)');
 assert.deepEqual(result.missingData,[]);assert.deepEqual(task,before);
 assert.deepEqual(counters(),{writes:0,apiReads:1});
});

test('время теста не придумывается и не извлекается из произвольного отчёта',async()=>{
 const {plugin,task}=fixture({verification:'Проверки и тесты не запускались',chatMessages:{uzs:{testSeconds:396}}});
 const result=await plugin.call('mcu_chat_message',{taskId:task.id,kind:'uzs'});
 assert.match(result.text,/тест \(\[длительность\] сек\)$/);
 assert.ok(result.missingData.includes('testSeconds'));
 assert.throws(()=>validateArguments('mcu_chat_message',{taskId:task.id,kind:'uzs',testSeconds:0}),/testSeconds/);
});

test('краткий итог отражает поведение, когда done содержит общее сообщение о завершении',async()=>{
 const {plugin,task}=fixture({uzs:{iid:10,web_url:'https://git.example.test/10',description:'Было сделано:\n- Main: обновление формы'},done:'Завершены доработки по результатам сверки',result:'При редактировании комнаты сохраняются параметры расписания. Остальной результат серии.'});
 const result=await plugin.call('mcu_chat_message',{taskId:task.id,kind:'uzs'});
 assert.match(result.text,/^Сливаю УЗС-1: При редактировании комнаты сохраняются параметры расписания\./);
});

test('дополнительный УЗС выбирается по связанному iid, неизвестный iid не читается из API',async()=>{
 const extra={iid:11,web_url:'https://git.example.test/11',target_branch:'release/26',description:'Исправлен повторный сбой открывания.'};
 const {plugin,task,counters}=fixture({additionalUzs:[extra]});
 const result=await plugin.call('mcu_chat_message',{taskId:task.id,kind:'uzs',iid:11,testSeconds:15});
 assert.match(result.text,/^Сливаю УЗС-2: Исправлен повторный сбой открывания\./);
 assert.match(result.text,/\nhttps:\/\/git.example.test\/11\n√2,💀, release\/26/);
 await assert.rejects(plugin.call('mcu_chat_message',{taskId:task.id,kind:'uzs',iid:999}),/не привязан|не связан/);
 assert.equal(counters().apiReads,1);
});

test('КЗС использует собственный diff; пустой diff даёт достоверный ноль, демо только по факту',async()=>{
 const visited=[];
 const {plugin,task}=fixture({kzs:{iid:20,web_url:'https://git.example.test/20',target_branch:'release'}},async(_task,path)=>{visited.push(path);return [];});
 const result=await plugin.call('mcu_chat_message',{taskId:task.id,kind:'kzs'});
 assert.equal(result.text,'КЗС: https://git.example.test/20\n√0, release, >=2');
 assert.deepEqual(result.missingData,[]);assert.deepEqual(visited,['/merge_requests/20/diffs']);
 task.assets.push({kind:'after',remote:{url:'/uploads/video.mp4'}});
 assert.match((await plugin.call('mcu_chat_message',{taskId:task.id,kind:'kzs'})).text,/, демо$/);
});

test('неполный diff и ошибка чтения оставляют число строк неизвестным',async()=>{
 const loaders=[async()=>[{too_large:true,diff:''}],async()=>[{collapsed:true,diff:''}],async()=>[{}],async()=>{throw new Error('GitLab: HTTP 403');}];
 for(const loader of loaders) {
  const {plugin,task}=fixture({},loader);
  const result=await plugin.call('mcu_chat_message',{taskId:task.id,kind:'uzs',testSeconds:1});
  assert.match(result.text,/√\[добавлено строк\]/);
  assert.ok(result.missingData.includes('addedLines'));
  assert.ok(!result.text.includes('√0,'));
 }
});

test('без MR возвращается шаблон с пропусками, без запроса API и без создания карточки',async()=>{
 const {plugin,task,counters}=fixture({uzs:undefined,done:'',result:'',title:'',targetBranch:''});
 const result=await plugin.call('mcu_chat_message',{taskId:task.id,kind:'uzs'});
 assert.equal(result.text,'Сливаю УЗС-1: [краткий результат]\n[ссылка на УЗС]\n√[добавлено строк],💀, [ветка] >= 2, тест ([длительность] сек)');
 assert.deepEqual(new Set(result.missingData),new Set(['summary','url','addedLines','targetBranch','testSeconds']));
 assert.deepEqual(counters(),{writes:0,apiReads:0});
});


test('реальный загрузчик diff суммирует страницы GitLab без сетевых запросов',async()=>{
 const {plugin,task}=fixture();
 const api=new GitLab({});const pages=[];
 api.request=async path=>{pages.push(path);return new URLSearchParams(path.split('?')[1]).get('page')==='1'?Array.from({length:100},()=>({diff:'@@ -0,0 +1 @@\n+строка'})):[{diff:'@@ -0,0 +1 @@\n+++counter'}];};
 plugin.gitlabFactory=()=>api;
 const result=await plugin.call('mcu_chat_message',{taskId:task.id,kind:'uzs',testSeconds:5});
 assert.match(result.text,/√101,💀/);
 assert.deepEqual(pages,['/projects/team%2Fapp/merge_requests/10/diffs?per_page=100&page=1','/projects/team%2Fapp/merge_requests/10/diffs?per_page=100&page=2']);
});

test('резервный endpoint с overflow не выдаётся за полный нулевой diff',async()=>{
 const {plugin,task}=fixture();
 const api={list:async()=>{throw new Error('GitLab: HTTP 500');},project:()=>'/projects/1',request:async()=>({overflow:true,changes:[]})};
 plugin.gitlabFactory=()=>api;
 const result=await plugin.call('mcu_chat_message',{taskId:task.id,kind:'uzs',testSeconds:2});
 assert.match(result.text,/√\[добавлено строк\]/);
 assert.deepEqual(result.missingData,['addedLines']);
});
