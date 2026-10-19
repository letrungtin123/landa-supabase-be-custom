import assert from 'node:assert/strict';
import test from 'node:test';
import express, { type Request } from 'express';
import { authenticatedUserOrIpRateLimitKey } from '../middleware/rate-limit-key.js';
import { configureTrustProxy, type TrustProxySettings } from './trust-proxy.js';

// req.ip under the app's real `trust proxy` setup (config/trust-proxy.ts, as
// app.ts calls it), and the rate-limit key the sign-in limiters derive from it
// (express-rate-limit ipKeyGenerator). Pins proxy-addr >= 2.0.8 and ip-address
// behaviour: a client cannot choose its own address by sending X-Forwarded-For,
// and IPv4-mapped IPv6 addresses neither bypass nor widen the allowlist.

// The recommended production value documented in .env.example
// (TRUSTED_PROXY_CIDRS): loopback + the Cloudflare IPv4 and IPv6 ranges.
const PRODUCTION_PROXIES = [
  'loopback',
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32',
];

const CLIENT = '198.51.100.7';
const CLOUDFLARE_EDGE = '172.70.1.2'; // in 172.64.0.0/13
const CLOUDFLARE_EDGE_V6 = '2606:4700:10::ac43:1';

function appWith(settings: TrustProxySettings): express.Express {
  const app = express();
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    configureTrustProxy(app, settings);
  } finally {
    console.log = log;
    console.warn = warn;
  }
  return app;
}

/** A request as Express sees it: the socket peer address and the forwarded chain. */
function requestTo(app: express.Express, socketAddress: string, forwardedFor?: string): Request {
  const req = Object.create(app.request) as Request;
  Object.assign(req, {
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
    socket: { remoteAddress: socketAddress },
  });
  return req;
}

const production = appWith({ TRUSTED_PROXY_CIDRS: PRODUCTION_PROXIES, TRUST_PROXY_HOPS: 0 });
const ipOf = (socket: string, forwardedFor?: string) => requestTo(production, socket, forwardedFor).ip;
const keyOf = (socket: string, forwardedFor?: string) =>
  authenticatedUserOrIpRateLimitKey(requestTo(production, socket, forwardedFor));

test('a caller that is not a trusted proxy is its own address, whatever X-Forwarded-For says', () => {
  assert.equal(ipOf('203.0.113.9'), '203.0.113.9');
  assert.equal(ipOf('203.0.113.9', '1.2.3.4'), '203.0.113.9');
  assert.equal(ipOf('203.0.113.9', `1.2.3.4, ${CLOUDFLARE_EDGE}`), '203.0.113.9');
  assert.equal(keyOf('203.0.113.9', '1.2.3.4'), 'ip:203.0.113.9');
});

test('the local gateway (IPv4, IPv6 or IPv4-mapped loopback) passes on the client address', () => {
  for (const socket of ['127.0.0.1', '127.0.0.53', '::1', '::ffff:127.0.0.1']) {
    assert.equal(ipOf(socket, CLIENT), CLIENT, socket);
  }
  assert.equal(ipOf('127.0.0.1'), '127.0.0.1');
});

test('behind Cloudflare and the gateway the client is the address Cloudflare appended', () => {
  assert.equal(ipOf('127.0.0.1', `${CLIENT}, ${CLOUDFLARE_EDGE}`), CLIENT);
  assert.equal(ipOf('127.0.0.1', `${CLIENT}, ${CLOUDFLARE_EDGE_V6}`), CLIENT);
  // A gateway on a dual-stack socket may report the Cloudflare hop IPv4-mapped.
  assert.equal(ipOf('127.0.0.1', `${CLIENT}, ::ffff:${CLOUDFLARE_EDGE}`), CLIENT);
  assert.equal(ipOf(`::ffff:${CLOUDFLARE_EDGE}`, CLIENT), CLIENT);
  assert.equal(keyOf('127.0.0.1', `${CLIENT}, ${CLOUDFLARE_EDGE}`), `ip:${CLIENT}`);
});

test('addresses a client prepends to X-Forwarded-For are never used', () => {
  // The client sent "6.6.6.6" (and fake proxy hops); Cloudflare appended the real address.
  assert.equal(ipOf('127.0.0.1', `6.6.6.6, ${CLIENT}, ${CLOUDFLARE_EDGE}`), CLIENT);
  assert.equal(ipOf('127.0.0.1', `6.6.6.6, 104.16.0.1, ${CLIENT}, ${CLOUDFLARE_EDGE}`), CLIENT);
  assert.equal(ipOf('127.0.0.1', `6.6.6.6, ::ffff:104.16.0.1, ${CLIENT}, ${CLOUDFLARE_EDGE}`), CLIENT);
  assert.equal(ipOf('127.0.0.1', `6.6.6.6, ::ffff:127.0.0.1, ${CLIENT}, ${CLOUDFLARE_EDGE}`), CLIENT);
  assert.equal(keyOf('127.0.0.1', `6.6.6.6, ${CLIENT}, ${CLOUDFLARE_EDGE}`), `ip:${CLIENT}`);
});

test('an IPv4-mapped client address gets the same rate-limit key as its IPv4 form', () => {
  assert.equal(ipOf(`::ffff:${CLIENT}`, '6.6.6.6'), `::ffff:${CLIENT}`);
  assert.equal(keyOf(`::ffff:${CLIENT}`, '6.6.6.6'), `ip:${CLIENT}`);
  assert.equal(keyOf('127.0.0.1', `::ffff:${CLIENT}, ${CLOUDFLARE_EDGE}`), `ip:${CLIENT}`);
});

test('IPv6 clients are keyed by their /56 network', () => {
  assert.equal(ipOf('127.0.0.1', `2001:db8:abcd:1200::5, ${CLOUDFLARE_EDGE}`), '2001:db8:abcd:1200::5');
  const key = keyOf('127.0.0.1', `2001:db8:abcd:1200::5, ${CLOUDFLARE_EDGE}`);
  assert.equal(key, 'ip:2001:db8:abcd:1200::/56');
  assert.equal(keyOf('127.0.0.1', `2001:db8:abcd:12ff:1:2:3:4, ${CLOUDFLARE_EDGE}`), key);
  assert.notEqual(keyOf('127.0.0.1', `2001:db8:abcd:1300::5, ${CLOUDFLARE_EDGE}`), key);
});

test('an IPv4-mapped allowlist entry with an IPv4-style prefix does not trust every IPv4 hop', () => {
  // "::ffff:172.17.0.0/16" reads like 172.17.0.0/16 but is an IPv6 /16. Before
  // proxy-addr 2.0.8 it matched every IPv4 address, so any forged hop was trusted.
  const app = appWith({ TRUSTED_PROXY_CIDRS: ['loopback', '::ffff:172.17.0.0/16'], TRUST_PROXY_HOPS: 0 });
  assert.equal(requestTo(app, '127.0.0.1', `6.6.6.6, ${CLIENT}`).ip, CLIENT);
  assert.equal(requestTo(app, '127.0.0.1', `6.6.6.6, ::ffff:${CLIENT}`).ip, `::ffff:${CLIENT}`);
  // The exact mapped notation (/112 here) still means the IPv4 range.
  const exact = appWith({ TRUSTED_PROXY_CIDRS: ['loopback', '::ffff:172.17.0.0/112'], TRUST_PROXY_HOPS: 0 });
  assert.equal(requestTo(exact, '127.0.0.1', `${CLIENT}, 172.17.0.1`).ip, CLIENT);
  assert.equal(requestTo(exact, '127.0.0.1', `${CLIENT}, ::ffff:172.17.0.1`).ip, CLIENT);
});

test('the CIDR allowlist replaces the legacy hop count; with neither, X-Forwarded-For is ignored', () => {
  const both = appWith({ TRUSTED_PROXY_CIDRS: PRODUCTION_PROXIES, TRUST_PROXY_HOPS: 3 });
  assert.equal(requestTo(both, '203.0.113.9', '6.6.6.6').ip, '203.0.113.9');

  // Legacy hop count: one hop is trusted whatever its address (the reason it is legacy).
  const hops = appWith({ TRUSTED_PROXY_CIDRS: [], TRUST_PROXY_HOPS: 1 });
  assert.equal(requestTo(hops, '203.0.113.9', '6.6.6.6').ip, '6.6.6.6');
  assert.equal(requestTo(hops, '203.0.113.9', `6.6.6.6, ${CLIENT}`).ip, CLIENT);

  const none = appWith({ TRUSTED_PROXY_CIDRS: [], TRUST_PROXY_HOPS: 0 });
  assert.equal(requestTo(none, '127.0.0.1', '6.6.6.6').ip, '127.0.0.1');
  assert.equal(requestTo(none, '::ffff:203.0.113.9', '6.6.6.6').ip, '::ffff:203.0.113.9');
});
