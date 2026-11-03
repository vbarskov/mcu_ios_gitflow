import test from 'node:test';
import assert from 'node:assert/strict';
import { title, description } from '../lib/core/description.mjs';
import { GitLab } from '../lib/core/gitlab.mjs';
test('длинный заголовок отклоняется без потери исходного названия и итога', () => {
 const t={key:'VCSMOB-15559',title:'Исправить очень длинное название '.repeat(30),done:'Подробный итог '.repeat(40),changes:[],jiraUrl:'https://jira.test/1'};
 assert.throws(()=>title(t,'uzs'),/Сократите|255/);
 assert.ok(description(t,'uzs').includes(t.done));
 const short={...t,title:'Исправить гостевой вход',done:'Сохранён ввод пароля при ошибке гостевого входа'};
 assert.equal(title(short,'uzs',{iid:123}),'!123 #15559 💀 Исправить гостевой вход №1. Сохранён ввод пароля при ошибке гостевого входа');
});
test('ошибка GitLab сообщает причину без тела ответа и секретов', async t => {
 t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({message:{title:['is too long (maximum is 255 characters)']},token:'secret'}),{status:400}));
 const api=new GitLab({gitlabUrl:'https://git.test',token:'secret'});
 await assert.rejects(api.request('/projects/1/merge_requests','POST',{title:'Тест'}),e=>e.message.includes('255')&&!e.message.includes('secret'));
});
test('ошибка обязательного squash объясняет способ повторного слияния', async t => {
 t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({message:'This project requires squashing commits when merge requests are accepted. Try again.'}),{status:422}));
 const api=new GitLab({gitlabUrl:'https://git.test',token:'secret'});
 await assert.rejects(api.request('/projects/1/merge_requests/105/merge','PUT',{squash:false}),/требует squash-коммитов/);
});
test('слишком длинный заголовок отклоняется до отправки',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('Не должно вызываться');});
 await assert.rejects(new GitLab({token:'secret'}).request('/projects/1/merge_requests','POST',{title:'я'.repeat(256)}),/255/);
 assert.equal(calls,0);
});
