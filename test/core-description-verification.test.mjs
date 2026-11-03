import test from 'node:test';
import assert from 'node:assert/strict';
import {description,title,updateIncludedUzs} from '../lib/core/description.mjs';

test('описание КЗС начинается со списка УЗС; заголовок остаётся отдельным полем MR',()=>{
 const task={key:'VCSMOB-15839',title:'Доработать планирование',done:'Исправлено расписание',result:'Сохраняется расписание',jiraUrl:'https://jira.test/VCSMOB-15839',uzs:{iid:361},kzs:{iid:362},changes:[{module:'M5P',text:'Сохранять расписание'}],assets:[{kind:'code',module:'M5P',codePath:'M5P.swift',remote:{url:'/code.png'}}],notes:'Сохранить примечание'};
 const heading=title(task,'kzs');
 for(const preview of [false,true]) {
  const body=description(task,'kzs',preview);
  assert.ok(body.startsWith('Включает следующие УЗС:\n1. !361\n\n'));
  assert.ok(!body.includes(heading));
  assert.doesNotMatch(body,/^Заголовок\r?$/m);
  assert.match(body,/Сохраняется расписание/);
  assert.match(body,/code\.png/);
  assert.match(body,/Сохранить примечание/);
 }
 assert.equal(title(task,'kzs'),heading);
});

test('обновление списка УЗС убирает прежний служебный заголовок и сохраняет ручной текст',()=>{
 const rest='Включает следующие УЗС:\n1. !361\n\nИтог: сохранён вручную\n\n## Примечания\n\nТочный ручной текст с !362.';
 const task={uzs:{iid:361},additionalUzs:[{iid:363}]};
 const expected=rest.replace('1. !361','1. !361\n2. !363');
 assert.equal(updateIncludedUzs('Заголовок\n- !362 #15839 🐬 Доработать планирование №2. Контроль\n\n'+rest,task),expected);
 assert.equal(updateIncludedUzs(expected,task),expected);
 const prose='Заголовок\n- Ручная заметка\n\n'+rest;
 assert.equal(updateIncludedUzs(prose,task),'Заголовок\n- Ручная заметка\n\n'+expected);
});

test('УЗС и КЗС не публикуют поле проверок, сохраняя демонстрацию и данные карточки',()=>{
 for(const verification of ['', 'Фактически выполненные проверки: служебный результат']){
  const task={key:'VCSMOB-1',title:'Исправить поведение экрана',jiraUrl:'https://jira.test/VCSMOB-1',done:'Исправлено поведение',result:'Корректное поведение',verification,demo:'Открытие экрана',uzs:{iid:1},changes:[{module:'Screen',text:'Исправлено поведение'}],assets:[{kind:'code',module:'Screen',codePath:'Screen.swift',remote:{url:'/code.png'}},{kind:'after',remote:{url:'/after.mp4'}}]};
  for(const kind of ['uzs','kzs'])for(const preview of [false,true]){
   const text=description(task,kind,preview);
   assert.doesNotMatch(text,/Проверки:|Фактически выполненные проверки|служебный результат|Не указаны\./);
   if(kind==='kzs'){assert.match(text,/## Демонстрация/);assert.match(text,/Открытие экрана/);assert.match(text,/code\.png/);}
  }
  assert.equal(task.verification,verification);
 }
});
