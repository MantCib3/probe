'use strict';

const dns = require('dns').promises;
const { fetchStatus } = require('./http-fetch');
const { hashBodySample, normalizeResult } = require('./classifier');
const { normalizePhone, isValidPhone, normalizeDomain, normalizeEmail, hashEmail } = require('./validation');

function makeIntelResult({ category, name, status, url, summary, detail, reasonCodes = [], extra = {} }) {
  return normalizeResult({
    name,
    category,
    status,
    url,
    summary,
    detail,
    mode: category,
    reasonCodes,
    evidence: {
      checkedAt: new Date().toISOString(),
      method: extra.method || (status === 'link' ? 'link' : `${category}_probe`),
      statusCode: extra.statusCode || 0,
      bodyHash: extra.bodyHash || null,
      reasons: reasonCodes,
    },
    ...extra,
  });
}

function makeEmailResult({ name, status, url, summary, detail, reasonCodes = [], extra = {} }) {
  return makeIntelResult({
    category: 'email',
    name,
    status,
    url,
    summary,
    detail,
    reasonCodes,
    extra,
  });
}

async function probeGravatar(email) {
  const emailHash = hashEmail(email);
  const avatarUrl = `https://www.gravatar.com/avatar/${emailHash}?d=404&s=256`;
  const profileUrl = `https://gravatar.com/${emailHash}`;
  const resp = await fetchStatus(avatarUrl);

  if (resp.statusCode === 200) {
    return makeEmailResult({
      name: 'Gravatar',
      status: 'found',
      url: profileUrl,
      summary: 'Public Gravatar avatar or profile data appears to exist for this email.',
      detail: 'Useful for avatars, bios, linked accounts, and profile metadata when the owner has enabled it.',
      reasonCodes: ['gravatar_profile_found'],
      extra: { statusCode: 200, bodyHash: hashBodySample(resp.body), method: 'gravatar' },
    });
  }

  if (resp.statusCode === 404) {
    return makeEmailResult({
      name: 'Gravatar',
      status: 'not_found',
      url: profileUrl,
      summary: 'No public Gravatar avatar was found for this email hash.',
      detail: 'This does not rule out the email being valid; it only means no public Gravatar profile was exposed here.',
      reasonCodes: ['gravatar_profile_not_found'],
      extra: { statusCode: 404, bodyHash: hashBodySample(resp.body), method: 'gravatar' },
    });
  }

  return makeEmailResult({
    name: 'Gravatar',
    status: 'unknown',
    url: profileUrl,
    summary: 'Gravatar lookup was inconclusive.',
    detail: 'The upstream service did not return a clear found/not found response.',
    reasonCodes: ['gravatar_inconclusive'],
    extra: { statusCode: resp.statusCode, bodyHash: hashBodySample(resp.body), method: 'gravatar' },
  });
}

async function analyzeEmailDomain(email) {
  const domain = normalizeEmail(email).split('@')[1] || '';
  let mx = [];
  let txt = [];
  let dmarc = [];

  try { mx = await dns.resolveMx(domain); } catch (_) {}
  try { txt = await dns.resolveTxt(domain); } catch (_) {}
  try { dmarc = await dns.resolveTxt(`_dmarc.${domain}`); } catch (_) {}

  const flatTxt = txt.flat().join(' ');
  const flatDmarc = dmarc.flat().join(' ');
  const hasMx = mx.length > 0;
  const hasSpf = /v=spf1/i.test(flatTxt);
  const hasDmarc = /v=dmarc1/i.test(flatDmarc);
  const mxPreview = hasMx ? mx.slice(0, 3).map(entry => entry.exchange).join(', ') : 'none detected';

  return makeEmailResult({
    name: 'Email Domain',
    status: hasMx ? 'found' : 'unknown',
    url: `https://${domain}`,
    summary: `MX ${hasMx ? 'present' : 'missing'} | SPF ${hasSpf ? 'present' : 'missing'} | DMARC ${hasDmarc ? 'present' : 'missing'}`,
    detail: `Mail exchangers: ${mxPreview}`,
    reasonCodes: [hasMx ? 'domain_mx_present' : 'domain_mx_missing'],
    extra: { method: 'dns' },
  });
}

async function probeHibpPublicPage(email) {
  const target = `https://haveibeenpwned.com/account/${encodeURIComponent(normalizeEmail(email))}`;
  const resp = await fetchStatus(target);
  const body = (resp.body || '').toLowerCase();

  if (body.includes('good news') && body.includes('no pwnage found')) {
    return makeEmailResult({
      name: 'Have I Been Pwned',
      status: 'not_found',
      url: target,
      summary: 'Public breach page indicates no known pwnage for this email.',
      detail: 'Treat as an indicator only. Breach status can change over time.',
      reasonCodes: ['hibp_page_no_pwnage'],
      extra: { statusCode: resp.statusCode, bodyHash: hashBodySample(resp.body), method: 'hibp_page' },
    });
  }

  if (body.includes('oh no') && body.includes('pwned')) {
    return makeEmailResult({
      name: 'Have I Been Pwned',
      status: 'found',
      url: target,
      summary: 'Public breach page indicates this email appears in known breaches.',
      detail: 'Open the source for breach names and exposure details.',
      reasonCodes: ['hibp_page_pwned'],
      extra: { statusCode: resp.statusCode, bodyHash: hashBodySample(resp.body), method: 'hibp_page' },
    });
  }

  return makeEmailResult({
    name: 'Have I Been Pwned',
    status: 'unknown',
    url: target,
    summary: 'Breach page could not be classified automatically.',
    detail: 'Open the page directly to validate current status.',
    reasonCodes: ['hibp_page_inconclusive'],
    extra: { statusCode: resp.statusCode, bodyHash: hashBodySample(resp.body), method: 'hibp_page' },
  });
}

async function probeWebSearch(name, target, markerRegex, foundReason, notFoundReason) {
  const resp = await fetchStatus(target);
  const body = String(resp.body || '');
  const matchCount = (body.match(markerRegex) || []).length;

  if (matchCount > 0) {
    return makeEmailResult({
      name,
      status: 'found',
      url: target,
      summary: `Indexed references found (${matchCount} signal${matchCount === 1 ? '' : 's'}).`,
      detail: 'Open source results to inspect context and attribution.',
      reasonCodes: [foundReason],
      extra: { statusCode: resp.statusCode, bodyHash: hashBodySample(resp.body), method: 'web_search', signalCount: matchCount },
    });
  }

  if (resp.statusCode === 200) {
    return makeEmailResult({
      name,
      status: 'not_found',
      url: target,
      summary: 'No strong indexed references were detected automatically.',
      detail: 'Manual review may still reveal edge-case hits.',
      reasonCodes: [notFoundReason],
      extra: { statusCode: resp.statusCode, bodyHash: hashBodySample(resp.body), method: 'web_search', signalCount: 0 },
    });
  }

  return makeEmailResult({
    name,
    status: 'unknown',
    url: target,
    summary: 'Search source response was inconclusive.',
    detail: 'Source may block automation or require interactive checks.',
    reasonCodes: ['email_source_inconclusive'],
    extra: { statusCode: resp.statusCode, bodyHash: hashBodySample(resp.body), method: 'web_search', signalCount: 0 },
  });
}

async function probeDuckDuckGoEmail(email) {
  const target = `https://duckduckgo.com/html/?q=${encodeURIComponent(`"${normalizeEmail(email)}"`)}`;
  return probeWebSearch('DuckDuckGo', target, /result__a|result-link/gi, 'duckduckgo_email_hits', 'duckduckgo_email_no_hits');
}

async function probeBingEmail(email) {
  const target = `https://www.bing.com/search?q=${encodeURIComponent(`"${normalizeEmail(email)}"`)}`;
  return probeWebSearch('Bing', target, /<li class="b_algo"|b_title/gi, 'bing_email_hits', 'bing_email_no_hits');
}

async function probeGitHubEmail(email) {
  const target = `https://github.com/search?q=${encodeURIComponent(`"${normalizeEmail(email)}"`)}&type=code`;
  return probeWebSearch('GitHub Search', target, /code-list-item|search-title|repo-list-item/gi, 'github_email_hits', 'github_email_no_hits');
}

function buildEmailPivots(email) {
  const encoded = encodeURIComponent(normalizeEmail(email));

  return [
    makeEmailResult({
      name: 'IntelX Search Pivot',
      status: 'link',
      url: `https://intelx.io/?s=${encoded}`,
      summary: 'Open deep-index search for leaked and indexed references.',
      detail: 'Useful for deeper manual validation when automated checks are inconclusive.',
      reasonCodes: ['manual_intel_pivot'],
      extra: { method: 'link' },
    }),
  ];
}

function guessPhoneRegion(phone) {
  const p = normalizePhone(phone);
  if (p.startsWith('+1')) return 'North America (+1)';
  if (p.startsWith('+44')) return 'United Kingdom (+44)';
  if (p.startsWith('+61')) return 'Australia (+61)';
  if (p.startsWith('+91')) return 'India (+91)';
  if (p.startsWith('+81')) return 'Japan (+81)';
  if (p.startsWith('+49')) return 'Germany (+49)';
  if (p.startsWith('+33')) return 'France (+33)';
  if (p.startsWith('+34')) return 'Spain (+34)';
  return p.startsWith('+') ? 'International format detected' : 'Local format detected';
}

function analyzePhoneNumber(phone) {
  const normalized = normalizePhone(phone);
  const valid = isValidPhone(normalized);
  return makeIntelResult({
    category: 'phone',
    name: 'Phone Structure',
    status: valid ? 'found' : 'unknown',
    url: `https://www.google.com/search?q=${encodeURIComponent(`"${normalized}"`)}`,
    summary: valid
      ? `Format valid (${normalized.length - (normalized.startsWith('+') ? 1 : 0)} digits).`
      : 'Phone format could not be validated confidently.',
    detail: valid
      ? `Region hint: ${guessPhoneRegion(normalized)}`
      : 'Try international format with country code, e.g. +1 555 123 4567.',
    reasonCodes: [valid ? 'phone_format_valid' : 'phone_format_unknown'],
    extra: { method: 'phone_format' },
  });
}

async function probeDuckDuckGoPhone(phone) {
  const normalized = normalizePhone(phone);
  const target = `https://duckduckgo.com/html/?q=${encodeURIComponent(`"${normalized}"`)}`;
  const result = await probeWebSearch('DuckDuckGo Phone', target, /result__a|result-link/gi, 'phone_search_hits', 'phone_search_no_hits');
  return { ...result, category: 'phone', mode: 'phone' };
}

async function probeBingPhone(phone) {
  const normalized = normalizePhone(phone);
  const target = `https://www.bing.com/search?q=${encodeURIComponent(`"${normalized}"`)}`;
  const result = await probeWebSearch('Bing Phone', target, /<li class="b_algo"|b_title/gi, 'phone_search_hits', 'phone_search_no_hits');
  return { ...result, category: 'phone', mode: 'phone' };
}

function buildPhonePivots(phone) {
  const normalized = normalizePhone(phone);
  const encoded = encodeURIComponent(normalized);
  const digitsOnly = normalized.replace(/^\+/, '');
  return [
    makeIntelResult({
      category: 'phone',
      name: 'Google Reverse Pivot',
      status: 'link',
      url: `https://www.google.com/search?q=${encodeURIComponent(`"${normalized}"`)}`,
      summary: 'Open web search pivot for reverse-phone traces.',
      detail: 'Useful for listings, forum posts, and cached directories.',
      reasonCodes: ['manual_search_pivot'],
      extra: { method: 'link' },
    }),
    makeIntelResult({
      category: 'phone',
      name: 'IntelX Phone Pivot',
      status: 'link',
      url: `https://intelx.io/?s=${encoded}`,
      summary: 'Open deep-index phone pivot for leaked/indexed mentions.',
      detail: 'Useful when direct indexing checks are inconclusive.',
      reasonCodes: ['manual_intel_pivot'],
      extra: { method: 'link' },
    }),
    makeIntelResult({
      category: 'phone',
      name: 'That\'sThem Pivot',
      status: 'link',
      url: `https://thatsthem.com/phone/${encodeURIComponent(digitsOnly)}`,
      summary: 'Open reverse-phone directory pivot.',
      detail: 'Best-effort public directory source; verify manually.',
      reasonCodes: ['manual_search_pivot'],
      extra: { method: 'link' },
    }),
  ];
}

async function probeDomainDns(domain) {
  const d = normalizeDomain(domain);
  let a = [];
  let aaaa = [];
  let mx = [];
  let ns = [];

  try { a = await dns.resolve4(d); } catch (_) {}
  try { aaaa = await dns.resolve6(d); } catch (_) {}
  try { mx = await dns.resolveMx(d); } catch (_) {}
  try { ns = await dns.resolveNs(d); } catch (_) {}

  const hasSignals = a.length > 0 || aaaa.length > 0 || mx.length > 0 || ns.length > 0;
  const summary = `A ${a.length} | AAAA ${aaaa.length} | MX ${mx.length} | NS ${ns.length}`;

  return makeIntelResult({
    category: 'domain',
    name: 'DNS Signals',
    status: hasSignals ? 'found' : 'unknown',
    url: `https://${d}`,
    summary,
    detail: hasSignals
      ? `NS sample: ${(ns.slice(0, 2).join(', ') || 'n/a')}`
      : 'No strong DNS signals detected via resolver checks.',
    reasonCodes: [hasSignals ? 'domain_dns_present' : 'domain_dns_missing'],
    extra: { method: 'dns' },
  });
}

async function probeDomainReachability(domain) {
  const d = normalizeDomain(domain);
  const httpsResp = await fetchStatus(`https://${d}`);
  const httpResp = await fetchStatus(`http://${d}`);

  if (httpsResp.statusCode >= 200 && httpsResp.statusCode < 500) {
    return makeIntelResult({
      category: 'domain',
      name: 'Web Reachability',
      status: 'found',
      url: `https://${d}`,
      summary: `HTTPS responded with status ${httpsResp.statusCode}.`,
      detail: 'Domain is reachable over HTTPS.',
      reasonCodes: ['domain_https_reachable'],
      extra: { statusCode: httpsResp.statusCode, bodyHash: hashBodySample(httpsResp.body), method: 'http' },
    });
  }

  if (httpResp.statusCode >= 200 && httpResp.statusCode < 500) {
    return makeIntelResult({
      category: 'domain',
      name: 'Web Reachability',
      status: 'unknown',
      url: `http://${d}`,
      summary: `HTTP responded with status ${httpResp.statusCode}; HTTPS did not respond clearly.`,
      detail: 'Domain appears reachable but TLS endpoint may be restricted or unavailable.',
      reasonCodes: ['domain_http_only'],
      extra: { statusCode: httpResp.statusCode, bodyHash: hashBodySample(httpResp.body), method: 'http' },
    });
  }

  return makeIntelResult({
    category: 'domain',
    name: 'Web Reachability',
    status: 'unknown',
    url: `https://${d}`,
    summary: 'Domain web endpoint did not respond clearly.',
    detail: 'Could be offline, parked, blocked, or challenge-protected.',
    reasonCodes: ['domain_unreachable'],
    extra: { statusCode: httpsResp.statusCode || httpResp.statusCode || 0, method: 'http' },
  });
}

async function probeDomainCrtSh(domain) {
  const d = normalizeDomain(domain);
  const target = `https://crt.sh/?q=${encodeURIComponent(d)}&output=json`;
  const resp = await fetchStatus(target);
  const body = String(resp.body || '');
  const count = (body.match(/"name_value"/g) || []).length;
  const found = resp.statusCode === 200 && count > 0;

  return makeIntelResult({
    category: 'domain',
    name: 'Certificate Transparency',
    status: found ? 'found' : (resp.statusCode === 200 ? 'not_found' : 'unknown'),
    url: `https://crt.sh/?q=${encodeURIComponent(d)}`,
    summary: found
      ? `Certificate records detected (${count} entries).`
      : resp.statusCode === 200
        ? 'No certificate records detected in this query response.'
        : 'Certificate lookup response was inconclusive.',
    detail: 'Use certificate history to pivot on subdomains and infrastructure.',
    reasonCodes: [found ? 'crtsh_hits' : 'crtsh_no_hits'],
    extra: { statusCode: resp.statusCode, bodyHash: hashBodySample(resp.body), method: 'crtsh' },
  });
}

function buildDomainPivots(domain) {
  const d = normalizeDomain(domain);
  return [
    makeIntelResult({
      category: 'domain',
      name: 'Whois Lookup Pivot',
      status: 'link',
      url: `https://who.is/whois/${encodeURIComponent(d)}`,
      summary: 'Open WHOIS pivot for registration history and registrar data.',
      detail: 'Useful for ownership and registration timeline checks.',
      reasonCodes: ['manual_search_pivot'],
      extra: { method: 'link' },
    }),
    makeIntelResult({
      category: 'domain',
      name: 'DNSdumpster Pivot',
      status: 'link',
      url: `https://dnsdumpster.com/static/map/${encodeURIComponent(d)}.png`,
      summary: 'Open DNS infrastructure pivot.',
      detail: 'Best-effort infrastructure map artifact; may not exist for every domain.',
      reasonCodes: ['manual_search_pivot'],
      extra: { method: 'link' },
    }),
    makeIntelResult({
      category: 'domain',
      name: 'VirusTotal GUI Pivot',
      status: 'link',
      url: `https://www.virustotal.com/gui/domain/${encodeURIComponent(d)}`,
      summary: 'Open reputation and passive DNS pivot.',
      detail: 'Useful for reputation context and linked artifacts.',
      reasonCodes: ['manual_search_pivot'],
      extra: { method: 'link' },
    }),
  ];
}

module.exports = { probeGravatar, analyzeEmailDomain, probeHibpPublicPage, probeDuckDuckGoEmail,
  probeBingEmail, probeGitHubEmail, buildEmailPivots, analyzePhoneNumber, probeDuckDuckGoPhone,
  probeBingPhone, buildPhonePivots, probeDomainDns, probeDomainReachability, probeDomainCrtSh,
  buildDomainPivots };
