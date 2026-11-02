import test from 'node:test';
import assert from 'node:assert/strict';
import { Jira, issueKey, documentText } from '../lib/core/jira.mjs';

test('ссылка Jira: номер, контекстный путь, чужой сервер и список задач',()=>{
  assert.equal(issueKey('https://jira.iva.ru/browse/VCSMOB-15564?src=test','https://jira.iva.ru'),'VCSMOB-15564');
  assert.equal(issueKey('VCSMOB-15564','https://jira.iva.ru'),'VCSMOB-15564');
  assert.equal(issueKey('https://jira.iva.ru/jira/browse/VCSMOB-1','https://jira.iva.ru/jira'),'VCSMOB-1');
  assert.throws(()=>issueKey('https://evil.test/browse/VCSMOB-1','https://jira.iva.ru'),/другому серверу/);
  assert.throws(()=>issueKey('https://jira.iva.ru/issues/?jql=test','https://jira.iva.ru'),/одну задачу/);
  assert.throws(()=>issueKey('https://jira.iva.ru/other/browse/VCSMOB-1','https://jira.iva.ru/jira'),/настроенному адресу/);
});
test('исходное описание сохраняется текстом, без исполнения разметки',()=>{
  assert.equal(documentText('*шаги*\nВеб сменить сервер'),'*шаги*\nВеб сменить сервер');
  assert.equal(documentText({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Шаг 1'}]}]}),'Шаг 1\n');
  assert.equal(documentText(null),'');
});
test('Jira выбирает только завершающие переходы и отправляет комментарий с переходом',async()=>{
 const jira=new Jira({jiraBaseUrl:'https://jira.test',jiraToken:'secret'}),calls=[];
 jira.request=async(path,method='GET',body)=>{calls.push({path,method,body});if(path.includes('transitions?'))return {transitions:[{id:'1',name:'В работу',to:{name:'В работе',statusCategory:{key:'indeterminate'}}},{id:'2',name:'Выполнено',to:{name:'Done',statusCategory:{key:'done'}}}]};if(path.endsWith('/comment'))return {id:'44'};return null;};
 assert.deepEqual(await jira.completionCandidates('VCSMOB-1'),[{id:'2',name:'Выполнено',status:'Done'}]);
 assert.equal((await jira.addComment('VCSMOB-1','КЗС: link')).id,'44');await jira.transition('VCSMOB-1','2');
 assert.deepEqual(calls.slice(1),[{path:'/issue/VCSMOB-1/comment',method:'POST',body:{body:'КЗС: link'}},{path:'/issue/VCSMOB-1/transitions',method:'POST',body:{transition:{id:'2'}}}]);
});
test('Jira распознаёт уже завершённую задачу',async()=>{
 const jira=new Jira({jiraBaseUrl:'https://jira.test',jiraToken:'secret'});jira.request=async path=>path.includes('?fields=status')?{fields:{status:{name:'Done',statusCategory:{key:'done'}}}}:{transitions:[]};
 assert.deepEqual(await jira.completionState('VCSMOB-1'),{transitions:[],status:'Done',completed:true});
});
test('Jira предлагает все переходы нестандартного workflow, если завершение не размечено',async()=>{
 const jira=new Jira({jiraBaseUrl:'https://jira.test',jiraToken:'secret'});jira.request=async()=>({transitions:[{id:'7',name:'Передать дальше',to:{name:'К завершению'}}]});
 assert.deepEqual(await jira.completionCandidates('VCSMOB-1'),[{id:'7',name:'Передать дальше',status:'К завершению'}]);
});
test('импорт Jira и проверка доступа: только GET, нужные поля, ошибки и Bearer', async () => {
  let mode = 'ok', requests = 0;
  const base = 'https://jira.example.test';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests++;
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer test-jira-secret');
    assert.equal(options.redirect, 'error');
    if (mode === 'redirect') throw new TypeError('redirect');
    if (mode === '401') return new Response('{"error":"test-jira-secret"}', { status: 401 });
    if (url === `${base}/rest/api/2/myself`) return Response.json({ name: 'v.barskov', displayName: 'Барсков Виктор' });
    assert.match(url, /\/issue\/VCSMOB-15564\?fields=/);
    return Response.json({ key: 'VCSMOB-15564', fields: {
      summary: '[IOS] Выход из мероприятия', description: 'МК в мероприятии\nВеб меняет сервер', status: { name: 'In Progress' },
      assignee: { displayName: 'Виктор' }, fixVersions: [{ name: 'ios_26.0' }],
      attachment: [{ filename: 'before.mp4', content: `${base}/secure/attachment/1/before.mp4`, mimeType: 'video/mp4', size: 200 },
        { filename: 'bad', content: 'javascript:alert(1)' }],
    } });
  };
  const jira = new Jira({ jiraBaseUrl: base, jiraToken: 'test-jira-secret' });
  try {
    assert.equal((await jira.me()).username, 'v.barskov');
    const data = await jira.import(`${base}/browse/VCSMOB-15564`);
    assert.equal(data.key, 'VCSMOB-15564'); assert.equal(data.attachments.length, 1); assert.match(data.beforeUrl, /before.mp4$/);
    assert.equal(data.sourceBranch, 'feature/VCSMOB-15564'); assert.equal(data.result, undefined); assert.equal(data.done, undefined); assert.equal(data.changes, undefined);
    assert.match(data.issueDescription, /Веб меняет сервер/);
    await assert.rejects(() => jira.import('https://evil.test/browse/VCSMOB-15564'), /другому серверу/); assert.equal(requests, 2);
    mode = '401'; await assert.rejects(() => jira.me(), error => error.message.includes('Токен недействителен') && !error.message.includes('test-jira-secret'));
    mode = 'redirect'; await assert.rejects(() => jira.me(), /Не удалось подключиться/);
    await assert.rejects(() => new Jira({ jiraBaseUrl: base }).me(), /Добавьте токен Jira/);
  } finally { globalThis.fetch = originalFetch; }
});
