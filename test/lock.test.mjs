import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {withLock} from '../lib/lock.mjs';

test('одновременное восстановление lock мёртвого процесса допускает только одного писателя',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mcu-lock-'));
  try{
    let active=0,maxActive=0;
    for(let round=0;round<40;round++) {
      await writeFile(join(dir,'operation.lock'),JSON.stringify({pid:2147483647}));
      const results=await Promise.allSettled(Array.from({length:4},()=>withLock(dir,async()=>{
        active++;maxActive=Math.max(maxActive,active);
        await new Promise(resolve=>setTimeout(resolve,2));active--;
      })));
      assert.ok(results.some(r=>r.status==='fulfilled'));
    }
    assert.equal(maxActive,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('завершение операции не удаляет подменённый lock другого владельца',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mcu-lock-owner-')),path=join(dir,'operation.lock');
  try {
    await withLock(dir,async()=>{await rm(path);await writeFile(path,'другой владелец');});
    assert.equal(await readFile(path,'utf8'),'другой владелец');
  }finally{await rm(dir,{recursive:true,force:true});}
});
