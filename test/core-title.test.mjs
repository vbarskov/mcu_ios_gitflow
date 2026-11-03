import test from 'node:test';
import assert from 'node:assert/strict';
import {title,taskTitle,validateTitleFields} from '../lib/core/description.mjs';
const task={key:'VCSMOB-9999',title:'Что-то сделать',done:'Краткое описание',targetBranch:'release'};

test('УЗС и КЗС соответствуют порядку полей wiki',()=>{
 assert.equal(title(task,'uzs',{iid:9999}),'!9999 #9999 💀 Что-то сделать №1. Краткое описание');
 assert.equal(title({...task,uzsPartNumber:2,kzsPartNumber:3},'kzs',{iid:9999}),'!9999 #9999 Что-то сделать №3. Контроль');
 assert.equal(title({...task,kzsPartNumber:3,kzsTargetIsGzs:true,kzsBaseBranch:'feature/task-feature'},'kzs',{iid:9999}),'!9999 #9999 🐬 Что-то сделать №3. Контроль');
 assert.equal(title({...task,targetBranch:'minor/20.2',uzsPartNumber:2,done:'Дубль в минор'},'uzs',{iid:9999}),'!9999 #9999 🐥20.2 💀 Что-то сделать №2. Дубль в минор');
 assert.equal(title({...task,targetBranch:'minor/20.2',kzsBaseBranch:'release'},'kzs',{iid:9999}),'!9999 #9999 Что-то сделать №2. Контроль');
 assert.equal(title({...task,kzsTargetIsGzs:true,kzsBaseBranch:'release'},'kzs',{iid:9999}),'!9999 #9999 Что-то сделать №2. Контроль');
 assert.equal(title({...task,kzsTargetIsGzs:true,kzsBaseBranch:'release/26.0'},'kzs',{iid:9999}),'!9999 #9999 Что-то сделать №2. Контроль');
 assert.equal(title({...task,kzsBaseBranch:'minor/20.3',kzsTargetIsGzs:true,featureName:'Feature',reopened:true},'kzs',{iid:99}),'!99 #9999 🐥20.3 Feature Что-то сделать reopened №2. Контроль');
});

test('Неизвестный MR обозначается только в preview; привязанный MR использует реальный номер',()=>{
 assert.equal(title(task,'uzs'),'#9999 💀 Что-то сделать №1. Краткое описание');
 assert.equal(title(task,'uzs',{preview:true}),'!<номер> #9999 💀 Что-то сделать №1. Краткое описание');
 assert.equal(title({...task,uzs:{iid:44}},'uzs',{preview:true}),'!44 #9999 💀 Что-то сделать №1. Краткое описание');
 assert.equal(title({...task,uzs:{iid:44}},'uzs',{iid:0}),'#9999 💀 Что-то сделать №1. Краткое описание');
});

test('Оформление прежнего заголовка не дублируется, обычное слово контроль сохраняется',()=>{
 const name='Исправить открытие информации';
 const t={...task,title:`#VCSMOB-9999 ${name}. Контроль`};
 assert.equal(taskTitle(t),name);
 assert.equal(taskTitle({...t,title:`VCSMOB-9999: ${name} №2. Контроль`}),name);
 assert.equal(taskTitle({...t,title:`!44 #9999 🐥20.2 💀 ${name} reopened №1. Краткое описание`}),name);
 assert.equal(taskTitle({...t,title:'Добавить контроль'}),'Добавить контроль');
 assert.equal(taskTitle({...t,title:'Усилить контроль'}),'Усилить контроль');
 assert.equal(taskTitle({...t,title:'Контроль доступа к мероприятию'}),'Контроль доступа к мероприятию');
 assert.equal(taskTitle({...t,title:'Исправить VCSMOB-999 вместе с текущей задачей'}),'Исправить VCSMOB-999 вместе с текущей задачей');
});

test('Важные части длинного заголовка не обрезаются молча',()=>{
 assert.throws(()=>title({...task,title:'Исправить '+'название '.repeat(30)},'uzs'),/255|Сократите/);
 assert.throws(()=>title({...task,done:'Описание '.repeat(40)},'uzs'),/255|Сократите/);
 const maximum={...task,title:'Исправить '+ 'я'.repeat(187)};
 const short=title(maximum,'uzs',{iid:1});
 assert.ok([...short].length<=255);
 assert.throws(()=>title({...maximum,title:maximum.title+'я'.repeat(20)},'uzs'),/255|Сократите/);
});

test('Название и итог — русские однострочные данные, номера частей положительные',()=>{
 assert.doesNotThrow(()=>validateTitleFields({...task,title:'Исправить API iOS',done:'Убрана ошибка HTTP'}));
 for(const fields of [{title:'Fix bug'},{done:'Fixed bug'},{done:''},{done:'Исправлено\nпроверено'},{title:'Исправить\nошибку'}])assert.throws(()=>validateTitleFields({...task,...fields}),/русск|строк|Заполните/);
 assert.throws(()=>title({...task,uzsPartNumber:0},'uzs'),/номер части/);
 assert.throws(()=>title({...task,kzsPartNumber:1.5},'kzs'),/номер части/);
});
