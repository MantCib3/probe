'use strict';

/* ── Constants ───────────────────────────────────────────────────────── */
const STATUS_LABEL = {
  found       : 'FOUND',
  not_found   : 'NOT FOUND',
  deleted     : 'DELETED',
  error       : 'ERROR',
  timeout     : 'TIMEOUT',
  unknown     : 'UNKNOWN',
  auth_required: 'LOGIN REQ',
  link        : 'OPEN',
};

const REASON_LABEL = {
  requires_authentication: 'Requires login — manual check needed',
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
let pinnedItems = [];       // cards pinned to case notepad
let captures    = {};       // { [url]: { metadata, screenshot, mimeType } }
let lastScannedTarget = ''; // current dork panel target
let activeDorkEngine  = 'google'; // active tab in dork panel
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

/* ── Dork engines ────────────────────────────────────────────────────── */
const DORK_URLS = {
  google:  q => `https://www.google.com/search?q=${encodeURIComponent('"'+q+'"')}`,
  bing:    q => `https://www.bing.com/search?q=${encodeURIComponent('"'+q+'"')}`,
  ddg:     q => `https://duckduckgo.com/?q=${encodeURIComponent('"'+q+'"')}`,
  yandex:  q => `https://yandex.com/search/?text=${encodeURIComponent('"'+q+'"')}`,
};

/* ── Floating panel utilities ────────────────────────────────────────── */
function makeDraggable(panel, handle) {
  let dragging = false, ox = 0, oy = 0;
  handle.addEventListener('mousedown', (e) => {
    if (e.target.closest('.fp-btn') || e.target.closest('.np-icon-btn')) return;
    dragging = true;
    const rect = panel.getBoundingClientRect();
    panel.style.right  = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left   = rect.left + 'px';
    panel.style.top    = rect.top  + 'px';
    ox = e.clientX - rect.left;
    oy = e.clientY - rect.top;
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    panel.style.left = Math.max(0, e.clientX - ox) + 'px';
    panel.style.top  = Math.max(0, e.clientY - oy) + 'px';
  });
  document.addEventListener('mouseup', () => { dragging = false; });
}

function updateDorkPanel(target) {
  lastScannedTarget = target || '';
  const queryEl = $('dorkEngineQuery');
  const tabs    = $('dorkTabs');
  if (!queryEl) return;
  if (target) {
    queryEl.innerHTML = `"<strong>${escHtml(target)}</strong>"`;
    if (tabs) tabs.querySelectorAll('.dork-tab').forEach(b => b.disabled = false);
  } else {
    queryEl.textContent = 'run a scan first';
    if (tabs) tabs.querySelectorAll('.dork-tab').forEach(b => b.disabled = true);
  }
}

function togglePin(r, btn) {
  const idx = pinnedItems.findIndex(p => p.name === r.name);
  if (idx >= 0) {
    pinnedItems.splice(idx, 1);
    btn.classList.remove('pinned');
  } else {
    pinnedItems.push({ name: r.name, url: r.url || '', status: r.status, category: r.category || '' });
    btn.classList.add('pinned');
    // Auto-fetch metadata for newly pinned item
    if (r.url) fetchPinMeta(pinnedItems.length - 1);
  }
  updateNotepad();
}

function updateNotepad() {
  const npPins     = $('npPins');
  const npPinCount = $('npPinCount');
  if (!npPins) return;
  npPinCount.textContent = pinnedItems.length;
  if (!pinnedItems.length) {
    npPins.innerHTML = '<span class="np-empty">No pins yet — click 📌 on a result card</span>';
    return;
  }
  npPins.innerHTML = pinnedItems.map((p, i) => {
    const href = p.url ? escHtml(safeUrl(p.url)) : '#';
    const linkHtml = (href !== '#' && p.url)
      ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${escHtml(p.name)}</a>`
      : `<span>${escHtml(p.name)}</span>`;
    const cap = p.url && captures[p.url];
    const m   = cap ? (cap.metadata || {}) : null;
    const metaHtml = m ? (() => {
      const title = (m.title || m.ogTitle || '').slice(0, 80);
      const desc  = (m.description || '').slice(0, 120);
      return `<div class="np-pin-meta">${title ? `<div class="np-pin-meta-title">${escHtml(title)}</div>` : ''}${desc ? `<div class="np-pin-meta-desc">${escHtml(desc)}</div>` : ''}</div>`;
    })() : (p.url && !cap ? '<div class="np-pin-meta np-pin-meta-loading">◌ fetching…</div>' : '');
    return `<div class="np-pin-item">
      <div class="np-pin-row">
        <span class="np-pin-status ${escHtml(p.status)}">${escHtml(p.status)}</span>
        ${linkHtml}
        <button class="np-unpin" data-unpin-idx="${i}" title="Remove">✕</button>
      </div>
      ${metaHtml}
    </div>`;
  }).join('');
  npPins.querySelectorAll('.np-unpin').forEach(btn => {
    btn.addEventListener('click', () => {
      const removed = pinnedItems.splice(Number(btn.dataset.unpinIdx), 1)[0];
      if (removed) {
        const pb = resultsGrid.querySelector(`.pin-btn[data-pin-name="${CSS.escape(removed.name)}"]`);
        if (pb) pb.classList.remove('pinned');
      }
      updateNotepad();
    });
  });
}

async function capturePin(idx, btn) {
  const pin = pinnedItems[idx];
  if (!pin || !pin.url) return;
  btn.classList.add('loading');
  btn.textContent = '↻';
  btn.disabled = true;
  try {
    // Fetch HTML + cheerio metadata from server
    const resp = await fetch(`/api/fetch-page?url=${encodeURIComponent(pin.url)}`);
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Fetch failed');

    // Client-side silent iframe render + html2canvas capture
    let screenshotB64 = '';
    if (data.html && typeof html2canvas !== 'undefined') {
      screenshotB64 = await silentCapture(pin.url, data.html);
    }

    captures[pin.url] = {
      metadata: data.metadata,
      screenshot: screenshotB64,
      mimeType: 'image/png',
      name: pin.name,
    };

    // Insert thumbnail + metadata block into the notes editor
    const npEditor = $('npEditor');
    if (npEditor) {
      const m = data.metadata || {};
      const domain = (() => { try { return new URL(pin.url).hostname; } catch (_) { return pin.url; } })();
      const pageTitle = (m.title || m.ogTitle || '').slice(0, 90);
      const desc = (m.description || '').slice(0, 150);
      const thumbHtml = screenshotB64
        ? `<img class="np-meta-thumb" src="data:image/png;base64,${screenshotB64}" alt="${escHtml(domain)}">`
        : '';
      const metaLines = [
        `<strong>${escHtml(pageTitle || domain)}</strong>`,
        desc ? `<em>${escHtml(desc)}</em>` : '',
        m.author ? `Author: ${escHtml(m.author)}` : '',
        `<span class="np-meta-ts">${escHtml(domain)} · ${escHtml((m.capturedAt || '').slice(0, 10))}</span>`,
      ].filter(Boolean).join('<br>');
      npEditor.insertAdjacentHTML('beforeend',
        `<div class="np-meta-embed">${thumbHtml}<div class="np-meta-detail">${metaLines}</div></div><p></p>`);
      localStorage.setItem('probe_case_content', npEditor.innerHTML);
    }

    renderCaptures();
    updateNotepad();
    const imgBtn  = $('npExportImg');
    const jsonBtn = $('npExportJson');
    if (imgBtn)  imgBtn.style.display = '';
    if (jsonBtn) jsonBtn.style.display = '';
  } catch (err) {
    btn.classList.remove('loading');
    btn.textContent = '⚠';
    btn.title = err.message;
    btn.disabled = false;
    setTimeout(() => { btn.textContent = '📷'; btn.title = 'Capture screenshot & metadata'; }, 3000);
  }
}

/* Silently render a URL's HTML in a sandboxed iframe and capture via html2canvas */
async function silentCapture(pageUrl, html) {
  return new Promise((resolve) => {
    try {
      let origin = pageUrl;
      try { origin = new URL(pageUrl).origin; } catch (_) { /* keep raw */ }
      // Inject base href so relative resources resolve to the original host
      const injected = html.replace(/<head(\s[^>]*)?>/i,
        m => `${m}<base href="${origin}">`);
      const blob = new Blob([injected], { type: 'text/html' });
      const blobUrl = URL.createObjectURL(blob);

      const iframe = document.createElement('iframe');
      iframe.style.cssText = [
        'position:fixed', 'top:-9999px', 'left:-9999px',
        'width:1280px', 'height:800px', 'border:none',
        'pointer-events:none', 'opacity:0', 'z-index:-1',
      ].join(';');
      iframe.sandbox = 'allow-same-origin';
      document.body.appendChild(iframe);

      const cleanup = () => {
        try { URL.revokeObjectURL(blobUrl); } catch (_) {}
        try { iframe.remove(); } catch (_) {}
      };
      const safetyTimer = setTimeout(() => { cleanup(); resolve(''); }, 15000);

      iframe.onload = async () => {
        clearTimeout(safetyTimer);
        try {
          const doc = iframe.contentDocument;
          const canvas = await html2canvas(doc.documentElement, {
            useCORS: false,
            allowTaint: true,
            width: 1280,
            height: 800,
            scale: 0.75,
            logging: false,
            windowWidth: 1280,
            windowHeight: 800,
          });
          const b64 = canvas.toDataURL('image/png').replace('data:image/png;base64,', '');
          cleanup();
          resolve(b64);
        } catch (_) {
          cleanup();
          resolve('');
        }
      };
      iframe.onerror = () => { clearTimeout(safetyTimer); cleanup(); resolve(''); };
      iframe.src = blobUrl;
    } catch (_) {
      resolve('');
    }
  });
}

function renderCaptures() {
  const section = $('npCapturesSection');
  const container = $('npCaptures');
  const count = $('npCaptureCount');
  if (!section || !container) return;
  const keys = Object.keys(captures);
  count.textContent = keys.length;
  section.style.display = keys.length ? '' : 'none';
  container.innerHTML = keys.map(url => {
    const c = captures[url];
    const m = c.metadata || {};
    const domain = (() => { try { return new URL(url).hostname; } catch { return url; } })();
    const title = m.title || m.ogTitle || domain;
    const desc  = m.description || '';
    const safeDomain = escHtml(domain);
    const safeTitle  = escHtml(title.slice(0, 80));
    const safeDesc   = escHtml(desc.slice(0, 140));
    const extras = [
      m.author        ? `<span class="np-cap-field"><b>Author</b> ${escHtml(m.author)}</span>` : '',
      m.publishedTime ? `<span class="np-cap-field"><b>Published</b> ${escHtml(m.publishedTime.slice(0,10))}</span>` : '',
      m.ogSiteName    ? `<span class="np-cap-field"><b>Site</b> ${escHtml(m.ogSiteName)}</span>` : '',
    ].filter(Boolean).join('');
    return `<div class="np-capture-card" data-cap-url="${escHtml(url)}">
      <div class="np-capture-info">
        <div class="np-capture-domain">${safeDomain}</div>
        ${title !== domain ? `<div class="np-capture-title">${safeTitle}</div>` : ''}
        ${desc ? `<div class="np-capture-desc">${safeDesc}</div>` : ''}
        ${extras ? `<div class="np-cap-extras">${extras}</div>` : ''}
        <div class="np-capture-dl-row">
          <button class="np-capture-dl" data-dl-meta="${escHtml(url)}" title="Download metadata JSON">↓ meta</button>
          <button class="np-capture-dl np-preview-btn" data-preview-url="${escHtml(url)}" title="Preview metadata">👁 preview</button>
        </div>
      </div>
    </div>`;
  }).join('');
  container.querySelectorAll('[data-dl-meta]').forEach(btn => {
    btn.addEventListener('click', () => downloadCaptureMeta(btn.dataset.dlMeta));
  });
  container.querySelectorAll('[data-preview-url]').forEach(btn => {
    btn.addEventListener('click', () => previewMeta(btn.dataset.previewUrl));
  });
}

function downloadCaptureMeta(url) {
  const c = captures[url];
  if (!c) return;
  const domain = (() => { try { return new URL(url).hostname.replace(/\./g, '-'); } catch { return 'meta'; } })();
  const payload = JSON.stringify({ url, ...c.metadata }, null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `meta-${domain}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function previewMeta(url) {
  const c = captures[url];
  if (!c) return;
  const m = c.metadata || {};
  const overlay = document.getElementById('metaPreviewOverlay');
  const body    = document.getElementById('metaPreviewBody');
  const domainEl = document.getElementById('metaPreviewDomain');
  if (!overlay || !body) return;

  const domain = (() => { try { return new URL(url).hostname; } catch (_) { return url; } })();
  domainEl.textContent = domain;

  const fields = [
    ['Title',        m.title],
    ['URL',          m.url],
    ['Description',  m.description],
    ['OG Title',     m.ogTitle],
    ['Site Name',    m.ogSiteName],
    ['OG Image',     m.ogImage],
    ['Author',       m.author],
    ['Keywords',     m.keywords],
    ['Published',    m.publishedTime],
    ['Twitter Card', m.twitterCard],
    ['Canonical',    m.canonical],
    ['Captured At',  m.capturedAt],
  ].filter(([, v]) => v);

  const isLink = k => k === 'URL' || k === 'Canonical' || k === 'OG Image';
  body.innerHTML = fields.map(([k, v]) => {
    const safeV = escHtml(v);
    const val = isLink(k)
      ? `<a href="${safeV}" target="_blank" rel="noopener noreferrer">${safeV}</a>`
      : safeV;
    return `<div class="meta-preview-row">
      <span class="meta-preview-key">${escHtml(k)}</span>
      <span class="meta-preview-val">${val}</span>
    </div>`;
  }).join('');

  // Add screenshot preview at top if available
  if (c.screenshot) {
    body.insertAdjacentHTML('afterbegin',
      `<div class="meta-preview-screenshot">
        <img src="data:${c.mimeType};base64,${c.screenshot}" alt="Page screenshot" style="width:100%;border-radius:6px;margin-bottom:10px;">
       </div>`);
  }

  overlay.style.display = 'flex';
}

// Wire up preview modal close (runs once)
document.addEventListener('DOMContentLoaded', () => {
  const overlay = document.getElementById('metaPreviewOverlay');
  const closeBtn = document.getElementById('metaPreviewClose');
  if (overlay) {
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.style.display = 'none'; });
  }
  if (closeBtn) {
    closeBtn.addEventListener('click', () => { if (overlay) overlay.style.display = 'none'; });
  }
});

function exportMarkdown() {
  const title   = ($('npTitle') || {}).value || '';
  const content = ($('npEditor') || {}).innerText || '';
  const lines   = [];
  if (title)   lines.push(`# ${title}`, '');
  if (content) lines.push(content, '');
  if (pinnedItems.length) {
    lines.push('## Pinned Sources', '');
    pinnedItems.forEach(p => {
      const capKey = p.url && captures[p.url] ? p.url : null;
      lines.push(`- **[${p.status.toUpperCase()}]** ${p.name}: ${p.url || '(no url)'}`);
      if (capKey) {
        const m = captures[capKey].metadata || {};
        const domain = (() => { try { return new URL(capKey).hostname.replace(/\./g, '-'); } catch { return 'capture'; } })();
        const ext = captures[capKey].mimeType === 'image/jpeg' ? 'jpg' : 'png';
        if (m.title)       lines.push(`  - Title: ${m.title}`);
        if (m.description) lines.push(`  - Description: ${m.description}`);
        if (m.author)      lines.push(`  - Author: ${m.author}`);
        if (m.keywords)    lines.push(`  - Keywords: ${m.keywords}`);
        if (m.publishedTime) lines.push(`  - Published: ${m.publishedTime}`);
        if (m.capturedAt)  lines.push(`  - Captured: ${m.capturedAt}`);
        lines.push(`  - Screenshot: ![${domain}](capture-${domain}.${ext})`);
      }
    });
    lines.push('');
  }
  const md = lines.join('\n');
  const blob = new Blob([md], { type: 'text/plain; charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'case-notes'}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function exportAllImages() {
  Object.keys(captures).forEach(url => downloadCaptureImage(url));
}

function exportAllMeta() {
  const all = {};
  Object.keys(captures).forEach(url => { all[url] = captures[url].metadata; });
  const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'captures-metadata.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function initFloatingPanels() {
  const dorkPanel   = $('dorkPanel');
  const caseNotepad = $('caseNotepad');
  const fabGrp      = $('fabGroup');
  const fabDork     = $('fabDork');
  const fabNotepad  = $('fabNotepad');
  if (!dorkPanel || !caseNotepad || !fabGrp) return;

  makeDraggable(dorkPanel,   $('dorkHandle'));
  makeDraggable(caseNotepad, $('notepadHandle'));

  function hidePanel(panel, fab) {
    panel.style.display = 'none';
    if (fab) fab.classList.remove('active');
  }

  fabDork.addEventListener('click', () => {
    if (dorkPanel.style.display === 'block') { hidePanel(dorkPanel, fabDork); return; }
    if (!dorkPanel.dataset.positioned) {
      dorkPanel.style.right  = '80px';
      dorkPanel.style.bottom = '80px';
      dorkPanel.style.left   = 'auto';
      dorkPanel.style.top    = 'auto';
      dorkPanel.dataset.positioned = '1';
    }
    dorkPanel.style.display = 'block';
    fabDork.classList.add('active');
  });

  fabNotepad.addEventListener('click', () => {
    if (caseNotepad.style.display === 'block') { hidePanel(caseNotepad, fabNotepad); return; }
    if (!caseNotepad.dataset.positioned) {
      caseNotepad.style.left   = '20px';
      caseNotepad.style.bottom = '80px';
      caseNotepad.style.right  = 'auto';
      caseNotepad.style.top    = 'auto';
      caseNotepad.dataset.positioned = '1';
    }
    caseNotepad.style.display = 'block';
    fabNotepad.classList.add('active');
  });

  $('dorkMinBtn').addEventListener('click', () => {
    dorkPanel.classList.toggle('minimised');
    $('dorkMinBtn').textContent = dorkPanel.classList.contains('minimised') ? '+' : '−';
  });
  $('dorkCloseBtn').addEventListener('click', () => hidePanel(dorkPanel, fabDork));
  $('notepadMinBtn').addEventListener('click', () => {
    caseNotepad.classList.toggle('minimised');
    $('notepadMinBtn').textContent = caseNotepad.classList.contains('minimised') ? '+' : '−';
  });
  $('notepadCloseBtn').addEventListener('click', () => hidePanel(caseNotepad, fabNotepad));

  // Dork tabs — each button opens that engine’s search in a new tab
  const dorkTabs = $('dorkTabs');
  if (dorkTabs) {
    dorkTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.dork-tab');
      if (!tab || tab.disabled) return;
      const engine = tab.dataset.engine;
      if (lastScannedTarget && DORK_URLS[engine]) {
        window.open(DORK_URLS[engine](lastScannedTarget), '_blank', 'noopener,noreferrer');
        tab.classList.add('visited');
      }
    });
  }

  // Dork panel — pin a URL from search results
  function addPinFromUrl(url, source) {
    const t = (url || '').trim();
    if (!t) return false;
    try { new URL(t); } catch (_) { return false; }
    if (pinnedItems.some(p => p.url === t)) return false;
    const label = t.replace(/^https?:\/\//, '').replace(/\/$/, '').substring(0, 55);
    pinnedItems.push({ name: label, url: t, status: 'found', category: source || 'manual' });
    updateNotepad();
    fetchPinMeta(pinnedItems.length - 1);
    return true;
  }

  // Notepad — title + contenteditable editor
  const npTitle  = $('npTitle');
  const npEditor = $('npEditor');
  if (npTitle) {
    const sv = localStorage.getItem('probe_case_title');
    if (sv) npTitle.value = sv;
    npTitle.addEventListener('input', () => localStorage.setItem('probe_case_title', npTitle.value));
  }
  if (npEditor) {
    const sv = localStorage.getItem('probe_case_content');
    if (sv) npEditor.innerHTML = sv;
    npEditor.addEventListener('input', () => localStorage.setItem('probe_case_content', npEditor.innerHTML));
  }

  $('npFmtBold').addEventListener('mousedown',   (e) => { e.preventDefault(); document.execCommand('bold'); });
  $('npFmtUnder').addEventListener('mousedown',  (e) => { e.preventDefault(); document.execCommand('underline'); });
  $('npFmtBullet').addEventListener('mousedown', (e) => { e.preventDefault(); document.execCommand('insertUnorderedList'); });

  // Notepad — paste URL to pin
  const npAddUrl   = $('npAddUrl');
  const npUrlInput = $('npUrlInput');
  if (npAddUrl)   npAddUrl.addEventListener('click', () => { if (addPinFromUrl(npUrlInput ? npUrlInput.value : '', 'manual')) { if (npUrlInput) npUrlInput.value = ''; } });
  if (npUrlInput) npUrlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && addPinFromUrl(npUrlInput.value, 'manual')) npUrlInput.value = ''; });

  // Export dropdown
  const npExportBtn  = $('npExportBtn');
  const npExportMenu = $('npExportMenu');
  const npExportMd   = $('npExportMd');
  const npExportImg  = $('npExportImg');
  const npExportJson = $('npExportJson');
  if (npExportBtn && npExportMenu) {
    npExportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = npExportMenu.classList.toggle('open');
      if (open) document.addEventListener('click', () => npExportMenu.classList.remove('open'), { once: true });
    });
  }
  if (npExportMd)   npExportMd.addEventListener('click', () => { exportMarkdown();  npExportMenu && npExportMenu.classList.remove('open'); });
  if (npExportImg)  npExportImg.addEventListener('click', () => { exportAllImages(); npExportMenu && npExportMenu.classList.remove('open'); });
  if (npExportJson) npExportJson.addEventListener('click', () => { exportAllMeta();   npExportMenu && npExportMenu.classList.remove('open'); });

  updateDorkPanel('');
  updateNotepad();
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
    : r.status === 'auth_required'
    ? `<span class="site-url auth-req-note">🔒 open manually to check</span>`
    : `<span class="site-url">${urlDisplay}</span>`;

  const displayNameHtml = r.displayName
    ? `<div class="display-name">${escHtml(r.displayName)}</div>`
    : '';

  const reasons = humanizeReasons(Array.isArray(r.reasonCodes) ? r.reasonCodes.slice(0, 2) : []);
  const reasonHtml = reasons.length
    ? `<div class="reason-codes" title="Classification signals">${escHtml(reasons.join(' · '))}</div>`
    : '';

  // auth_required: show a direct link so user can check manually
  const manualLink = r.status === 'auth_required'
    ? `<a href="${escHtml(urlAttr)}" target="_blank" rel="noopener noreferrer" class="site-url" style="margin-top:2px;font-size:0.72rem;">↗ open ${escHtml(r.name)}</a>`
    : '';

  const isPinned = pinnedItems.some(p => p.name === r.name);
  card.innerHTML = `
    <div class="card-top">
      <span class="status-badge ${r.status}">${STATUS_LABEL[r.status] || r.status.toUpperCase()}</span>
      <div class="card-top-right">${browserBadge}${scBadge}<span class="category-badge">${escHtml(r.category)}</span><button class="pin-btn${isPinned ? ' pinned' : ''}" data-pin-name="${escHtml(r.name)}" title="Pin to case notepad">📌</button></div>
    </div>
    <div class="site-name">${escHtml(r.name)}</div>
    ${displayNameHtml}
    ${reasonHtml}
    ${badgeHtml}
    ${manualLink}
  `;

  // Queue client-side verification based on what the server sent
  if (r.cors && r.status === 'unknown' && r.checkUrl) {
    _cvQueue.push({ type: 'cors', card, checkUrl: r.checkUrl, checkMethod: r.checkMethod || 'status_code', errorMsg: r.errorMsg || null, positiveMsg: r.positiveMsg || null });
  } else if (r.cfProxy && (r.status === 'unknown') && r.checkUrl) {
    _cvQueue.push({ type: 'cfProxy', card, checkUrl: r.checkUrl, checkMethod: r.checkMethod || 'status_code', errorMsg: r.errorMsg || null, positiveMsg: r.positiveMsg || null });
  } else if (r.auth && r.status === 'auth_required') {
    // No-cors redirect detection using user's browser cookies
    _cvQueue.push({ type: 'auth', card, checkUrl: r.url || r.checkUrl });
  }

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

/* ── Client-side verification ─────────────────────────────────────────
 *
 *  Three job types — all run after the SSE scan ends:
 *
 *  'cors'    → direct browser fetch (CORS-enabled API; uses residential IP)
 *  'cfProxy' → fetch via Cloudflare Worker proxy (CF-blocked HTML sites)
 *  'auth'    → no-cors redirect-detect (auth-gated sites; uses user's cookies)
 *
 *  Set CF_WORKER_URL to your deployed worker URL to enable cfProxy jobs.
 *  Leave empty to skip CF proxying (cors/auth still run).
 * ─────────────────────────────────────────────────────────────────── */
const CF_WORKER_URL = ''; // e.g. 'https://probe-proxy.xxx.workers.dev'

const _cvQueue = [];

function _applyVerdict(card, verdict, label) {
  const prevStatus = card.dataset.status;
  const removals = [prevStatus, 'cv-verifying', 'auth_required', 'unknown'];
  card.classList.remove(...removals);
  card.classList.add(verdict);
  card.dataset.status = verdict;
  const statusEl = card.querySelector('.status-badge');
  if (statusEl) {
    statusEl.className = `status-badge ${verdict}`;
    statusEl.textContent = label || (STATUS_LABEL[verdict] || verdict.toUpperCase());
  }
  const idx = results.findIndex(r => r.name === card.dataset.site);
  if (idx !== -1) results[idx].status = verdict;
}

async function _resolveBody(resp, checkMethod, errorMsg, positiveMsg) {
  if (checkMethod === 'status_code' || (!errorMsg && !positiveMsg)) {
    return resp.status === 200 ? 'found' : resp.status === 404 ? 'not_found' : 'unknown';
  }
  const body = await resp.text();
  if (positiveMsg && body.includes(positiveMsg)) return 'found';
  if (errorMsg && body.includes(errorMsg)) return 'not_found';
  return resp.status === 200 ? 'found' : resp.status === 404 ? 'not_found' : 'unknown';
}

async function _clientVerifyOne(job) {
  const { type, card, checkUrl, checkMethod, errorMsg, positiveMsg } = job;
  if (!card || !card.isConnected) return;

  card.classList.add('cv-verifying');
  const statusEl = card.querySelector('.status-badge');
  const prevText = statusEl ? statusEl.textContent : '';
  if (statusEl) statusEl.textContent = '…';

  try {
    if (type === 'auth') {
      // No-cors redirect detection — sends user's browser cookies to the site.
      // opaque = page loaded without redirect → profile probably exists.
      // opaqueredirect = redirected (to login or 404) → inconclusive.
      const resp = await fetch(checkUrl, {
        mode: 'no-cors',
        redirect: 'manual',
        credentials: 'include',
        signal: AbortSignal.timeout(8000),
      });
      if (resp.type === 'opaque') {
        // Direct (non-redirected) response — likely the profile loaded
        _applyVerdict(card, 'found', 'FOUND (browser)');
        updateStats();
      } else {
        // Redirected or error → keep auth_required
        card.classList.remove('cv-verifying');
        if (statusEl) statusEl.textContent = prevText;
      }
      return;
    }

    let fetchUrl = checkUrl;
    if (type === 'cfProxy') {
      if (!CF_WORKER_URL) {
        card.classList.remove('cv-verifying');
        if (statusEl) statusEl.textContent = prevText;
        return;
      }
      fetchUrl = CF_WORKER_URL + '?url=' + encodeURIComponent(checkUrl);
    }

    const resp = await fetch(fetchUrl, { signal: AbortSignal.timeout(14000) });
    const verdict = await _resolveBody(resp, checkMethod, errorMsg, positiveMsg);
    if (verdict !== 'unknown') {
      const suffix = type === 'cfProxy' ? ' (CF)' : ' (browser)';
      _applyVerdict(card, verdict, (STATUS_LABEL[verdict] || verdict.toUpperCase()) + suffix);
      updateStats();
    } else {
      card.classList.remove('cv-verifying');
      if (statusEl) statusEl.textContent = prevText;
    }
  } catch (_) {
    card.classList.remove('cv-verifying');
    if (statusEl) statusEl.textContent = prevText;
  }
}

// Kick off all queued verify jobs after SSE scan ends.
// Batched: 8 concurrent to avoid overwhelming the browser / CF Worker.
async function runClientVerifyQueue() {
  const BATCH = 8;
  const q = [..._cvQueue];
  _cvQueue.length = 0;
  for (let i = 0; i < q.length; i += BATCH) {
    await Promise.all(q.slice(i, i + BATCH).map(_clientVerifyOne));
  }
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
  updateDorkPanel(username);
  const fabGrpA = $('fabGroup'); if (fabGrpA) fabGrpA.style.display = 'flex';
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
  updateDorkPanel(fullName);
  const fabGrpB = $('fabGroup'); if (fabGrpB) fabGrpB.style.display = 'flex';
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
  updateDorkPanel(email);
  const fabGrpC = $('fabGroup'); if (fabGrpC) fabGrpC.style.display = 'flex';
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
  updateDorkPanel(phone);
  const fabGrpD = $('fabGroup'); if (fabGrpD) fabGrpD.style.display = 'flex';
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
  updateDorkPanel(domain);
  const fabGrpE = $('fabGroup'); if (fabGrpE) fabGrpE.style.display = 'flex';
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

  // Run client-side verification for CORS-capable unknowns
  if (_cvQueue.length > 0) {
    const n = _cvQueue.length;
    const cfCount = _cvQueue.filter(j => j.type === 'cfProxy').length;
    const corsCount = _cvQueue.filter(j => j.type === 'cors').length;
    const authCount = _cvQueue.filter(j => j.type === 'auth').length;
    const parts = [];
    if (corsCount) parts.push(`${corsCount} API`);
    if (cfCount) parts.push(cfCount + ' CF' + (CF_WORKER_URL ? '' : ' (no worker URL)'));
    if (authCount) parts.push(`${authCount} auth`);
    progressStatus.innerHTML += ` &mdash; <span id="cvStatus">browser-verifying ${parts.join(', ')}…</span>`;
    runClientVerifyQueue().then(() => {
      const cvEl = document.getElementById('cvStatus');
      if (cvEl) cvEl.remove();
      updateStats();
    });
  }
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
    const pinBtn = e.target.closest('.pin-btn');
    if (pinBtn) {
      const name = pinBtn.dataset.pinName;
      const r = results.find(res => res.name === name);
      if (r) togglePin(r, pinBtn);
      return;
    }
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

  initFloatingPanels();
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
