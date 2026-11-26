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
      case 'invite-user': {
        const maxUses = a ? Number(a) : 1;
        if (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 1000) throw new Error('Usage: admin invite-user [maxUses]');
        const created = store.createRegistrationInvite('cli-admin', { maxUses, note: b });
        console.log(JSON.stringify(created, null, 2));
        break;
      }
      case 'devices': console.log(JSON.stringify(store.devices(), null, 2)); break;
      case 'revoke': if (!store.revoke(uuid.parse(a))) throw new Error('Unknown or revoked device.'); break;
      case 'oauth-revoke': store.revokeAllAuth(); break;
      case 'audit': {
        for (const row of store.recentAudit(100).reverse()) console.log(JSON.stringify(row));
        break;
      }
      default: throw new Error('Usage: admin pair|invite-user|devices|revoke|oauth-revoke|audit|backup|verify-backup|restore');
    }
  } finally { store.db.close(); }
}
