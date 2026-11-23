import { Store } from './store.js';
import { capabilities, uuid, type Capability } from './protocol.js';
import { exportDatabase, importDatabase } from './database-transfer.js';
const [cmd, a, b, ...extra] = process.argv.slice(2);
if (extra.length) throw new Error('Unexpected arguments.');
const database = process.env.STATE_DB ?? 'state/gateway.sqlite';
if (cmd === 'backup' || cmd === 'verify-backup' || cmd === 'restore') {
  if (a || b) throw new Error('backup, verify-backup and restore do not accept additional arguments. Set STATE_DB to select the database.');
  if (cmd === 'backup') await exportDatabase(database);
  else {
    await importDatabase(database, cmd === 'verify-backup');
    console.log(cmd === 'verify-backup' ? 'Backup passed the SQLite integrity check.' : 'Database restored to a new file. Pair devices and authorize ChatGPT again.');
  }
} else {
const store = new Store(database);
try {
  switch (cmd) {
    case 'pair': {
      const caps = (b ?? 'read').split(',') as Capability[];
      if (!a || a.length > 80 || /[\u0000-\u001f\u007f]/.test(a) || new Set(caps).size !== caps.length || !caps.every(c => capabilities.includes(c)))
        throw new Error('Usage: admin pair NAME [read,write,exec]');
      console.log(store.invite(a, caps));
      break;
    }
    case 'devices': console.log(JSON.stringify(store.devices(), null, 2)); break;
    case 'revoke': if (!store.revoke(uuid.parse(a))) throw new Error('Unknown or revoked device.'); break;
    case 'oauth-revoke': store.tx(() => { store.db.exec('DELETE FROM auth'); store.audit('oauth_revoked_all'); }); break;
    case 'audit': {
      const rows = store.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 100').all().reverse();
      for (const row of rows) console.log(JSON.stringify({ ...row, at: new Date(Number(row.at)).toISOString(), details: JSON.parse(String(row.details)) }));
      break;
    }
    default: throw new Error('Usage: admin pair|devices|revoke|oauth-revoke|audit|backup|verify-backup|restore');
  }
} finally { store.db.close(); }
}
