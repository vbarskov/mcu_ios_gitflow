import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

test('установленный stdio entrypoint отвечает JSON-RPC без HTTP-сервиса',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mcu-mcp-'));
  try {
    const output=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/mcp-server.mjs',import.meta.url))],{env:{...process.env,MCU_IOS_GITFLOW_DATA_DIR:dir},stdio:['pipe','pipe','pipe']});
      let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('error',reject);
      child.on('exit',code=>code===0?resolve(stdout):reject(new Error(`Код ${code}: ${stderr}`)));
      child.stdin.end([
        '{invalid',
        JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}}),
        JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'}),
        JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'}),
        JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'mcu_status',arguments:{}}}),
        JSON.stringify({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'mcu_configure',arguments:{token:'do-not-save'}}}),
      ].join('\n')+'\n');
    });
    const rows=output.trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(rows.length,5);assert.equal(rows[0].error.code,-32700);
    assert.equal(rows[1].result.serverInfo.name,'mcu-ios-gitflow');
    assert.ok(rows[2].result.tools.some(t=>t.name==='mcu_create_workspace'));
    assert.equal(JSON.parse(rows[3].result.content[0].text).standalone,true);
    assert.equal(rows[4].result.isError,true);assert.doesNotMatch(output,/do-not-save/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
