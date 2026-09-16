import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { restoreData } from '../scripts/restore-docker-data.mjs';

test('first Docker start restores SQLite, configuration key and media without overwriting on repeat', async () => {
  const dir=mkdtempSync(path.join(tmpdir(),'libtv-restore-')),source=path.join(dir,'source'),destination=path.join(dir,'target');
  mkdirSync(path.join(source,'media'),{recursive:true});
  const db=new DatabaseSync(path.join(source,'studio.sqlite'));
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE projects (name TEXT); INSERT INTO projects VALUES (\'saved-project\')');
    writeFileSync(path.join(source,'.master-key'),Buffer.alloc(32,7));
    writeFileSync(path.join(source,'media','synthetic.png'),'synthetic-file-for-copy-verification');
    assert.equal((await restoreData(source,destination)).restored,true);
    const restored=new DatabaseSync(path.join(destination,'studio.sqlite'));
    assert.equal(restored.prepare('SELECT name FROM projects').get().name,'saved-project');
    restored.exec("INSERT INTO projects VALUES ('new-user-work')");restored.close();
    assert.deepEqual(readFileSync(path.join(destination,'.master-key')),Buffer.alloc(32,7));
    assert.equal(readFileSync(path.join(destination,'media','synthetic.png'),'utf8'),'synthetic-file-for-copy-verification');
    assert.equal((await restoreData(source,destination)).reason,'existing-database');
    const untouched=new DatabaseSync(path.join(destination,'studio.sqlite'));
    assert.equal(untouched.prepare('SELECT COUNT(*) AS count FROM projects').get().count,2);untouched.close();
  } finally { db.close();rmSync(dir,{recursive:true,force:true}); }
});

test('Docker initialization allows an empty workspace but refuses to replace unrelated files', async () => {
  const dir=mkdtempSync(path.join(tmpdir(),'libtv-empty-')),source=path.join(dir,'source'),destination=path.join(dir,'target');
  try {
    mkdirSync(source);assert.equal((await restoreData(source,destination)).reason,'empty-seed');
    writeFileSync(path.join(destination,'existing.txt'),'keep');
    await assert.rejects(restoreData(source,destination),/refusing to replace/);
    assert.equal(readFileSync(path.join(destination,'existing.txt'),'utf8'),'keep');
    assert.equal(existsSync(path.join(destination,'studio.sqlite')),false);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
