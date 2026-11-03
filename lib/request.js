'use strict';

const { TRUST_PROXY, CF_FRONTED } = require('./config');

/**
 * Resolve the client IP using an explicit trust chain instead of blindly
 * reading X-Forwarded-For (which any client can set to an arbitrary value
 * to evade rate limiting). Preference order:
 *   1. CF-Connecting-IP — only trusted if CF_FRONTED=1 (Cloudflare
 *      overwrites this header at its edge; the raw origin never sees a
 *      client-supplied value once traffic is actually proxied through CF).
 *   2. Right-most X-Forwarded-For entry — only trusted if TRUST_PROXY=1
 *      (that hop is the one appended by our own trusted reverse proxy;
 *      anything the client prepended to the left is untrustworthy).
 *   3. Raw socket address — always safe, used when neither flag is set.
 */
function getClientIp(req) {
  if (CF_FRONTED) {
    const cfIp = (req.headers['cf-connecting-ip'] || '').trim();
    if (cfIp) return cfIp;
  }
  if (TRUST_PROXY) {
    const xff = (req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress || '0.0.0.0';
}

/** Read up to maxLen bytes from req body, resolve as string. */
function readBody(req, maxLen = 8192) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxLen) {
        tooLarge = true;
        const error = new Error('body_too_large');
        error.code = 'BODY_TOO_LARGE';
        reject(error);
        return;
      }
      data += chunk;
    });
    req.on('end', () => { if (!tooLarge) resolve(data); });
    req.on('error', error => { if (!tooLarge) reject(error); });
  });
}

module.exports = { getClientIp, readBody };
