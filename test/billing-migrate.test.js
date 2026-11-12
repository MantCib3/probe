'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { migrate } = require('../scripts/billing-migrate');

const directory = path.join(__dirname, '..', 'migrations', 'billing');
const digest = value => createHash('sha256').update(value).digest('hex');
function fixture(style, changed = false) {
  const queries = [];
  const client = { connection: { stream: { encrypted: true, authorized: true } }, release() {},
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.includes("current_setting('server_version_num')")) return { rows: [{ version: 170000 }], rowCount: 1 };
      if (sql.startsWith('SELECT sha256')) {
        let content = fs.readFileSync(path.join(directory, values[0]), 'utf8').replace(/\r\n/g, '\n');
        if (style === 'crlf') content = content.replace(/\n/g, '\r\n');
        if (changed) content += '\nSELECT 1;\n';
        return { rows: [{ sha256: digest(content) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    } };
  return { queries, async connect() { return client; } };
}
test('migration checks accept exact legacy LF/CRLF SQL without replaying or rewriting history', async () => {
  for (const style of ['lf','crlf']) {
    const pool = fixture(style);
    assert.equal(await migrate(pool), 6);
    assert.equal(pool.queries.some(query => query.sql.startsWith('INSERT INTO probe_billing.migrations')), false);
    assert.equal(pool.queries.some(query => query.sql.includes('ALTER TABLE probe_billing.collections')), false);
    assert.equal(pool.queries.some(query => query.sql === 'COMMIT'), true);
  }
});
test('substantive migration checksum changes still fail and roll back', async () => {
  const pool = fixture('lf', true);
  await assert.rejects(migrate(pool), { code: 'MIGRATION_CHECKSUM_MISMATCH' });
  assert.equal(pool.queries.some(query => query.sql === 'ROLLBACK'), true);
  assert.equal(pool.queries.some(query => query.sql === 'COMMIT'), false);
});
