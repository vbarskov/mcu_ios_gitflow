import {taskTitle} from './core/description.mjs';
import {lineCounts as countLines} from './chat-line-counts.mjs';
const oneLine=value=>String(value||'').replace(/[\r\n]+/g,' ').trim();

function selectedRequest(task,kind,iid) {
  const requests=kind==='uzs'?[task.uzs,...(task.additionalUzs||[])]:[task.kzs];
  const index=iid===undefined?0:requests.findIndex(mr=>mr?.iid===iid);
  if(index<0||iid!==undefined&&!requests[index])throw new Error('Указанный запрос не привязан к этой задаче.');
  const mr=requests[index];
  const parts=[...String(mr?.title||'').matchAll(/(?:^|\s)№([1-9]\d*)(?=\.|$)/gu)];
  const part=Number(parts.at(-1)?.[1]);
  const number=Number.isSafeInteger(part)&&part>0?part:index===0&&Number.isSafeInteger(task.uzsPartNumber)&&task.uzsPartNumber>0?task.uzsPartNumber:index+1;
  return {mr,number};
}

function requestTitle(task,mr) {
  for(const source of [mr?.title,task.title]) {
    if(typeof source!=='string'||/[\r\n]/.test(source))continue;
    const normalized=source.replace(/(?:\[(?:💀|🐬)\]|💀|🐬)(?=[А-Яа-яЁё])/gu,'$& ');
    const name=taskTitle({...task,title:normalized});
    if(/^[А-Яа-яЁё]+(?:ть|ти|чь)(?=\s|$)/u.test(name))return name;
  }
  return '';
}

export function addedLines(diffs) {return countLines(diffs).total??undefined;}

function demonstration(task,mr) {
  const text=String(mr?.description||'').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g,'');
  if(oneLine(task.afterUrl)||(task.assets||[]).some(asset=>asset.kind==='after')||/!\[Стало\]\(\s*(?:https:\/\/|\/uploads\/)[^)\r\n]+\)/iu.test(text))return true;
  if(Array.isArray(task.assets)||task.kzsWithoutDemoConfirmed===true||typeof task.afterUrl==='string')return false;
  return null;
}

function kzsInGzs(task,target,confirmation) {
  if(/^release(?:\/|$)/.test(target))return false;
  if(typeof confirmation==='boolean')return confirmation;
  if(typeof task.kzsTargetIsGzs==='boolean')return task.kzsTargetIsGzs;
  return undefined;
}

function askFor(field,question) {
  return {text:null,needsInput:true,missingData:[field],question,lineCounts:{total:null,technical:null,ordinary:null}};
}

export async function chatMessage(task,{kind,iid,testSeconds,kzsTargetIsGzs},readDiffs) {
  const {mr,number}=selectedRequest(task,kind,iid);
  const actualTarget=oneLine(mr?.target_branch||(kind==='kzs'?task.kzsBaseBranch:'')||task.targetBranch);
  let gzs;
  if(kind==='kzs') {
    const label=mr?.iid?`КЗС !${mr.iid}`:'КЗС';
    if(!actualTarget)return askFor('targetBranch',`Укажите фактическую ветку назначения ${label}.`);
    gzs=kzsInGzs(task,actualTarget,kzsTargetIsGzs);
    if(gzs===undefined)return askFor('kzsTargetIsGzs',`${label} направлен в «${actualTarget}». Это запрос в ГЗС?`);
  }
  const missingData=[];
  const value=(field,known,placeholder)=>{
    if(known!==undefined&&known!==null&&known!=='')return known;
    missingData.push(field);return placeholder;
  };
  let lineCounts={total:null,technical:null,ordinary:null};
  if(mr?.iid) {
    try{lineCounts=countLines(await readDiffs(mr));}catch{}
  }
  let count=value('addedLines',lineCounts.total,'[добавлено строк]');
  if(lineCounts.total>500)count+=` (т. ${value('technicalLines',lineCounts.technical,'[технических строк]')})`;
  const url=value('url',oneLine(mr?.web_url),`[ссылка на ${kind==='uzs'?'УЗС':'КЗС'}]`);
  const target=value('targetBranch',actualTarget,'[ветка]');
  const hasDemo=demonstration(task,mr);
  let demo=hasDemo===true?', демо':'';
  if(kind==='kzs') {
    if(hasDemo===false)demo=', без демо';
    if(hasDemo===null){demo=', демо [не указано]';missingData.push('demo');}
    if(!gzs)return {text:`КЗС ${url}\n√${count}, ${target} >= 2${demo}`,missingData,lineCounts};
    const seconds=value('testSeconds',testSeconds,'[длительность]');
    return {text:`🐬 КЗС в ${target}: ${url}\n√${count}, ${target} >= 2, тест (${seconds} сек)${demo}`,missingData,lineCounts};
  }
  const name=value('title',requestTitle(task,mr),'[название УЗС]');
  const seconds=value('testSeconds',testSeconds,'[длительность]');
  const markers=/^minor\//.test(target)?'💀🐥':'💀';
  return {text:`Сливаю УЗС-${number}: ${name}\n${url}\n√${count}, ${markers}, ${target}, >=2, тест (${seconds} сек)${demo}`,missingData,lineCounts};
}
