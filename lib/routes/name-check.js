'use strict';

const { NAME_SITES } = require('../config');
const { normalizeResult } = require('../classifier');
const { isValidName } = require('../validation');
const { buildNameUrl, probeNameSearch } = require('../name-search');

/* ── Real-name SSE endpoint ─────────────────────────────────────────── */
function handleNameCheck(req, res, urlObj) {
  const q = (urlObj.searchParams.get('q') || '').trim();
  const city = (urlObj.searchParams.get('city') || '').trim();
  const state = (urlObj.searchParams.get('state') || '').trim();
  const ageMinRaw = (urlObj.searchParams.get('ageMin') || '').trim();
  const ageMaxRaw = (urlObj.searchParams.get('ageMax') || '').trim();
  const ageMinNum = ageMinRaw === '' ? null : Number(ageMinRaw);
  const ageMaxNum = ageMaxRaw === '' ? null : Number(ageMaxRaw);
  const ageMin = Number.isFinite(ageMinNum) && ageMinNum >= 0 && ageMinNum <= 120 ? String(Math.floor(ageMinNum)) : '';
  const ageMax = Number.isFinite(ageMaxNum) && ageMaxNum >= 0 && ageMaxNum <= 120 ? String(Math.floor(ageMaxNum)) : '';
  const filters = {
    city: city.slice(0, 60),
    state: state.slice(0, 40),
    ageMin,
    ageMax,
  };
  if (!isValidName(q)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid name. Use letters, spaces, hyphens, apostrophes (2-80 chars).' }));
  }

  // Parse first / last names
  const parts     = q.split(/\s+/);
  const firstName = parts[0];
  const lastName  = parts.slice(1).join(' ') || '';

  res.writeHead(200, {
    'Content-Type' : 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection'   : 'keep-alive',
  });

  let cancelled = false;
  req.on('close', () => { cancelled = true; });

  const queue = [...NAME_SITES];
  const total = queue.length;
  let idx = 0, active = 0, done = 0;
  const NAME_CONCURRENCY = 2;

  const send = (obj) => {
    if (!cancelled && !res.writableEnded) {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    }
  };

  send({ type: 'start', total, name: q, firstName, lastName, filters });

  function normalizeNameResult(site, rawResult) {
    const resultCount = typeof rawResult.resultCount === 'number' ? rawResult.resultCount : null;
    const statusReason = rawResult.status === 'found'
      ? 'name_results_pattern_matched'
      : rawResult.status === 'not_found'
        ? 'name_no_results_message'
        : 'name_search_inconclusive';
    const reasonCodes = Array.isArray(rawResult.reasonCodes) && rawResult.reasonCodes.length
      ? rawResult.reasonCodes
      : [statusReason];
    const challengeDetected = reasonCodes.includes('cloudflare_or_challenge_detected');

    const summary = challengeDetected
      ? 'Source returned a challenge page, so automatic classification was limited.'
      : rawResult.status === 'found'
      ? `Potential people records detected${resultCount !== null ? ` (${resultCount})` : ''}.`
      : rawResult.status === 'not_found'
        ? 'No obvious people records detected.'
        : 'Result was inconclusive and may need manual verification.';
    const detail = challengeDetected
      ? `Source: ${site.name}. Challenge protection detected; open source manually to continue.`
      : `Source: ${site.name}`;

    return normalizeResult({
      ...rawResult,
      mode: 'name',
      summary,
      detail,
      reasonCodes,
      evidence: rawResult.evidence || {
        checkedAt: new Date().toISOString(),
        method: 'name_search',
        statusCode: rawResult.statusCode || 0,
        bodyHash: null,
        reasons: reasonCodes,
      },
    });
  }

  function tick() {
    while (active < NAME_CONCURRENCY && idx < total) {
      const site = queue[idx++];
      active++;
      probeNameSearch(site, firstName, lastName, filters)
        .then(raw => normalizeNameResult(site, raw))
        .catch(() => normalizeNameResult(site, {
          name: site.name,
          category: 'people-finder',
          url: buildNameUrl(site, firstName, lastName, filters),
          status: 'unknown',
          statusCode: 0,
        }))
        .then(result => {
          active--;
          done++;
          if (!cancelled) send({ type: 'result', ...result, done, total });
          tick();
        });
    }

    if (idx >= total && active === 0 && !res.writableEnded) {
      send({ type: 'done', done, total });
      res.end();
    }
  }

  tick();
  return;
}

module.exports = { handleNameCheck };
