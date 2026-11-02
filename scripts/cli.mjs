#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {Plugin} from '../lib/plugin.mjs';
import {tools} from '../lib/tools.mjs';
const [name,file,...extra]=process.argv.slice(2);
if(!name||name==='--help') {
  console.log('Использование: node scripts/cli.mjs ИНСТРУМЕНТ [JSON_ФАЙЛ]\nНастройка токенов: node scripts/setup.mjs\n'+tools.map(t=>`${t.name}: ${t.description}`).join('\n'));
} else {
  let plugin;
  try {
    if(extra.length)throw new Error('Параметры передаются JSON-файлом; секреты в аргументах запрещены.');
    const args=file?JSON.parse(await readFile(file,'utf8')):{};
    plugin=new Plugin();console.log(JSON.stringify(await plugin.call(name,args),null,2));
  }catch(error){console.error(plugin?plugin.redact(error):'Не удалось прочитать параметры или открыть хранилище.');process.exitCode=1;}
  finally {plugin?.close();}
}
