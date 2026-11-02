import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, access, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/core/store.mjs';
import { cleanupMergedAssets } from '../lib/core/asset-cleanup.mjs';
test('Очистка только слитого КЗС сохраняет метаданные и историю, повтор безопасен', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cleanup-'));const store=new Store(dir);
 try {
  await mkdir(join(dir,'uploads'));await writeFile(join(dir,'uploads','asset'),'video');
  const task=store.create({kzs:{state:'opened'}});task.assets=[{id:'asset',remote:{url:'/uploads/video'}}];
  await cleanupMergedAssets(store,task);await access(join(dir,'uploads','asset'));
  task.kzs.state='merged';await cleanupMergedAssets(store,task);
  await assert.rejects(access(join(dir,'uploads','asset')));assert.equal(task.assets[0].remote.url,'/uploads/video');assert.ok(task.assets[0].localDeletedAt);
  const n=task.events.length;await cleanupMergedAssets(store,task);assert.equal(task.events.length,n);
 } finally {store.close();await rm(dir,{recursive:true,force:true});}
});
test('Очистка не удаляет внешний файл через символическую ссылку',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cleanup-'));const store=new Store(join(dir,'data'));
 try {await mkdir(join(store.dir,'uploads'));await writeFile(join(dir,'original'),'video');await symlink(join(dir,'original'),join(store.dir,'uploads','asset'));
 const task=store.create({kzs:{state:'merged'}});task.assets=[{id:'asset',remote:{url:'/uploads/asset'}}];await assert.rejects(cleanupMergedAssets(store,task),/пределы/);await access(join(dir,'original'));
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('Новый файл исправления слитого КЗС хранится до загрузки в GitLab',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cleanup-pending-'));const store=new Store(dir);
 try {await mkdir(join(dir,'uploads'));await writeFile(join(dir,'uploads','pending'),'image');
 const task=store.create({kzs:{state:'merged'}});task.assets=[{id:'pending',kind:'code'}];await cleanupMergedAssets(store,task);
 await access(join(dir,'uploads','pending'));assert.equal(task.assets[0].localDeletedAt,undefined);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
