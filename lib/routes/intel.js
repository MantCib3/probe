'use strict';

const {
  isValidEmail, normalizePhone, isValidPhone, normalizeDomain, isValidDomain, normalizeEmail,
} = require('../validation');
const {
  probeGravatar, analyzeEmailDomain, probeHibpPublicPage, probeDuckDuckGoEmail, probeBingEmail,
  probeGitHubEmail, buildEmailPivots, analyzePhoneNumber, probeDuckDuckGoPhone, probeBingPhone,
  buildPhonePivots, probeDomainDns, probeDomainReachability, probeDomainCrtSh, buildDomainPivots,
} = require('../intel-probes');

async function streamTaskResults(send, startPayload, taskFactories) {
  const total = taskFactories.length;
  let done = 0;
  send({ type: 'start', total, ...startPayload });

  await Promise.all(taskFactories.map(factory => Promise.resolve()
    .then(factory)
    .catch(() => null)
    .then(item => {
      done += 1;
      if (item) send({ type: 'result', ...item, done, total });
    })));

  send({ type: 'done', done: total, total });
}

/* ── Email investigation SSE endpoint ──────────────────────────────── */
function handleEmailCheck(req, res, urlObj) {
  const email = (urlObj.searchParams.get('q') || '').trim();
  if (!isValidEmail(email)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid email address.' }));
  }

  res.writeHead(200, {
    'Content-Type' : 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection'   : 'keep-alive',
  });

  let cancelled = false;
  req.on('close', () => { cancelled = true; });

  const send = (obj) => {
    if (!cancelled && !res.writableEnded) {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    }
  };

  (async () => {
    const pivots = buildEmailPivots(email);
    const tasks = [
      () => probeGravatar(email),
      () => analyzeEmailDomain(email),
      () => probeHibpPublicPage(email),
      () => probeDuckDuckGoEmail(email),
      () => probeBingEmail(email),
      () => probeGitHubEmail(email),
      ...pivots.map(item => () => item),
    ];

    await streamTaskResults(send, { email: normalizeEmail(email) }, tasks);
    res.end();
  })().catch(() => {
    if (!res.writableEnded) {
      send({ type: 'done', done: 0, total: 0 });
      res.end();
    }
  });
  return;
}

function handlePhoneCheck(req, res, urlObj) {
  const phone = (urlObj.searchParams.get('q') || '').trim();
  if (!isValidPhone(phone)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid phone number. Use 7-15 digits with optional leading +.' }));
  }

  res.writeHead(200, {
    'Content-Type' : 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection'   : 'keep-alive',
  });

  let cancelled = false;
  req.on('close', () => { cancelled = true; });

  const send = (obj) => {
    if (!cancelled && !res.writableEnded) {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    }
  };

  (async () => {
    const normalized = normalizePhone(phone);
    const pivots = buildPhonePivots(normalized);
    const tasks = [
      () => analyzePhoneNumber(normalized),
      () => probeDuckDuckGoPhone(normalized),
      () => probeBingPhone(normalized),
      ...pivots.map(item => () => item),
    ];

    await streamTaskResults(send, { phone: normalized }, tasks);
    res.end();
  })().catch(() => {
    if (!res.writableEnded) {
      send({ type: 'done', done: 0, total: 0 });
      res.end();
    }
  });
  return;
}

function handleDomainCheck(req, res, urlObj) {
  const rawDomain = (urlObj.searchParams.get('q') || '').trim();
  if (!isValidDomain(rawDomain)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid domain. Use a hostname like example.com.' }));
  }

  const domain = normalizeDomain(rawDomain);

  res.writeHead(200, {
    'Content-Type' : 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection'   : 'keep-alive',
  });

  let cancelled = false;
  req.on('close', () => { cancelled = true; });

  const send = (obj) => {
    if (!cancelled && !res.writableEnded) {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    }
  };

  (async () => {
    const pivots = buildDomainPivots(domain);
    const tasks = [
      () => probeDomainDns(domain),
      () => probeDomainReachability(domain),
      () => probeDomainCrtSh(domain),
      ...pivots.map(item => () => item),
    ];

    await streamTaskResults(send, { domain }, tasks);
    res.end();
  })().catch(() => {
    if (!res.writableEnded) {
      send({ type: 'done', done: 0, total: 0 });
      res.end();
    }
  });
  return;
}

module.exports = { handleEmailCheck, handlePhoneCheck, handleDomainCheck };
