// Réseau pair-à-pair (PeerJS) : l'onglet de l'hôte fait tourner la partie, les invités s'y connectent.
const PREFIX = 'chaotic-armada-v1-';

// Serveur de signalisation : PeerJS public par défaut ; ?peerserver=hote:port pour un serveur local (tests).
function peerOpts() {
  const o = { debug: 1 };
  const ps = new URLSearchParams(location.search).get('peerserver');
  if (ps) { const [host, port] = ps.split(':'); Object.assign(o, { host, port: +port, path: '/', secure: false }); }
  return o;
}

export function randomCode() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

// Hôte : crée un pair joignable via le code. handlers: {onOpen(code), onGuestMessage(connId, msg), onGuestClose(connId), onError(err)}
export class Host {
  constructor(handlers) {
    this.h = handlers; this.conns = new Map();
    this.tries = 0;
    this.start();
  }
  start() {
    this.code = randomCode();
    this.peer = new window.Peer(PREFIX + this.code, peerOpts());
    this.peer.on('open', () => this.h.onOpen(this.code));
    this.peer.on('connection', (conn) => {
      const id = conn.connectionId;
      conn.on('open', () => { this.conns.set(id, conn); });
      conn.on('data', (msg) => this.h.onGuestMessage(id, msg));
      conn.on('close', () => { this.conns.delete(id); this.h.onGuestClose(id); });
      conn.on('error', () => { this.conns.delete(id); this.h.onGuestClose(id); });
    });
    this.peer.on('disconnected', () => { try { this.peer.reconnect(); } catch (e) { /* ignore */ } });
    this.peer.on('error', (err) => {
      if (err.type === 'unavailable-id' && this.tries++ < 3) { this.peer.destroy(); this.start(); return; }
      this.h.onError(err);
    });
  }
  send(connId, msg) { const c = this.conns.get(connId); if (c && c.open) c.send(msg); }
  close(connId) { const c = this.conns.get(connId); if (c) c.close(); }
}

// Invité : se connecte à l'hôte. handlers: {onOpen(), onMessage(msg), onClose(), onError(err)}
export class Guest {
  constructor(code, handlers) {
    this.code = code; this.h = handlers; this.closed = false;
    this.peer = new window.Peer(peerOpts());
    this.peer.on('open', () => this.connect());
    this.peer.on('error', (err) => this.h.onError(err));
    this.peer.on('disconnected', () => { try { this.peer.reconnect(); } catch (e) { /* ignore */ } });
  }
  connect() {
    this.conn = this.peer.connect(PREFIX + this.code, { reliable: true });
    this.conn.on('open', () => this.h.onOpen());
    this.conn.on('data', (msg) => this.h.onMessage(msg));
    this.conn.on('close', () => { if (!this.closed) this.h.onClose(); });
    this.conn.on('error', () => { if (!this.closed) this.h.onClose(); });
  }
  send(msg) { if (this.conn && this.conn.open) this.conn.send(msg); }
}
