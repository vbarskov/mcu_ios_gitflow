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

export async function chatMessage(task,{kind,iid,testSeconds},readDiffs) {
  const {mr,number}=selectedRequest(task,kind,iid);
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
  const target=value('targetBranch',oneLine(mr?.target_branch||(kind==='kzs'?task.kzsBaseBranch:'')||task.targetBranch),'[ветка]');
  const demo=oneLine(task.afterUrl)||(task.assets||[]).some(asset=>asset.kind==='after')?', демо':'';
  if(kind==='kzs') {
    const gzs=task.kzsTargetIsGzs===true&&target!=='[ветка]'&&!/^(?:release(?:\/|$)|minor\/)/.test(target);
    if(!gzs)return {text:`КЗС ${url}\n√${count}, ${target} >= 2${demo}`,missingData,lineCounts};
    const seconds=value('testSeconds',testSeconds,'[длительность]');
    return {text:`🐬 КЗС в ${target}: ${url}\n√${count}, 🐬, ${target} >= 2, тест (${seconds} сек)${demo}`,missingData,lineCounts};
  }
  const name=value('title',requestTitle(task,mr),'[название УЗС]');
  const seconds=value('testSeconds',testSeconds,'[длительность]');
  const markers=/^minor\//.test(target)?'💀🐥':'💀';
  return {text:`Сливаю УЗС-${number}: ${name}\n${url}\n√${count}, ${markers}, ${target}, >=2, тест (${seconds} сек)${demo}`,missingData,lineCounts};
}
