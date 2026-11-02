import test from 'node:test';
import assert from 'node:assert/strict';
import {description} from '../lib/core/description.mjs';

test('УЗС и КЗС не публикуют поле проверок, сохраняя демонстрацию и данные карточки',()=>{
 for(const verification of ['', 'Фактически выполненные проверки: служебный результат']){
  const task={key:'VCSMOB-1',jiraUrl:'https://jira.test/VCSMOB-1',done:'Исправлено поведение',result:'Корректное поведение',verification,demo:'Открытие экрана',uzs:{iid:1},changes:[{module:'Screen',text:'Исправлено поведение'}],assets:[{kind:'code',module:'Screen',codePath:'Screen.swift',remote:{url:'/code.png'}},{kind:'after',remote:{url:'/after.mp4'}}]};
  for(const kind of ['uzs','kzs'])for(const preview of [false,true]){
   const text=description(task,kind,preview);
   assert.doesNotMatch(text,/Проверки:|Фактически выполненные проверки|служебный результат|Не указаны\./);
   if(kind==='kzs'){assert.match(text,/## Демонстрация/);assert.match(text,/Открытие экрана/);assert.match(text,/code\.png/);}
  }
  assert.equal(task.verification,verification);
 }
});
