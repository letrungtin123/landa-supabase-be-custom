#!/usr/bin/env node
// Local stub of the API surface used by the load test, for trying the kit without the real API.
//   node scripts/loadtest/stub-server.mjs --port 3999 [--latency-ms 5,40] [--fault-429 0.01] [--fault-500 0.005] [--access-ttl-s 900]
// The stub accepts the password given by --password (default "stub-password"), never the real test password.
// Then: LOADTEST_PASSWORD=stub-password node scripts/loadtest/deadline-morning.mjs --target http://127.0.0.1:3999 --pg-container none
import { startStubServer } from './lib/stub.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const port = Number(value('--port', 3999));
if ([3101, 5273, 5274].includes(port)) {
  console.error(`Port ${port} belongs to a live local app; pick another (e.g. 3999).`);
  process.exit(2);
}
const latency = String(value('--latency-ms', '0,0')).split(',').map(Number);
const { url, stub } = await startStubServer({
  port,
  host: '127.0.0.1',
  password: value('--password', 'stub-password'),
  latencyMs: [latency[0] || 0, latency[1] ?? latency[0] ?? 0],
  fault429Rate: Number(value('--fault-429', 0)),
  fault500Rate: Number(value('--fault-500', 0)),
  accessTtlS: Number(value('--access-ttl-s', 900)),
  metrics: args.includes('--metrics'),
});
console.log(`load-test stub listening on ${url} (stats: ${url}/__stub/stats); Ctrl+C to stop`);
process.on('SIGINT', () => {
  console.log(JSON.stringify(stub.stats().events));
  process.exit(0);
});
