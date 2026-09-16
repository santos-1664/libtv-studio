import { existsSync, mkdirSync, readdirSync, lstatSync, copyFileSync, chownSync, chmodSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';

// Runs once before the app. Personal data is mounted read-only, never baked into the image.
export async function restoreData(source, destination, owner) {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const own = file => { if (owner) chownSync(file, owner.uid, owner.gid); };
  own(destination);
  const database = path.join(destination, 'studio.sqlite');
  if (existsSync(database)) return { restored: false, reason: 'existing-database' };
  if (readdirSync(destination).some(name => name !== '.restore-in-progress')) throw new Error('Destination contains data without a database; refusing to replace existing files');
  const sourceDatabase = path.join(source, 'studio.sqlite');
  if (!existsSync(sourceDatabase)) return { restored: false, reason: 'empty-seed' };
  if (lstatSync(sourceDatabase).isSymbolicLink()) throw new Error('Seed database must not be a symlink');

  const staged = path.join(destination, '.restore-in-progress');
  rmSync(staged, { recursive: true, force: true });
  mkdirSync(staged, { mode: 0o700 });
  function copyDirectory(from, to) {
    mkdirSync(to, { recursive: true, mode: 0o700 });
    own(to);
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (['studio.sqlite', 'studio.sqlite-wal', 'studio.sqlite-shm', '.DS_Store', '.restore-in-progress'].includes(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error('Seed data must not contain symlinks');
      const src = path.join(from, entry.name), dest = path.join(to, entry.name);
      if (entry.isDirectory()) copyDirectory(src, dest);
      else if (entry.isFile()) { copyFileSync(src, dest); chmodSync(dest, 0o600); own(dest); }
    }
  }
  let connection;
  try {
    connection = new DatabaseSync(sourceDatabase, { readOnly: true });
    await backup(connection, path.join(staged, 'studio.sqlite'));
    connection.close(); connection = undefined;
    copyDirectory(source, staged);
    // Publish the database last: an interrupted copy can be retried before the app starts.
    for (const name of readdirSync(staged).filter(name => name !== 'studio.sqlite')) {
      const dest = path.join(destination, name);
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
      renameSync(path.join(staged, name), dest);
    }
    const stagedDatabase = path.join(staged, 'studio.sqlite');
    chmodSync(stagedDatabase, 0o600); own(stagedDatabase);
    renameSync(stagedDatabase, database);
    rmSync(staged, { recursive: true, force: true });
    return { restored: true, reason: 'seed-restored' };
  } finally { connection?.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await restoreData(process.env.RESTORE_SOURCE || '/seed', process.env.RESTORE_DEST || '/restore', { uid: 1000, gid: 1000 });
  console.log(result.restored ? 'Workspace snapshot restored; starting with saved configuration.' : `Workspace initialization: ${result.reason}.`);
}
