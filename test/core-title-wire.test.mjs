import test from 'node:test';
import assert from 'node:assert/strict';
import {GitLab} from '../lib/core/gitlab.mjs';
import {title} from '../lib/core/description.mjs';
const task={key:'APP-42',title:'Исправить выход',done:'Убран повторный сбой',targetBranch:'minor/20.2',uzsPartNumber:2};

test('Создание и повтор GitLab используют общий заголовок без дублирования номера MR',async()=>{
 const api=new GitLab({});const writes=[];let mr;
 api.squashSetting=async()=>undefined;api.find=async()=>mr;
 api.request=async(path,method,body)=>{if(path==='/user')return {id:7};writes.push({method,body});mr={iid:77,state:'opened',...body};return mr;};
 api.update=async(_t,iid,body)=>{writes.push({method:'PUT',body});mr={...mr,...body};return mr;};
 const first=await api.ensureMR(task,'feature/fix','не использовать этот старый шаблон','Описание','uzs');
 assert.equal(writes[0].body.title,'#42 🐥20.2 💀 Исправить выход №2. Убран повторный сбой');
 assert.equal(first.title,'!77 #42 🐥20.2 💀 Исправить выход №2. Убран повторный сбой');
 assert.equal(first.title,title({...task,uzs:first},'uzs',{preview:true}));
 await api.ensureMR({...task,uzs:first},'feature/fix',first.title,'Описание','uzs');
 assert.equal(writes.filter(w=>w.method==='POST').length,1);
 assert.equal(writes.at(-1).body.title,first.title);
});

test('Длинный заголовок отклоняется до запросов GitLab',async()=>{
 const api=new GitLab({});let calls=0;
 api.squashSetting=async()=>{calls++;};api.find=async()=>{calls++;};
 await assert.rejects(api.ensureMR({...task,done:'Исправлено '.repeat(40)},'feature/fix','старый','Описание','uzs'),/255|Сократите/);
 assert.equal(calls,0);
});

test('Обновление существующего MR допускает полный заголовок до 255 символов с реальным IID',async()=>{
 const long={...task,targetBranch:'release',title:'Исправить '+ 'я'.repeat(200)};
 const api=new GitLab({});
 api.squashSetting=async()=>undefined;api.find=async()=>({iid:7,state:'opened'});
 api.update=async(_t,iid,body)=>({iid,state:'opened',...body});
 const expected=title(long,'uzs',{iid:7});
 assert.ok([...expected].length<=255);
 assert.throws(()=>title(long,'uzs',{iid:0}),/255/);
 const mr=await api.ensureMR(long,'feature/fix','','Описание','uzs');
 assert.equal(mr.title,expected);
});
