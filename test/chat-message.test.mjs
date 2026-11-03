import test from 'node:test';
import assert from 'node:assert/strict';
import {Plugin} from '../lib/plugin.mjs';
import {tools,validateArguments} from '../lib/tools.mjs';
import {GitLab} from '../lib/core/gitlab.mjs';

function fixture(overrides={},list=async()=>[{new_path:'App/Main.swift',diff:'@@ -1,2 +1,3 @@\n-old\n+first\n+second\n context'}]) {
 const task={id:'task-1',key:'APP-1',title:'Исправить загрузку файла',done:'Исправлена загрузка файла',targetBranch:'release',gitlabUrl:'https://git.example.test',project:'team/app',repoPath:'/unused/repo',jiraBaseUrl:'https://jira.example.test',uzs:{iid:10,web_url:'https://git.example.test/10',target_branch:'minor/20.2',title:'!10 #1 🐥20.2 💀 Доработать загрузку файла №3. Исправлена загрузка',description:'Было сделано:\nИсправлено открытие большого файла. Сохранён выбранный путь.\n\n- Main: исправление'},assets:[],previews:{uzs:'keep-token'},job:{state:'failed',error:'keep-error'},...overrides};
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
 assert.equal(result.text,'Сливаю УЗС-3: Доработать загрузку файла\nhttps://git.example.test/10\n√2, 💀🐥, minor/20.2, >=2, тест (42 сек)');
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

test('название из MR имеет приоритет над описанием, итогом и карточкой; метаданные убраны',async()=>{
 const {plugin,task}=fixture({featureName:'Мероприятия',title:'Исправить старое название',uzsPartNumber:1,uzs:{iid:10,web_url:'https://git.example.test/10',title:'!10 #1 🐥20.2 💀 Мероприятия Доработать планирование комнат reopened №4. Сохранены параметры',description:'Было сделано:\nСохранены параметры комнаты.'},done:'Завершены доработки',result:'Настройки сохраняются'});
 const result=await plugin.call('mcu_chat_message',{taskId:task.id,kind:'uzs'});
 assert.match(result.text,/^Сливаю УЗС-4: Доработать планирование комнат\n/);
 assert.ok(!result.text.includes('Сохранены параметры'));
});

test('неподходящее название MR заменяется только действием из карточки без сочинения итога',async()=>{
 const {plugin,task}=fixture({uzsPartNumber:7,uzs:{iid:10,web_url:'https://git.example.test/10',title:'Исправлено поведение'},title:'Добавить контроль'});
 assert.match((await plugin.call('mcu_chat_message',{taskId:task.id,kind:'uzs'})).text,/^Сливаю УЗС-7: Добавить контроль\n/);
 task.title='Исправление поведения';
 const missing=await plugin.call('mcu_chat_message',{taskId:task.id,kind:'uzs'});
 assert.match(missing.text,/^Сливаю УЗС-7: \[название УЗС\]\n/);
 assert.ok(missing.missingData.includes('title'));
});

test('дополнительный УЗС выбирается по связанному iid, неизвестный iid не читается из API',async()=>{
 const extra={iid:11,web_url:'https://git.example.test/11',target_branch:'release/26',title:'!11 #1 💀 Убрать повторный сбой №6. Исправлен повторный сбой',description:'Исправлен повторный сбой открывания.'};
 const {plugin,task,counters}=fixture({additionalUzs:[extra]});
 const result=await plugin.call('mcu_chat_message',{taskId:task.id,kind:'uzs',iid:11,testSeconds:15});
 assert.match(result.text,/^Сливаю УЗС-6: Убрать повторный сбой\n/);
 assert.match(result.text,/\nhttps:\/\/git.example.test\/11\n√2, 💀, release\/26/);
 await assert.rejects(plugin.call('mcu_chat_message',{taskId:task.id,kind:'uzs',iid:999}),/не привязан|не связан/);
 assert.equal(counters().apiReads,1);
});

test('КЗС использует собственный diff; пустой diff даёт достоверный ноль, демо только по факту',async()=>{
 const visited=[];
 const {plugin,task}=fixture({kzs:{iid:20,web_url:'https://git.example.test/20',target_branch:'release'}},async(_task,path)=>{visited.push(path);return [];});
 const result=await plugin.call('mcu_chat_message',{taskId:task.id,kind:'kzs'});
 assert.equal(result.text,'КЗС https://git.example.test/20\n√0, release >= 2, без демо');
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
 assert.equal(result.text,'Сливаю УЗС-1: [название УЗС]\n[ссылка на УЗС]\n√[добавлено строк], 💀, [ветка], >=2, тест ([длительность] сек)');
 assert.deepEqual(new Set(result.missingData),new Set(['title','url','addedLines','targetBranch','testSeconds']));
 assert.deepEqual(counters(),{writes:0,apiReads:0});
});


test('реальный загрузчик diff суммирует страницы GitLab без сетевых запросов',async()=>{
 const {plugin,task}=fixture();
 const api=new GitLab({});const pages=[];
 api.request=async path=>{pages.push(path);return new URLSearchParams(path.split('?')[1]).get('page')==='1'?Array.from({length:100},()=>({diff:'@@ -0,0 +1 @@\n+строка'})):[{diff:'@@ -0,0 +1 @@\n+++counter'}];};
 plugin.gitlabFactory=()=>api;
 const result=await plugin.call('mcu_chat_message',{taskId:task.id,kind:'uzs',testSeconds:5});
 assert.match(result.text,/√101, 💀🐥/);
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


test('длинное название MR не сокращается, отсутствующая часть дополнительного УЗС берётся по позиции',async()=>{
 const name='Доработать '+ 'планирование '.repeat(15).trim();
 const {plugin,task}=fixture({additionalUzs:[{iid:11,web_url:'https://git.example.test/11',title:name}],uzsPartNumber:9});
 const result=await plugin.call('mcu_chat_message',{taskId:task.id,kind:'uzs',iid:11});
 assert.equal(result.text.split('\n')[0],`Сливаю УЗС-2: ${name}`);
});

test('техническое подмножество показывается строго после 500 строк',async()=>{
 for(const total of [500,501]) {
  const rows=Array.from({length:total},(_,i)=>i<100?'+// комментарий':'+let value = 1').join('\n');
  const {plugin,task}=fixture({},async()=>[{new_path:'Main.swift',diff:'@@ -0,0 +1 @@\n'+rows}]);
  const result=await plugin.call('mcu_chat_message',{taskId:task.id,kind:'uzs'});
  assert.deepEqual(result.lineCounts,{total,technical:100,ordinary:total-100});
  assert.equal(result.text.includes('(т. 100)'),total>500);
 }
});

test('при известном общем размере и отсутствии путей техническое число не выдумывается',async()=>{
 const {plugin,task}=fixture({},async()=>[{diff:'@@ -0,0 +1 @@\n'+'+строка\n'.repeat(501)}]);
 const result=await plugin.call('mcu_chat_message',{taskId:task.id,kind:'uzs'});
 assert.match(result.text,/√501 \(т\. \[технических строк\]\)/);
 assert.deepEqual(result.lineCounts,{total:501,technical:null,ordinary:null});
 assert.ok(result.missingData.includes('technicalLines'));
});

test('форматы КЗС release и явного ГЗС соответствуют назначению, демо только фактическое',async()=>{
 const {plugin,task}=fixture({kzsTargetIsGzs:true,kzs:{iid:20,web_url:'https://git.example.test/20',target_branch:'feature/planning'},afterUrl:'https://git.example.test/demo.mp4'},async()=>[]);
 assert.equal((await plugin.call('mcu_chat_message',{taskId:task.id,kind:'kzs',testSeconds:276})).text,'🐬 КЗС в feature/planning: https://git.example.test/20\n√0, 🐬, feature/planning >= 2, тест (276 сек), демо');
 task.kzs.target_branch='release/26';
 assert.equal((await plugin.call('mcu_chat_message',{taskId:task.id,kind:'kzs'})).text,'КЗС https://git.example.test/20\n√0, release/26 >= 2, демо');
 task.kzs.target_branch='minor/20.2';task.afterUrl='';
 assert.equal((await plugin.call('mcu_chat_message',{taskId:task.id,kind:'kzs'})).text,'КЗС https://git.example.test/20\n√0, minor/20.2 >= 2, без демо');
 task.kzs.target_branch='custom/group';task.kzsTargetIsGzs=false;
 assert.ok(!(await plugin.call('mcu_chat_message',{taskId:task.id,kind:'kzs'})).text.includes('🐬'));
});

test('название из Wiki распознаётся и при маркере вплотную к инфинитиву',async()=>{
 const {plugin,task}=fixture({title:'Исправить старую задачу',uzs:{iid:10,web_url:'https://git.example.test/10',title:'!10 #1 🐥20.2 💀Доработать импорт комнат №2. Дубль в минор'}});
 assert.match((await plugin.call('mcu_chat_message',{taskId:task.id,kind:'uzs'})).text,/^Сливаю УЗС-2: Доработать импорт комнат\n/);
});

test('КЗС явно сообщает об отсутствии демо; код и пояснение не заменяют результат',async()=>{
 const {plugin,task}=fixture({kzs:{iid:20,web_url:'https://git.example.test/20',target_branch:'release'},demo:'Пояснение демонстрации',assets:[{kind:'code',remote:{url:'/uploads/code.png'}}]},async()=>[]);
 assert.equal((await plugin.call('mcu_chat_message',{taskId:task.id,kind:'kzs'})).text,'КЗС https://git.example.test/20\n√0, release >= 2, без демо');
 task.assets.push({kind:'after',remote:{url:'/uploads/result.mp4'}});
 assert.match((await plugin.call('mcu_chat_message',{taskId:task.id,kind:'kzs'})).text,/, демо$/);
});

test('привязанный КЗС сохраняет дельфина из служебного префикса MR при отсутствующем флаге',async()=>{
 const {plugin,task}=fixture({kzs:{iid:20,web_url:'https://git.example.test/20',target_branch:'feature/planning/giant',title:'!20 #1 🐬 Доработать планирование №2. Контроль'}},async()=>[]);
 const result=await plugin.call('mcu_chat_message',{taskId:task.id,kind:'kzs',testSeconds:20});
 assert.equal(result.text,'🐬 КЗС в feature/planning/giant: https://git.example.test/20\n√0, 🐬, feature/planning/giant >= 2, тест (20 сек), без демо');
 task.kzs.title='!20 #1 [🐬] Доработать планирование №2. Контроль';
 assert.match((await plugin.call('mcu_chat_message',{taskId:task.id,kind:'kzs'})).text,/^🐬 КЗС/);
 task.kzsTargetIsGzs=false;
 assert.doesNotMatch((await plugin.call('mcu_chat_message',{taskId:task.id,kind:'kzs'})).text,/🐬/);
 delete task.kzsTargetIsGzs;task.kzs.target_branch='release';
 assert.doesNotMatch((await plugin.call('mcu_chat_message',{taskId:task.id,kind:'kzs'})).text,/🐬/);
 task.kzs.target_branch='feature/planning/giant';task.kzs.title='!20 #1 Доработать планирование 🐬 №2. Контроль';
 assert.doesNotMatch((await plugin.call('mcu_chat_message',{taskId:task.id,kind:'kzs'})).text,/🐬/);
});

test('демо Стало в описании привязанного КЗС подтверждает наличие; пустой раздел и код — нет',async()=>{
 const {plugin,task}=fixture({kzs:{iid:20,web_url:'https://git.example.test/20',target_branch:'release',description:'## Демонстрация\n\n![Стало](/uploads/result.mp4){width=250}'}},async()=>[]);
 assert.match((await plugin.call('mcu_chat_message',{taskId:task.id,kind:'kzs'})).text,/, демо$/);
 task.kzs.description='## Демонстрация\n\n![Код](/uploads/code.png)';
 assert.match((await plugin.call('mcu_chat_message',{taskId:task.id,kind:'kzs'})).text,/, без демо$/);
 task.kzs.description='## Демонстрация\n\n```text\n![Стало](/uploads/example.mp4)\n```';
 assert.match((await plugin.call('mcu_chat_message',{taskId:task.id,kind:'kzs'})).text,/, без демо$/);
});

test('неизвестное состояние демо отмечается пропуском, подтверждённое исключение означает без демо',async()=>{
 const {plugin,task}=fixture({assets:undefined,kzs:{iid:20,web_url:'https://git.example.test/20',target_branch:'release'}},async()=>[]);
 const result=await plugin.call('mcu_chat_message',{taskId:task.id,kind:'kzs'});
 assert.match(result.text,/, демо \[не указано\]$/);assert.ok(result.missingData.includes('demo'));
 task.kzsWithoutDemoConfirmed=true;
 assert.match((await plugin.call('mcu_chat_message',{taskId:task.id,kind:'kzs'})).text,/, без демо$/);
});
