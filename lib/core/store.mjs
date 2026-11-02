import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export class Store {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.db = new DatabaseSync(join(dir, 'flow.sqlite'));
    chmodSync(join(dir, 'flow.sqlite'), 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL)');
  }
  get(id) { const r = this.db.prepare('SELECT body FROM records WHERE id=?').get(id); return r ? JSON.parse(r.body) : null; }
  put(id, kind, body) { this.db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(id, kind, JSON.stringify(body)); return body; }
  list(kind) { return this.db.prepare('SELECT body FROM records WHERE kind=? ORDER BY rowid DESC').all(kind).map(r => JSON.parse(r.body)); }
  save(t) { t.updatedAt = new Date().toISOString(); return this.put(t.id, 'task', t); }
  create(input) { return this.save({ ...input, id: randomUUID(), createdAt: new Date().toISOString(), assets: [], events: [], stage: 'draft' }); }
  event(t, message) { t.events.push({ at: new Date().toISOString(), message }); this.save(t); }
  close() { this.db.close(); }
}
