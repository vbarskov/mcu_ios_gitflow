import {open,readFile,stat,unlink} from 'node:fs/promises';
import {join} from 'node:path';

const busy=()=>new Error('Уже выполняется операция плагина. После её завершения можно повторить запрос с той же карточкой.');
async function release(path,handle) {
  try {
    const owned=await handle.stat(),current=await stat(path).catch(()=>null);
    if(current&&owned.ino===current.ino&&owned.dev===current.dev)await unlink(path);
  }finally{await handle.close();}
}
async function acquire(path) {
  try{return await open(path,'wx',0o600);}
  catch(error){if(error.code!=='EEXIST')throw error;}
  // Только один процесс имеет право восстанавливать устаревший lock.
  // Обычное получение остаётся атомарным даже между unlink и повторным open.
  const recoveryPath=path+'.recovery';
  let recovery;
  try{recovery=await open(recoveryPath,'wx',0o600);}
  catch(error){if(error.code==='EEXIST')throw busy();throw error;}
  try {
    await recovery.writeFile(JSON.stringify({pid:process.pid}));
    let stale=false;
    try {
      const {pid}=JSON.parse(await readFile(path,'utf8'));
      if(Number.isSafeInteger(pid)&&pid>0)try{process.kill(pid,0);}catch(error){stale=error.code==='ESRCH';}
    }catch(error){if(error.code==='ENOENT')return await open(path,'wx',0o600).catch(()=>{throw busy();});}
    if(!stale)throw busy();
    await unlink(path);
    return await open(path,'wx',0o600).catch(()=>{throw busy();});
  }finally{await release(recoveryPath,recovery);}
}
export async function withLock(dir,fn) {
  const path=join(dir,'operation.lock'),handle=await acquire(path);
  try{await handle.writeFile(JSON.stringify({pid:process.pid,at:new Date().toISOString()}));return await fn();}
  finally{await release(path,handle);}
}
