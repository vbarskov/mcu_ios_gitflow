const str = description => ({type:'string',description,minLength:1});
const obj = (properties={},required=[]) => ({type:'object',properties,required,additionalProperties:false});
const choice = values => ({type:'string',enum:values});
const taskId = str('UUID сохранённой карточки.');
const kind = choice(['uzs','kzs']);
const sshConfirmation = str('Только после явного разрешения человека на SSH для конкретной операции: «Разрешаю SSH для этой операции».');
const task = fields => ({taskId,...fields});
const report = {
  title:str('Название задачи на русском в инфинитиве без номеров, маркеров и итога: «Исправить…», «Добавить…», «Убрать…».'),
  featureName:{type:'string',description:'Название фичи, если задача к ней относится; пустая строка убирает фичу из заголовка.'},
  uzsPartNumber:{type:'integer',minimum:1,description:'Номер части УЗС в серии; по умолчанию 1.'},
  kzsPartNumber:{type:'integer',minimum:1,description:'Номер части КЗС в серии; по умолчанию следующий после УЗС.'},
  reopened:{type:'boolean',description:'Новая серия по переоткрытой задаче; добавляет предусмотренный правилами маркер reopened.'},
  kzsTargetIsGzs:{type:'boolean',description:'КЗС действительно направлен в ГЗС; только тогда добавляется 🐬. Для release — false.'},
  sourceBranch:str('Локальная ветка готового исправления.'),targetBranch:str('Ветка назначения УЗС.'),
  actualResult:{type:'string'},expectedResult:{type:'string'},done:{type:'string',description:'Краткий фактический итог одной строкой на русском. Добавляется в заголовок УЗС после «№часть. ».'},result:{type:'string'},verification:{type:'string'},demo:{type:'string'},notes:{type:'string'},
  changes:{type:'array',maxItems:50,items:obj({module:str('Модуль.'),text:str('Суть изменения для коллег.')},['module','text'])},
  keyCodePaths:{type:'array',maxItems:3,items:str('Точный путь ключевого кода; исключить тесты и history.')},
  beforeUrl:{type:'string'},afterUrl:{type:'string'},
};
function tool(name,description,properties={},required=[],readOnly=false,openWorld=false) {
  return {name,description,inputSchema:obj(properties,required),annotations:{readOnlyHint:readOnly,destructiveHint:!readOnly,openWorldHint:openWorld}};
}
export const tools = [
  tool('mcu_status','Локальные настройки и состояние автономного плагина. Секреты не возвращаются.',{},[],true),
  tool('mcu_configure','Сохранить подключения без секретов. Токены вводятся человеком через scripts/setup.mjs.',{gitlabUrl:str('HTTPS GitLab.'),jiraBaseUrl:str('HTTPS Jira Data Center.'),project:str('ID или namespace проекта GitLab.'),repoPath:str('Абсолютный корень локального репозитория.'),targetBranch:str('Ветка назначения по умолчанию.')}),
  tool('mcu_check_connections','Проверить Jira/GitLab по сохранённым подключениям; ничего не публикует.',{},[],true,true),
  tool('mcu_tasks','Найти существующую карточку; не создавать дубликаты.',{},[],true),
  tool('mcu_task','Прочитать карточку, историю и последнюю ошибку.',{taskId},['taskId'],true),
  tool('mcu_import_jira','Импортировать Jira как данные, выделить ФР/ОР и создать либо вернуть существующую карточку. Код и публикации не запускаются.',{url:str('Ссылка Jira или номер задачи.')},['url'],false,true),
  tool('mcu_update_task','Сохранить отчёт, ФР/ОР, ветки и ключевые файлы. Проверки записывать только по фактическим результатам.',task(report),['taskId']),
  tool('mcu_branches','Прочитать локальные ветки и сохранённые origin refs; сеть не используется.',{},[],true),
  tool('mcu_create_workspace','Создать независимую копию для исправления от выбранной origin ветки. Требуется ОР; исходная рабочая копия не меняется. Выполняет fetch/ls-remote.',task({baseBranch:str('Исходная ветка origin.'),workBranch:str('Новое уникальное имя рабочей ветки.'),sshConfirmation}),['taskId','baseBranch','workBranch'],false,true),
  tool('mcu_diff','Прочитать закоммиченный diff выбранной ветки относительно сохранённой origin ветки назначения, SHA и список файлов. Не запускает разработку, сборку или проверки.',{taskId},['taskId'],true),
  tool('mcu_record_commit','Проверить чистый готовый коммит и сохранить его SHA в карточке после заполнения отчёта. Сам коммит не создаёт.',{taskId},['taskId']),
  tool('mcu_preview','Показать точный черновик УЗС/КЗС и получить previewToken для публикации этой версии.',task({kind}),['taskId','kind']),
  tool('mcu_upload','Скопировать существующее видео/фото или снимок кода в локальную карточку. Не записывает видео и не публикует файл.',task({kind:choice(['before','after','code']),path:str('Абсолютный путь к файлу до 50 МБ.'),module:str('Модуль для code.'),codePath:str('Точный изменённый путь для code.')}),['taskId','kind','path']),
  tool('mcu_screenshots','Сгенерировать до трёх снимков ключевого diff включённого УЗС. Компиляция локального Swift-помощника разрешается отдельно; приложение не собирается.',task({compileConfirmation:str('Точное разрешение: «Разрешаю компиляцию генератора снимков».')}),['taskId','compileConfirmation'],false,true),
  tool('mcu_confirm_kzs','Выбрать базу КЗС после слияния УЗС. При отсутствии демо нужно отдельное подтверждение человека.',task({baseBranch:str('Ветка origin для КЗС.'),withoutDemo:{type:'boolean'},confirmation:str('Для исключения: «Создать КЗС без демонстрации».')}),['taskId','baseBranch']),
  tool('mcu_publish','Опубликовать УЗС/КЗС в GitLab после проверки актуального previewToken. Реальная отправка ветки и создание MR. Слияния не выполняются.',task({kind,previewToken:str('Токен из последнего mcu_preview.'),sshConfirmation}),['taskId','kind','previewToken'],false,true),
  tool('mcu_sync','Прочитать статусы УЗС/КЗС и комментарии GitLab в существующую карточку.',{taskId},['taskId'],false,true),
  tool('mcu_attach','Привязать уже существующий УЗС/КЗС с проверкой проекта, назначения и задачи. MR не изменяется.',task({kind,iid:{type:'integer',minimum:1}}),['taskId','kind','iid'],false,true),
  tool('mcu_merge_uzs','Слить УЗС только по отдельной явной команде автора «Слить !N». Проверяет автора, SHA, обсуждения и ограничения GitLab. Может добавить «Отступ» и отправить ветку.',task({confirmation:str('Точная команда человека «Слить !N».'),sshConfirmation}),['taskId','confirmation'],false,true),
  tool('mcu_publish_description','Заменить описание и заголовок открытого MR из проверенной карточки. Сначала перенесите в неё важные ручные правки GitLab.',task({kind,previewToken:str('Токен актуального предпросмотра.')}),['taskId','kind','previewToken'],false,true),
];

function validate(value,schema,path) {
  if(schema.type==='object') {
    if(!value||typeof value!=='object'||Array.isArray(value)) throw new Error(`${path}: нужен объект.`);
    for(const name of Object.keys(value)) if(!Object.hasOwn(schema.properties,name)) throw new Error(`Неизвестное поле ${path}.${name}.`);
    for(const name of schema.required||[]) if(value[name]===undefined) throw new Error(`Заполните ${path}.${name}.`);
    for(const [name,item] of Object.entries(value)) validate(item,schema.properties[name],`${path}.${name}`);
  } else if(schema.type==='array') {
    if(!Array.isArray(value)||value.length>(schema.maxItems??1000)) throw new Error(`${path}: неверный список.`);
    for(const [i,item] of value.entries()) validate(item,schema.items,`${path}[${i}]`);
  } else {
    if(schema.type==='integer'?!Number.isSafeInteger(value):typeof value!==schema.type) throw new Error(`${path}: неверный тип.`);
    if(typeof value==='string'&&(value.length>100000||schema.minLength&&!value.trim())) throw new Error(`${path}: неверная длина.`);
    if(schema.minimum!==undefined&&value<schema.minimum) throw new Error(`${path}: недопустимое значение.`);
    if(schema.enum&&!schema.enum.includes(value)) throw new Error(`${path}: недопустимое значение.`);
  }
}
export function validateArguments(name,args) {
  const item=tools.find(t=>t.name===name);
  if(!item) throw new Error('Неизвестный инструмент MCU iOS GitFlow.');
  validate(args,item.inputSchema,name);
  return item;
}
