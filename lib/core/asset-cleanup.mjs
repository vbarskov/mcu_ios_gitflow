import { realpath, unlink } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

// Удаляем только зарегистрированные копии внутри хранилища сервиса.
async function removeOwned(root, path) {
  const base = await realpath(root);
  const candidate = resolve(path);
  if (!candidate.startsWith(resolve(root) + sep)) throw new Error('Вложение находится вне хранилища сервиса.');
  try {
    const actual = await realpath(candidate);
    if (!actual.startsWith(base + sep)) throw new Error('Вложение ссылается за пределы хранилища сервиса.');
    await unlink(candidate);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
export async function cleanupMergedAssets(store, task) {
  if (task.kzs?.state !== 'merged') return;
  const at = new Date().toISOString();
  let count = 0;
  for (const asset of task.assets || []) {
    if (asset.localDeletedAt) continue;
    // Новый файл для исправления отчёта удаляем только после загрузки в GitLab.
    if (!asset.remote) continue;
    if (!/^[a-zA-Z0-9-]+$/.test(asset.id)) throw new Error('Некорректный идентификатор вложения.');
    await removeOwned(store.dir, resolve(store.dir, 'uploads', asset.id));
    await removeOwned(store.dir, resolve(store.dir, 'uploads', asset.id + '.json'));
    asset.localDeletedAt = at;
    count++;
    store.save(task);
  }
  for (const run of store.list('execution').filter(r => r.taskId === task.id)) {
    const recordings = [...(run.recordings || []), ...(run.attempts || []).flatMap(a => a.recordings || [])];
    for (const recording of recordings) {
      if (recording.localDeletedAt || !recording.path) continue;
      const owned = resolve(store.dir, 'executions', run.id) + sep;
      if (!resolve(recording.path).startsWith(owned) || !/\.mp4$/i.test(recording.path)) throw new Error('Не удалось подтвердить принадлежность записи задаче.');
      await removeOwned(store.dir, recording.path);
      recording.localDeletedAt = at;
      count++;
    }
    store.put(run.id, 'execution', run);
  }
  task.assetsCleanedAt = at;
  if (count) store.event(task, `КЗС слит: удалены локальные вложения и записи (${count}). История и ссылки GitLab сохранены.`);
  else store.save(task);
}
