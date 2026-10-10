// ComCom Relay: lets staff outside the office reach the company's ComCom host
// without any router changes. The office host keeps an outgoing, authenticated
// control connection to the relay; when a remote staff app connects, the relay
// asks the host to open a data connection and joins the two byte streams.
//
// The relay never sees message content: the staff app's TLS session runs end
// to end to the office host, whose certificate the app pins. The relay only
// forwards encrypted bytes.
//
// One relay can serve many companies. Each company has its own token (its
// office host proves it with that token) and its own address, such as
// k3x9q2mf7a.relay.example.com; the relay reads only the server name from the
// staff app's TLS ClientHello to know which office host to connect it to.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { isIP } from 'node:net';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import selfsigned from 'selfsigned';

export const CODE_PREFIX = 'comcom-relay:';

export function encodeRelayCode(info) {
  return CODE_PREFIX + Buffer.from(JSON.stringify(info)).toString('base64url');
}

export function decodeRelayCode(code) {
  const s = String(code || '').trim();
  if (!s.startsWith(CODE_PREFIX)) throw new Error('That is not a ComCom Relay connection code');
  let info;
  try {
    info = JSON.parse(Buffer.from(s.slice(CODE_PREFIX.length), 'base64url').toString());
  } catch {
    throw new Error('The relay connection code is damaged; copy it again');
  }
  if (!info.h || !info.p || !info.c || !info.t || !info.f) throw new Error('The relay connection code is incomplete');
  return info;
}

// Reads one newline-terminated JSON message, then hands back the socket with
// any extra bytes put back in front of the stream.
export function readLine(socket, { max = 4096, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => done(new Error('Timed out')), timeout);
    function done(err, value) {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onErr);
      socket.off('close', onClose);
      if (err) reject(err);
      else resolve(value);
    }
    const onErr = (e) => done(e);
    const onClose = () => done(new Error('Connection closed'));
    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(10);
      if (nl === -1) {
        if (buf.length > max) done(new Error('Line too long'));
        return;
      }
      socket.pause();
      const rest = buf.subarray(nl + 1);
      if (rest.length) socket.unshift(rest);
      try {
        done(null, JSON.parse(buf.subarray(0, nl).toString()));
      } catch {
        done(new Error('Bad message'));
      }
    }
    socket.on('data', onData);
    socket.on('error', onErr);
    socket.on('close', onClose);
  });
}

const send = (socket, msg) => socket.write(`${JSON.stringify(msg)}\n`);

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export async function loadRelayIdentity(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'relay.json');
  if (!fs.existsSync(file)) {
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'ComCom Relay' }], {
      keyType: 'ec', curve: 'P-256', algorithm: 'sha256',
      notAfterDate: new Date(Date.now() + 10 * 365 * 86400000),
    });
    fs.writeFileSync(file, JSON.stringify({ key: pems.private, cert: pems.cert, token: crypto.randomBytes(32).toString('base64url') }), { mode: 0o600 });
  }
  const id = JSON.parse(fs.readFileSync(file, 'utf8'));
  id.fingerprint = new crypto.X509Certificate(id.cert).fingerprint256;
  return id;
}

// ---- reading the server name (SNI) from a TLS ClientHello ----

// Returns undefined while more bytes are needed, null when the hello carries
// no server name, or the lowercase name. Throws if this is not TLS.
export function parseClientHelloSni(buf) {
  // Gather the handshake bytes from as many TLS records as needed.
  const parts = [];
  let off = 0;
  let have = 0;
  let need = Infinity;
  while (have < need) {
    if (buf.length < off + 5) return undefined;
    if (buf[off] !== 0x16) throw new Error('Not a TLS handshake');
    const len = buf.readUInt16BE(off + 3);
    if (buf.length < off + 5 + len) return undefined;
    parts.push(buf.subarray(off + 5, off + 5 + len));
    have += len;
    off += 5 + len;
    if (need === Infinity) {
      const first = Buffer.concat(parts);
      if (first.length < 4) continue;
      if (first[0] !== 0x01) throw new Error('Not a ClientHello');
      need = 4 + first.readUIntBE(1, 3);
      if (need > 65536) throw new Error('ClientHello too large');
    }
  }
  const h = Buffer.concat(parts).subarray(4, need);
  let p = 34; // version + random
  const skip = (n) => {
    p += n;
    if (p > h.length) throw new Error('Bad ClientHello');
  };
  skip(1 + h[p]); // session id
  skip(2 + h.readUInt16BE(p)); // cipher suites
  skip(1 + h[p]); // compression methods
  if (p + 2 > h.length) return null; // no extensions
  const end = Math.min(h.length, p + 2 + h.readUInt16BE(p));
  p += 2;
  while (p + 4 <= end) {
    const type = h.readUInt16BE(p);
    const len = h.readUInt16BE(p + 2);
    p += 4;
    if (type === 0 && p + 5 <= end) {
      // server_name: list length, name type (0 = host name), name length, name
      const nameLen = h.readUInt16BE(p + 3);
      if (h[p + 2] === 0 && p + 5 + nameLen <= end) return h.subarray(p + 5, p + 5 + nameLen).toString('ascii').toLowerCase();
      return null;
    }
    p += len;
  }
  return null;
}

// ---- companies served by this relay ----

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const newCompanyId = () => Array.from(crypto.randomBytes(10), (b) => ID_CHARS[b % 36]).join('');
const tokenKey = (token) => crypto.createHash('sha256').update(String(token)).digest('base64url');

// The list of companies lives in <dataDir>/companies.json. The relay operator
// adds and removes companies with the command-line tool; the running relay
// picks changes up through reload().
export function openCompanyStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'companies.json');
  let companies = [];
  let byToken = new Map();
  let byId = new Map();
  let mtime = -1;

  function reload() {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      stat = null;
    }
    const m = stat ? stat.mtimeMs : 0;
    if (m === mtime) return false;
    mtime = m;
    companies = stat ? JSON.parse(fs.readFileSync(file, 'utf8')).companies || [] : [];
    byToken = new Map(companies.filter((c) => !c.disabled).map((c) => [tokenKey(c.token), c]));
    byId = new Map(companies.filter((c) => !c.disabled).map((c) => [c.id, c]));
    return true;
  }
  function save() {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ companies }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    mtime = -1;
    reload();
  }
  const find = (ref) => {
    reload();
    const r = String(ref || '').trim().toLowerCase();
    return companies.find((c) => c.id === r) || companies.find((c) => c.name.toLowerCase() === r) || null;
  };
  reload();
  return {
    file,
    reload,
    list: () => (reload(), companies.map((c) => ({ ...c }))),
    byToken: (token) => byToken.get(tokenKey(token)) || null,
    byId: (id) => byId.get(id) || null,
    find,
    add(name) {
      reload();
      const n = String(name || '').trim().slice(0, 80);
      if (!n) throw new Error('Give the company a name');
      if (companies.some((c) => c.name.toLowerCase() === n.toLowerCase())) throw new Error(`"${n}" is already on this relay`);
      const company = { id: newCompanyId(), name: n, token: crypto.randomBytes(32).toString('base64url'), createdAt: new Date().toISOString(), disabled: false };
      companies.push(company);
      save();
      return { ...company };
    },
    setDisabled(ref, disabled) {
      const c = find(ref);
      if (!c) throw new Error(`No company "${ref}" on this relay`);
      c.disabled = !!disabled;
      save();
      return { ...c };
    },
    remove(ref) {
      const c = find(ref);
      if (!c) throw new Error(`No company "${ref}" on this relay`);
      companies = companies.filter((x) => x !== c);
      save();
      return { ...c };
    },
  };
}

// The address staff apps use for one company: <id>.<relay domain>. Without a
// domain of its own, the relay's IP address is turned into a name through the
// public sslip.io DNS service (k3x9q2mf7a.203-0-113-10.sslip.io -> 203.0.113.10).
export function companyHostname(id, { domain, publicHost }) {
  if (domain) return `${id}.${domain.replace(/^\*?\./, '')}`;
  if (isIP(publicHost)) return `${id}.${publicHost.replace(/[.:]/g, '-')}.sslip.io`;
  return `${id}.${publicHost}`;
}

export function companyCode(company, { publicHost, domain, controlPort, clientPort, fingerprint }) {
  return encodeRelayCode({
    v: 2, h: publicHost, p: controlPort, c: clientPort, t: company.token, f: fingerprint,
    n: companyHostname(company.id, { domain, publicHost }),
  });
}

// ---- the relay ----

// `companies` is a company store (see openCompanyStore). Without one the relay
// serves a single company whose token is identity.token, at any address.
export function createRelay({
  identity, companies = null, controlPort = 7443, clientPort = 443, host = '0.0.0.0', log = console.log,
  maxConnections = 5000, perCompany = 500,
}) {
  const single = { id: 'default', name: 'default', token: identity.token };
  const store = companies || {
    byToken: (t) => (identity.token && safeEqual(t, identity.token) ? single : null),
    byId: (id) => (id === single.id ? single : null),
    reload: () => false,
  };
  const controls = new Map(); // company id -> { sock, token, name }
  let nextId = 1;
  const pending = new Map(); // id -> { client, head, companyId, timer }
  const clients = new Set();

  const controlServer = tls.createServer({ key: identity.key, cert: identity.cert, handshakeTimeout: 10000 }, async (sock) => {
    sock.on('error', () => {});
    let hello;
    try {
      hello = await readLine(sock);
    } catch {
      return sock.destroy();
    }
    store.reload();
    const company = hello.token ? store.byToken(hello.token) : null;
    if (!company) {
      log('Rejected a connection with an unknown or disabled company code');
      return sock.destroy();
    }
    if (hello.type === 'control') return attachControl(sock, company, hello.token);
    if (hello.type === 'data') return attachData(sock, company, Number(hello.id));
    sock.destroy();
  });

  function attachControl(sock, company, token) {
    controls.get(company.id)?.sock.destroy(); // the newest office host connection wins
    controls.set(company.id, { sock, token, name: company.name });
    sock.setKeepAlive(true, 15000);
    send(sock, { type: 'ok' });
    log(`Office host connected: ${company.name}`);
    let alive = true;
    const ping = setInterval(() => {
      if (!alive) return sock.destroy();
      alive = false;
      send(sock, { type: 'ping' });
    }, 25000);
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      if (buf.length > 65536) return sock.destroy();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          if (JSON.parse(line).type === 'pong') alive = true;
        } catch { /* ignore */ }
      }
    });
    sock.on('close', () => {
      clearInterval(ping);
      if (controls.get(company.id)?.sock === sock) {
        controls.delete(company.id);
        log(`Office host disconnected: ${company.name}`);
      }
    });
    sock.resume();
  }

  function attachData(sock, company, id) {
    const entry = pending.get(id);
    if (!entry || entry.companyId !== company.id) return sock.destroy();
    pending.delete(id);
    clearTimeout(entry.timer);
    const { client, head } = entry;
    sock.setNoDelay(true);
    sock.write(head); // the staff app's ClientHello, read to find the company
    client.pipe(sock);
    sock.pipe(client);
    const end = () => {
      client.destroy();
      sock.destroy();
    };
    client.on('close', end);
    sock.on('close', end);
    sock.resume();
    client.resume();
  }

  function route(client, head, name) {
    const id = name ? name.split('.')[0] : null;
    const company = (id && store.byId(id)) || (companies ? null : single);
    const control = company && controls.get(company.id);
    if (!control) return client.destroy();
    let open = 0;
    for (const c of clients) if (c.companyId === company.id) open++;
    if (open > perCompany || pending.size > 500) return client.destroy();
    client.companyId = company.id;
    const id2 = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id2);
      client.destroy();
    }, 10000);
    pending.set(id2, { client, head, companyId: company.id, timer });
    send(control.sock, { type: 'open', id: id2, ip: client.remoteAddress, port: client.remotePort });
  }

  const clientServer = net.createServer((client) => {
    client.on('error', () => {});
    clients.add(client);
    client.on('close', () => clients.delete(client));
    if (clients.size > maxConnections || !controls.size) return client.destroy();
    client.setNoDelay(true);
    // Read just the ClientHello to learn which company this is for.
    let head = Buffer.alloc(0);
    const timer = setTimeout(() => client.destroy(), 10000);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      let name;
      try {
        name = parseClientHelloSni(head);
      } catch {
        clearTimeout(timer);
        return client.destroy();
      }
      if (name === undefined) {
        if (head.length > 70000) client.destroy();
        return;
      }
      clearTimeout(timer);
      client.off('data', onData);
      client.pause();
      route(client, head, name);
    };
    client.on('data', onData);
  });

  return {
    async listen() {
      await new Promise((resolve, reject) => controlServer.once('error', reject).listen(controlPort, host, resolve));
      await new Promise((resolve, reject) => clientServer.once('error', reject).listen(clientPort, host, resolve));
      return { controlPort: controlServer.address().port, clientPort: clientServer.address().port };
    },
    get hostConnected() {
      return controls.size > 0;
    },
    isConnected: (companyId) => controls.has(companyId),
    // After companies change: disconnect any whose access was removed.
    refresh() {
      store.reload();
      for (const [id, c] of controls) {
        if (store.byToken(c.token)?.id === id) continue;
        c.sock.destroy();
        for (const client of clients) if (client.companyId === id) client.destroy();
        log(`Disconnected ${c.name}: removed or disabled on this relay`);
      }
    },
    close() {
      for (const c of controls.values()) c.sock.destroy();
      for (const c of clients) c.destroy();
      return Promise.all([
        new Promise((r) => controlServer.close(r)),
        new Promise((r) => clientServer.close(r)),
      ]);
    },
  };
}
