const oneLine=value=>String(value||'').replace(/[\r\n]+/g,' ').trim();

function selectedRequest(task,kind,iid) {
  const requests=kind==='uzs'?[task.uzs,...(task.additionalUzs||[])]:[task.kzs];
  const index=iid===undefined?0:requests.findIndex(mr=>mr?.iid===iid);
  if(index<0||iid!==undefined&&!requests[index])throw new Error('Указанный запрос не привязан к этой задаче.');
  return {mr:requests[index],number:index+1};
}

function chatSummary(task,mr) {
  const prose=String(mr?.description||'').split('\n').map(value=>value.trim()).find(value=>
    value.length>15&&!/^(?:Было сделано:|#{1,6}\s|[-*|]|Включается в КЗС:|https?:\/\/)/i.test(value));
  let source=oneLine(prose||task.result||task.done);
  if(!source)return '';
  source=source.split(/(?<=[.!?])\s/)[0];
  if(source.length>140&&source.includes(':'))source=source.split(':')[0].trim()+'.';
  if(source.length<=140)return source;
  return source.slice(0,138).replace(/\s+\S*$/,'').trim()+'…';
}

export function addedLines(diffs) {
  if(!Array.isArray(diffs)||diffs.some(change=>!change||change.too_large||change.collapsed||change.overflow||typeof change.diff!=='string'))return undefined;
  return diffs.reduce((total,change)=>{
    let hunk=false;
    for(const line of change.diff.split('\n')) {
      if(line.startsWith('@@'))hunk=true;
      if(line.startsWith('+')&&(hunk||!/^\+\+\+ (?:[ab]\/|\/dev\/null)/.test(line)))total++;
    }
    return total;
  },0);
}

export async function chatMessage(task,{kind,iid,testSeconds},readDiffs) {
  const {mr,number}=selectedRequest(task,kind,iid);
  const missingData=[];
  const value=(field,known,placeholder)=>{
    if(known!==undefined&&known!==null&&known!=='')return known;
    missingData.push(field);return placeholder;
  };
  let added;
  if(mr?.iid) {
    try{added=addedLines(await readDiffs(mr));}catch{}
  }
  const count=value('addedLines',added,'[добавлено строк]');
  const url=value('url',oneLine(mr?.web_url),`[ссылка на ${kind==='uzs'?'УЗС':'КЗС'}]`);
  const target=value('targetBranch',oneLine(mr?.target_branch||(kind==='kzs'?task.kzsBaseBranch:'')||task.targetBranch),'[ветка]');
  if(kind==='kzs') {
    const demo=oneLine(task.afterUrl)||(task.assets||[]).some(asset=>asset.kind==='after')?', демо':'';
    return {text:`КЗС: ${url}\n√${count}, ${target}, >=2${demo}`,missingData};
  }
  const summary=value('summary',chatSummary(task,mr),'[краткий результат]');
  const seconds=value('testSeconds',testSeconds,'[длительность]');
  return {text:`Сливаю УЗС-${number}: ${summary}\n${url}\n√${count},💀, ${target} >= 2, тест (${seconds} сек)`,missingData};
}
