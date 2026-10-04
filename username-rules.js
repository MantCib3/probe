'use strict';

const compiled = new WeakMap();

function ruleFor(site) {
  if (!site.usernameRule) return null;
  if (compiled.has(site)) return compiled.get(site);
  const rule = site.usernameRule;
  if (typeof rule.pattern !== 'string' || !rule.pattern.startsWith('^') || !rule.pattern.endsWith('$')
      || typeof rule.description !== 'string' || !rule.description
      || typeof rule.source !== 'string' || !rule.source.startsWith('https://')) {
    throw new Error(`Invalid username rule for ${site.name}`);
  }
  const pattern = new RegExp(rule.pattern, 'i');
  compiled.set(site, pattern);
  return pattern;
}

function validateCatalog(sites) {
  for (const site of sites) ruleFor(site);
}

function incompatibleReason(site, username) {
  const pattern = ruleFor(site);
  // Sources without verified restrictions are always allowed to run.
  if (!pattern) return null;
  const match = pattern.exec(username);
  return match && match[0].length === username.length ? null : site.usernameRule.description;
}

module.exports = { validateCatalog, incompatibleReason };
