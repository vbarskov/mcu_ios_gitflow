import test from 'node:test';
import assert from 'node:assert/strict';
import {lineCounts} from '../lib/chat-line-counts.mjs';
const patch=lines=>'@@ -0,0 +1 @@\n'+lines.map(line=>'+'+line).join('\n');
const change=(new_path,lines,rest={})=>({new_path,diff:patch(lines),...rest});

test('все добавления содержат техническое подмножество без двойного счёта',()=>{
 const diffs=[
  change('Main.swift',['let a = 1','let b = 2 // inline','// full','   ','/* block */','let text = "/*"']),
  change('Plan.yml',['name: value','value: 1 # inline','# comment','']),
  change('Features/Generated/DTO.swift',['let a = 1','// generated']),
  change('Main.SectionGenerated.swift',['let a = 1','']),
  change('Main.Generated.swift',['let a = 1'],{generated_file:false}),
  change('Auto.swift',['let a = 1'],{generated_file:true}),
  change('Tests/Unit/Check.swift',['let a = 1','// test']),
  change('MainTests.swift',['let a = 1']),
  change('tool.spec.ts',['let a = 1']),
  change('history/APP-1',['текст']),
 ];
 assert.deepEqual(lineCounts(diffs),{total:21,technical:16,ordinary:5});
});

test('контекст блочного комментария используется осторожно, inline-код не становится техническим',()=>{
 const diff='@@ -1,1 +1,8 @@\n /* start\n+body\n+*/\n+let outside = true\n+/* another */ let next = 1\n+// full\n+let url = "https://host"\n+let token = "/*"';
 assert.deepEqual(lineCounts([{new_path:'Main.swift',diff}]),{total:7,technical:3,ordinary:4});
 assert.deepEqual(lineCounts([change('Main.swift',['* unknown middle','let a = 1'])]),{total:2,technical:0,ordinary:2});
 assert.deepEqual(lineCounts([change('history/Main.swift',['let a = 1'])]),{total:1,technical:0,ordinary:1});
});

test('путь нужен для классификации, полный пустой diff остаётся достоверным нулём',()=>{
 assert.deepEqual(lineCounts([{diff:patch(['one','two'])}]),{total:2,technical:null,ordinary:null});
 assert.deepEqual(lineCounts([{generated_file:true,diff:patch(['one','two'])}]),{total:2,technical:2,ordinary:0});
 assert.deepEqual(lineCounts([]),{total:0,technical:0,ordinary:0});
 for(const diffs of [undefined,[{}],[{too_large:true,diff:''}],[{collapsed:true,diff:''}],[{truncated:true,diff:''}]])assert.deepEqual(lineCounts(diffs),{total:null,technical:null,ordinary:null});
});

test('служебный заголовок +++ не считается, добавленный оператор +++ считается',()=>{
 const diff='--- a/Main.swift\n+++ b/Main.swift\n@@ -1 +1,2 @@\n-old\n+++counter\n+let a = 1';
 assert.deepEqual(lineCounts([{new_path:'Main.swift',diff}]),{total:2,technical:0,ordinary:2});
});

test('суффикс Test обозначает тестовый Swift-файл, Latest остаётся обычным кодом',()=>{
 assert.deepEqual(lineCounts([change('Models/RoomTest.swift',['let value = 1']),change('Models/Latest.swift',['let value = 1'])]),{total:2,technical:1,ordinary:1});
});
