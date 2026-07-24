'use strict';

/* ── Constants ───────────────────────────────────────────────────────── */
const STATUS_LABEL = {
  found    : 'FOUND',
  not_found: 'NOT FOUND',
  deleted  : 'DELETED',
  error    : 'ERROR',
  timeout  : 'TIMEOUT',
  unknown  : 'UNKNOWN',
  link     : 'OPEN',
};

const REASON_LABEL = {
  body_guard_username_match: 'Username matched on page',
  body_guard_no_username_match: 'Profile loaded but username was not confirmed',
  site_positive_message: 'Site-specific positive signal matched',
  skip_body_check_enabled: 'Direct profile response accepted',
  username_present_in_body: 'Username explicitly present in page content',
  username_missing_in_body: 'Username missing from expected page content',
  title_not_found_pattern: 'Page title indicates account not found',
  body_not_found_pattern: 'Page content indicates account not found',
  body_deleted_pattern: 'Page content indicates a deleted or suspended account',
  redirect_auth_login: 'Redirected to login or auth flow',
  redirect_reachable: 'Profile URL remained reachable after redirect',
  title_blocked_pattern: 'Challenge or bot-check page detected',
  body_blocked_pattern: 'Bot-protection content detected',
  browser_fallback: 'Resolved after browser rendering',
  site_specific_not_found_status: 'Site returned a known not-found status',
  http_404: 'Profile returned HTTP 404',
  http_410: 'Profile returned HTTP 410',
  site_error_message: 'Site-specific missing-account message matched',
  request_timeout: 'Request timed out',
  request_error: 'Request failed',
  inconclusive_result: 'Automatic check was inconclusive',
  gravatar_profile_found: 'Public Gravatar data appears available',
  gravatar_profile_not_found: 'No public Gravatar profile was found',
  gravatar_inconclusive: 'Gravatar response was inconclusive',
  domain_mx_present: 'Mail exchange records were found for this domain',
  domain_mx_missing: 'No mail exchange records were detected for this domain',
  manual_breach_lookup: 'Open a breach search for this email',
  manual_search_pivot: 'Open a web-search pivot for this email',
  manual_intel_pivot: 'Open deeper investigation pivot',
  hibp_page_pwned: 'Breach page indicates exposure',
  hibp_page_no_pwnage: 'Breach page indicates no known pwnage',
  hibp_page_inconclusive: 'Breach page could not be classified automatically',
  duckduckgo_email_hits: 'DuckDuckGo found indexed references',
  duckduckgo_email_no_hits: 'DuckDuckGo returned no strong indexed references',
  bing_email_hits: 'Bing found indexed references',
  bing_email_no_hits: 'Bing returned no strong indexed references',
  github_email_hits: 'GitHub search found indexed references',
  github_email_no_hits: 'GitHub search returned no strong indexed references',
  email_source_inconclusive: 'Email source response was inconclusive',
  name_results_pattern_matched: 'People-finder page matched result signals',
  name_no_results_message: 'People-finder page matched no-result signals',
  name_search_inconclusive: 'People-finder source was inconclusive',
  phone_format_valid: 'Phone format appears valid',
  phone_format_unknown: 'Phone format could not be fully validated',
  phone_search_hits: 'Indexed references were found for this phone number',
  phone_search_no_hits: 'No strong indexed phone references were detected',
  domain_dns_present: 'Domain DNS records were detected',
  domain_dns_missing: 'Domain DNS records were not detected',
  domain_https_reachable: 'HTTPS endpoint responded',
  domain_http_only: 'Only HTTP endpoint responded',
  domain_unreachable: 'Domain web endpoint was not reachable',
  crtsh_hits: 'Certificate transparency records were detected',
  crtsh_no_hits: 'No certificate transparency records were detected',
  cloudflare_or_challenge_detected: 'Challenge or protection page detected',
  http_fallback_results_pattern: 'HTTP fallback found expected result patterns',
  http_fallback_no_results: 'HTTP fallback found explicit no-result signals',
  http_fallback_not_found: 'HTTP fallback returned not-found status',
};

/* ── State ───────────────────────────────────────────────────────────── */
let results       = [];   // all result objects from this scan
let manualResults = [];   // undetectable sites routed to manual panel
let evtSource     = null; // active EventSource
let activeFilter  = 'all';
let foundOnly     = false;
let scanActive    = false;
let foundInsertIdx = 0;   // grid insertion cursor for found/deleted cards
let manualOpen    = false;
let currentMode   = 'username'; // 'username' | 'email' | 'phone' | 'domain' | 'name'
let quickCheckTimer = null;
let quickCheckAbort = null;
let caseEvents = [];
/* ── DOM refs ────────────────────────────────────────────────────────── */
const $  = (id) => document.getElementById(id);
const usernameInput     = $('usernameInput');
const scanBtn           = $('scanBtn');
const quickChecks       = $('quickChecks');
const searchError       = $('searchError');
const scanProgressSec   = $('scanProgressSection');
const resultsSec        = $('resultsSection');
const progressBarFill   = $('progressBarFill');
const progressStatus    = $('progressStatus');
const currentUsername   = $('currentUsername');
const cancelBtn         = $('cancelBtn');
const statChecked       = $('statChecked');
const statTotal         = $('statTotal');
const statFound         = $('statFound');
const statDeleted       = $('statDeleted');
const statNotFound      = $('statNotFound');
const resultsGrid       = $('resultsGrid');
const completionBar     = $('completionBar');
const completionText    = $('completionText');
const foundOnlyToggle   = $('foundOnlyToggle');
const exportCsvBtn      = $('exportCsvBtn');
const exportJsonBtn     = $('exportJsonBtn');
const openFoundBtn      = $('openFoundBtn');
const copyUrlsBtn       = $('copyUrlsBtn');
const newScanBtn        = $('newScanBtn');
const platformsGrid     = $('platformsGrid');
const manualCheckPanel  = $('manualCheckPanel');
const manualCheckBody   = $('manualCheckBody');
const manualCheckCount  = $('manualCheckCount');
const manualLinksList   = $('manualLinksList');
const manualChevron     = $('manualChevron');
const manualCheckToggle = $('manualCheckToggle');
const caseTimeline      = $('caseTimeline');
const evidencePanel     = $('evidencePanel');
const filterCategories  = $('filterCategories');
const navbar            = $('navbar');
const hamburger         = $('hamburger');
const navMenu           = $('navMenu');
const searchBoxEmail    = $('searchBoxEmail');
const emailInput        = $('emailInput');
const emailScanBtn      = $('emailScanBtn');
const searchBoxPhone    = $('searchBoxPhone');
const phoneInput        = $('phoneInput');
const phoneScanBtn      = $('phoneScanBtn');
const searchBoxDomain   = $('searchBoxDomain');
const domainInput       = $('domainInput');
const domainScanBtn     = $('domainScanBtn');
const searchBoxName     = $('searchBoxName');
const nameInput         = $('nameInput');
const nameScanBtn       = $('nameScanBtn');
const nameFilters       = $('nameFilters');
const nameCityInput     = $('nameCityInput');
const nameStateInput    = $('nameStateInput');
const nameAgeMinInput   = $('nameAgeMinInput');
const nameAgeMaxInput   = $('nameAgeMaxInput');
const emailHint         = $('emailHint');
const phoneHint         = $('phoneHint');
const domainHint        = $('domainHint');
const nameHint          = $('nameHint');
const searchHint        = $('searchHint');

/* ── Security helpers ────────────────────────────────────────────────── */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeUrl(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') ? url : '#';
  } catch (_) { return '#'; }
}

/* ── Validation ──────────────────────────────────────────────────────── */
function validateUsername(val) {
  if (!val)                   return 'Please enter a username.';
  if (val.length > 50)        return 'Username must be 50 characters or fewer.';
  if (!/^[a-zA-Z0-9._\-]+$/.test(val)) return 'Username may only contain letters, numbers, dots, hyphens, and underscores.';
  return null;
}
function validateName(val) {
  if (!val || val.trim().length < 2) return 'Please enter a full name.';
  if (val.trim().length > 80)        return 'Name must be 80 characters or fewer.';
  if (!/^[a-zA-Z][a-zA-Z '\-.]+$/.test(val.trim())) return 'Name may only contain letters, spaces, hyphens, apostrophes, and dots.';
  return null;
}

function validateEmail(val) {
  if (!val) return 'Please enter an email address.';
  if (val.length > 254) return 'Email must be 254 characters or fewer.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val.trim())) return 'Please enter a valid email address.';
  return null;
}

function validatePhone(val) {
  if (!val) return 'Please enter a phone number.';
  const normalized = String(val).replace(/[\s().-]/g, '');
  if (!/^\+?[0-9]{7,15}$/.test(normalized)) {
    return 'Use a valid phone format (7-15 digits, optional leading +).';
  }
  return null;
}

function validateDomain(val) {
  if (!val) return 'Please enter a domain.';
  const cleaned = String(val).trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  if (cleaned.length > 253) return 'Domain must be 253 characters or fewer.';
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(cleaned)) {
    return 'Use a valid domain like example.com.';
  }
  return null;
}

function humanizeReasons(reasonCodes = []) {
  return reasonCodes.map(code => REASON_LABEL[code] || code.replace(/_/g, ' '));
}

function pushCaseEvent(message, kind = 'info') {
  caseEvents.unshift({
    at: new Date().toISOString(),
    message,
    kind,
  });
  if (!caseTimeline) return;
  caseTimeline.innerHTML = caseEvents.slice(0, 25).map(evt => {
    const time = new Date(evt.at).toLocaleTimeString();
    return `<div class="case-event ${escHtml(evt.kind)}"><span class="case-time">${escHtml(time)}</span><span>${escHtml(evt.message)}</span></div>`;
  }).join('');
}

function renderEvidenceForResult(index) {
  if (!evidencePanel) return;
  const r = results[index];
  if (!r) {
    evidencePanel.textContent = 'Select a result card to inspect evidence.';
    return;
  }

  const reasons = humanizeReasons(Array.isArray(r.reasonCodes) ? r.reasonCodes : []);
  const lines = [
    `Source: ${r.name}`,
    `Status: ${r.status}`,
    `URL: ${r.url || ''}`,
    `Reason(s): ${reasons.join(' | ') || 'n/a'}`,
    `Checked: ${r.evidence && r.evidence.checkedAt ? r.evidence.checkedAt : 'n/a'}`,
    `Method: ${r.evidence && r.evidence.method ? r.evidence.method : 'n/a'}`,
    `HTTP: ${r.evidence && typeof r.evidence.statusCode !== 'undefined' ? r.evidence.statusCode : 'n/a'}`,
    `Body Hash: ${r.evidence && r.evidence.bodyHash ? r.evidence.bodyHash : 'n/a'}`,
  ];
  evidencePanel.textContent = lines.join('\n');
}

/* ── Quick checks (instant username pulse) ───────────────────────────── */
function renderQuickChecks(items = []) {
  if (!quickChecks) return;
  if (!items.length) {
    quickChecks.innerHTML = '';
    quickChecks.classList.remove('active');
    return;
  }

  const html = items.map(item => {
    const statusLabel = item.status === 'taken' ? 'taken'
      : item.status === 'available' ? 'available'
      : 'unclear';
    return `
      <span class="quick-pill ${escHtml(item.status)}" title="${escHtml(item.name)}: ${escHtml(statusLabel)}">
        <span class="qp-name">${escHtml(item.name)}</span>
        <span class="qp-state">${escHtml(statusLabel)}</span>
      </span>
    `;
  }).join('');

  quickChecks.innerHTML = html;
  quickChecks.classList.add('active');
}

function queueQuickCheck(username) {
  if (quickCheckTimer) clearTimeout(quickCheckTimer);
  if (quickCheckAbort) {
    quickCheckAbort.abort();
    quickCheckAbort = null;
  }

  if (!username || username.length < 3 || validateUsername(username)) {
    renderQuickChecks([]);
    return;
  }

  quickCheckTimer = setTimeout(() => {
    quickCheckAbort = new AbortController();
    fetch(`/api/quick-check?username=${encodeURIComponent(username)}`, { signal: quickCheckAbort.signal })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(payload => renderQuickChecks(payload.results || []))
      .catch(() => {
        // Ignore aborted requests and transient quick-check failures.
      })
      .finally(() => { quickCheckAbort = null; });
  }, 400);
}
/* ── Platforms grid (static, rendered on load) ───────────────────────── */
function initPlatformsGrid(sites) {
  const frag = document.createDocumentFragment();
  sites.forEach(site => {
    const chip = document.createElement('div');
    chip.className = 'platform-chip';
    chip.innerHTML = `<span class="chip-name">${escHtml(site.name)}</span><span class="chip-cat">${escHtml(site.category)}</span>`;
    frag.appendChild(chip);
  });
  platformsGrid.appendChild(frag);

  // Update count placeholders
  const count = sites.length;
  document.querySelectorAll('#heroCount, #siteCount, .step-count').forEach(el => {
    el.textContent = count;
  });

  // Update checklist with real counts per category
  const catCount = {};
  sites.forEach(s => { catCount[s.category] = (catCount[s.category] || 0) + 1; });
  // update search hint
  const hint = $('searchHint');
  if (hint) hint.innerHTML = `${count} platforms &nbsp;·&nbsp; social · developer · gaming · content · and more`;
}

/* ── Card creation ───────────────────────────────────────────────────── */
function makeCard(r, animDelay = 0) {
  const card = document.createElement('div');
  card.className = `result-card ${r.status}`;
  card.dataset.site     = r.name;
  card.dataset.category = r.category;
  card.dataset.status   = r.status;
  card.style.animationDelay = `${animDelay}ms`;

  const urlAttr    = safeUrl(r.url || '');
  const urlDisplay = escHtml(r.url || '');
  const scBadge    = r.statusCode ? `<span class="sc-badge" title="HTTP status code">${r.statusCode}</span>` : '';
  const browserBadge = r.resolvedBy === 'browser'
    ? '<span class="sc-badge" title="Resolved by browser rendering">BROWSER</span>'
    : '';

  const badgeHtml = (r.status === 'found' || r.status === 'deleted')
    ? `<a href="${escHtml(urlAttr)}" target="_blank" rel="noopener noreferrer" class="site-url">${urlDisplay}</a>`
    : `<span class="site-url">${urlDisplay}</span>`;

  const displayNameHtml = r.displayName
    ? `<div class="display-name">${escHtml(r.displayName)}</div>`
    : '';

  const reasons = humanizeReasons(Array.isArray(r.reasonCodes) ? r.reasonCodes.slice(0, 2) : []);
  const reasonHtml = reasons.length
    ? `<div class="reason-codes" title="Classification signals">${escHtml(reasons.join(' · '))}</div>`
    : '';

  card.innerHTML = `
    <div class="card-top">
      <span class="status-badge ${r.status}">${STATUS_LABEL[r.status] || r.status.toUpperCase()}</span>
      <div class="card-top-right">${browserBadge}${scBadge}<span class="category-badge">${escHtml(r.category)}</span></div>
    </div>
    <div class="site-name">${escHtml(r.name)}</div>
    ${displayNameHtml}
    ${reasonHtml}
    ${badgeHtml}
  `;
  return card;
}

function makeIntelCard(r, animDelay = 0) {
  const card = document.createElement('div');
  card.className = `result-card email-card ${r.status === 'link' ? 'link' : r.status}`;
  card.dataset.site = r.name;
  card.dataset.category = r.category || 'intel';
  card.dataset.status = r.status;
  card.style.animationDelay = `${animDelay}ms`;

  const urlAttr = safeUrl(r.url || '');
  const statusText = STATUS_LABEL[r.status] || String(r.status || '').toUpperCase();
  const summaryHtml = r.summary ? `<div class="display-name">${escHtml(r.summary)}</div>` : '';
  const detailHtml = r.detail ? `<div class="reason-codes">${escHtml(r.detail)}</div>` : '';
  const linkLabel = r.status === 'link'
    ? 'Open pivot ↗'
    : (r.status === 'found' ? 'Open source ↗' : escHtml(r.url || ''));
  const linkHtml = urlAttr !== '#'
    ? `<a href="${escHtml(urlAttr)}" target="_blank" rel="noopener noreferrer" class="site-url">${linkLabel}</a>`
    : '';

  card.innerHTML = `
    <div class="card-top">
      <span class="status-badge ${r.status === 'link' ? 'link' : r.status}">${statusText}</span>
      <div class="card-top-right"><span class="category-badge">${escHtml(r.category || 'intel')}</span></div>
    </div>
    <div class="site-name">${escHtml(r.name)}</div>
    ${summaryHtml}
    ${detailHtml}
    ${linkHtml}
  `;
  return card;
}

/* ── People-finder card (name search mode) ───────────────────────────── */
function makeNameCard(r, animDelay = 0) {
  const card = document.createElement('div');
  card.className = `result-card name-card ${r.status}`;
  card.dataset.site     = r.name;
  card.dataset.category = 'people-finder';
  card.dataset.status   = r.status;
  card.style.animationDelay = `${animDelay}ms`;

  const urlAttr = safeUrl(r.url || '');
  const statusText = STATUS_LABEL[r.status] || String(r.status || '').toUpperCase();
  const summaryHtml = r.summary ? `<div class="display-name">${escHtml(r.summary)}</div>` : '';
  const detailHtml = r.detail ? `<div class="reason-codes">${escHtml(r.detail)}</div>` : '';
  const linkLabel = r.status === 'found' ? 'Open source ↗' : 'Open search ↗';

  card.innerHTML = `
    <div class="card-top">
      <span class="status-badge ${escHtml(r.status || 'unknown')}">${statusText}</span>
      <span class="category-badge">people-finder</span>
    </div>
    <div class="site-name">${escHtml(r.name)}</div>
    ${summaryHtml}
    ${detailHtml}
    <a href="${escHtml(urlAttr)}" target="_blank" rel="noopener noreferrer" class="site-url name-search-url">${linkLabel}</a>
  `;
  return card;
}

/* ── Found-first insertion ───────────────────────────────────────────── */
function insertCardSorted(card) {
  const isTop = card.dataset.status === 'found' || card.dataset.status === 'deleted';
  if (isTop) {
    resultsGrid.insertBefore(card, resultsGrid.children[foundInsertIdx] || null);
    foundInsertIdx++;
  } else {
    resultsGrid.appendChild(card);
  }
}

/* ── Manual check item ───────────────────────────────────────────────── */
function makeManualItem(r) {
  const a = document.createElement('a');
  a.className = 'manual-link-item';
  a.href = safeUrl(r.url || '');
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.innerHTML = `
    <span class="mli-name">${escHtml(r.name)}</span>
    <span class="mli-cat">${escHtml(r.category)}</span>
    <span class="mli-arrow">↗</span>
  `;
  return a;
}

/* ── Filter application ──────────────────────────────────────────────── */
function applyFilters() {
  const cards = resultsGrid.querySelectorAll('.result-card');
  cards.forEach(card => {
    if (card.classList.contains('name-card')) return; // name cards always visible
    const catMatch   = activeFilter === 'all' || card.dataset.category === activeFilter;
    const foundMatch = !foundOnly || card.dataset.status === 'found';
    card.classList.toggle('hidden', !(catMatch && foundMatch));
  });
}

/* ── Stats ───────────────────────────────────────────────────────────── */
function updateStats(done, total) {
  const found    = results.filter(r => r.status === 'found').length;
  const deleted  = results.filter(r => r.status === 'deleted').length;
  const notFound = results.filter(r => r.status === 'not_found').length;

  statChecked.textContent  = done;
  statTotal.textContent    = total;
  statFound.textContent    = found;
  statDeleted.textContent  = deleted;
  statNotFound.textContent = notFound;
  progressBarFill.style.width = total ? `${(done / total) * 100}%` : '0%';
}

/* ── Main scan ───────────────────────────────────────────────────────── */
function resetScanState() {
  results = [];
  manualResults = [];
  caseEvents = [];
  foundInsertIdx = 0;
  manualOpen = false;
  resultsGrid.innerHTML = '';
  if (caseTimeline) caseTimeline.innerHTML = '';
  if (evidencePanel) evidencePanel.textContent = 'Select a result card to inspect evidence.';
  manualLinksList.innerHTML = '';
  manualCheckPanel.style.display = 'none';
  manualCheckBody.classList.remove('open');
  manualChevron.classList.remove('open');
  completionBar.style.display = 'none';
  progressBarFill.style.width = '0%';
  progressBarFill.parentElement.classList.add('scanning');
}

function startScan(username) {
  if (scanActive) return;
  scanActive = true;

  resetScanState();
  renderQuickChecks([]);

  // Update UI
  currentUsername.textContent = username;
  pushCaseEvent(`Username investigation started for ${username}`, 'start');
  scanProgressSec.style.display = 'block';
  resultsSec.style.display = 'block';
  scanBtn.disabled = true;
  scanBtn.textContent = 'SCANNING…';
  searchError.style.display = 'none';
  filterCategories.style.display = '';

  // Scroll to results
  resultsSec.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Open SSE stream
  const url = `/api/check?username=${encodeURIComponent(username)}`;
  evtSource = new EventSource(url);

  evtSource.onmessage = (e) => {
    let data;
    try { data = JSON.parse(e.data); }
    catch (_) { return; }

    if (data.type === 'start') {
      updateStats(0, data.total);
      progressStatus.innerHTML = `Scanning <strong>${escHtml(username)}</strong>…`;
    }

    if (data.type === 'result') {
      results.push(data);
      const resultIndex = results.length - 1;
      pushCaseEvent(`${data.name}: ${STATUS_LABEL[data.status] || data.status}`);
      if (data.status === 'unknown') {
        manualResults.push(data);
        manualLinksList.appendChild(makeManualItem(data));
        manualCheckCount.textContent = manualResults.length;
        manualCheckPanel.style.display = 'block';
      } else {
        const card = makeCard(data, 0);
        card.dataset.resultIndex = String(resultIndex);
        insertCardSorted(card);
        applyFilters();
      }
      updateStats(data.done, data.total);
    }

    if (data.type === 'done') {
      finishScan(username, data.done, data.total);
    }
  };

  evtSource.onerror = () => {
    if (evtSource) evtSource.close();
    progressStatus.textContent = 'Connection error — please try again.';
    progressBarFill.parentElement.classList.remove('scanning');
    resetScanControls();
  };
}

/* ── Name scan ───────────────────────────────────────────────────────── */
function startNameScan(fullName, filters = {}) {
  if (scanActive) return;
  scanActive = true;

  resetScanState();

  // Update UI
  currentUsername.textContent = fullName;
  const parts = [];
  if (filters.city) parts.push(`city=${filters.city}`);
  if (filters.state) parts.push(`state=${filters.state}`);
  if (filters.ageMin) parts.push(`minAge=${filters.ageMin}`);
  if (filters.ageMax) parts.push(`maxAge=${filters.ageMax}`);
  const filterNote = parts.length ? ` with filters (${parts.join(', ')})` : '';
  pushCaseEvent(`Name investigation started for ${fullName}${filterNote}`, 'start');
  scanProgressSec.style.display = 'block';
  resultsSec.style.display = 'block';
  nameScanBtn.disabled = true;
  nameScanBtn.textContent = 'SEARCHING…';
  searchError.style.display = 'none';
  filterCategories.style.display = 'none';

  resultsSec.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const qs = new URLSearchParams({ q: fullName });
  if (filters.city) qs.set('city', filters.city);
  if (filters.state) qs.set('state', filters.state);
  if (filters.ageMin) qs.set('ageMin', filters.ageMin);
  if (filters.ageMax) qs.set('ageMax', filters.ageMax);
  const url = `/api/name-check?${qs.toString()}`;
  evtSource = new EventSource(url);

  evtSource.onmessage = (e) => {
    let data;
    try { data = JSON.parse(e.data); }
    catch (_) { return; }

    if (data.type === 'start') {
      updateStats(0, data.total);
      const startFilters = data.filters || {};
      const startParts = [];
      if (startFilters.city) startParts.push(`city: ${escHtml(startFilters.city)}`);
      if (startFilters.state) startParts.push(`state: ${escHtml(startFilters.state)}`);
      if (startFilters.ageMin) startParts.push(`min age: ${escHtml(startFilters.ageMin)}`);
      if (startFilters.ageMax) startParts.push(`max age: ${escHtml(startFilters.ageMax)}`);
      const suffix = startParts.length ? ` (${startParts.join(' | ')})` : '';
      progressStatus.innerHTML = `Searching name <strong>${escHtml(fullName)}</strong>${suffix}…`;
    }

    if (data.type === 'result') {
      results.push(data);
      const resultIndex = results.length - 1;
      pushCaseEvent(`${data.name}: ${STATUS_LABEL[data.status] || data.status}`);
      if (data.status === 'unknown') {
        manualResults.push(data);
        manualLinksList.appendChild(makeManualItem(data));
        manualCheckCount.textContent = manualResults.length;
        manualCheckPanel.style.display = 'block';
      }
      const card = makeNameCard(data, 0);
      card.dataset.resultIndex = String(resultIndex);
      insertCardSorted(card);
      updateStats(data.done, data.total);
    }

    if (data.type === 'done') {
      finishNameScan(fullName, data.done, data.total);
    }
  };

  evtSource.onerror = () => {
    if (evtSource) evtSource.close();
    progressStatus.textContent = 'Connection error — please try again.';
    progressBarFill.parentElement.classList.remove('scanning');
    resetNameScanControls();
  };
}

function startEmailScan(email) {
  if (scanActive) return;
  scanActive = true;

  resetScanState();

  currentUsername.textContent = email;
  pushCaseEvent(`Email investigation started for ${email}`, 'start');
  scanProgressSec.style.display = 'block';
  resultsSec.style.display = 'block';
  emailScanBtn.disabled = true;
  emailScanBtn.textContent = 'INVESTIGATING…';
  searchError.style.display = 'none';
  filterCategories.style.display = 'none';

  resultsSec.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const url = `/api/email-check?q=${encodeURIComponent(email)}`;
  evtSource = new EventSource(url);

  evtSource.onmessage = (e) => {
    let data;
    try { data = JSON.parse(e.data); }
    catch (_) { return; }

    if (data.type === 'start') {
      updateStats(0, data.total);
      progressStatus.innerHTML = `Investigating email <strong>${escHtml(email)}</strong>…`;
    }

    if (data.type === 'result') {
      results.push(data);
      const resultIndex = results.length - 1;
      pushCaseEvent(`${data.name}: ${STATUS_LABEL[data.status] || data.status}`);
      const card = makeIntelCard(data, 0);
      card.dataset.resultIndex = String(resultIndex);
      resultsGrid.appendChild(card);
      updateStats(data.done, data.total);
    }

    if (data.type === 'done') {
      finishEmailScan(email, data.done, data.total);
    }
  };

  evtSource.onerror = () => {
    if (evtSource) evtSource.close();
    progressStatus.textContent = 'Connection error — please try again.';
    progressBarFill.parentElement.classList.remove('scanning');
    resetEmailScanControls();
  };
}

function startPhoneScan(phone) {
  if (scanActive) return;
  scanActive = true;

  resetScanState();

  currentUsername.textContent = phone;
  pushCaseEvent(`Phone investigation started for ${phone}`, 'start');
  scanProgressSec.style.display = 'block';
  resultsSec.style.display = 'block';
  if (phoneScanBtn) {
    phoneScanBtn.disabled = true;
    phoneScanBtn.textContent = 'SCANNING…';
  }
  searchError.style.display = 'none';
  filterCategories.style.display = 'none';

  resultsSec.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const url = `/api/phone-check?q=${encodeURIComponent(phone)}`;
  evtSource = new EventSource(url);

  evtSource.onmessage = (e) => {
    let data;
    try { data = JSON.parse(e.data); }
    catch (_) { return; }

    if (data.type === 'start') {
      updateStats(0, data.total);
      progressStatus.innerHTML = `Investigating phone <strong>${escHtml(phone)}</strong>…`;
    }

    if (data.type === 'result') {
      results.push(data);
      const resultIndex = results.length - 1;
      pushCaseEvent(`${data.name}: ${STATUS_LABEL[data.status] || data.status}`);
      const card = makeIntelCard(data, 0);
      card.dataset.resultIndex = String(resultIndex);
      resultsGrid.appendChild(card);
      updateStats(data.done, data.total);
    }

    if (data.type === 'done') {
      finishPhoneScan(phone, data.done, data.total);
    }
  };

  evtSource.onerror = () => {
    if (evtSource) evtSource.close();
    progressStatus.textContent = 'Connection error — please try again.';
    progressBarFill.parentElement.classList.remove('scanning');
    resetPhoneScanControls();
  };
}

function startDomainScan(domain) {
  if (scanActive) return;
  scanActive = true;

  resetScanState();

  currentUsername.textContent = domain;
  pushCaseEvent(`Domain investigation started for ${domain}`, 'start');
  scanProgressSec.style.display = 'block';
  resultsSec.style.display = 'block';
  if (domainScanBtn) {
    domainScanBtn.disabled = true;
    domainScanBtn.textContent = 'SCANNING…';
  }
  searchError.style.display = 'none';
  filterCategories.style.display = 'none';

  resultsSec.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const url = `/api/domain-check?q=${encodeURIComponent(domain)}`;
  evtSource = new EventSource(url);

  evtSource.onmessage = (e) => {
    let data;
    try { data = JSON.parse(e.data); }
    catch (_) { return; }

    if (data.type === 'start') {
      updateStats(0, data.total);
      progressStatus.innerHTML = `Investigating domain <strong>${escHtml(domain)}</strong>…`;
    }

    if (data.type === 'result') {
      results.push(data);
      const resultIndex = results.length - 1;
      pushCaseEvent(`${data.name}: ${STATUS_LABEL[data.status] || data.status}`);
      const card = makeIntelCard(data, 0);
      card.dataset.resultIndex = String(resultIndex);
      resultsGrid.appendChild(card);
      updateStats(data.done, data.total);
    }

    if (data.type === 'done') {
      finishDomainScan(domain, data.done, data.total);
    }
  };

  evtSource.onerror = () => {
    if (evtSource) evtSource.close();
    progressStatus.textContent = 'Connection error — please try again.';
    progressBarFill.parentElement.classList.remove('scanning');
    resetDomainScanControls();
  };
}

function finishScan(username, done, total) {
  if (evtSource) { evtSource.close(); evtSource = null; }
  progressBarFill.parentElement.classList.remove('scanning');
  progressBarFill.style.width = '100%';

  const found   = results.filter(r => r.status === 'found').length;

  progressStatus.innerHTML = `Scan complete — <strong>${escHtml(username)}</strong>`;
  completionText.textContent = `${found} profile${found !== 1 ? 's' : ''} found across ${total} platforms`;
  completionBar.style.display = 'flex';
  pushCaseEvent(`Username investigation complete: ${found} found across ${total} sources`, 'done');

  resetScanControls();
}

function finishNameScan(name, done, total) {
  if (evtSource) { evtSource.close(); evtSource = null; }
  progressBarFill.parentElement.classList.remove('scanning');
  progressBarFill.style.width = '100%';

  progressStatus.innerHTML = `Ready — <strong>${escHtml(name)}</strong>`;
  const matches = results.filter(r => r.status === 'found').length;
  completionText.textContent = `${matches} potential match${matches !== 1 ? 'es' : ''} across ${total} people-finder sources`;
  completionBar.style.display = 'flex';
  pushCaseEvent(`Name investigation complete: ${total} sources processed`, 'done');

  resetNameScanControls();
}

function finishEmailScan(email, done, total) {
  if (evtSource) { evtSource.close(); evtSource = null; }
  progressBarFill.parentElement.classList.remove('scanning');
  progressBarFill.style.width = '100%';

  const pivots = results.filter(r => r.status === 'link').length;
  progressStatus.innerHTML = `Email investigation ready — <strong>${escHtml(email)}</strong>`;
  completionText.textContent = `${total} email intelligence result${total !== 1 ? 's' : ''} ready, including ${pivots} pivot${pivots !== 1 ? 's' : ''}`;
  completionBar.style.display = 'flex';
  pushCaseEvent(`Email investigation complete: ${total} sources processed`, 'done');

  resetEmailScanControls();
}

function finishPhoneScan(phone, done, total) {
  if (evtSource) { evtSource.close(); evtSource = null; }
  progressBarFill.parentElement.classList.remove('scanning');
  progressBarFill.style.width = '100%';

  const found = results.filter(r => r.status === 'found').length;
  progressStatus.innerHTML = `Phone investigation ready — <strong>${escHtml(phone)}</strong>`;
  completionText.textContent = `${found} high-signal result${found !== 1 ? 's' : ''} across ${total} phone sources`;
  completionBar.style.display = 'flex';
  pushCaseEvent(`Phone investigation complete: ${total} sources processed`, 'done');

  resetPhoneScanControls();
}

function finishDomainScan(domain, done, total) {
  if (evtSource) { evtSource.close(); evtSource = null; }
  progressBarFill.parentElement.classList.remove('scanning');
  progressBarFill.style.width = '100%';

  const found = results.filter(r => r.status === 'found').length;
  progressStatus.innerHTML = `Domain investigation ready — <strong>${escHtml(domain)}</strong>`;
  completionText.textContent = `${found} high-signal result${found !== 1 ? 's' : ''} across ${total} domain sources`;
  completionBar.style.display = 'flex';
  pushCaseEvent(`Domain investigation complete: ${total} sources processed`, 'done');

  resetDomainScanControls();
}

function cancelScan() {
  if (evtSource) { evtSource.close(); evtSource = null; }
  progressBarFill.parentElement.classList.remove('scanning');
  progressStatus.textContent = 'Scan cancelled.';
  completionBar.style.display = 'flex';
  completionText.textContent = `Cancelled — ${results.filter(r => r.status === 'found').length} found so far`;
  pushCaseEvent('Investigation cancelled by user', 'warn');
  if (currentMode === 'name') resetNameScanControls();
  else if (currentMode === 'email') resetEmailScanControls();
  else if (currentMode === 'phone') resetPhoneScanControls();
  else if (currentMode === 'domain') resetDomainScanControls();
  else resetScanControls();
}

function resetScanControls() {
  scanActive = false;
  scanBtn.disabled = false;
  scanBtn.textContent = 'SCAN';
}

function resetNameScanControls() {
  scanActive = false;
  nameScanBtn.disabled = false;
  nameScanBtn.textContent = 'SCAN';
}

function resetEmailScanControls() {
  scanActive = false;
  emailScanBtn.disabled = false;
  emailScanBtn.textContent = 'SCAN';
}

function resetPhoneScanControls() {
  scanActive = false;
  if (phoneScanBtn) {
    phoneScanBtn.disabled = false;
    phoneScanBtn.textContent = 'SCAN';
  }
}

function resetDomainScanControls() {
  scanActive = false;
  if (domainScanBtn) {
    domainScanBtn.disabled = false;
    domainScanBtn.textContent = 'SCAN';
  }
}

/* ── Export helpers ──────────────────────────────────────────────────── */
function exportCsv() {
  const header = 'Name,Category,Status,Confidence,Reasons,URL';
  const rows = results.map(r =>
    [
      r.name,
      r.category,
      r.status,
      typeof r.confidence === 'number' ? Math.round(r.confidence * 100) : '',
      Array.isArray(r.reasonCodes) ? r.reasonCodes.join('|') : '',
      r.url,
    ]
      .map(v => `"${String(v).replace(/"/g, '""')}"`)
      .join(',')
  );
  const csv = [header, ...rows].join('\r\n');
  downloadText(csv, `probe_${usernameInput.value}_${Date.now()}.csv`, 'text/csv');
}

function exportJson() {
  const payload = {
    query: currentMode === 'name'
      ? (nameInput ? nameInput.value.trim() : '')
      : currentMode === 'email'
        ? (emailInput ? emailInput.value.trim() : '')
        : currentMode === 'phone'
          ? (phoneInput ? phoneInput.value.trim() : '')
          : currentMode === 'domain'
            ? (domainInput ? domainInput.value.trim() : '')
        : usernameInput.value.trim(),
    mode: currentMode,
    generatedAt: new Date().toISOString(),
    totals: {
      checked: results.length,
      found: results.filter(r => r.status === 'found').length,
      deleted: results.filter(r => r.status === 'deleted').length,
      notFound: results.filter(r => r.status === 'not_found').length,
      unknown: results.filter(r => r.status === 'unknown').length,
    },
    results,
  };
  downloadText(JSON.stringify(payload, null, 2), `probe_${payload.query || 'scan'}_${Date.now()}.json`, 'application/json');
}

function openFoundLinks() {
  const foundLinks = results
    .filter(r => r.status === 'found' || r.status === 'deleted')
    .map(r => safeUrl(r.url || ''))
    .filter(url => url !== '#');

  foundLinks.forEach((url, idx) => {
    setTimeout(() => window.open(url, '_blank', 'noopener,noreferrer'), idx * 120);
  });
}

function copyFoundUrls() {
  const urls = results
    .filter(r => r.status === 'found')
    .map(r => r.url)
    .join('\n');
  navigator.clipboard.writeText(urls).then(() => {
    const orig = copyUrlsBtn.textContent;
    copyUrlsBtn.textContent = '✓ Copied!';
    setTimeout(() => { copyUrlsBtn.textContent = orig; }, 2000);
  }).catch(() => {
    // Fallback for environments without clipboard API
    const ta = document.createElement('textarea');
    ta.value = urls;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select(); document.execCommand('copy');
    document.body.removeChild(ta);
  });
}

function downloadText(content, filename, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ── Intersection observer for fade-in ───────────────────────────────── */
function initFadeIn() {
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add('fade-in');
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.08 });
  document.querySelectorAll('section').forEach(s => io.observe(s));
}

/* ── Event wiring ────────────────────────────────────────────────────── */
function initEvents() {
  const modeButtons = ['modeUsername', 'modeEmail', 'modePhone', 'modeDomain', 'modeName'];
  function activateMode(mode) {
    currentMode = mode;
    modeButtons.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const shouldActive = id === `mode${mode.charAt(0).toUpperCase()}${mode.slice(1)}`
        || (mode === 'username' && id === 'modeUsername')
        || (mode === 'email' && id === 'modeEmail')
        || (mode === 'phone' && id === 'modePhone')
        || (mode === 'domain' && id === 'modeDomain')
        || (mode === 'name' && id === 'modeName');
      el.classList.toggle('active', shouldActive);
    });

    document.getElementById('searchBox').style.display = mode === 'username' ? '' : 'none';
    if (searchBoxEmail) searchBoxEmail.style.display = mode === 'email' ? '' : 'none';
    if (searchBoxPhone) searchBoxPhone.style.display = mode === 'phone' ? '' : 'none';
    if (searchBoxDomain) searchBoxDomain.style.display = mode === 'domain' ? '' : 'none';
    if (searchBoxName) searchBoxName.style.display = mode === 'name' ? '' : 'none';
    if (nameFilters) nameFilters.style.display = mode === 'name' ? '' : 'none';

    if (searchHint) searchHint.style.display = mode === 'username' ? '' : 'none';
    if (emailHint) emailHint.style.display = mode === 'email' ? '' : 'none';
    if (phoneHint) phoneHint.style.display = mode === 'phone' ? '' : 'none';
    if (domainHint) domainHint.style.display = mode === 'domain' ? '' : 'none';
    if (nameHint) nameHint.style.display = mode === 'name' ? '' : 'none';

    if (mode !== 'username') renderQuickChecks([]);
  }

  // Mode toggle
  const modeUsernameBtn = document.getElementById('modeUsername');
  if (modeUsernameBtn) {
    modeUsernameBtn.addEventListener('click', () => {
      activateMode('username');
    });
  }

  const modeEmailBtn = document.getElementById('modeEmail');
  if (modeEmailBtn) {
    modeEmailBtn.addEventListener('click', () => {
      activateMode('email');
    });
  }

  const modePhoneBtn = document.getElementById('modePhone');
  if (modePhoneBtn) {
    modePhoneBtn.addEventListener('click', () => {
      activateMode('phone');
    });
  }

  const modeDomainBtn = document.getElementById('modeDomain');
  if (modeDomainBtn) {
    modeDomainBtn.addEventListener('click', () => {
      activateMode('domain');
    });
  }

  const modeNameBtn = document.getElementById('modeName');
  if (modeNameBtn) {
    modeNameBtn.addEventListener('click', () => {
      activateMode('name');
    });
  }

  // Scan button
  scanBtn.addEventListener('click', () => {
    const val = usernameInput.value.trim();
    const err = validateUsername(val);
    if (err) {
      searchError.textContent = err;
      searchError.style.display = 'block';
      usernameInput.focus();
      return;
    }
    searchError.style.display = 'none';
    startScan(val);
  });

  // Enter key in input
  usernameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') scanBtn.click();
  });
  usernameInput.addEventListener('input', (e) => {
    queueQuickCheck(e.target.value.trim());
  });

  // Name scan button
  if (nameScanBtn) {
    nameScanBtn.addEventListener('click', () => {
      const val = nameInput ? nameInput.value.trim() : '';
      const err = validateName(val);
      if (err) {
        searchError.textContent = err;
        searchError.style.display = 'block';
        if (nameInput) nameInput.focus();
        return;
      }
      searchError.style.display = 'none';
      const filters = {
        city: nameCityInput ? nameCityInput.value.trim() : '',
        state: nameStateInput ? nameStateInput.value.trim() : '',
        ageMin: nameAgeMinInput && nameAgeMinInput.value ? nameAgeMinInput.value.trim() : '',
        ageMax: nameAgeMaxInput && nameAgeMaxInput.value ? nameAgeMaxInput.value.trim() : '',
      };
      startNameScan(val, filters);
    });
  }

  if (emailScanBtn) {
    emailScanBtn.addEventListener('click', () => {
      const val = emailInput ? emailInput.value.trim() : '';
      const err = validateEmail(val);
      if (err) {
        searchError.textContent = err;
        searchError.style.display = 'block';
        if (emailInput) emailInput.focus();
        return;
      }
      searchError.style.display = 'none';
      startEmailScan(val);
    });
  }

  if (phoneScanBtn) {
    phoneScanBtn.addEventListener('click', () => {
      const val = phoneInput ? phoneInput.value.trim() : '';
      const err = validatePhone(val);
      if (err) {
        searchError.textContent = err;
        searchError.style.display = 'block';
        if (phoneInput) phoneInput.focus();
        return;
      }
      searchError.style.display = 'none';
      startPhoneScan(val);
    });
  }

  if (domainScanBtn) {
    domainScanBtn.addEventListener('click', () => {
      const val = domainInput ? domainInput.value.trim() : '';
      const err = validateDomain(val);
      if (err) {
        searchError.textContent = err;
        searchError.style.display = 'block';
        if (domainInput) domainInput.focus();
        return;
      }
      searchError.style.display = 'none';
      startDomainScan(val);
    });
  }

  // Enter key in name input
  if (nameInput) {
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && nameScanBtn) nameScanBtn.click();
    });
  }

  if (emailInput) {
    emailInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && emailScanBtn) emailScanBtn.click();
    });
  }

  if (phoneInput) {
    phoneInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && phoneScanBtn) phoneScanBtn.click();
    });
  }

  if (domainInput) {
    domainInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && domainScanBtn) domainScanBtn.click();
    });
  }

  // Cancel button
  cancelBtn.addEventListener('click', cancelScan);

  // New scan button
  newScanBtn.addEventListener('click', () => {
    usernameInput.value = '';
    if (emailInput) emailInput.value = '';
    if (phoneInput) phoneInput.value = '';
    if (domainInput) domainInput.value = '';
    if (nameInput) nameInput.value = '';
    if (currentMode === 'email' && emailInput) emailInput.focus();
    else if (currentMode === 'phone' && phoneInput) phoneInput.focus();
    else if (currentMode === 'domain' && domainInput) domainInput.focus();
    else if (currentMode === 'name' && nameInput) nameInput.focus();
    else usernameInput.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // Manual check toggle
  manualCheckToggle.addEventListener('click', () => {
    manualOpen = !manualOpen;
    manualCheckBody.classList.toggle('open', manualOpen);
    manualChevron.classList.toggle('open', manualOpen);
    manualCheckToggle.setAttribute('aria-expanded', String(manualOpen));
  });
  manualCheckToggle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); manualCheckToggle.click(); }
  });

  // Export
  exportCsvBtn.addEventListener('click', exportCsv);
  if (exportJsonBtn) exportJsonBtn.addEventListener('click', exportJson);
  if (openFoundBtn) openFoundBtn.addEventListener('click', openFoundLinks);
  copyUrlsBtn.addEventListener('click', copyFoundUrls);

  // Category filter pills
  filterCategories.addEventListener('click', (e) => {
    const pill = e.target.closest('.filter-pill');
    if (!pill) return;
    filterCategories.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    activeFilter = pill.dataset.cat;
    applyFilters();
  });

  // Found-only toggle
  foundOnlyToggle.addEventListener('change', () => {
    foundOnly = foundOnlyToggle.checked;
    applyFilters();
  });

  resultsGrid.addEventListener('click', (e) => {
    const card = e.target.closest('.result-card');
    if (!card) return;
    const idx = Number(card.dataset.resultIndex);
    if (Number.isInteger(idx)) {
      renderEvidenceForResult(idx);
    }
  });

  // Navbar scroll shadow
  window.addEventListener('scroll', () => {
    navbar.classList.toggle('scrolled', window.scrollY > 10);
  }, { passive: true });

  // Hamburger
  hamburger.addEventListener('click', () => {
    hamburger.classList.toggle('open');
    navMenu.classList.toggle('open');
  });
  hamburger.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') hamburger.click();
  });
}

/* ── Bootstrap ───────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  // Load sites.json to populate platforms grid + update counts
  fetch('/sites.json')
    .then(r => r.ok ? r.json() : Promise.reject())
    .then(sites => initPlatformsGrid(sites))
    .catch(() => {
      // Use fallback count
      document.querySelectorAll('#heroCount, #siteCount, .step-count').forEach(el => {
        el.textContent = '100';
      });
    });

  initEvents();
  initFadeIn();
});
