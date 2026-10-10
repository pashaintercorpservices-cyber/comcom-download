// ComCom Relay. Run on a VPS; one relay can serve many companies.
//
//   RELAY_PUBLIC_HOST=203.0.113.10 node relay/index.js            start the relay
//   RELAY_PUBLIC_HOST=203.0.113.10 node relay/index.js add "Acme"  add a company, print its code
//   node relay/index.js list | code <company> | disable <company> | enable <company> | remove <company>
//
// With Docker (see relay/Dockerfile) run the same commands with
// `docker exec comcom-relay node relay/index.js …` (or the `comcom-relay` helper
// that install-relay.sh puts on the server).
//
// Optional RELAY_DOMAIN=relay.example.com uses your own domain for company
// addresses (needs a wildcard DNS record *.relay.example.com -> this server).
// Without it, addresses use the free sslip.io DNS service.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { companyCode, companyHostname, createRelay, loadRelayIdentity, openCompanyStore } from './relay.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.RELAY_DATA_DIR || path.join(here, 'data'));
const publicHost = process.env.RELAY_PUBLIC_HOST;
const domain = process.env.RELAY_DOMAIN || '';
const controlPort = Number(process.env.RELAY_CONTROL_PORT || 7443);
const clientPort = Number(process.env.RELAY_CLIENT_PORT || 443);
// Ports as seen from the internet, if a firewall/Docker maps them differently.
const publicClientPort = Number(process.env.RELAY_PUBLIC_CLIENT_PORT || clientPort);
const publicControlPort = Number(process.env.RELAY_PUBLIC_CONTROL_PORT || controlPort);

const [command = 'run', ...args] = process.argv.slice(2);
const store = openCompanyStore(dataDir);

function needHost() {
  if (!publicHost) {
    console.error('Set RELAY_PUBLIC_HOST to this server\'s public IP address or domain name.');
    process.exit(1);
  }
}
async function codeFor(company) {
  needHost();
  const identity = await loadRelayIdentity(dataDir);
  return companyCode(company, { publicHost, domain, controlPort: publicControlPort, clientPort: publicClientPort, fingerprint: identity.fingerprint });
}
function printCode(company, code) {
  console.log('');
  console.log(`Company: ${company.name}   (id ${company.id})`);
  console.log(`Staff connect at: ${companyHostname(company.id, { domain, publicHost })}`);
  console.log('');
  console.log('Give this code to the company administrator. They paste it into');
  console.log('ComCom -> Admin console -> Remote access -> Relay connection code -> Save:');
  console.log('');
  console.log(code);
  console.log('');
}

try {
  switch (command) {
    case 'add': {
      const company = store.add(args.join(' '));
      printCode(company, await codeFor(company));
      break;
    }
    case 'code': {
      const company = store.find(args.join(' '));
      if (!company) throw new Error(`No company "${args.join(' ')}" on this relay. See: list`);
      printCode(company, await codeFor(company));
      break;
    }
    case 'list': {
      const all = store.list();
      if (!all.length) console.log('No companies yet. Add one with: add "Company name"');
      for (const c of all) console.log(`${c.id}  ${c.disabled ? 'DISABLED' : 'active  '}  ${c.createdAt.slice(0, 10)}  ${c.name}`);
      break;
    }
    case 'disable':
    case 'enable': {
      const c = store.setDisabled(args.join(' '), command === 'disable');
      console.log(`${c.name} is now ${c.disabled ? 'disabled: its staff can no longer connect from outside the office' : 'enabled'}.`);
      break;
    }
    case 'remove': {
      const c = store.remove(args.join(' '));
      console.log(`Removed ${c.name}. Its relay code no longer works.`);
      break;
    }
    case 'run': {
      needHost();
      const identity = await loadRelayIdentity(dataDir);
      const relay = createRelay({
        identity, companies: store, controlPort, clientPort,
        log: (m) => console.log(`[${new Date().toISOString()}] ${m}`),
      });
      await relay.listen();
      fs.watchFile(store.file, { interval: 2000 }, () => relay.refresh());
      const n = store.list().filter((c) => !c.disabled).length;
      console.log(`ComCom Relay running for ${n} ${n === 1 ? 'company' : 'companies'}. Staff connect on port ${publicClientPort}; office hosts on port ${publicControlPort}.`);
      if (!n) console.log('Add a company with: add "Company name"');
      for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => relay.close().then(() => process.exit(0)));
      break;
    }
    case 'help':
    default:
      console.log('Commands: add "Company name" | list | code <company> | disable <company> | enable <company> | remove <company>');
      process.exit(command === 'help' ? 0 : 1);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
