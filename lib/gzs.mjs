const branch=value=>typeof value==='string'?value.trim():'';
export const isReleaseBranch=value=>/^release(?:\/|$)/.test(value);

export function kzsDestination(t) {
  return branch(t.kzs?.target_branch)||(t.kzsBaseBranchConfirmed===true?branch(t.kzsBaseBranch):'')||branch(t.targetBranch);
}

export function gzsSnapshot(t,mr,iid,projectId) {
  if(!mr||mr.iid!==iid)throw new Error('GitLab вернул другой номер ГЗС.');
  if(!Number.isSafeInteger(projectId)||projectId<1||mr.source_project_id!==projectId||mr.target_project_id!==projectId||mr.project_id!==undefined&&mr.project_id!==projectId)throw new Error('ГЗС должен принадлежать выбранному проекту без fork.');
  if(typeof mr.title!=='string'||!/(?:^|[^\p{L}\p{N}])Гигант(?=$|[^\p{L}\p{N}])/iu.test(mr.title))throw new Error('В заголовке родительского запроса нужен маркер «Гигант».');
  if(!['opened','merged'].includes(mr.state))throw new Error('ГЗС должен быть открыт или слит.');
  const target=kzsDestination(t);
  if(!target)throw new Error('Сначала укажите фактическую ветку назначения КЗС.');
  if(mr.source_branch!==target)throw new Error('Исходная ветка ГЗС должна совпадать с назначением КЗС.');
  const fields=['iid','project_id','source_project_id','target_project_id','title','web_url','source_branch','target_branch','state','sha'];
  const unique=pattern=>[...new Set([...mr.title.matchAll(pattern)].map(match=>match[1]))];
  return {
    ...Object.fromEntries(fields.filter(key=>mr[key]!==undefined).map(key=>[key,mr[key]])),
    jiraNumbers:unique(/#(\d+)(?![\p{L}\p{N}_])/gu),
    jiraKeys:unique(/(?<![\p{L}\p{N}_-])([A-Z][A-Z0-9_]*-\d+)(?![\p{L}\p{N}_-])/gu),
  };
}

export function clearStaleGzs(t,confirmation) {
  if(!t.gzs||confirmation!==false&&t.gzs.source_branch===kzsDestination(t))return false;
  delete t.gzs;
  if(confirmation===undefined&&t.kzsTargetIsGzs===true)delete t.kzsTargetIsGzs;
  delete t.previews;
  return true;
}
