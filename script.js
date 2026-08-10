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
  username_format_incompatible: 'Username format not valid for this platform',
  probe_timeout: 'Site did not respond within 15 seconds',
  body_guard_username_match: 'Username matched on page',
  body_guard_no_username_match: 'Profile loaded but username was not confirmed',
  site_positive_message: 'Site-specific positive signal matched',
  skip_body_check_enabled: 'Direct profile response accepted',
  username_present_in_body: 'Username explicitly present in page content',
  archive_org_fallback_found: 'Found archived in the Wayback Machine',
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
let activeStatusFilter = null; // null = no filter, else a status string

/* ── Turnstile state ─────────────────────────────────────────────────── */
// Replace with your real sitekey from dash.cloudflare.com > Turnstile
const TURNSTILE_SITEKEY = '1x00000000000000000000AA'; // test key — always passes
let _cfToken     = null;   // token provided by Turnstile callback
let _tsWidgetId  = null;   // widget handle for reset()

window.__probeOnTurnstile = function (token) { _cfToken = token; };
window.__probeOnTsExpire  = function ()      { _cfToken = null;  };

function initTurnstile() {
  const container = document.getElementById('turnstileContainer');
  if (!container || !window.turnstile) return;
  _tsWidgetId = window.turnstile.render(container, {
    sitekey             : TURNSTILE_SITEKEY,
    callback            : '__probeOnTurnstile',
    'expired-callback'  : '__probeOnTsExpire',
    appearance          : 'interaction-only',
  });
}
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
const statBlocked       = $('statBlocked');
const statNotFound      = $('statNotFound');
const statError         = $('statError');
const resultsGrid       = $('resultsGrid');
const foundOnlyToggle   = $('foundOnlyToggle');
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

/* fetchPinMeta — call /api/link-preview to resolve og:image for pinned URLs */
function fetchPinMeta(idx) {
  const p = pinnedItems[idx];
  if (!p || !p.url || captures[p.url]) return;
  fetch(`/api/link-preview?url=${encodeURIComponent(p.url)}`)
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      // Store result (image may be null) — either way clears the loading state
      captures[p.url] = {
        metadata: data && data.image ? { ogImage: data.image } : {},
        screenshot: '',
        mimeType: '',
      };
      updateNotepad();
    })
    .catch(() => {
      captures[p.url] = { metadata: {}, screenshot: '', mimeType: '' };
      updateNotepad();
    });
}

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
    dorkStatus.textContent = `Ready to search ${target}`;
    renderPivotSources();
  } else {
    if (tabs) tabs.querySelectorAll('.dork-tab').forEach(b => b.disabled = true);
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
  const target = lastScannedTarget || '';
  ['email', 'phone', 'name'].forEach(mode => {
    const listEl = $(`pivot${mode.charAt(0).toUpperCase() + mode.slice(1)}List`);
    if (!listEl) return;
    const sources = PIVOT_SOURCES[mode] || [];
    listEl.innerHTML = sources.map(source => {
      const href = safeUrl(target ? source.url(target) : source.home);
      return `
        <div class="wmn-source-card">
          <div class="wmn-source-row">
            <div>
              <div class="wmn-source-name">${escHtml(source.name)}</div>
              <div class="wmn-source-meta">${escHtml(source.note)}</div>
            </div>
            <a class="wmn-source-link" href="${href}" target="_blank" rel="noopener noreferrer">${target ? 'Open' : 'Home'}</a>
          </div>
        </div>
      `;
    }).join('');
  });
}

/* ── Dork results — rendered as a search-engine results page (SERP):
 * clickable blue title, green breadcrumb URL, gray snippet text, and an
 * optional lazy-loaded thumbnail pulled from the target page's og:image.
 * Every engine (google/bing/ddg/yandex) renders with this exact layout. */
function renderDorkResults(searched) {
  if (!dorkResultsList || !dorkStatus) return;
  if (!dorkResults.length) {
    dorkResultsList.innerHTML = searched
      ? '<div class="wmn-empty">No results found for this engine.</div>'
      : '<div class="wmn-empty">Run a scan to populate dork results.</div>';
    return;
  }
  const engineLabel = activeDorkEngine.charAt(0).toUpperCase() + activeDorkEngine.slice(1);
  dorkStatus.textContent = `${dorkResults.length} ${engineLabel} results for ${lastScannedTarget || 'current target'}`;
  dorkResultsList.innerHTML = dorkResults.map((item, idx) => {
    const cleanUrl = String(item.url || '').replace(/\s+/g, '');
    const safeHref = escHtml(safeUrl(cleanUrl));
    let host = cleanUrl;
    try { host = new URL(cleanUrl).hostname.replace(/^www\./, ''); } catch (_) { /* keep raw */ }
    const displayUrl = cleanUrl.length > 90 ? `${cleanUrl.slice(0, 87)}…` : cleanUrl;
    const snippetHtml = item.snippet
      ? `<div class="serp-snippet">${escHtml(item.snippet)}</div>`
      : '';
    return `
      <div class="serp-result">
        <div class="serp-thumb" data-preview-url="${escHtml(cleanUrl)}" data-preview-idx="${idx}">
          <img class="serp-thumb-img" alt="" loading="lazy">
        </div>
        <div class="serp-body">
          <div class="serp-breadcrumb">${escHtml(host)}</div>
          <a class="serp-title" href="${safeHref}" target="_blank" rel="noopener noreferrer">${escHtml(item.title || cleanUrl || 'Result')}</a>
          <div class="serp-url">${escHtml(displayUrl)}</div>
          ${snippetHtml}
        </div>
      </div>
    `;
  }).join('');

  loadDorkThumbnails();
}

// Lazily fetch an og:image/twitter:image preview for each rendered result.
// Small batch size (4) since there are only ever ~8 results per engine —
// no need for a full concurrency-controlled queue like the main scan.
async function loadDorkThumbnails() {
  const thumbs = [...dorkResultsList.querySelectorAll('.serp-thumb[data-preview-url]')];
  for (let i = 0; i < thumbs.length; i += 4) {
    await Promise.all(thumbs.slice(i, i + 4).map(async (thumb) => {
      const url = thumb.dataset.previewUrl;
      if (!url) return;
      try {
        const resp = await fetch(`/api/link-preview?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(7000) });
        const payload = await resp.json();
        if (payload && payload.ok && payload.image) {
          const img = thumb.querySelector('.serp-thumb-img');
          if (img) {
            img.src = payload.image;
            img.onerror = () => thumb.classList.add('no-image');
            thumb.classList.add('has-image');
          }
        } else {
          thumb.classList.add('no-image');
        }
      } catch (_) {
        thumb.classList.add('no-image');
      }
    }));
  }
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
      title: item.title || `Result ${idx + 1}`,
      url: item.url,
      snippet: item.snippet || '',
      engine: item.engine || activeDorkEngine,
    }));
    renderDorkResults(true);
  } catch (err) {
    dorkResults = [];
    dorkStatus.textContent = (err && err.name === 'TimeoutError') ? 'Dork lookup timed out.' : 'Dork lookup failed.';
    renderDorkResults(true);
  }
}

function initSidePanel() {
  const panel     = $('caseNotepad');
  const tabBtn    = $('sideNotepadTab');
  const closeBtn  = $('notepadCloseBtn');
  const detachBtn = $('notepadDetachBtn');
  const detachBar = $('spDetachBar');
  const formatBar = panel && panel.querySelector('.np-format-bar');
  if (!panel || !tabBtn) return;

  // ── Restore edge/position from localStorage ─────────────────────────
  const savedEdge = localStorage.getItem('np_edge') || 'right';
  const savedPos  = parseFloat(localStorage.getItem('np_pos') || '50');
  applyEdgePos(panel, savedEdge, savedPos);

  let panelOpen   = false;
  let dragging    = false;
  let startX, startY, currentEdge = savedEdge, currentPos = savedPos;

  function openPanel()  { panelOpen = true;  panel.classList.add('sp-open');    }
  function closePanel() { panelOpen = false; panel.classList.remove('sp-open'); }

  // ── Detach / Reattach ────────────────────────────────────────────────
  let isDetached = localStorage.getItem('np_detached') === '1';

  function setDetached(flag) {
    isDetached = flag;
    localStorage.setItem('np_detached', flag ? '1' : '0');
    panel.classList.toggle('detached', flag);
    if (flag) {
      // Float the panel
      panel.classList.add('sp-open');
      const dx = parseFloat(localStorage.getItem('np_dx') || String(Math.max(20, window.innerWidth  - 340)));
      const dy = parseFloat(localStorage.getItem('np_dy') || String(Math.max(20, window.innerHeight - 420)));
      panel.style.left   = dx + 'px';
      panel.style.top    = dy + 'px';
      panel.style.right  = 'auto';
      panel.style.bottom = 'auto';
      panel.style.transform = '';
      // Make drag bar the move handle; save position on mouseup
      if (detachBar) {
        makeDraggable(panel, detachBar);
        // Persist position when dragging ends
        document.addEventListener('mouseup', function saveDrag() {
          if (!isDetached) { document.removeEventListener('mouseup', saveDrag); return; }
          localStorage.setItem('np_dx', String(Math.round(parseFloat(panel.style.left)  || 0)));
          localStorage.setItem('np_dy', String(Math.round(parseFloat(panel.style.top)   || 0)));
        });
      }
      if (detachBtn) { detachBtn.textContent = '\u229f'; detachBtn.title = 'Re-attach to edge'; }
    } else {
      // Return to edge
      applyEdgePos(panel, currentEdge, currentPos);
      if (!panelOpen) closePanel();
      if (detachBtn) { detachBtn.textContent = '\u229e'; detachBtn.title = 'Detach from edge'; }
    }
  }

  if (detachBtn) detachBtn.addEventListener('click', () => setDetached(!isDetached));

  // Restore detached state on load
  if (isDetached) {
    setDetached(true);
  }

  // Tab click: toggle open/close. Drag detection prevents accidental toggle.
  tabBtn.addEventListener('pointerdown', (e) => {
    dragging = false;
    startX = e.clientX;
    startY = e.clientY;
    tabBtn.setPointerCapture(e.pointerId);
  });

  tabBtn.addEventListener('pointermove', (e) => {
    if (!e.buttons) return;
    const dx = Math.abs(e.clientX - startX);
    const dy = Math.abs(e.clientY - startY);
    if (dx > 6 || dy > 6) dragging = true;
    if (!dragging) return;

    // Find closest edge
    const W = window.innerWidth, H = window.innerHeight;
    const dists = {
      right:  W - e.clientX,
      left:   e.clientX,
      top:    e.clientY,
      bottom: H - e.clientY,
    };
    currentEdge = Object.keys(dists).reduce((a, b) => dists[a] < dists[b] ? a : b);
    currentPos  = (currentEdge === 'left' || currentEdge === 'right')
      ? (e.clientY / H) * 100
      : (e.clientX / W) * 100;

    applyEdgePos(panel, currentEdge, currentPos);
  });

  tabBtn.addEventListener('pointerup', () => {
    if (dragging) {
      localStorage.setItem('np_edge', currentEdge);
      localStorage.setItem('np_pos', String(currentPos.toFixed(1)));
    } else {
      // Simple click — toggle
      panelOpen ? closePanel() : openPanel();
    }
    dragging = false;
  });

  if (closeBtn) closeBtn.addEventListener('click', closePanel);

  // ── Pin a URL from dork results ─────────────────────────────────────
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

  // ── Notepad content (localStorage) ─────────────────────────────────
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

  // ── Format bar ──────────────────────────────────────────────────────
  const fmtBold   = $('npFmtBold');
  const fmtUnder  = $('npFmtUnder');
  const fmtBullet = $('npFmtBullet');
  if (fmtBold)   fmtBold.addEventListener('mousedown',   (e) => { e.preventDefault(); document.execCommand('bold'); });
  if (fmtUnder)  fmtUnder.addEventListener('mousedown',  (e) => { e.preventDefault(); document.execCommand('underline'); });
  if (fmtBullet) fmtBullet.addEventListener('mousedown', (e) => { e.preventDefault(); document.execCommand('insertUnorderedList'); });

  // ── Export (markdown only) ───────────────────────────────────────────
  const npExportBtn = $('npExportBtn');
  if (npExportBtn) npExportBtn.addEventListener('click', exportMarkdown);

  // ── URL pin input ────────────────────────────────────────────────────
  const npAddUrl   = $('npAddUrl');
  const npUrlInput = $('npUrlInput');
  if (npAddUrl)   npAddUrl.addEventListener('click', () => { if (addPinFromUrl(npUrlInput ? npUrlInput.value : '', 'manual')) { if (npUrlInput) npUrlInput.value = ''; } });
  if (npUrlInput) npUrlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && addPinFromUrl(npUrlInput.value, 'manual')) npUrlInput.value = ''; });

  updateDorkPanel('');
  updateNotepad();
}

/* ── Edge/position helper ────────────────────────────────────────────── */
function applyEdgePos(panel, edge, pos) {
  const pct = `${Math.max(8, Math.min(92, pos)).toFixed(1)}%`;
  panel.dataset.edge = edge;
  panel.style.top    = '';
  panel.style.bottom = '';
  panel.style.left   = '';
  panel.style.right  = '';
  panel.style.transform = '';
  if (edge === 'right') {
    panel.style.right     = '0';
    panel.style.top       = pct;
    panel.style.transform = 'translateY(-50%)';
  } else if (edge === 'left') {
    panel.style.left      = '0';
    panel.style.top       = pct;
    panel.style.transform = 'translateY(-50%)';
  } else if (edge === 'top') {
    panel.style.top       = '0';
    panel.style.left      = pct;
    panel.style.transform = 'translateX(-50%)';
  } else {
    panel.style.bottom    = '0';
    panel.style.left      = pct;
    panel.style.transform = 'translateX(-50%)';
  }
}

/* ── Platforms grid (static, rendered on load) ───────────────────────── */
function initPlatformsGrid(sites) {
  // Platforms to feature in the ticker (order matters for visual variety)
  const FEATURED_ORDER = [
    'GitHub','Instagram','TikTok','Reddit','YouTube','Twitch',
    'Snapchat','LinkedIn','Pinterest','Steam','Discord','Spotify',
    'SoundCloud','Vimeo','DeviantArt','Medium','Behance','Dribbble',
    'Patreon','Fiverr','Etsy','GitLab','Telegram','Mastodon','Flickr',
  ];

  const activeSites = (sites || []).filter(s => !s.defunct);
  const featured = FEATURED_ORDER
    .map(name => activeSites.find(s => s.name === name))
    .filter(Boolean);

  // Fallback: fill with alphabetical active sites if featured list too short
  if (featured.length < 12) {
    activeSites.forEach(s => {
      if (!featured.find(f => f.name === s.name)) featured.push(s);
    });
    featured.length = Math.min(featured.length, 25);
  }

  function makeChip(site) {
    let domain = '';
    try { domain = new URL(site.urlMain || site.url.replace('{}', 'x')).hostname.replace(/^www\./, ''); } catch(_) {}
    const chip = document.createElement('div');
    chip.className = 'platform-chip';
    chip.title = site.name;
    chip.innerHTML = domain
      ? `<img class="chip-logo" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32" alt="" loading="lazy"><span class="chip-name">${escHtml(site.name)}</span>`
      : `<span class="chip-name">${escHtml(site.name)}</span>`;
    return chip;
  }

  const track = $('platformsGrid');
  if (!track) return;

  // Build two copies for seamless infinite scroll
  const frag = document.createDocumentFragment();
  [...featured, ...featured].forEach(site => frag.appendChild(makeChip(site)));
  track.appendChild(frag);

  // Update count placeholders
  const count = activeSites.length;
  document.querySelectorAll('#heroCount, #siteCount, .step-count').forEach(el => {
    el.textContent = count;
  });

  // Update search hint
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
      <div class="card-top-right">${browserBadge}${scBadge}<span class="category-badge">${escHtml(r.category)}</span><button class="pin-btn${isPinned ? ' pinned' : ''}" data-pin-name="${escHtml(r.name)}" title="Pin to case notepad">📌</button><button class="report-btn" data-report-site="${escHtml(r.name)}" title="Report incorrect result">⚑</button></div>
    </div>
    <div class="site-name">${escHtml(r.name)}</div>
    ${displayNameHtml}
    ${reasonHtml}
    ${badgeHtml}
    ${manualLink}
  `;

  // Store profile URL for archive.org fallback
  card.dataset.profileUrl = r.url || '';

  // The server now resolves every site itself (direct request, WMN dual-
  // signal check, stealth-browser fallback, and Wayback Machine fallback
  // are all done server-side). The only thing that genuinely can't be
  // done server-side is an auth-gated check that needs the *user's own*
  // login cookies — that's the one client-side tier kept below.
  if (r.auth && r.status === 'auth_required') {
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
 *  The server resolves every site itself now (direct request, WMN dual-
 *  signal check, stealth-browser fallback, Wayback Machine fallback are
 *  all done server-side — see /api/check in server.js). The 'cors' and
 *  'proxy' (CF Worker edge) tiers that used to run in the browser were
 *  removed as redundant now that the server handles those sites the same
 *  way as everything else.
 *  The ONE tier still run here is 'auth' — a no-cors, credentials:include
 *  redirect-detect for auth-gated sites, which only works with the
 *  *user's own* browser session/cookies and can never be replicated
 *  server-side.
 * ─────────────────────────────────────────────────────────────────── */

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

async function _clientVerifyOne(job) {
  const { card, checkUrl } = job;
  if (!card || !card.isConnected) return;

  card.classList.add('cv-verifying');
  const statusEl = card.querySelector('.status-badge');
  const prevText = statusEl ? statusEl.textContent : '';
  if (statusEl) statusEl.textContent = '…';

  try {
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
  } catch (_) {
    card.classList.remove('cv-verifying');
    if (statusEl) statusEl.textContent = prevText;
  }
}

// Kick off all queued auth-tier verify jobs after the scan ends. These all
// hit different origins (one per site), so a wide batch is safe.
async function runClientVerifyQueue() {
  const jobs = _cvQueue.slice();
  _cvQueue.length = 0;
  for (let i = 0; i < jobs.length; i += 8) {
    await Promise.all(jobs.slice(i, i + 8).map(_clientVerifyOne));
  }
}

/* ── Archive.org CDX fallback ────────────────────────────────────────────
 * This used to run client-side against any 'unknown'/'blocked' card after
 * the other tiers finished. It's now done server-side (see
 * probeArchiveOrgFallback() in server.js) as part of the single /api/check
 * result for each site, so there's nothing left to do here.
 * ─────────────────────────────────────────────────────────────────────── */

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
function statusFilterMatch(cardStatus) {
  if (activeStatusFilter) {
    if (activeStatusFilter === 'error') return cardStatus === 'error' || cardStatus === 'timeout';
    return cardStatus === activeStatusFilter;
  }
  return !foundOnly || cardStatus === 'found';
}

function applyFilters() {
  const cards = resultsGrid.querySelectorAll('.result-card');
  cards.forEach(card => {
    if (card.classList.contains('name-card')) return; // name cards always visible
    const catMatch = activeFilter === 'all' || card.dataset.category === activeFilter;
    const stMatch  = statusFilterMatch(card.dataset.status);
    card.classList.toggle('hidden', !(catMatch && stMatch));
  });
}

/* ── Stats ───────────────────────────────────────────────────────────── */
function updateStats(done, total) {
  const found    = results.filter(r => r.status === 'found').length;
  const blocked  = results.filter(r => r.status === 'blocked').length;
  const notFound = results.filter(r => r.status === 'not_found').length;
  const error    = results.filter(r => r.status === 'error' || r.status === 'timeout').length;

  if (done  !== undefined) statChecked.textContent = done;
  if (total !== undefined) statTotal.textContent   = total;
  statFound.textContent    = found;
  statBlocked.textContent  = blocked;
  statNotFound.textContent = notFound;
  statError.textContent    = error;
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
  progressBarFill.style.width = '0%';
  progressBarFill.parentElement.classList.add('scanning');
  // Restore cancel button
  cancelBtn.textContent = '✕ Cancel';
  cancelBtn.classList.remove('btn-done');
  // Clear status filter
  activeStatusFilter = null;
  document.querySelectorAll('.stat-pill.active').forEach(el => el.classList.remove('active'));
}

/* ── Main scan — streams live results from the server via SSE ────────
 * The server (/api/check) does ALL of the work: direct request, WMN
 * dual-signal classification, stealth-browser fallback, and Wayback
 * Machine fallback. Each site is sent to the client the instant the
 * server finishes checking it, with a real running `done`/`total`
 * count — that's what drives an accurate progress bar (as opposed to
 * the old approach of building every card up-front and only then
 * kicking off async verification). */
function startScan(username, cfToken) {
  if (scanActive) return;
  scanActive = true;

  resetScanState();
  renderQuickChecks([]);
  dorkResults = [];
  renderDorkResults();

  currentUsername.textContent = username;
  updateDorkPanel(username);
  renderPivotSources();
  // Kick off dork search at scan start so results appear early
  runDorkSearch();
  pushCaseEvent(`Username investigation started for ${username}`, 'start');
  scanProgressSec.style.display = 'block';
  resultsSec.style.display = 'block';
  scanBtn.disabled = true;
  scanBtn.textContent = 'SCANNING…';
  searchError.style.display = 'none';
  filterCategories.style.display = '';
  resultsSec.scrollIntoView({ behavior: 'smooth', block: 'start' });

  updateStats(0, 0);
  progressStatus.innerHTML = `Scanning <strong>${escHtml(username)}</strong>…`;

  if (evtSource) { evtSource.close(); evtSource = null; }
  const tokenParam = cfToken ? `&cf-token=${encodeURIComponent(cfToken)}` : '';
  evtSource = new EventSource(`/api/check?username=${encodeURIComponent(username)}${tokenParam}`);

  evtSource.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }

    // Rate-limit or Turnstile failure from server
    if (msg.type === 'error') {
      if (evtSource) { evtSource.close(); evtSource = null; }
      scanActive = false;
      scanBtn.disabled = false;
      scanBtn.textContent = 'SCAN';
      progressBarFill.parentElement.classList.remove('scanning');
      cancelBtn.textContent = '\u2715 Cancel';
      cancelBtn.classList.remove('btn-done');
      scanProgressSec.style.display = 'none';
      resultsSec.style.display = 'none';
      searchError.textContent = msg.error || 'Scan failed. Please try again.';
      searchError.style.display = 'block';
      if (window.turnstile && _tsWidgetId !== null) {
        try { window.turnstile.reset(_tsWidgetId); } catch (_) {}
      }
      return;
    }

    if (msg.type === 'result') {
      const category = msg.category || 'misc';
      const result = {
        name        : msg.name,
        category,
        url         : msg.url || '',
        auth        : !!msg.auth,
        status      : msg.status || 'unknown',
        statusCode  : msg.statusCode || null,
        reasonCodes : Array.isArray(msg.reasonCodes) ? msg.reasonCodes : [],
        displayName : msg.displayName || null,
        resolvedBy  : msg.resolvedBy || null,
      };
      results.push(result);
      const card = makeCard(result, 0);
      card.dataset.resultIndex = String(results.length - 1);
      resultsGrid.appendChild(card);
      updateStats(msg.done, msg.total);
      applyFilters();
      return;
    }

    if (msg.type === 'done') {
      finishScan(username, msg.done ?? results.length, msg.total ?? results.length);
    }
  };

  evtSource.onerror = () => {
    if (!scanActive) return; // already finished/cancelled — ignore trailing error after close()
    if (evtSource) { evtSource.close(); evtSource = null; }
    finishScan(username, results.length, results.length);
  };
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
  if (evtSource) { evtSource.close(); evtSource = null; }
  progressBarFill.parentElement.classList.remove('scanning');
  progressBarFill.style.width = '100%';

  const found = results.filter(r => r.status === 'found').length;
  progressStatus.innerHTML = `Scan complete — <strong>${escHtml(username)}</strong>`;
  pushCaseEvent(`Username investigation complete: ${found} found across ${total} sources`, 'done');
  cancelBtn.textContent = '✓ Done';
  cancelBtn.classList.add('btn-done');
  renderPivotSources();
  runDorkSearch();
  resetScanControls();

  /* The only client-side verification tier left is 'auth' (auth-gated
   * sites, checked with the user's own browser cookies) — everything
   * else was resolved server-side already. */
  const authCount = _cvQueue.length;
  if (authCount) {
    progressStatus.innerHTML += ` &mdash; <span id="cvStatus">verifying ${authCount} auth-gated source${authCount !== 1 ? 's' : ''}…</span>`;
  }

  const runCV = _cvQueue.length > 0 ? runClientVerifyQueue() : Promise.resolve();
  runCV.then(() => {
    const cvEl = document.getElementById('cvStatus');
    if (cvEl) cvEl.remove();
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
  pushCaseEvent(`Name investigation complete: ${total} sources processed`, 'done');
  cancelBtn.textContent = '✓ Done';
  cancelBtn.classList.add('btn-done');

  resetNameScanControls();
}

function finishEmailScan(email, done, total) {
  if (evtSource) { evtSource.close(); evtSource = null; }
  progressBarFill.parentElement.classList.remove('scanning');
  progressBarFill.style.width = '100%';

  progressStatus.innerHTML = `Email investigation ready — <strong>${escHtml(email)}</strong>`;
  pushCaseEvent(`Email investigation complete: ${total} sources processed`, 'done');
  cancelBtn.textContent = '✓ Done';
  cancelBtn.classList.add('btn-done');

  resetEmailScanControls();
}

function finishPhoneScan(phone, done, total) {
  if (evtSource) { evtSource.close(); evtSource = null; }
  progressBarFill.parentElement.classList.remove('scanning');
  progressBarFill.style.width = '100%';

  progressStatus.innerHTML = `Phone investigation ready — <strong>${escHtml(phone)}</strong>`;
  pushCaseEvent(`Phone investigation complete: ${total} sources processed`, 'done');
  cancelBtn.textContent = '✓ Done';
  cancelBtn.classList.add('btn-done');

  resetPhoneScanControls();
}

function finishDomainScan(domain, done, total) {
  if (evtSource) { evtSource.close(); evtSource = null; }
  progressBarFill.parentElement.classList.remove('scanning');
  progressBarFill.style.width = '100%';

  progressStatus.innerHTML = `Domain investigation ready — <strong>${escHtml(domain)}</strong>`;
  pushCaseEvent(`Domain investigation complete: ${total} sources processed`, 'done');
  cancelBtn.textContent = '✓ Done';
  cancelBtn.classList.add('btn-done');

  resetDomainScanControls();
}

function cancelScan() {
  if (evtSource) { evtSource.close(); evtSource = null; }
  progressBarFill.parentElement.classList.remove('scanning');
  progressStatus.textContent = 'Scan cancelled.';
  pushCaseEvent('Investigation cancelled by user', 'warn');
  cancelBtn.textContent = '✓ Done';
  cancelBtn.classList.add('btn-done');
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
function buildCsvRows(subset) {
  const header = 'Name,Category,Status,Confidence,Reasons,URL';
  const rows = subset.map(r =>
    [r.name, r.category, r.status,
     typeof r.confidence === 'number' ? Math.round(r.confidence * 100) : '',
     Array.isArray(r.reasonCodes) ? r.reasonCodes.join('|') : '', r.url]
      .map(v => `"${String(v).replace(/"/g, '""')}"`)
      .join(',')
  );
  return [header, ...rows].join('\r\n');
}

function exportCsv() {
  const csv = buildCsvRows(results);
  downloadText(csv, `probe_${usernameInput.value}_all_${Date.now()}.csv`, 'text/csv');
}

function exportCsvFound() {
  const subset = results.filter(r => r.status === 'found' || r.status === 'deleted');
  const csv = buildCsvRows(subset);
  downloadText(csv, `probe_${usernameInput.value}_found_${Date.now()}.csv`, 'text/csv');
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
  downloadText(JSON.stringify(payload, null, 2), `probe_${payload.query || 'scan'}_all_${Date.now()}.json`, 'application/json');
}

function exportJsonFound() {
  const found = results.filter(r => r.status === 'found' || r.status === 'deleted');
  const query = currentMode === 'name'
    ? (nameInput ? nameInput.value.trim() : '')
    : currentMode === 'email'
      ? (emailInput ? emailInput.value.trim() : '')
      : currentMode === 'phone'
        ? (phoneInput ? phoneInput.value.trim() : '')
        : currentMode === 'domain'
          ? (domainInput ? domainInput.value.trim() : '')
      : usernameInput.value.trim();
  const payload = {
    query,
    mode: currentMode,
    generatedAt: new Date().toISOString(),
    totals: { found: found.filter(r => r.status === 'found').length, deleted: found.filter(r => r.status === 'deleted').length },
    results: found,
  };
  downloadText(JSON.stringify(payload, null, 2), `probe_${payload.query || 'scan'}_found_${Date.now()}.json`, 'application/json');
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
    const btn = document.getElementById('copyUrlsBtn');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = orig; }, 2000);
    }
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
  scanBtn.addEventListener('click', async () => {
    const val = usernameInput.value.trim();
    const err = validateUsername(val);
    if (err) {
      searchError.textContent = err;
      searchError.style.display = 'block';
      usernameInput.focus();
      return;
    }
    searchError.style.display = 'none';

    // If Turnstile is loaded but token not yet ready, wait up to 3s
    if (!_cfToken && window.turnstile) {
      const origText = scanBtn.textContent;
      scanBtn.disabled = true;
      scanBtn.textContent = 'VERIFYING…';
      for (let i = 0; i < 30 && !_cfToken; i++) {
        await new Promise(r => setTimeout(r, 100));
      }
      scanBtn.disabled = false;
      scanBtn.textContent = origText;
    }

    const token = _cfToken || '';
    _cfToken = null;
    // Pre-emptively reset so a fresh token is ready for the next scan
    if (window.turnstile && _tsWidgetId !== null) {
      try { window.turnstile.reset(_tsWidgetId); } catch (_) {}
    }
    startScan(val, token);
  });

  // Enter key in input
  usernameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') scanBtn.click();
  });
  usernameInput.addEventListener('input', (e) => {
    queueQuickCheck(e.target.value.trim());
  });

  if (dorkTabs) {
    dorkTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.dork-tab');
      if (!tab || tab.disabled) return;
      activeDorkEngine = tab.dataset.engine || 'google';
      dorkTabs.querySelectorAll('.dork-tab').forEach(btn => btn.classList.toggle('active', btn === tab));
      if (lastScannedTarget) runDorkSearch();
    });
  }

  // Cancel / Done button — same element, dual behaviour
  cancelBtn.addEventListener('click', () => {
    if (scanActive) {
      cancelScan();
    } else {
      // "Done" clicked — scroll back to search
      window.scrollTo({ top: 0, behavior: 'smooth' });
      usernameInput.focus();
    }
  });

  // Stat pill click → filter results by that status
  document.querySelectorAll('.stat-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const filter = pill.dataset.statusFilter || null;
      if (activeStatusFilter === filter) {
        // toggle off
        activeStatusFilter = null;
        document.querySelectorAll('.stat-pill').forEach(p => p.classList.remove('active'));
      } else {
        activeStatusFilter = filter;
        document.querySelectorAll('.stat-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
      }
      applyFilters();
    });
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

  // Download dropdown (progress header)
  const dlBtn  = $('dlBtn');
  const dlMenu = $('dlMenu');
  if (dlBtn && dlMenu) {
    dlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = dlMenu.classList.toggle('open');
      if (open) document.addEventListener('click', () => dlMenu.classList.remove('open'), { once: true });
    });
    const wire = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', () => { fn(); dlMenu.classList.remove('open'); }); };
    wire('dlFoundCsv',  exportCsvFound);
    wire('dlAllCsv',    exportCsv);
    wire('dlFoundJson', exportJsonFound);
    wire('dlAllJson',   exportJson);
  }

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
    // Report button
    const reportBtn = e.target.closest('.report-btn');
    if (reportBtn) {
      e.stopPropagation();
      const card     = reportBtn.closest('.result-card');
      const siteName = reportBtn.dataset.reportSite || '';
      openReportPopover(siteName, card);
      return;
    }
    // Pin button
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

  initSidePanel();
}

/* ── Report popover ────────────────────────────────────────────────── */
let _reportPopover   = null;
let _reportSiteName  = '';

function initReportPopover() {
  _reportPopover = document.createElement('div');
  _reportPopover.className = 'report-popover';
  _reportPopover.innerHTML = `
    <div class="rp-header">Report incorrect result</div>
    <div class="rp-options">
      <label class="rp-opt"><input type="radio" name="rp-status" value="should_be_found"> Should be FOUND</label>
      <label class="rp-opt"><input type="radio" name="rp-status" value="should_be_not_found"> Should be NOT FOUND</label>
      <label class="rp-opt"><input type="radio" name="rp-status" value="other"> Other issue</label>
    </div>
    <textarea class="rp-notes" placeholder="Optional: describe the issue…" rows="2" maxlength="500"></textarea>
    <div class="rp-footer">
      <button class="rp-submit">Send Report</button>
      <button class="rp-cancel">Cancel</button>
    </div>
    <div class="rp-status"></div>
  `;
  document.body.appendChild(_reportPopover);
  _reportPopover.querySelector('.rp-cancel').addEventListener('click', closeReportPopover);
  _reportPopover.querySelector('.rp-submit').addEventListener('click', submitReport);
  document.addEventListener('click', (e) => {
    if (_reportPopover.classList.contains('open') &&
        !_reportPopover.contains(e.target) &&
        !e.target.closest('.report-btn')) {
      closeReportPopover();
    }
  }, true);
}

function openReportPopover(siteName, card) {
  if (!_reportPopover) initReportPopover();
  _reportSiteName = siteName;
  _reportPopover.querySelectorAll('input[name="rp-status"]').forEach(r => { r.checked = false; });
  _reportPopover.querySelector('.rp-notes').value = '';
  const statusEl = _reportPopover.querySelector('.rp-status');
  statusEl.textContent = ''; statusEl.className = 'rp-status';
  _reportPopover.classList.add('open');
  // Position near the card (prefer right side; flip left if too close to edge)
  const rect = card.getBoundingClientRect();
  const popW = 264;
  let left = Math.round(rect.right + 8);
  if (left + popW > window.innerWidth - 12) left = Math.round(rect.left - popW - 8);
  left = Math.max(8, left);
  const top  = Math.round(window.scrollY + Math.max(12, Math.min(rect.top, window.innerHeight - 300)));
  _reportPopover.style.left = left + 'px';
  _reportPopover.style.top  = top  + 'px';
}

function closeReportPopover() {
  if (_reportPopover) _reportPopover.classList.remove('open');
}

async function submitReport() {
  const selected = _reportPopover.querySelector('input[name="rp-status"]:checked');
  const statusEl = _reportPopover.querySelector('.rp-status');
  if (!selected) {
    statusEl.textContent = 'Please select what should be different.';
    statusEl.className   = 'rp-status error';
    return;
  }
  const notes = (_reportPopover.querySelector('.rp-notes').value || '').trim();
  const btn   = _reportPopover.querySelector('.rp-submit');
  btn.disabled = true;
  statusEl.textContent = ''; statusEl.className = 'rp-status';
  try {
    const r    = await fetch('/api/report', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ site: _reportSiteName, username: lastScannedTarget || '', correctStatus: selected.value, notes }),
    });
    const data = await r.json();
    if (data.ok) {
      statusEl.textContent = '✓ Report sent. Thank you!';
      statusEl.className   = 'rp-status success';
      setTimeout(closeReportPopover, 1800);
    } else {
      statusEl.textContent = data.error || 'Error. Please try again.';
      statusEl.className   = 'rp-status error';
    }
  } catch (_) {
    statusEl.textContent = 'Network error. Try again.';
    statusEl.className   = 'rp-status error';
  }
  btn.disabled = false;
}

/* ── Contact form ──────────────────────────────────────────────── */
function initContactForm() {
  const form   = document.getElementById('contactForm');
  if (!form) return;
  const status = document.getElementById('cfStatus');
  const btn    = document.getElementById('cfSubmitBtn');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name    = (document.getElementById('cfName')?.value    || '').trim();
    const email   = (document.getElementById('cfEmail')?.value   || '').trim();
    const message = (document.getElementById('cfMessage')?.value || '').trim();
    if (!name || !email || !message) {
      status.textContent = 'Please fill in all fields.'; status.className = 'cf-status error'; return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      status.textContent = 'Please enter a valid email address.'; status.className = 'cf-status error'; return;
    }
    btn.disabled = true; btn.textContent = 'Sending…'; status.textContent = '';
    try {
      const r    = await fetch('/api/contact', {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify({ name, email, message }),
      });
      const data = await r.json();
      if (data.ok) {
        status.textContent = '✓ Message sent! We\'ll get back to you.'; status.className = 'cf-status success';
        form.reset();
      } else {
        status.textContent = data.error || 'Something went wrong. Try again.'; status.className = 'cf-status error';
      }
    } catch (_) {
      status.textContent = 'Network error. Please try again.'; status.className = 'cf-status error';
    }
    btn.disabled = false; btn.textContent = 'Send Message';
  });
}

/* ── Bootstrap ───────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  // Load sites.json to populate platforms grid + update counts
  fetch('./sites.json')
    .then(r => r.ok ? r.json() : Promise.reject())
    .then(sites => initPlatformsGrid(sites))
    .catch(() => {
      // Fallback count — update if site list size changes
      document.querySelectorAll('#heroCount, #siteCount, .step-count').forEach(el => {
        el.textContent = '373';
      });
    });

  initEvents();
  initFadeIn();
  initContactForm();
  renderPivotSources();

  // Bootstrap Turnstile (may load after DOM; poll until api.js is ready)
  function tryInitTurnstile() {
    if (window.turnstile) { initTurnstile(); return; }
    const tid = setInterval(() => {
      if (window.turnstile) { clearInterval(tid); initTurnstile(); }
    }, 150);
    setTimeout(() => clearInterval(tid), 8000);
  }
  tryInitTurnstile();
});
