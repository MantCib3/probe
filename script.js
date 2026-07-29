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
  datacenter_ip_blocked: 'IP blocked by platform — check via CF Worker',
  blocked_http_403: 'HTTP 403 — access denied from server IP',
  blocked_http_429: 'Rate-limited from server IP',
  title_blocked_pattern: 'CF/bot protection page detected',
  body_blocked_pattern: 'CF/bot protection content detected',
  client_side_check_pending: 'Server skipped — browser will verify directly',
  probe_timeout: 'Site did not respond within 15 seconds',
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
let evtSource     = null; // kept for cancelScan compat — not used in static mode
let _sitesCache   = null; // sites.json loaded once on first scan
let activeFilter  = 'all';
let foundOnly     = true;
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
let activePivotMode = 'email';
let dorkResults = [];
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
const pivotTabs         = $('pivotTabs');
const pivotResultsList  = $('pivotResultsList');
const pivotStatus       = $('pivotStatus');
const dorkTabs          = $('dorkTabs');
const dorkResultsList   = $('dorkResultsList');
const dorkStatus        = $('dorkStatus');
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

function queueQuickCheck(_username) {
  if (quickCheckTimer) clearTimeout(quickCheckTimer);
  if (quickCheckAbort) { quickCheckAbort.abort(); quickCheckAbort = null; }
  renderQuickChecks([]); /* static mode: no server-side quick-check */
}

/* fetchPinMeta is a no-op in static mode (metadata capture requires a server) */
function fetchPinMeta(_idx) {}

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
  const tabs = $('dorkTabs');
  if (target) {
    if (tabs) tabs.querySelectorAll('.dork-tab').forEach(b => b.disabled = false);
    pivotStatus.textContent = `${activePivotMode.charAt(0).toUpperCase() + activePivotMode.slice(1)} pivot ready for ${target}`;
    dorkStatus.textContent = `Ready to search ${target}`;
    renderPivotSources();
  } else {
    if (tabs) tabs.querySelectorAll('.dork-tab').forEach(b => b.disabled = true);
    pivotStatus.textContent = 'Ready for the current scan target.';
    dorkStatus.textContent = 'Awaiting scan…';
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

async function capturePin(_idx, btn) {
  /* Metadata / screenshot capture requires a server-side renderer.
   * Not available in static mode — show a brief error on the button. */
  btn.textContent = '⚠';
  btn.title = 'Capture is not available in static mode.';
  setTimeout(() => { btn.textContent = '📷'; btn.title = 'Capture screenshot & metadata'; }, 3000);
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

function normalizePivotQuery(value) {
  return String(value || '').trim().toLowerCase();
}

/* Static, curated reference sources for each pivot mode. These are plain
 * link cards — nothing is fetched or searched; the URL is built from the
 * current scan target and opened manually by the user. */
const PIVOT_SOURCES = {
  email: [
    { name: 'Have I Been Pwned', note: 'Check breach exposure for this email', home: 'https://haveibeenpwned.com/', url: t => `https://haveibeenpwned.com/account/${encodeURIComponent(t)}` },
    { name: 'Epieos', note: 'Reverse email lookup across linked services', home: 'https://epieos.com/', url: t => `https://epieos.com/?q=${encodeURIComponent(t)}&t=email` },
    { name: 'IntelX', note: 'Deep-index search for leaked and indexed references', home: 'https://intelx.io/', url: t => `https://intelx.io/?s=${encodeURIComponent(t)}` },
    { name: 'Google Search', note: 'Web search pivot for this email address', home: 'https://www.google.com/', url: t => `https://www.google.com/search?q=${encodeURIComponent('"' + t + '"')}` },
    { name: 'GitHub Code Search', note: 'Search commits/code for this email', home: 'https://github.com/', url: t => `https://github.com/search?q=${encodeURIComponent('"' + t + '"')}&type=code` },
  ],
  phone: [
    { name: 'That\'sThem', note: 'Reverse phone directory lookup', home: 'https://thatsthem.com/', url: t => `https://thatsthem.com/phone/${encodeURIComponent(t.replace(/[^0-9]/g, ''))}` },
    { name: 'Sync.me', note: 'Caller ID / reverse phone lookup', home: 'https://sync.me/', url: t => `https://sync.me/search/?number=${encodeURIComponent(t)}` },
    { name: 'TruePeopleSearch', note: 'Reverse phone number search', home: 'https://www.truepeoplesearch.com/', url: t => `https://www.truepeoplesearch.com/results?phoneno=${encodeURIComponent(t.replace(/[^0-9]/g, ''))}` },
    { name: 'NumLookup', note: 'Carrier and line-type lookup', home: 'https://www.numlookup.com/', url: t => `https://www.numlookup.com/${encodeURIComponent(t.replace(/[^0-9+]/g, ''))}` },
    { name: 'Google Search', note: 'Web search pivot for this phone number', home: 'https://www.google.com/', url: t => `https://www.google.com/search?q=${encodeURIComponent('"' + t + '"')}` },
  ],
  name: [
    { name: 'FastPeopleSearch', note: 'Public records and people search', home: 'https://www.fastpeoplesearch.com/', url: t => `https://www.fastpeoplesearch.com/name/${encodeURIComponent(t.trim().replace(/\s+/g, '-').toLowerCase())}` },
    { name: 'Whitepages', note: 'Contact and address lookup', home: 'https://www.whitepages.com/', url: t => `https://www.whitepages.com/name/${encodeURIComponent(t.trim().replace(/\s+/g, '-'))}` },
    { name: 'TruePeopleSearch', note: 'Public records search by name', home: 'https://www.truepeoplesearch.com/', url: t => `https://www.truepeoplesearch.com/results?name=${encodeURIComponent(t.trim().replace(/\s+/g, '-'))}` },
    { name: 'Spokeo', note: 'People search aggregator', home: 'https://www.spokeo.com/', url: t => `https://www.spokeo.com/${encodeURIComponent(t.trim().replace(/\s+/g, '-'))}` },
    { name: 'Google Search', note: 'Web search pivot for this name', home: 'https://www.google.com/', url: t => `https://www.google.com/search?q=${encodeURIComponent('"' + t + '"')}` },
  ],
};

function renderPivotSources() {
  if (!pivotResultsList || !pivotStatus) return;
  const target = lastScannedTarget || '';
  const label = activePivotMode.charAt(0).toUpperCase() + activePivotMode.slice(1);
  const sources = PIVOT_SOURCES[activePivotMode] || [];

  pivotStatus.textContent = target
    ? `${sources.length} ${label} pivot sources for ${target}`
    : `${sources.length} ${label} pivot sources — run a scan to auto-fill the target`;

  pivotResultsList.innerHTML = sources.map(source => {
    const href = safeUrl(target ? source.url(target) : source.home);
    return `
      <div class="wmn-source-card">
        <div class="wmn-source-row">
          <div>
            <div class="wmn-source-name">${escHtml(source.name)}</div>
            <div class="wmn-source-meta">${escHtml(source.note)}</div>
          </div>
          <a class="wmn-source-link" href="${href}" target="_blank" rel="noopener noreferrer">Open</a>
        </div>
      </div>
    `;
  }).join('');
}

function renderDorkResults() {
  if (!dorkResultsList || !dorkStatus) return;
  if (!dorkResults.length) {
    dorkResultsList.innerHTML = '<div class="wmn-empty">Run a scan to populate dork results.</div>';
    return;
  }
  const engineLabel = activeDorkEngine.charAt(0).toUpperCase() + activeDorkEngine.slice(1);
  dorkStatus.textContent = `${dorkResults.length} ${engineLabel} dork hits for ${lastScannedTarget || 'current target'}`;
  dorkResultsList.innerHTML = dorkResults.map(item => {
    const cleanUrl = String(item.url || '').replace(/\s+/g, '');
    const displayUrl = cleanUrl.length > 90 ? `${cleanUrl.slice(0, 87)}…` : cleanUrl;
    const isSearchResult = /google\.com\/search|bing\.com\/search|duckduckgo\.com|yandex\.com\/search/.test(cleanUrl);
    const label = isSearchResult ? 'Open query' : 'Open';
    return `
      <div class="wmn-source-card">
        <div class="wmn-source-row">
          <div>
            <div class="wmn-source-name">${escHtml(item.title || item.url || 'Result')}</div>
            <div class="wmn-source-meta">${escHtml(item.engine || 'search')} · ${escHtml(displayUrl)}</div>
          </div>
          <a class="wmn-source-link" href="${escHtml(safeUrl(cleanUrl))}" target="_blank" rel="noopener noreferrer">${escHtml(label)}</a>
        </div>
      </div>
    `;
  }).join('');
}

async function runDorkSearch() {
  if (!lastScannedTarget) return;
  dorkStatus.textContent = `Searching ${activeDorkEngine}…`;
  try {
    const response = await fetch(`/api/dork-search?target=${encodeURIComponent(lastScannedTarget)}&engine=${encodeURIComponent(activeDorkEngine)}`, {
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || 'Dork lookup failed');
    dorkResults = (Array.isArray(payload.results) ? payload.results : []).slice(0, 8).map((item, idx) => ({
      title: item.title || `Dork result ${idx + 1}`,
      url: item.url,
      engine: item.engine || activeDorkEngine,
    }));
    renderDorkResults();
  } catch (err) {
    dorkResults = [];
    dorkStatus.textContent = (err && err.name === 'TimeoutError') ? 'Dork lookup timed out.' : 'Dork lookup failed.';
    renderDorkResults();
  }
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
  const activeSites = (sites || []).filter(s => !s.defunct);
  const frag = document.createDocumentFragment();
  activeSites.forEach(site => {
    const chip = document.createElement('div');
    chip.className = 'platform-chip';
    chip.innerHTML = `<span class="chip-name">${escHtml(site.name)}</span><span class="chip-cat">${escHtml(site.category)}</span>`;
    frag.appendChild(chip);
  });
  platformsGrid.appendChild(frag);

  // Update count placeholders
  const count = activeSites.length;
  document.querySelectorAll('#heroCount, #siteCount, .step-count').forEach(el => {
    el.textContent = count;
  });

  // Update checklist with real counts per category
  const catCount = {};
  activeSites.forEach(s => { catCount[s.category] = (catCount[s.category] || 0) + 1; });
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

  // Store profile URL for archive.org fallback
  card.dataset.profileUrl = r.url || '';

  // Queue client-side verification based on what the server sent
  if (r.cors && r.status === 'unknown' && r.checkUrl) {
    // Tier 1: direct CORS fetch from browser (API endpoints with open CORS)
    _cvQueue.push({ type: 'cors', card, checkUrl: r.checkUrl, checkMethod: r.checkMethod || 'status_code', errorMsg: r.errorMsg || null, positiveMsg: r.positiveMsg || null, notFoundStatus: r.notFoundStatus || null });
  } else if (r.cfProxy && r.status === 'unknown') {
    // Tier 2: CF Worker edge proxy — allowlisted social/CF-protected sites
    _cvQueue.push({ type: 'proxy', card, checkUrl: r.checkUrl, checkMethod: r.checkMethod || 'status_code', errorMsg: r.errorMsg || null, positiveMsg: r.positiveMsg || null, notFoundStatus: r.notFoundStatus || null });
  } else if (r.auth && r.status === 'auth_required') {
    // Tier 3: no-cors redirect detect with user cookies
    _cvQueue.push({ type: 'auth', card, checkUrl: r.url || r.checkUrl });
  } else if (r.status === 'unknown' && r.checkUrl) {
    // Tier 4: server-side /api/verify — for sites with no cors/cfProxy/auth
    // flag (e.g. the merged WhatsMyName catalog). Our own backend fetches
    // server-to-server, which isn't subject to browser CORS restrictions.
    _cvQueue.push({ type: 'server', card, checkUrl: r.checkUrl, checkMethod: r.checkMethod || 'status_code', errorMsg: r.errorMsg || null, positiveMsg: r.positiveMsg || null, notFoundStatus: r.notFoundStatus || null, expectedStatus: r.expectedStatus || null });
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
 *  Four job types — run after all cards are created:
 *  'cors'   → direct browser fetch (CORS-enabled API endpoints, user's IP)
 *  'proxy'  → CF Worker edge proxy (allowlisted CF-protected/social sites)
 *  'auth'   → no-cors redirect-detect (auth-gated; uses user's cookies)
 *  'server' → our own backend's /api/verify (no cors/cfProxy/auth flag —
 *             e.g. the merged WhatsMyName catalog; bypasses browser CORS
 *             entirely since the fetch happens server-to-server)
 *  Archive.org CDX fallback runs on any remaining unknowns afterwards.
 * ─────────────────────────────────────────────────────────────────── */

// CF Worker proxy URL — handles cfProxy:true sites (edge-network, allowlisted hosts)
const CF_WORKER_URL = 'https://probe-proxy.noviss-osint.workers.dev';

// CF challenge page fingerprints — a 200 with these is NOT a profile
const CF_CHALLENGE = [
  'just a moment', 'checking your browser', 'please stand by',
  'enable javascript and cookies', 'cf-spinner', 'challenge-running',
  'cloudflare ray id', 'ddos-guard', 'under attack mode',
];

const _cvQueue = [];

function _applyVerdict(card, verdict, label) {
  const prevStatus = card.dataset.status;
  const removals = [prevStatus, 'cv-verifying', 'auth_required', 'unknown', 'blocked'];
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
  applyFilters();
}

async function _resolveBody(resp, checkMethod, errorMsg, positiveMsg, notFoundStatus) {
  const st = resp.status;
  if (st === 403 || st === 401 || st === 429) return 'blocked';
  if (st === 404 || st === 410) return 'not_found';
  if (notFoundStatus && st === notFoundStatus) return 'not_found';

  // Read body for all non-hard-error responses so errorMsg/positiveMsg can fire
  // even on non-200 status codes (e.g. LinkedIn returns 999 for missing users)
  let body = '';
  try { body = await resp.text(); } catch (_) { return st === 200 ? 'found' : 'unknown'; }
  const lbody = body.toLowerCase();
  if (CF_CHALLENGE.some(p => lbody.includes(p))) return 'blocked';

  if (positiveMsg && body.includes(positiveMsg)) return 'found';
  if (errorMsg   && body.includes(errorMsg))     return 'not_found';
  return st === 200 ? 'found' : 'unknown'; // non-200 without matching msg = unknown
}

async function _clientVerifyOne(job) {
  const { type, card, checkUrl, checkMethod, errorMsg, positiveMsg, notFoundStatus, expectedStatus } = job;
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

    if (type === 'proxy') {
      if (!CF_WORKER_URL) {
        card.classList.remove('cv-verifying');
        if (statusEl) statusEl.textContent = prevText;
        return;
      }
      const proxyTarget = CF_WORKER_URL + '?url=' + encodeURIComponent(checkUrl);
      const proxyResp = await fetch(proxyTarget, { signal: AbortSignal.timeout(16000) });
      if (proxyResp.status === 403) {
        // Host not in allowlist — leave unknown so archive fallback runs
        card.classList.remove('cv-verifying');
        if (statusEl) statusEl.textContent = prevText;
        return;
      }
      // Use X-Proxy-Status if set (real upstream code, e.g. 999→200 clamped by worker)
      const realStatus = Number(proxyResp.headers.get('X-Proxy-Status') || proxyResp.status) || proxyResp.status;
      const proxyRespWithRealStatus = { ...proxyResp, status: realStatus, text: () => proxyResp.text() };
      const verdict = await _resolveBody(proxyRespWithRealStatus, checkMethod, errorMsg, positiveMsg, notFoundStatus);
      if (verdict !== 'unknown') {
        _applyVerdict(card, verdict, (STATUS_LABEL[verdict] || verdict.toUpperCase()) + ' (proxy)');
        updateStats();
      } else {
        card.classList.remove('cv-verifying');
        if (statusEl) statusEl.textContent = prevText;
      }
      return;
    }

    if (type === 'server') {
      const qs = new URLSearchParams({ url: checkUrl, checkMethod: checkMethod || 'status_code' });
      if (positiveMsg)    qs.set('positiveMsg', positiveMsg);
      if (errorMsg)       qs.set('errorMsg', errorMsg);
      if (notFoundStatus) qs.set('notFoundStatus', String(notFoundStatus));
      if (expectedStatus) qs.set('expectedStatus', String(expectedStatus));
      const resp = await fetch('/api/verify?' + qs.toString(), { signal: AbortSignal.timeout(14000) });
      const payload = await resp.json();
      if (payload.ok && payload.verdict && payload.verdict !== 'unknown') {
        _applyVerdict(card, payload.verdict, (STATUS_LABEL[payload.verdict] || payload.verdict.toUpperCase()) + ' (server)');
        updateStats();
      } else {
        card.classList.remove('cv-verifying');
        if (statusEl) statusEl.textContent = prevText;
      }
      return;
    }

    const resp = await fetch(checkUrl, { signal: AbortSignal.timeout(14000) });
    const verdict = await _resolveBody(resp, checkMethod, errorMsg, positiveMsg, notFoundStatus);
    if (verdict !== 'unknown') {
      _applyVerdict(card, verdict, (STATUS_LABEL[verdict] || verdict.toUpperCase()) + ' (browser)');
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
// Proxy jobs (type='proxy') all hit the same CF Worker hostname, so the browser's
// HTTP/1.1 per-host connection limit (6) applies — keep their batch ≤ 4.
// Server jobs (type='server') all hit our own origin — same per-host limit applies.
// CORS/auth jobs hit different origins so a wider batch is fine.
async function runClientVerifyQueue() {
  const proxyJobs  = _cvQueue.filter(j => j.type === 'proxy');
  const serverJobs = _cvQueue.filter(j => j.type === 'server');
  const otherJobs  = _cvQueue.filter(j => j.type !== 'proxy' && j.type !== 'server');
  _cvQueue.length = 0;

  // CORS + auth — different origins, batch of 8
  for (let i = 0; i < otherJobs.length; i += 8) {
    await Promise.all(otherJobs.slice(i, i + 8).map(_clientVerifyOne));
  }
  // Proxy — same CF Worker origin, batch of 4 (stays under browser 6-conn limit)
  for (let i = 0; i < proxyJobs.length; i += 4) {
    await Promise.all(proxyJobs.slice(i, i + 4).map(_clientVerifyOne));
  }
  // Server — same origin as our own app, batch of 6
  for (let i = 0; i < serverJobs.length; i += 6) {
    await Promise.all(serverJobs.slice(i, i + 6).map(_clientVerifyOne));
  }
}

/* ── Archive.org CDX fallback ────────────────────────────────────────────
 * For any card still 'unknown' or 'blocked' after all other checks,
 * query the Wayback Machine CDX API (open CORS, no key needed) to see
 * if the profile URL was ever archived with a 200 status since 2022.
 * If it was, the profile almost certainly existed at that point in time.
 * ─────────────────────────────────────────────────────────────────────── */
async function runArchiveFallback() {
  const cards = [...resultsGrid.querySelectorAll('.result-card.unknown, .result-card.blocked')]
    .filter(c => c.dataset.profileUrl && !c.classList.contains('cv-verifying'));
  if (!cards.length) return;

  const BATCH = 5; // CDX API has no hard rate-limit but be polite
  for (let i = 0; i < cards.length; i += BATCH) {
    await Promise.all(cards.slice(i, i + BATCH).map(async card => {
      const profileUrl = card.dataset.profileUrl;
      if (!profileUrl) return;
      try {
        // Strip leading https:// for CDX URL matching (more inclusive)
        const cdxTarget = profileUrl.replace(/^https?:\/\//, '');
        const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(cdxTarget)}&output=json&limit=2&filter=statuscode:200&from=20220101&fl=timestamp&matchType=prefix`;
        const resp = await fetch(cdxUrl, { signal: AbortSignal.timeout(9000) });
        if (!resp.ok) return;
        const data = await resp.json();
        // data[0] = header row, data[1] = first result (if any)
        if (Array.isArray(data) && data.length > 1 && data[1]) {
          const ts  = String(data[1][0] || '');
          const yr  = ts.length >= 4 ? ts.slice(0, 4) : '?';
          _applyVerdict(card, 'found', `FOUND (archived ${yr})`);
          updateStats();
        }
      } catch (_) { /* timeout or network error — skip */ }
    }));
  }
}

/* ── Found-first insertion ───────────────────────────────────────────── */
function insertCardSorted(card) {
  const category = (card.dataset.category || 'misc').toLowerCase();
  const section = resultsGrid.querySelector(`[data-category-section="${CSS.escape(category)}"]`);
  if (section) {
    section.appendChild(card);
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
  const sections = resultsGrid.querySelectorAll('.result-category-section');
  sections.forEach(section => {
    const sectionCards = section.querySelectorAll('.result-card');
    const visibleCards = [...sectionCards].filter(card => {
      if (card.classList.contains('name-card')) return true;
      const catMatch = activeFilter === 'all' || card.dataset.category === activeFilter;
      const foundMatch = !foundOnly || card.dataset.status === 'found';
      return catMatch && foundMatch;
    });
    const hasVisible = visibleCards.length > 0;
    section.style.display = hasVisible ? '' : 'none';
  });
  cards.forEach(card => {
    if (card.classList.contains('name-card')) return; // name cards always visible
    const catMatch = activeFilter === 'all' || card.dataset.category === activeFilter;
    const foundMatch = !foundOnly || card.dataset.status === 'found';
    card.classList.toggle('hidden', !(catMatch && foundMatch));
  });
}

/* ── Stats ───────────────────────────────────────────────────────────── */
function updateStats(done, total) {
  const found    = results.filter(r => r.status === 'found').length;
  const deleted  = results.filter(r => r.status === 'deleted').length;
  const notFound = results.filter(r => r.status === 'not_found').length;

  if (done  !== undefined) statChecked.textContent = done;
  if (total !== undefined) statTotal.textContent   = total;
  statFound.textContent    = found;
  statDeleted.textContent  = deleted;
  statNotFound.textContent = notFound;
  if (done !== undefined && total !== undefined) {
    progressBarFill.style.width = total ? `${(done / total) * 100}%` : '0%';
  }
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

/* ── Main scan (client-side static — no server required) ─────────────── */
async function startScan(username) {
  if (scanActive) return;
  scanActive = true;

  resetScanState();
  renderQuickChecks([]);
  dorkResults = [];
  renderDorkResults();

  currentUsername.textContent = username;
  updateDorkPanel(username);
  renderPivotSources();
  const fabGrpA = $('fabGroup'); if (fabGrpA) fabGrpA.style.display = 'flex';
  pushCaseEvent(`Username investigation started for ${username}`, 'start');
  scanProgressSec.style.display = 'block';
  resultsSec.style.display = 'block';
  scanBtn.disabled = true;
  scanBtn.textContent = 'SCANNING…';
  searchError.style.display = 'none';
  filterCategories.style.display = '';
  resultsSec.scrollIntoView({ behavior: 'smooth', block: 'start' });

  /* Load sites.json once; reuse cache on subsequent scans */
  if (!_sitesCache) {
    try {
      const r = await fetch('./sites.json');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      _sitesCache = (await r.json()).filter(s => !s.defunct);
    } catch (_) {
      progressStatus.textContent = 'Could not load platforms list — check connection and reload.';
      progressBarFill.parentElement.classList.remove('scanning');
      resetScanControls();
      return;
    }
  }

  const sites = _sitesCache;
  updateStats(0, sites.length);
  progressStatus.innerHTML = `Scanning <strong>${escHtml(username)}</strong>…`;

  const categoryOrder = ['social','developer','gaming','content','forum','professional','shopping','misc'];
  const categorySections = {};
  categoryOrder.forEach(cat => {
    const section = document.createElement('div');
    section.className = 'result-category-section';
    section.dataset.categorySection = cat;
    section.innerHTML = `<div class="result-category-header">${escHtml(cat)}</div><div class="result-category-list"></div>`;
    resultsGrid.appendChild(section);
    categorySections[cat] = section.querySelector('.result-category-list');
  });
  const miscSection = categorySections.misc || resultsGrid.appendChild(document.createElement('div'));

  /* Build result objects and create cards for every site up-front.
   * makeCard() auto-queues cors=true sites into _cvQueue for direct
   * browser verification (user IP → avoids datacenter blocks).
   * Non-CORS sites stay 'unknown' and are handled by runArchiveFallback(). */
  let done = 0;
  for (const site of sites) {
    const profileUrl = site.url.replace(/\{\}/g, username);
    const checkUrl   = (site.checkUrl || site.apiUrl || site.url).replace(/\{\}/g, username);
    const result = {
      name           : site.name,
      category       : site.category,
      url            : profileUrl,
      checkUrl,
      cors           : !!site.cors,
      auth           : !!site.auth,
      cfProxy        : !!site.cfProxy,
      status         : 'unknown',
      statusCode     : null,
      reasonCodes    : [],
      checkMethod    : site.checkMethod    || 'status_code',
      positiveMsg    : site.positiveMsg    || null,
      errorMsg       : site.errorMsg       || null,
      notFoundStatus : site.notFoundStatus || null,
      expectedStatus : site.expectedStatus || null,
      caveat         : site.caveat         || null,
    };
    results.push(result);
    const card = makeCard(result, 0);
    card.dataset.resultIndex = String(results.length - 1);
    const targetList = categorySections[site.category] || miscSection;
    targetList.appendChild(card);
    done++;
    if (done % 30 === 0) {
      updateStats(done, sites.length);
      await new Promise(resolve => setTimeout(resolve, 0)); /* yield so UI stays responsive */
    }
  }
  updateStats(sites.length, sites.length);
  applyFilters();

  finishScan(username, sites.length, sites.length);
}

/* ── Name / Email / Phone / Domain scans (not available in static mode) ─ */
async function startNameScan(fullName) {
  scanActive = false;
  if (pivotNameBtn) {
    pivotNameBtn.disabled = true;
    pivotNameBtn.textContent = 'OPENING…';
  }
  await runPivotQuery('name', fullName);
  if (pivotNameBtn) {
    pivotNameBtn.disabled = false;
    pivotNameBtn.textContent = 'Run name pivot';
  }
}
async function startEmailScan(email) {
  scanActive = false;
  if (pivotEmailBtn) {
    pivotEmailBtn.disabled = true;
    pivotEmailBtn.textContent = 'OPENING…';
  }
  await runPivotQuery('email', email);
  if (pivotEmailBtn) {
    pivotEmailBtn.disabled = false;
    pivotEmailBtn.textContent = 'Run email pivot';
  }
}
async function startPhoneScan(phone) {
  scanActive = false;
  if (pivotPhoneBtn) {
    pivotPhoneBtn.disabled = true;
    pivotPhoneBtn.textContent = 'OPENING…';
  }
  await runPivotQuery('phone', phone);
  if (pivotPhoneBtn) {
    pivotPhoneBtn.disabled = false;
    pivotPhoneBtn.textContent = 'Run phone pivot';
  }
}
function startDomainScan(_domain) {
  scanActive = false;
  if (domainScanBtn) { domainScanBtn.disabled = false; domainScanBtn.textContent = 'SCAN'; }
}

function finishScan(username, done, total) {
  progressBarFill.parentElement.classList.remove('scanning');
  progressBarFill.style.width = '100%';

  const found = results.filter(r => r.status === 'found').length;
  progressStatus.innerHTML = `Scan complete — <strong>${escHtml(username)}</strong>`;
  completionText.textContent = `${found} profile${found !== 1 ? 's' : ''} found across ${total} platforms · grouped by category`;
  completionBar.style.display = 'flex';
  pushCaseEvent(`Username investigation complete: ${found} found across ${total} sources`, 'done');
  renderPivotSources();
  runDorkSearch();
  resetScanControls();

  /* Run CORS browser verification then Archive.org CDX, then populate manual panel */
  const corsCount   = _cvQueue.filter(j => j.type === 'cors').length;
  const authCount   = _cvQueue.filter(j => j.type === 'auth').length;
  const proxyCount  = _cvQueue.filter(j => j.type === 'proxy').length;
  const serverCount = _cvQueue.filter(j => j.type === 'server').length;
  const parts = [];
  if (corsCount)   parts.push(`${corsCount} API`);
  if (authCount)   parts.push(`${authCount} auth`);
  if (proxyCount)  parts.push(`${proxyCount} proxy`);
  if (serverCount) parts.push(`${serverCount} server`);
  progressStatus.innerHTML += ` &mdash; <span id="cvStatus">verifying ${parts.length ? parts.join(', ') : 'sources'}…</span>`;

  const runCV = _cvQueue.length > 0 ? runClientVerifyQueue() : Promise.resolve();
  runCV.then(() => {
    const cvEl = document.getElementById('cvStatus');
    if (cvEl) cvEl.textContent = 'archive check…';
    return runArchiveFallback();
  }).then(() => {
    const cvEl2 = document.getElementById('cvStatus');
    if (cvEl2) cvEl2.remove();
    populateManualPanel();
    updateStats();
  });
}

/* Add sites still 'unknown' after all verification to the manual check panel */
function populateManualPanel() {
  /* Only add cards still truly 'unknown' (unresolvable) — 'blocked' stays in the grid */
  const unknownCards = [...resultsGrid.querySelectorAll('.result-card.unknown')]
    .filter(c => !manualResults.some(m => m.name === c.dataset.site));
  unknownCards.forEach(card => {
    const r = results.find(res => res.name === card.dataset.site);
    if (r) {
      manualResults.push(r);
      manualLinksList.appendChild(makeManualItem(r));
    }
  });
  if (manualResults.length) {
    manualCheckCount.textContent = manualResults.length;
    manualCheckPanel.style.display = 'block';
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

  if (pivotTabs) {
    pivotTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.pivot-tab');
      if (!tab) return;
      activePivotMode = tab.dataset.pivot || 'email';
      pivotTabs.querySelectorAll('.pivot-tab').forEach(btn => btn.classList.toggle('active', btn === tab));
      renderPivotSources();
    });
  }

  if (dorkTabs) {
    dorkTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.dork-tab');
      if (!tab || tab.disabled) return;
      activeDorkEngine = tab.dataset.engine || 'google';
      dorkTabs.querySelectorAll('.dork-tab').forEach(btn => btn.classList.toggle('active', btn === tab));
      if (lastScannedTarget) runDorkSearch();
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
  fetch('./sites.json')
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
  renderPivotSources();
});
