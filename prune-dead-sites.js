#!/usr/bin/env node
/**
 * prune-dead-sites.js
 *
 * Checks every entry in sites.json for basic network reachability
 * (DNS resolution + TCP connect + HTTP response) and marks genuinely
 * dead sites with { defunct: true } so server.js filters them out.
 *
 * A site is considered DEAD only when its root domain is completely
 * unreachable — DNS failure, connection refused, or a hard non-2xx/3xx
 * status (i.e. 4xx/5xx on the main URL). Sites that are slow, return
 * auth walls (401/403), or use weak verification are kept as-is.
 *
 * Usage:
 *   node prune-dead-sites.js [--dry-run] [--concurrency=N] [--timeout=N]
 *
 * Flags:
 *   --dry-run        Print results but don't write back sites.json
 *   --concurrency=N  Parallel workers (default: 30)
 *   --timeout=N      Per-site timeout in ms (default: 8000)
 */

'use strict';
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const http    = require('http');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args       = process.argv.slice(2);
const DRY_RUN    = args.includes('--dry-run');
const CONCURRENCY = parseInt((args.find(a => a.startsWith('--concurrency=')) || '--concurrency=30').split('=')[1], 10);
const TIMEOUT_MS  = parseInt((args.find(a => a.startsWith('--timeout='))     || '--timeout=8000').split('=')[1], 10);

// ── Load sites ────────────────────────────────────────────────────────────────
const SITES_PATH = path.join(__dirname, 'sites.json');
const sites = JSON.parse(fs.readFileSync(SITES_PATH, 'utf8'));

// ── Reachability probe ────────────────────────────────────────────────────────
/**
 * Returns { alive: bool, status: number|null, reason: string }.
 * "alive" = true if we got ANY valid HTTP response (including 4xx/5xx that
 * prove the server is there) or a redirect.  Only DNS/connect/timeout
 * failures mean the site is actually gone.
 */
function probe(rawUrl) {
  return new Promise(resolve => {
    let parsed;
    try { parsed = new URL(rawUrl); } catch (_) {
      return resolve({ alive: false, status: null, reason: 'invalid-url' });
    }
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(parsed, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SiteProbe/1.0)',
        'Accept': 'text/html',
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      res.resume(); // consume and discard body
      const s = res.statusCode;
      // Any HTTP response (even 403/404/503) proves the domain is alive.
      // We only treat 4xx/5xx on the main page as "dead" if combined with
      // a DNS/connect error on retry — here we keep it alive.
      resolve({ alive: true, status: s, reason: `http-${s}` });
    });
    req.on('error', (err) => {
      const code = err.code || 'UNKNOWN';
      // These error codes mean the domain genuinely doesn't exist or the
      // server is gone. Anything else (ECONNRESET, ETIMEDOUT, etc.) might
      // be a transient block — be conservative and keep the site.
      const dead = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH'].includes(code);
      resolve({ alive: !dead, status: null, reason: code });
    });
    req.on('timeout', () => {
      req.destroy();
      // Timeout = server is there but slow/blocking HEAD — keep alive.
      resolve({ alive: true, status: null, reason: 'timeout' });
    });
    req.end();
  });
}

// ── Concurrency pool ──────────────────────────────────────────────────────────
async function runPool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const total     = sites.length;
  const alreadyDefunct = sites.filter(s => s.defunct).length;

  console.log(`Probing ${total} sites (${alreadyDefunct} already defunct)…`);
  console.log(`Concurrency: ${CONCURRENCY}  |  Timeout: ${TIMEOUT_MS}ms  |  Dry-run: ${DRY_RUN}`);
  console.log('─'.repeat(60));

  let done = 0;
  const tasks = sites.map((site, idx) => async () => {
    // Already marked defunct — skip the network call but keep the flag.
    if (site.defunct) {
      done++;
      return;
    }

    // Derive the base URL to probe: prefer urlMain, fall back to url.
    // Many entries use wildcard subdomains like "https://{}.example.com" —
    // strip the "{}" placeholder (and the dot-separator before it) so we
    // resolve and connect to the actual registered domain, not a literal
    // "{}.example.com" hostname that will always NXDOMAIN.
    const rawUrl = (site.urlMain || site.url || '').replace(/\{\}\./g, '').replace(/\{\}/g, '');
    // Only probe the root origin (no path) to avoid auth-wall false positives.
    let probeUrl = rawUrl;
    try {
      const p = new URL(rawUrl);
      probeUrl = `${p.protocol}//${p.host}`;
    } catch (_) { /* use rawUrl as-is */ }

    const result = await probe(probeUrl);

    done++;
    if (done % 50 === 0 || done === total) {
      process.stdout.write(`\r  ${done}/${total} checked…`);
    }

    if (!result.alive) {
      sites[idx] = { ...site, defunct: true };
      console.log(`\n  ✗ DEAD  ${site.name.padEnd(35)} ${probeUrl} (${result.reason})`);
    }
  });

  await runPool(tasks, CONCURRENCY);
  process.stdout.write('\n');

  const nowDefunct = sites.filter(s => s.defunct).length;
  const newlyPruned = nowDefunct - alreadyDefunct;

  console.log('─'.repeat(60));
  console.log(`Done.  ${newlyPruned} newly marked defunct  |  ${nowDefunct} total defunct  |  ${total - nowDefunct} active`);

  if (DRY_RUN) {
    console.log('(dry-run — sites.json not written)');
  } else {
    fs.writeFileSync(SITES_PATH, JSON.stringify(sites, null, 2), 'utf8');
    console.log(`Wrote ${SITES_PATH}`);
  }
})();
