import test from 'node:test';
import assert from 'node:assert/strict';
import {title,taskTitle} from '../lib/core/description.mjs';
test('Заголовок не дублирует Jira и оформление КЗС из карточки',()=>{
 const name='Исправить открытие информации о позднем сеансе периодического мероприятия';
 const t={key:'VCSMOB-15625',title:`#VCSMOB-15625 ${name}. Контроль`,done:'Исправлено открытие информации'};
 assert.equal(taskTitle(t),name);
 assert.equal(title(t,'kzs'),`#15625 [🐬] ${name} №2. Контроль`);
 assert.equal(title(t,'uzs'),`#15625 💀 ${name} №1`);
 assert.equal(taskTitle({...t,title:`VCSMOB-15625: ${name} №2. Контроль`}),name);
 assert.equal(taskTitle({...t,title:'Контроль доступа к мероприятию'}),'Контроль доступа к мероприятию');
 assert.equal(taskTitle({...t,title:'Исправить VCSMOB-999 вместе с текущей задачей'}),'Исправить VCSMOB-999 вместе с текущей задачей');
});
