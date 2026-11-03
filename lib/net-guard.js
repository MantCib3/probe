'use strict';

const dns = require('dns').promises;
const net = require('net');
const { URL } = require('url');

const BLOCKED_ADDRESSES = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
].forEach(([address, prefix]) => BLOCKED_ADDRESSES.addSubnet(address, prefix, 'ipv4'));
// IPv4-mapped IPv6 (::ffff:a.b.c.d) is matched against the IPv4 rules above
// by BlockList itself; an explicit ::ffff:0:0/96 rule would block all IPv4.
[
  ['::', 96], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
].forEach(([address, prefix]) => BLOCKED_ADDRESSES.addSubnet(address, prefix, 'ipv6'));

function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (!family) return true;
  return BLOCKED_ADDRESSES.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function publicLookup(hostname, options, callback) {
  const opts = typeof options === 'number' ? { family: options } : (options || {});
  dns.lookup(hostname, { all: true, verbatim: true })
    .then(addresses => {
      const publicAddresses = addresses.filter(item => !isPrivateAddress(item.address));
      if (!publicAddresses.length) throw new Error('Private or non-routable address blocked');
      const requestedFamily = Number(opts.family) || 0;
      const eligible = requestedFamily
        ? publicAddresses.filter(item => item.family === requestedFamily)
        : publicAddresses;
      if (!eligible.length) throw new Error('No address for requested family');
      if (opts.all) return callback(null, eligible);
      callback(null, eligible[0].address, eligible[0].family);
    })
    .catch(error => callback(error));
}

// SSRF guard shared by proxy endpoints that accept an arbitrary target URL.
// IP-literal hosts never reach publicLookup (Node skips DNS for them), so
// this check is the only barrier for them; URL hostnames bracket IPv6.
function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const family = net.isIP(h);
  return (
    (family > 0 && isPrivateAddress(h)) ||
    h === '' || h === 'localhost' || h.endsWith('.localhost') ||
    h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')
  );
}

/* ── Safe URL for href (prevent javascript: etc.) ─────────────────────── */
function isSafeUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:';
  } catch (_) { return false; }
}

module.exports = { publicLookup, isPrivateHost };
