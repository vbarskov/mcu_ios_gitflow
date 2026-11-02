function section(text,labels,nextLabels){
 const source=String(text||'').replace(/\r\n?/g,'\n');
 const marker='(?:\\{\\*\\}|\\*{1,2}|_)?';
 const start=new RegExp(`(?:^|\\n)\\s*${marker}\\s*(?:${labels.join('|')})\\s*${marker}\\s*[:：]?\\s*`,'i').exec(source);
 if(!start)return '';
 const rest=source.slice(start.index+start[0].length);
 const next=new RegExp(`\\n\\s*${marker}\\s*(?:${nextLabels.join('|')})\\s*${marker}\\s*[:：]?\\s*`,'i').exec(rest);
 return rest.slice(0,next?.index??rest.length).trim();
}

export function jiraRequirements(description){
 const actual=['ФР','Фактический результат','Фактическое поведение'];
 const expected=['ОР','Ожидаемый результат','Ожидаемое поведение'];
 return {actualResult:section(description,actual,expected),expectedResult:section(description,expected,actual)};
}
