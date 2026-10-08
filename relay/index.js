// Run on any VPS the company controls:
//   RELAY_PUBLIC_HOST=203.0.113.10 node relay/index.js
// or with Docker (see relay/Dockerfile). Prints the connection code to paste
// into ComCom → Admin console → Remote access.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay, encodeRelayCode, loadRelayIdentity } from './relay.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.RELAY_DATA_DIR || path.join(here, 'data'));
const publicHost = process.env.RELAY_PUBLIC_HOST;
const controlPort = Number(process.env.RELAY_CONTROL_PORT || 7443);
const clientPort = Number(process.env.RELAY_CLIENT_PORT || 443);
// Ports as seen from the internet, if a firewall/Docker maps them differently.
const publicClientPort = Number(process.env.RELAY_PUBLIC_CLIENT_PORT || clientPort);
const publicControlPort = Number(process.env.RELAY_PUBLIC_CONTROL_PORT || controlPort);

if (!publicHost) {
  console.error('Set RELAY_PUBLIC_HOST to this server\'s public IP address or domain name.');
  process.exit(1);
}

const identity = await loadRelayIdentity(dataDir);
const relay = createRelay({ identity, controlPort, clientPort, log: (m) => console.log(`[${new Date().toISOString()}] ${m}`) });
await relay.listen();
const code = encodeRelayCode({ v: 1, h: publicHost, p: publicControlPort, c: publicClientPort, t: identity.token, f: identity.fingerprint });

console.log(`ComCom Relay running. Staff connect on port ${publicClientPort}; the office host connects on port ${publicControlPort}.`);
console.log('');
console.log('Paste this connection code into ComCom → Admin console → Remote access:');
console.log('');
console.log(code);
console.log('');

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => relay.close().then(() => process.exit(0)));
