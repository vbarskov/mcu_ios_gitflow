import test from 'node:test';
import assert from 'node:assert/strict';
import {Plugin} from '../lib/plugin.mjs';
import {chatMessage} from '../lib/chat-message.mjs';
import {GitLab} from '../lib/core/gitlab.mjs';
import {tools,validateArguments} from '../lib/tools.mjs';
import * as gzs from '../lib/gzs.mjs';

const parent=()=>({iid:319,project_id:42,source_project_id:42,target_project_id:42,title:'!319 #15815 #15835 #15836 #15838 🐬 Добавить настройки мероприятий. Гигант',web_url:'https://git.example.test/319',source_branch:'feature/parent',target_branch:'release',state:'opened',sha:'parent-sha',description:''});
const additions=(count,line='let value = 1')=>`@@ -0,0 +1,${count} @@\n${Array.from({length:count},()=>`+${line}`).join('\n')}`;
const child=()=>({id:'task-1',key:'APP-999',title:'Исправить детскую ошибку',done:'Детская ошибка исправлена',targetBranch:'minor/child',kzsBaseBranch:'feature/child',kzsTargetIsGzs:false,afterUrl:'https://video.example.test/child.mp4',assets:[{kind:'after',remote:{url:'/uploads/child.mov'}}],demo:'Демонстрация дочерней задачи',verification:'тест занял 999 секунд',gitlabUrl:'https://git.example.test',project:'team/app',repoPath:'/unused/repo',jiraBaseUrl:'https://jira.example.test',previews:{uzs:'keep'},job:{state:'failed',error:'keep'},events:[]});

function fixture({task:fields={},mr=parent(),diffs=[{new_path:'App/Main.swift',diff:additions(1)}],projectId=42}={}) {
  const task={...child(),...fields},reads=[];let writes=0;
  const store={get:id=>id===task.id?task:null,save(){writes++;throw new Error('Сообщение не должно сохранять карточку.');},event(){writes++;throw new Error('Сообщение не должно создавать событие.');},close(){}};
  const config={dir:'/unused/no-lock',get:()=>({gitlabUrl:task.gitlabUrl,project:task.project,repoPath:task.repoPath,jiraBaseUrl:task.jiraBaseUrl})};
  const api={
    project:t=>`/projects/${encodeURIComponent(t.project)}`,
    request:async(path,method='GET')=>{assert.equal(method,'GET');reads.push(path);assert.equal(path,'/projects/team%2Fapp');return {id:projectId};},
    mr:async(_task,iid)=>{reads.push(`mr:${iid}`);return structuredClone(mr);},
    list:async(_task,path)=>{reads.push(path);if(diffs instanceof Error)throw diffs;return structuredClone(diffs);},
  };
  const plugin=new Plugin({config,store,gitlabFactory:()=>api,flowFactory:()=>{throw new Error('Git Flow не должен запускаться для сообщения.');}});
  return {plugin,task,reads,counters:()=>({writes}),api};
}

test('только mcu_chat_message принимает kind:gzs и остаётся чтением',()=>{
  const item=validateArguments('mcu_chat_message',{taskId:'task-1',kind:'gzs',iid:319});
  assert.equal(item.annotations.readOnlyHint,true);assert.equal(item.annotations.destructiveHint,false);
  for(const [name,args] of [['mcu_preview',{}],['mcu_publish',{previewToken:'x'}],['mcu_publish_description',{previewToken:'x'}],['mcu_attach',{iid:319}]])assert.throws(()=>validateArguments(name,{taskId:'task-1',kind:'gzs',...args}),/kind/);
  assert.equal(tools.filter(tool=>tool.inputSchema.properties.kind?.enum?.includes('gzs')).length,1);
});

test('сообщение ГЗС использует собственное действие, URL, release и дельфина в третьей строке',async()=>{
  const task={...child(),gzs:{...parent(),title:'Draft: WIP: !319 #15815 #15835 APP-7 #APP-8 🐥20.2 🐬Добавить настройки мероприятий. Гигант',description:'![Стало](/uploads/parent.mp4)'}};
  const before=structuredClone(task);const visited=[];
  const result=await chatMessage(task,{kind:'gzs',testSeconds:276},async mr=>{visited.push(mr.iid);return [{new_path:'App/Main.swift',diff:additions(2)}];});
  assert.equal(result.text,'Сливаю ГЗС: Добавить настройки мероприятий\nhttps://git.example.test/319\n√2, 🐬, release >= 2, тест (276 сек), демо');
  assert.deepEqual(result.missingData,[]);assert.deepEqual(result.lineCounts,{total:2,technical:0,ordinary:2});assert.deepEqual(visited,[319]);assert.deepEqual(task,before);
});

test('неподходящее собственное имя ГЗС не заменяется названием дочерней задачи',async()=>{
  const task={...child(),gzs:{...parent(),title:'!319 #15815 🐬 Настройки добавлены. Гигант'}};
  const result=await chatMessage(task,{kind:'gzs'},async()=>[]);
  assert.match(result.text,/^Сливаю ГЗС: \[название ГЗС\]\n/);assert.ok(result.missingData.includes('title'));
  assert.doesNotMatch(result.text,/детск|999 секунд|minor\/child|feature\/child/);
});

test('очистка имени ГЗС удаляет только финальное «. Гигант» и не сокращает длинное действие',async()=>{
  const name='Добавить Гигант в описание '+ 'длинного названия '.repeat(35).trim();
  const task={...child(),gzs:{...parent(),title:`!319 #15815 #15835 🐬 ${name}. Гигант`}};
  const result=await chatMessage(task,{kind:'gzs',testSeconds:1},async()=>[]);
  assert.equal(result.text.split('\n')[0],`Сливаю ГЗС: ${name}`);
});

for(const [label,description,suffix,unknown] of [
  ['пустое тело','',', без демо',false],
  ['null',null,', без демо',false],
  ['неизвестное тело',undefined,', демо [не указано]',true],
  ['только Было','![Было](/uploads/before.mp4)',', без демо',false],
  ['только код','![Код](/uploads/code.png)',', без демо',false],
  ['картинка внутри кода','```md\n![Стало](/uploads/quoted.mp4)\n```',', без демо',false],
  ['незакрытый блок кода','```md\n![Стало](/uploads/quoted.mp4)',', без демо',false],
  ['собственное Стало','![Стало](https://video.example.test/parent.mp4)',', демо',false],
])test(`демонстрация ГЗС независима от детских медиа: ${label}`,async()=>{
  const task={...child(),gzs:{...parent(),description}};
  const result=await chatMessage(task,{kind:'gzs',testSeconds:1},async()=>[]);
  assert.ok(result.text.endsWith(suffix),result.text);assert.equal(result.missingData.includes('demo'),unknown);
});

for(const [label,description,hasDemo] of [
  ['подпись Демо','![Демо](/uploads/result.mov)',true],
  ['подпись Демонстрация','![Демонстрация](/uploads/result.png)',true],
  ['подпись Результат','![Результат](https://video.example.test/result.webm)',true],
  ['видео в разделе','## Демонстрация\n![Запись](/uploads/result.mp4)',true],
  ['фото в подразделе','## Демонстрация\n### Устройство\n![Фото](/uploads/result.jpg)',true],
  ['ссылка на фото в разделе','## Демонстрация\n[Открыть фото](/uploads/result.jpeg)',true],
  ['обычная video ссылка','[Открыть запись](https://video.example.test/result.webm?download=1)',true],
  ['обычная mov ссылка','[Запись](/uploads/result.mov)',true],
  ['явно Было в demo разделе','## Демонстрация\n![Было](/uploads/before.mp4)',false],
  ['явно Код в demo разделе','## Демонстрация\n![Код](/uploads/code.png)',false],
  ['ссылка с подписью Код','[Код](/uploads/code.mov)',false],
  ['видео в Было','## Было\n[Запись](/uploads/before.mp4)',false],
  ['Стало внутри Было','## Было\n![Стало](/uploads/example.mp4)',false],
  ['видео в подразделе кода','## Код\n### Запись\n[Видео](/uploads/code.mp4)',false],
  ['следующий раздел Код','## Демонстрация\nТекст\n## Код\n![Стало](/uploads/code.png)',false],
  ['соседний раздел после Было','## Было\nТекст\n## Демонстрация\n[Видео](/uploads/result.mp4)',true],
  ['HTML комментарий','<!-- ![Стало](/uploads/example.mp4) -->',false],
  ['незакрытый HTML комментарий','<!-- ![Стало](/uploads/example.mp4)',false],
  ['inline code','Пример: `![Стало](/uploads/example.mp4)`',false],
  ['inline code с двойными кавычками','``![Стало](/uploads/example.mp4)``',false],
  ['неоднозначный снимок','![Снимок](/uploads/screenshot.png)',null],
  ['неоднозначная ссылка на фото','[Фото](/uploads/screenshot.png)',null],
  ['неразобранный HTML video','<video src="/uploads/result.mp4"></video>',null],
  ['только заголовок раздела','## Демонстрация\nМатериал не приложен.',false],
])test(`собственный материал ГЗС распознаётся осторожно: ${label}`,async()=>{
  const result=await chatMessage({...child(),gzs:{...parent(),description}},{kind:'gzs',testSeconds:1},async()=>[]);
  const suffix=hasDemo===true?', демо':hasDemo===false?', без демо':', демо [не указано]';
  assert.ok(result.text.endsWith(suffix),result.text);assert.equal(result.missingData.includes('demo'),hasDemo===null);
});

for(const [label,description] of [
  ['fenced HTML-код','```html\n<!--\n```\n![Стало](/uploads/result.mp4)'],
  ['inline HTML-код','Пример: `<!--`\n![Демо](/uploads/result.mov)'],
])test(`HTML-пример в коде не скрывает настоящее демо ГЗС: ${label}`,async()=>{
  const result=await chatMessage({...child(),gzs:{...parent(),description}},{kind:'gzs',testSeconds:1},async()=>[]);
  assert.ok(result.text.endsWith(', демо'),result.text);assert.ok(!result.missingData.includes('demo'));
});

for(const total of [500,501])test(`ГЗС считает собственный полный diff и техническую часть при ${total} строках`,async()=>{
  const diffs=[{new_path:'App/Main.swift',diff:additions(300)},{new_path:'Generated/Model.Generated.swift',generated_file:true,diff:additions(100)},{new_path:'Tests/Unit/ModelTests.swift',diff:additions(total-400)}];
  const result=await chatMessage({...child(),gzs:parent()},{kind:'gzs',testSeconds:2},async()=>diffs);
  assert.deepEqual(result.lineCounts,{total,technical:total-300,ordinary:300});
  assert.match(result.text,total===500?/√500, 🐬, release >= 2/:/√501 \(т\. 201\), 🐬, release >= 2/);
});

test('неполный или недоступный diff ГЗС остаётся неизвестным, а время не берётся из детского отчёта',async()=>{
  for(const loader of [async()=>[{too_large:true,diff:''}],async()=>{throw new Error('Недоступно.');}]) {
    const result=await chatMessage({...child(),gzs:parent()},{kind:'gzs'},loader);
    assert.match(result.text,/√\[добавлено строк\], 🐬, release >= 2, тест \(\[длительность\] сек\), без демо/);
    assert.deepEqual(new Set(result.missingData),new Set(['addedLines','testSeconds']));assert.equal(result.lineCounts.total,null);
  }
});

test('без собственного URL и назначения ГЗС не использует дочерние поля',async()=>{
  const result=await chatMessage({...child(),gzs:{...parent(),web_url:undefined,target_branch:undefined}},{kind:'gzs',testSeconds:1},async()=>[]);
  assert.match(result.text,/\n\[ссылка на ГЗС\]\n√0, 🐬, \[ветка\] >= 2/);
  assert.deepEqual(new Set(result.missingData),new Set(['url','targetBranch']));
});

test('чистый formatter без номера ГЗС спрашивает номер до diff',async()=>{
  let reads=0;const result=await chatMessage(child(),{kind:'gzs'},async()=>{reads++;return [];});
  assert.equal(result.text,null);assert.equal(result.needsInput,true);assert.deepEqual(result.missingData,['iid']);assert.match(result.question,/Укажите номер или ссылку ГЗС/);assert.equal(reads,0);
});

test('прямой iid ГЗС работает без binding и без совпадения назначения ребёнка, не меняя состояние',async()=>{
  const {plugin,task,reads,counters}=fixture();const before=structuredClone(task);
  const result=await plugin.call('mcu_chat_message',{taskId:task.id,kind:'gzs',iid:319,testSeconds:45});
  assert.equal(result.text,'Сливаю ГЗС: Добавить настройки мероприятий\nhttps://git.example.test/319\n√1, 🐬, release >= 2, тест (45 сек), без демо');
  assert.deepEqual(task,before);assert.deepEqual(counters(),{writes:0});
  assert.deepEqual(reads,['/projects/team%2Fapp','mr:319','/merge_requests/319/diffs']);
});

test('сохранённый iid используется лишь для свежего чтения родителя без записи snapshot',async()=>{
  const cached={...parent(),title:'Старое имя',target_branch:'old',description:'![Стало](/uploads/stale.mp4)'};
  const {plugin,task,reads,counters}=fixture({task:{gzs:cached}});const before=structuredClone(task);
  const result=await plugin.call('mcu_chat_message',{taskId:task.id,kind:'gzs',testSeconds:3});
  assert.match(result.text,/Добавить настройки мероприятий/);assert.match(result.text,/release >= 2, тест \(3 сек\), без демо$/);
  assert.equal(result.needsInput,undefined);assert.deepEqual(task,before);assert.deepEqual(counters(),{writes:0});assert.ok(reads.includes('mr:319'));
});

test('явный iid имеет приоритет над binding без сохранения новой связи',async()=>{
  const {plugin,task,reads}=fixture({task:{gzs:parent()},mr:{...parent(),iid:400,web_url:'https://git.example.test/400'}});const before=structuredClone(task);
  const result=await plugin.call('mcu_chat_message',{taskId:task.id,kind:'gzs',iid:400,testSeconds:1});
  assert.match(result.text,/\nhttps:\/\/git.example.test\/400\n/);assert.ok(reads.includes('mr:400'));assert.ok(!reads.includes('mr:319'));assert.deepEqual(task,before);
});

test('MCP без номера ГЗС задаёт вопрос без API, блокировки, jobs и записи',async()=>{
  const {plugin,task,reads,counters}=fixture();const before=structuredClone(task);
  const result=await plugin.call('mcu_chat_message',{taskId:task.id,kind:'gzs'});
  assert.equal(result.needsInput,true);assert.equal(result.text,null);assert.deepEqual(result.missingData,['iid']);
  assert.deepEqual(result.lineCounts,{total:null,technical:null,ordinary:null});assert.deepEqual(reads,[]);assert.deepEqual(counters(),{writes:0});assert.deepEqual(task,before);
});

for(const [label,override,projectId,pattern] of [
  ['другой IID',{iid:500},42,/номер/],['fork',{source_project_id:99},42,/проект/],['другой project_id',{project_id:99},42,/проект/],['неизвестный проект',{},undefined,/проект/],['нет Гигант',{title:'Добавить фичу'},42,/Гигант/],['закрытый MR',{state:'closed'},42,/открыт|слит/],
])test(`MCP проверяет идентичность ГЗС до diff: ${label}`,async()=>{
  const {plugin,task,reads,counters}=fixture({mr:{...parent(),...override},projectId:projectId===undefined?null:projectId});const before=structuredClone(task);
  await assert.rejects(plugin.call('mcu_chat_message',{taskId:task.id,kind:'gzs',iid:319}),pattern);
  assert.ok(!reads.some(path=>path.includes('/diffs')));assert.deepEqual(counters(),{writes:0});assert.deepEqual(task,before);
});

test('общая metadata-валидация ГЗС не привязана к ветке или Jira дочерней задачи',()=>{
  assert.equal(typeof gzs.gzsMetadata,'function');
  const result=gzs.gzsMetadata(parent(),319,42);
  assert.deepEqual(result.jiraNumbers,['15815','15835','15836','15838']);assert.equal(result.title,parent().title);
  assert.equal(result.description,undefined);assert.equal(result.primaryJiraKey,undefined);
});

test('MCP читает все страницы diff именно ГЗС через общий GitLab загрузчик',async()=>{
  const {plugin,task}=fixture();const api=new GitLab({}),reads=[];
  api.request=async(path,method='GET')=>{
    assert.equal(method,'GET');reads.push(path);
    if(path==='/projects/team%2Fapp')return {id:42};
    if(path==='/projects/team%2Fapp/merge_requests/319')return parent();
    return new URLSearchParams(path.split('?')[1]).get('page')==='1'?Array.from({length:100},()=>({new_path:'App/Main.swift',diff:additions(1)})):[{new_path:'Tests/Unit/ExampleTests.swift',diff:additions(1)}];
  };plugin.gitlabFactory=()=>api;
  const result=await plugin.call('mcu_chat_message',{taskId:task.id,kind:'gzs',iid:319,testSeconds:1});
  assert.deepEqual(result.lineCounts,{total:101,technical:1,ordinary:100});
  assert.deepEqual(reads,['/projects/team%2Fapp','/projects/team%2Fapp/merge_requests/319','/projects/team%2Fapp/merge_requests/319/diffs?per_page=100&page=1','/projects/team%2Fapp/merge_requests/319/diffs?per_page=100&page=2']);
});
