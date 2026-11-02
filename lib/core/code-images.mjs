import {isSupportingPath} from './report-policy.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);
export function diffPages(diff) {
 let old=0,next=0;const rows=[];
 for(const line of diff.split('\n')) {
  const h=line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if(h){old=Number(h[1]);next=Number(h[2]);const text=[...line];for(let i=0;i<text.length;i+=110)rows.push({text:text.slice(i,i+110).join(''),kind:'@'});continue;}
  const kind=line[0];if(![' ','+','-'].includes(kind))continue;
  const a=kind==='+'?'':String(old++),b=kind==='-'?'':String(next++);
  const chars=[...line.slice(1).replaceAll('\t','    ')];
  for(let i=0;i<Math.max(1,chars.length);i+=100)rows.push({kind,text:`${(i?'':a).padStart(5)} ${(i?'':b).padStart(5)} ${i?' ':kind} ${chars.slice(i,i+100).join('')}`});
 }
 const pages=[];for(let i=0;i<rows.length;i+=42)pages.push(rows.slice(i,i+42));return pages;
}
export async function renderCodePage(page, output, dir) {
 await mkdir(dir,{recursive:true,mode:0o700});
 const source=fileURLToPath(new URL('./code-image.swift',import.meta.url));
 const hash=createHash('sha256').update(await readFile(source)).digest('hex').slice(0,12);
 const binary=join(dir,`code-image-${hash}`);
 try{await access(binary);}catch{await exec('/usr/bin/swiftc',[source,'-o',binary],{timeout:120000});}
 const input=output+'.json';await writeFile(input,JSON.stringify(page),{mode:0o600});
 await exec(binary,[input,output],{timeout:30000});
 return readFile(output);
}
export async function loadMergeRequestDiffs(api,t,iid) {
 try { return await api.list(t,`/merge_requests/${iid}/diffs`); }
 catch(error) {
  if(!/HTTP (404|500|502|503)\b/.test(error.message))throw error;
  const result=await api.request(`${api.project(t)}/merge_requests/${iid}/changes`);
  if(result.overflow || !Array.isArray(result.changes))throw new Error('GitLab вернул неполные изменения УЗС. Добавьте снимки вручную.');
  return result.changes;
 }
}
export async function loadCodeDiffs(api,t) { return loadMergeRequestDiffs(api,t,t.uzs.iid); }
export async function prepareCodeImages(store,api,t,render=renderCodePage) {
 if(!t.uzs)throw new Error('Для снимков кода нужен включённый УЗС.');
 const diffs=await loadCodeDiffs(api,t);
 const dir=join(store.dir,'code-images');await mkdir(join(store.dir,'uploads'),{recursive:true,mode:0o700});
 const expected=new Set();let selectedFiles=0;
 for(const d of diffs){
  const path=d.new_path||d.old_path;
  if(isSupportingPath(path))continue;
  if(Array.isArray(t.keyCodePaths)&&!t.keyCodePaths.includes(path))continue;
  if(selectedFiles>=3)continue;
  if(!/\.(swift|m|mm|h|c|cpp|js|mjs|ts|tsx|jsx|py|kt|java|go|rs|sh)$/i.test(path))continue;

  const module=t.changes.map(c=>c.module).find(group=>group.split(',').map(name=>name.trim()).filter(Boolean).some(name=>[d.new_path,d.old_path].some(p=>p&&(p===name||p.startsWith(name+'/')||('/'+p+'/').includes('/'+name+'/')||p.split('/').at(-1)?.replace(/\.[^.]+$/,'')===name))));
  if(!module)continue;
  if(t.assets.some(a=>a.kind==='code'&&!a.generated&&a.codePath===path))continue;
  if(d.too_large||d.collapsed)throw new Error(`GitLab не вернул полный diff: ${path}. Добавьте снимок вручную.`);
  if(!d.diff)continue;
  selectedFiles++;
  const allPages=diffPages(d.diff);
  const pages=[...allPages].sort((a,b)=>b.filter(r=>['+','-'].includes(r.kind)).length-a.filter(r=>['+','-'].includes(r.kind)).length).slice(0,1);
  for(let i=0;i<pages.length;i++){
   const id=createHash('sha256').update(JSON.stringify([t.id,t.uzs.iid,path,d.diff,i,'v3'])).digest('hex');
   expected.add(id);
   const existing=t.assets.find(a=>a.id===id);
   if(existing&&(existing.remote||!existing.localDeletedAt))continue;
   const output=join(store.dir,'uploads',id);
   const bytes=await render({title:`УЗС !${t.uzs.iid} · ${path} · ${allPages.length>1?'ключевой фрагмент':'изменение'}`,rows:pages[i]},output,dir);
   await writeFile(output,bytes,{mode:0o600});
   t.assets=t.assets.filter(a=>a.id!==id);
   t.assets.push({id,kind:'code',generated:true,name:`code-${path.split('/').at(-1)}-${i+1}.png`,mime:'image/png',module,codePath:path,size:bytes.length});store.save(t);
  }
 }
 if(!t.assets.some(a=>a.kind==='code'&&!isSupportingPath(a.codePath)&&(!Array.isArray(t.keyCodePaths)||t.keyCodePaths.includes(a.codePath))&&(!a.generated||expected.has(a.id))))throw new Error('Не удалось подготовить снимки: выбранные ключевые файлы не сопоставлены с модулями изменений или не содержат доступного diff. Проверьте keyCodePaths и названия модулей.');
 t.assets=t.assets.filter(a=>!a.generated||expected.has(a.id));store.save(t);
 return t;
}
