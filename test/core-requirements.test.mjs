import test from 'node:test';
import assert from 'node:assert/strict';
import {jiraRequirements} from '../lib/core/requirements.mjs';

test('из описания Jira выделяются ФР и ОР',()=>{
 assert.deepEqual(jiraRequirements('Шаги\nОткрыть экран\nФР: приложение закрывается\nОР: экран остаётся открыт\nПримечание к ОР'),{actualResult:'приложение закрывается',expectedResult:'экран остаётся открыт\nПримечание к ОР'});
 assert.deepEqual(jiraRequirements('Фактический результат： ошибка\nОжидаемое поведение: данные показаны'),{actualResult:'ошибка',expectedResult:'данные показаны'});
 assert.deepEqual(jiraRequirements('{*}ФР{*}: имя не обрезается\n{*}ОР{*}: имя занимает одну строку'),{actualResult:'имя не обрезается',expectedResult:'имя занимает одну строку'});
 assert.deepEqual(jiraRequirements('**ФР**: вылет\n**ОР**: мероприятие остаётся открытым'),{actualResult:'вылет',expectedResult:'мероприятие остаётся открытым'});
});

test('отсутствующие требования не выдумываются',()=>{
 assert.deepEqual(jiraRequirements('Исправить экран без описания результата'),{actualResult:'',expectedResult:''});
});
