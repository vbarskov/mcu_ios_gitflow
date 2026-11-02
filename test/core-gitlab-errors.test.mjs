import test from 'node:test';
import assert from 'node:assert/strict';
import { title, description } from '../lib/core/description.mjs';
import { GitLab } from '../lib/core/gitlab.mjs';
test('длинный заголовок сокращается; полный итог остаётся в описании', () => {
 const t={key:'VCSMOB-15559',title:'Очень длинное название '.repeat(30),done:'Подробный итог '.repeat(40),changes:[],jiraUrl:'https://jira.test/1'};
 const value=title(t,'uzs');
 assert.ok([...value].length<=240);assert.match(value,/#15559 💀/);assert.match(value,/№1$/);
 assert.ok(!value.includes(t.done));
 assert.equal(title({...t,done:'Сохранён ввод пароля при ошибке гостевого входа'},'uzs'),value);
 assert.ok(description(t,'uzs').includes(t.done));
 assert.ok([...`!123456789 ${value}`].length<=255);
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
