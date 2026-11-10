import {taskTitle} from './core/description.mjs';
import {lineCounts as countLines} from './chat-line-counts.mjs';
const oneLine=value=>String(value||'').replace(/[\r\n]+/g,' ').trim();

function selectedRequest(task,kind,iid) {
  const requests=kind==='uzs'?[task.uzs,...(task.additionalUzs||[])]:[task[kind]];
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

function gzsTitle(mr) {
  if(typeof mr?.title!=='string'||/[\r\n\0]/.test(mr.title))return '';
  let name=mr.title.trim(),previous;
  const metadata=/^(?:(?:Draft|WIP):|!\d+(?=\s|#|$)|#\d+(?=\s|🐬|🐥|$)|#?[A-Z][A-Z0-9_]*-\d+(?=\s|🐬|🐥|$)|\[(?:🐬|🐥[^\s\]]+)\]|🐬|🐥[^\s]+)\s*/iu;
  do{previous=name;name=name.replace(metadata,'');}while(name!==previous);
  name=name.replace(/\.\s*Гигант\s*$/iu,'').trim();
  return /^[А-Яа-яЁё]+(?:ть|ти|чь)(?=\s|$)/u.test(name)?name:'';
}

export function addedLines(diffs) {return countLines(diffs).total??undefined;}

function demonstration(task,mr) {
  const text=String(mr?.description||'').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g,'');
  if(oneLine(task.afterUrl)||(task.assets||[]).some(asset=>asset.kind==='after')||/!\[Стало\]\(\s*(?:https:\/\/|\/uploads\/)[^)\r\n]+\)/iu.test(text))return true;
  if(Array.isArray(task.assets)||task.kzsWithoutDemoConfirmed===true||typeof task.afterUrl==='string')return false;
  return null;
}

function gzsDemonstration(mr) {
  if(mr?.description===undefined)return null;
  const text=String(mr.description||'')
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g,'')
    .replace(/(`+)[^\r\n]*?\1/g,'').replace(/`[^\r\n]*$/gm,'')
    .replace(/<!--[\s\S]*?(?:-->|$)/g,'');
  const excluded=label=>/^(?:Было|Код|Сним(?:ок|ки)\s+кода)(?=$|[\s:.,])/iu.test(label.trim());
  const resultLabel=label=>/^(?:Стало|Демо(?:нстрация)?|Результат)(?=$|[\s:.,])/iu.test(label.trim());
  const media=/(?<![\\!])(!?)\[([^\]\r\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"'\r\n]*["'])?\s*\)/gu;
  let uncertain=false;const sections=[];
  for(const row of text.split(/\r?\n/)) {
    const heading=row.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u);
    if(heading) {
      while(sections.at(-1)?.depth>=heading[1].length)sections.pop();
      sections.push({depth:heading[1].length,label:heading[2].replace(/[*_]/g,'')});
    }
    if(sections.some(section=>excluded(section.label)))continue;
    const demoSection=sections.some(section=>/^Демонстрация(?=$|[\s:.,])/iu.test(section.label));
    for(const match of row.matchAll(media)) {
      if(excluded(match[2]))continue;
      const url=match[3],video=/\.(?:mp4|mov|webm)(?:[?#]|$)/iu.test(url);
      const image=/\.(?:png|jpe?g|gif|webp|heic|avif)(?:[?#]|$)/iu.test(url);
      if(!match[1]&&!video&&!image){if(resultLabel(match[2]))uncertain=true;continue;}
      if(!/^(?:https:\/\/|\/uploads\/)/iu.test(url)){uncertain=true;continue;}
      if(video||resultLabel(match[2])||demoSection)return true;
      uncertain=true;
    }
    const remaining=row.replace(media,'');
    if(/<(?:img|video|source|iframe)\b|(?<!\\)!\[[^\]\r\n]*\](?:\(|\[)/iu.test(remaining))uncertain=true;
  }
  return uncertain?null:false;
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
  if(kind==='gzs'&&!task.gzs?.iid)return askFor('iid','Укажите номер или ссылку ГЗС.');
  const {mr,number}=selectedRequest(task,kind,iid);
  const actualTarget=oneLine(kind==='gzs'?mr?.target_branch:mr?.target_branch||(kind==='kzs'?task.kzsBaseBranch:'')||task.targetBranch);
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
  const label={uzs:'УЗС',kzs:'КЗС',gzs:'ГЗС'}[kind];
  const url=value('url',oneLine(mr?.web_url),`[ссылка на ${label}]`);
  const target=value('targetBranch',actualTarget,'[ветка]');
  const hasDemo=kind==='gzs'?gzsDemonstration(mr):demonstration(task,mr);
  let demo=hasDemo===true?', демо':'';
  if(kind==='kzs'||kind==='gzs') {
    if(hasDemo===false)demo=', без демо';
    if(hasDemo===null){demo=', демо [не указано]';missingData.push('demo');}
    if(kind==='gzs') {
      const name=value('title',gzsTitle(mr),'[название ГЗС]');
      const seconds=value('testSeconds',testSeconds,'[длительность]');
      return {text:`Сливаю ГЗС: ${name}\n${url}\n√${count}, 🐬, ${target} >= 2, тест (${seconds} сек)${demo}`,missingData,lineCounts};
    }
    if(!gzs)return {text:`КЗС: ${url}\n√${count}, ${target} >= 2${demo}`,missingData,lineCounts};
    return {text:`🐬 КЗС в ${target}: ${url}\n√${count}, release >= 2${demo}`,missingData,lineCounts};
  }
  const name=value('title',requestTitle(task,mr),'[название УЗС]');
  const seconds=value('testSeconds',testSeconds,'[длительность]');
  const markers=/^minor\//.test(target)?'💀🐥':'💀';
  return {text:`Сливаю УЗС-${number}: ${name}\n${url}\n√${count}, ${markers}, ${target}, >=2, тест (${seconds} сек)${demo}`,missingData,lineCounts};
}
