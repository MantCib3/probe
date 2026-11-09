'use strict';

const { Pool } = require('pg');
const { connectionOptions } = require('../../scripts/billing-check');
function createPool(env = process.env) {
  const pool = new Pool({ ...connectionOptions(env), max: 4,
    application_name: 'probe-staging-billing' });
  pool.on('error', () => console.error('[billing] database pool error; details withheld.'));
  return pool;
}
async function transaction(pool, action) {
  const client = await pool.connect();
  let discarded = false;
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch (_) { client.release(true); discarded = true; throw error; }
    throw error;
  } finally {
    if (!discarded) client.release();
  }
}
module.exports = { createPool, transaction };
