import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Plugin} from '../lib/plugin.mjs';
import {Config} from '../lib/config.mjs';
import {Flow,git} from '../lib/core/flow.mjs';

test('автономный MCP-фасад проводит готовый коммит через УЗС и пустой КЗС без сервиса',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mcu-e2e-'));
  const repo=join(dir,'source'),origin=join(dir,'origin.git');
  await mkdir(repo);
  await git(dir,'init','--bare',origin);
  await git(repo,'init','-b','release');
  await git(repo,'config','user.name','Тест');await git(repo,'config','user.email','test@example.test');
  await mkdir(join(repo,'App'));await writeFile(join(repo,'App','foo.js'),'export const value=1;\n');
  await git(repo,'add','.');await git(repo,'commit','-m','База');await git(repo,'remote','add','origin',origin);await git(repo,'push','-u','origin','release');
  await git(repo,'checkout','-b','feature/APP-1');await writeFile(join(repo,'App','foo.js'),'export const value=2;\n');await git(repo,'commit','-am','Исправить значение');
  const original=await git(repo,'rev-parse','HEAD');
  const config=new Config(join(dir,'data'));config.save({gitlabUrl:'https://git.example.test',jiraBaseUrl:'https://jira.example.test',project:'team/app',repoPath:repo,targetBranch:'release'});
  const mrs=new Map();let next=10;
  const api={
    mr:async(_t,iid)=>mrs.get(iid),discussions:async()=>[],find:async()=>undefined,
    list:async(_t,suffix)=>suffix.includes('/diffs')?[{new_path:'App/foo.js',old_path:'App/foo.js',diff:'@@ -1 +1 @@\n-export const value=1;\n+export const value=2;'}]:[],
    ensureMR:async(t,branch,heading,body,kind)=>{const mr={iid:next++,state:'opened',source_branch:branch,target_branch:t.targetBranch,title:heading,description:body,web_url:`https://git.example.test/team/app/-/merge_requests/${next-1}`,kind,sha:await git(repo,'rev-parse',branch)};mrs.set(mr.iid,mr);return mr;},
    upload:async(_t,asset)=>({url:`/uploads/${asset.id}/${asset.name}`}),
    update:async(_t,iid,fields)=>Object.assign(mrs.get(iid),fields),
  };
  class TestFlow extends Flow {
    async validateRepository(t,branch=t.targetBranch) {await git(t.executionRepoPath||t.repoPath,'fetch','origin',`+refs/heads/${branch}:refs/remotes/origin/${branch}`);return `refs/remotes/origin/${branch}`;}
  }
  const plugin=new Plugin({config,flowFactory:(s,c)=>new TestFlow(s,c,api)});
  const t=plugin.store.create({key:'APP-1',title:'Исправить значение',repoPath:config.get().repoPath,project:'team/app',gitlabUrl:'https://git.example.test',jiraBaseUrl:'https://jira.example.test',jiraUrl:'https://jira.example.test/browse/APP-1',sourceBranch:'feature/APP-1',targetBranch:'release',done:'Исправлено значение.',result:'Возвращается ожидаемое значение.',verification:'Локальный модульный тест пройден.',changes:[{module:'App',text:'Исправлено значение.'}],keyCodePaths:['App/foo.js']});
  try {
    await plugin.call('mcu_record_commit',{taskId:t.id});
    const oldPreview=await plugin.call('mcu_preview',{taskId:t.id,kind:'uzs'});
    await plugin.call('mcu_update_task',{taskId:t.id,result:'Возвращается значение 2.'});
    await assert.rejects(plugin.call('mcu_publish',{taskId:t.id,kind:'uzs',previewToken:oldPreview.previewToken}),/предпросмотр/);
    const preview=await plugin.call('mcu_preview',{taskId:t.id,kind:'uzs'});
    const published=await plugin.call('mcu_publish',{taskId:t.id,kind:'uzs',previewToken:preview.previewToken});
    assert.equal(published.uzs.iid,10);assert.equal(await git(repo,'rev-parse','HEAD'),original);
    assert.equal(await git(repo,'rev-list','--count',`origin/release..${published.uzsBranch}`),'2');
    // Временный origin имитирует уже выполненное человеком слияние УЗС.
    await git(repo,'push','origin',`${published.uzsBranch}:release`);
    const uzs=mrs.get(10);uzs.state='merged';uzs.merge_commit_sha=uzs.sha;
    await plugin.call('mcu_sync',{taskId:t.id});
    await assert.rejects(plugin.call('mcu_confirm_kzs',{taskId:t.id,baseBranch:'release',withoutDemo:true}),/подтверждение/);
    await plugin.call('mcu_confirm_kzs',{taskId:t.id,baseBranch:'release',withoutDemo:true,confirmation:'Создать КЗС без демонстрации'});
    const image=join(dir,'code.png');await writeFile(image,Buffer.from([137,80,78,71,13,10,26,10,0]));
    await plugin.call('mcu_upload',{taskId:t.id,kind:'code',path:image,module:'App',codePath:'App/foo.js'});
    const kzsPreview=await plugin.call('mcu_preview',{taskId:t.id,kind:'kzs'});
    assert.match(kzsPreview.description,/file:/);assert.doesNotMatch(kzsPreview.description,/\/api\/tasks/);
    const finished=await plugin.call('mcu_publish',{taskId:t.id,kind:'kzs',previewToken:kzsPreview.previewToken});
    assert.equal(finished.kzs.state,'opened');
    assert.equal(await git(repo,'diff','--name-only',`origin/release..${finished.kzsBranch}`),'');
    assert.equal(await git(repo,'rev-list','--count',`origin/release..${finished.kzsBranch}`),'2');
    assert.equal(await git(repo,'log','--format=%s',`origin/release..${finished.kzsBranch}`),'Отступ\nОтступ');
    assert.match(finished.kzs.description,/\/uploads\//);assert.doesNotMatch(finished.kzs.description,/Локальный модульный тест/);
    assert.equal(await git(repo,'rev-parse','HEAD'),original);
  }finally{plugin.close();await rm(dir,{recursive:true,force:true});}
});
