// ComCom Relay: lets staff outside the office reach the company's ComCom host
// without any router changes. The office host keeps an outgoing, authenticated
// control connection to the relay; when a remote staff app connects, the relay
// asks the host to open a data connection and joins the two byte streams.
//
// The relay never sees message content: the staff app's TLS session runs end
// to end to the office host, whose certificate the app pins. The relay only
// forwards encrypted bytes.
import crypto from 'node:crypto';
import fs from 'node:fs';
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

export function createRelay({ identity, controlPort = 7443, clientPort = 443, host = '0.0.0.0', log = console.log, maxConnections = 1000 }) {
  let control = null; // the office host's control connection
  let nextId = 1;
  const pending = new Map(); // id -> { client, timer }
  const clients = new Set();

  const controlServer = tls.createServer({ key: identity.key, cert: identity.cert, handshakeTimeout: 10000 }, async (sock) => {
    sock.on('error', () => {});
    let hello;
    try {
      hello = await readLine(sock);
    } catch {
      return sock.destroy();
    }
    if (!safeEqual(hello.token, identity.token)) {
      log('Rejected a connection with a wrong token');
      return sock.destroy();
    }
    if (hello.type === 'control') return attachControl(sock);
    if (hello.type === 'data') return attachData(sock, Number(hello.id));
    sock.destroy();
  });

  function attachControl(sock) {
    if (control) control.destroy(); // the newest office host connection wins
    control = sock;
    sock.setKeepAlive(true, 15000);
    send(sock, { type: 'ok' });
    log('Office host connected');
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
      if (control === sock) {
        control = null;
        log('Office host disconnected');
      }
    });
    sock.resume();
  }

  function attachData(sock, id) {
    const entry = pending.get(id);
    if (!entry) return sock.destroy();
    pending.delete(id);
    clearTimeout(entry.timer);
    const { client } = entry;
    sock.setNoDelay(true);
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

  const clientServer = net.createServer({ pauseOnConnect: true }, (client) => {
    client.on('error', () => {});
    clients.add(client);
    client.on('close', () => clients.delete(client));
    if (!control || clients.size > maxConnections || pending.size > 200) return client.destroy();
    client.setNoDelay(true);
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      client.destroy();
    }, 10000);
    pending.set(id, { client, timer });
    send(control, { type: 'open', id, ip: client.remoteAddress, port: client.remotePort });
  });

  return {
    async listen() {
      await new Promise((resolve, reject) => controlServer.once('error', reject).listen(controlPort, host, resolve));
      await new Promise((resolve, reject) => clientServer.once('error', reject).listen(clientPort, host, resolve));
      return { controlPort: controlServer.address().port, clientPort: clientServer.address().port };
    },
    get hostConnected() {
      return !!control;
    },
    close() {
      control?.destroy();
      for (const c of clients) c.destroy();
      return Promise.all([
        new Promise((r) => controlServer.close(r)),
        new Promise((r) => clientServer.close(r)),
      ]);
    },
  };
}
