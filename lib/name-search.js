'use strict';

/* ── Name-site URL builder ───────────────────────────────────────────────── */
function toSlug(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function toTitleSlug(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part[0].toUpperCase() + part.slice(1))
    .join('-');
}

const US_STATE_CODES = {
  'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR','california':'CA',
  'colorado':'CO','connecticut':'CT','delaware':'DE','florida':'FL','georgia':'GA',
  'hawaii':'HI','idaho':'ID','illinois':'IL','indiana':'IN','iowa':'IA',
  'kansas':'KS','kentucky':'KY','louisiana':'LA','maine':'ME','maryland':'MD',
  'massachusetts':'MA','michigan':'MI','minnesota':'MN','mississippi':'MS',
  'missouri':'MO','montana':'MT','nebraska':'NE','nevada':'NV',
  'new hampshire':'NH','new jersey':'NJ','new mexico':'NM','new york':'NY',
  'north carolina':'NC','north dakota':'ND','ohio':'OH','oklahoma':'OK',
  'oregon':'OR','pennsylvania':'PA','rhode island':'RI','south carolina':'SC',
  'south dakota':'SD','tennessee':'TN','texas':'TX','utah':'UT',
  'vermont':'VT','virginia':'VA','washington':'WA','west virginia':'WV',
  'wisconsin':'WI','wyoming':'WY','district of columbia':'DC',
};

const STATE_CODE_TO_NAME = Object.fromEntries(
  Object.entries(US_STATE_CODES).map(([name, code]) => [code, name])
);

function toStateCode(s) {
  if (!s) return '';
  const t = s.trim();
  if (t.length <= 3) return t.toUpperCase();
  return US_STATE_CODES[t.toLowerCase()] || t.slice(0, 2).toUpperCase();
}

function toStateName(s) {
  if (!s) return '';
  const t = String(s).trim();
  if (!t) return '';
  const code = toStateCode(t);
  const raw = STATE_CODE_TO_NAME[code] || t.toLowerCase();
  return raw.split(' ').map(part => part ? (part[0].toUpperCase() + part.slice(1)) : '').join(' ');
}

function toPlusParam(s) {
  return encodeURIComponent(String(s || '').trim()).replace(/%20/g, '+');
}

function buildNameUrl(site, firstName, lastName, filters = {}) {
  const city     = (filters.city  || '').trim();
  const stateRaw = (filters.state || '').trim();
  const state    = toStateCode(stateRaw);
  const stateFull = toStateName(stateRaw);
  const ageMin   = String(filters.ageMin || '');
  const ageMax   = String(filters.ageMax || '');

  const fLow  = firstName.toLowerCase();
  const lLow  = lastName.toLowerCase();

  const encFirst  = encodeURIComponent(firstName);
  const encLast   = encodeURIComponent(lastName);
  const encFull   = encodeURIComponent(`${firstName} ${lastName}`);
  const encHyphen = encodeURIComponent(`${fLow}-${lLow}`);
  const encUnder  = encodeURIComponent(`${fLow}_${lLow}`);
  const encPlus   = encodeURIComponent(`${firstName}+${lastName}`);

  const citySlug       = toSlug(city);
  const cityTitleSlug  = toTitleSlug(city);
  const cityPlus       = toPlusParam(city);
  const stateSlug      = toSlug(stateRaw);
  const stateCodeLower = state.toLowerCase();
  const locationPath = city && state ? `${citySlug}-${stateCodeLower}`
                     : city          ? citySlug
                     : stateCodeLower;
  const locationQs = city && state ? encodeURIComponent(`${city}, ${state}`)
                   : city          ? encodeURIComponent(city)
                   : encodeURIComponent(state);
  const locationQsDouble = encodeURIComponent(locationQs);
  const fullNameDouble = encodeURIComponent(encFull);

  const hasCity  = !!city;
  const hasState = !!state;
  const hasAge   = !!(ageMin || ageMax);
  let template = site.url;
  if (site.urlFiltered) {
    const fr = site.filterRequires || 'any';
    const useFiltered =
      (fr === 'city_and_state' && hasCity && hasState) ||
      ((fr === 'state' || fr === 'any') && (hasCity || hasState || hasAge));
    if (useFiltered) template = site.urlFiltered;
  }

  return template
    .replace('{first}',               encFirst)
    .replace('{last}',                encLast)
    .replace('{first_lower}',         encodeURIComponent(fLow))
    .replace('{last_lower}',          encodeURIComponent(lLow))
    .replace('{fullname}',            encFull)
    .replace('{fullname_hyphen}',     encHyphen)
    .replace('{fullname_hyphen_lower}', `${fLow}-${lLow}`)
    .replace('{fullname_underscore}', encUnder)
    .replace('{fullname_underscore_lower}', `${fLow}_${lLow}`)
    .replace('{fullname_plus}',       encodeURIComponent(`${fLow} ${lLow}`))
    .replace('{fullname_plus_lower}', `${encodeURIComponent(fLow)}+${encodeURIComponent(lLow)}`)
    .replace('{city}',                encodeURIComponent(city))
    .replace('{city_slug}',           citySlug)
    .replace('{city_title_slug}',     cityTitleSlug)
    .replace('{city_plus}',           cityPlus)
    .replace('{state_code}',          state)
    .replace('{state_code_lower}',    stateCodeLower)
    .replace('{state_full}',          encodeURIComponent(stateFull))
    .replace('{state_slug}',          stateSlug)
    .replace('{city_state_slug}',     locationPath)
    .replace('{location_path}',       locationPath)
    .replace('{location_qs}',         locationQs)
    .replace('{location_qs_double}',  locationQsDouble)
    .replace('{fullname_double}',     fullNameDouble)
    .replace('{age_min}',             ageMin)
    .replace('{age_max}',             ageMax);
}

/* ── Name-site probe ───────────────────────────────────────────────────────── */
async function probeNameSearch(site, firstName, lastName, filters = {}) {
  const profileUrl = buildNameUrl(site, firstName, lastName, filters);

  const base = { name: site.name, category: 'people-finder', url: profileUrl, mode: 'name' };

  // Name searches need a rendered browser page, which PROBE does not run.
  return { ...base, status: 'unknown', statusCode: 0 };
}

module.exports = { buildNameUrl, probeNameSearch };
