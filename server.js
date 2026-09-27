'use strict';

/**
 * little room — server
 *
 * Two jobs:
 *   1. Serve ./public statically.
 *   2. Run ONE global WebSocket room where every visitor is an emoji cursor.
 *
 * The server is authoritative for anything that matters: player ids, the
 * player roster, positions, and the capture/lock state machine. Clients only
 * ever ask; they never declare that a capture happened. Keeping that rule in
 * one place is what stops two people from "capturing" the same victim at the
 * same moment.
 *
 * All room state is in memory and is discarded when a player disconnects.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

// ---------------------------------------------------------------- config

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const TICK_MS = 100; // how often the room is evaluated
const CAPTURE_MS = 3000; // continuous overlap needed to capture someone
const LOCK_MS = 5000; // how long a captured player stays frozen
const CAPTURE_RADIUS_PX = 48; // how close two cursors must be to count as overlapping

const MAX_MESSAGE_BYTES = 512; // reject anything bigger than this
const MAX_MESSAGES_PER_SEC = 60; // move updates target ~30/s, so this is roomy
const ICON_MAX_CODEPOINTS = 12; // long enough for a ZWJ couple emoji

const DEFAULT_ICON = '\u{1F9D1}'; // 🧑
const JOIN_TIMEOUT_MS = 15000; // a socket that never introduces itself is dropped

// const EMOJI_POOL = [
//   '\u2764\uFE0F',
//   '\u{1F495}',
//   '\u{1F496}',
//   '\u{1F497}',
//   '\u{1F493}',
//   '\u{1F498}',
//   '\u{1F970}',
//   '\u{1F618}',
//   '\u{1F60D}',
//   '\u{1FAF6}',
//   '\u{1F48B}',
//   '\u2728',
//   '\u{1F338}',
//   '\u{1F979}',
// ];

const EMOJI_POOL = [
  '😜',
  '😀',
  '😆',
  '🥶',
  '🥰',
  '😍',
  '🥳',
  '🤭',
  '🤯',
  '🥰',
  '😘',
  '😍',
  '❤️',
  '💕',
  '💖',
  '💗',
  '💓',
  '💘',
  '💞',
  '🌸',
  '🌷',
  '💐',
  '💋',
  '💥',
  '🔥',
  '🎉',
  '💯',
];

















// ---------------------------------------------------------------- static files

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request');
    return;
  }

  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, rel);

  // Never let a crafted path escape the public directory.
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------- room state

/** @type {Map<string, object>} id -> player */
const players = new Map();

/**
 * Continuous-overlap timers for each unordered pair of free players.
 * key: "idA|idB" (ids sorted) -> { capturer, target, startedAt }
 */
const pairs = new Map();

let nextPlayerNumber = 1;

function newId() {
  // Short and unguessable. Never shown to the user.
  return `${nextPlayerNumber++}-${crypto.randomBytes(4).toString('hex')}`;
}

function newPlayer(ws) {
  return {
    id: newId(),
    ws,
    ready: false,
    icon: DEFAULT_ICON,
    x: 0.5,
    y: 0.5,
    vw: 1280, // reference viewport, used to measure overlap in pixels
    vh: 800,
    locked: false,
    lockedUntil: 0,
    immuneUntil: 0, // set after a capture so piles resolve into one event
    lastMoveAt: 0, // used to decide who "moved onto" whom
    msgWindowStart: Date.now(),
    msgCount: 0,
    alive: true,
    joinTimer: 0,
  };
}

function send(ws, message) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(message));
}

function broadcast(message, exceptId) {
  const data = JSON.stringify(message);
  for (const player of players.values()) {
    if (player.id === exceptId) continue;
    if (player.ws.readyState !== WebSocket.OPEN) continue;
    player.ws.send(data);
  }
}

function readyPlayers() {
  const out = [];
  for (const player of players.values()) if (player.ready) out.push(player);
  return out;
}

// ---------------------------------------------------------------- validation

const isUnit = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);

function sanitizeIcon(value) {
  if (typeof value !== 'string') return DEFAULT_ICON;
  // Strip control characters, then cap the length in code points so ZWJ
  // emoji sequences survive intact.
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (!cleaned) return DEFAULT_ICON;
  return Array.from(cleaned).slice(0, ICON_MAX_CODEPOINTS).join('');
}

function setViewport(player, message) {
  if (Number.isFinite(message.w)) player.vw = clamp(message.w, 1, 10000);
  if (Number.isFinite(message.h)) player.vh = clamp(message.h, 1, 10000);
}

/** Cheap per-socket rate limit so one client cannot flood the room. */
function allowMessage(player) {
  const now = Date.now();
  if (now - player.msgWindowStart >= 1000) {
    player.msgWindowStart = now;
    player.msgCount = 0;
  }
  player.msgCount += 1;
  return player.msgCount <= MAX_MESSAGES_PER_SEC;
}

// ---------------------------------------------------------------- capture engine

/**
 * Are these two cursors close enough to count as overlapping?
 *
 * Positions are normalized (0..1), so a raw distance in that space would be
 * skewed by the screen's aspect ratio. We convert back to pixels using the
 * smaller of the two viewports, which keeps "close" feeling equally close for
 * both players regardless of their screen size.
 */
function withinCaptureRadius(a, b) {
  const w = Math.min(a.vw, b.vw);
  const h = Math.min(a.vh, b.vh);
  const dx = (a.x - b.x) * w;
  const dy = (a.y - b.y) * h;
  return Math.hypot(dx, dy) <= CAPTURE_RADIUS_PX;
}

/**
 * When both cursors sit on each other, someone has to be the catcher. The
 * player who moved most recently is the one who "moved onto" the other, so
 * they get the capture. Ties fall back to the stable id order.
 */
function pickCapturer(a, b) {
  if (a.lastMoveAt === b.lastMoveAt) return a.id < b.id ? a : b;
  return a.lastMoveAt > b.lastMoveAt ? a : b;
}

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function performCapture(entry, now) {
  const capturer = players.get(entry.capturer);
  const target = players.get(entry.target);
  if (!capturer || !target) return;
  if (capturer.locked || target.locked) return;
  if (now < capturer.immuneUntil || now < target.immuneUntil) return;

  target.locked = true;
  target.lockedUntil = now + LOCK_MS;

  // Both players step out of the capture game until the lock expires. Without
  // this, a third cursor parked on the same spot would immediately capture the
  // catcher, turning one pile-up into a chain of captures. Clearing the pair
  // timers is handled by step 3 of the tick, since neither player will be
  // visited while immune.
  capturer.immuneUntil = target.lockedUntil;
  target.immuneUntil = target.lockedUntil;

  broadcast({
    t: 'capture',
    by: capturer.id,
    target: target.id,
    emoji: EMOJI_POOL[Math.floor(Math.random() * EMOJI_POOL.length)],
    x: (capturer.x + target.x) / 2,
    y: (capturer.y + target.y) / 2,
    until: target.lockedUntil,
  });
}

function tick() {
  const now = Date.now();

  // 1. Release anyone whose lock has expired.
  for (const player of players.values()) {
    if (player.locked && now >= player.lockedUntil) {
      player.locked = false;
      player.lockedUntil = 0;
      broadcast({ t: 'unlock', id: player.id });
    }
  }

  // 2. Evaluate every unordered pair of free players. "Free" means neither
  //    frozen by a lock nor inside a post-capture recovery window.
  const free = readyPlayers().filter((p) => !p.locked && now >= p.immuneUntil);
  const visited = new Set();

  for (let i = 0; i < free.length; i += 1) {
    for (let j = i + 1; j < free.length; j += 1) {
      const a = free[i];
      const b = free[j];
      const key = pairKey(a.id, b.id);
      visited.add(key);

      if (!withinCaptureRadius(a, b)) {
        // Overlap broke: the timer resets to zero and partial time is
        // discarded. There is no accumulation.
        pairs.delete(key);
        continue;
      }

      const entry = pairs.get(key);
      if (!entry) {
        const capturer = pickCapturer(a, b);
        pairs.set(key, {
          capturer: capturer.id,
          target: capturer === a ? b.id : a.id,
          startedAt: now,
        });
      } else if (now - entry.startedAt >= CAPTURE_MS) {
        performCapture(entry, now);
        pairs.delete(key);
      }
    }
  }

  // 3. Forget timers that no longer apply (a player left or got locked).
  for (const key of pairs.keys()) {
    if (!visited.has(key)) pairs.delete(key);
  }
}

// ---------------------------------------------------------------- messaging

function handleMessage(player, message) {
  switch (message.t) {
    case 'join': {
      player.icon = sanitizeIcon(message.icon);
      if (isUnit(message.x)) player.x = message.x;
      if (isUnit(message.y)) player.y = message.y;
      setViewport(player, message);

      if (!player.ready) {
        player.ready = true;
        clearTimeout(player.joinTimer);
      }
      broadcast({ t: 'joined', id: player.id, icon: player.icon, x: player.x, y: player.y }, player.id);
      break;
    }

    case 'move': {
      if (!player.ready) return;
      // A locked player is frozen: their cursor stays put even though their
      // mouse keeps moving. The server is the one enforcing that.
      if (player.locked) return;
      if (!isUnit(message.x) || !isUnit(message.y)) return;
      player.x = message.x;
      player.y = message.y;
      player.lastMoveAt = Date.now();
      broadcast({ t: 'move', id: player.id, x: player.x, y: player.y }, player.id);
      break;
    }

    case 'icon': {
      if (!player.ready) return;
      player.icon = sanitizeIcon(message.icon);
      broadcast({ t: 'icon', id: player.id, icon: player.icon }, player.id);
      break;
    }

    case 'size': {
      setViewport(player, message);
      break;
    }

    default:
      break; // unknown message types are ignored
  }
}

function leave(player) {
  if (!player.alive) return; // 'close' and 'error' can both fire
  player.alive = false;
  clearTimeout(player.joinTimer);
  players.delete(player.id);

  for (const key of pairs.keys()) {
    const [a, b] = key.split('|');
    if (a === player.id || b === player.id) pairs.delete(key);
  }

  broadcast({ t: 'left', id: player.id });
}

// ---------------------------------------------------------------- wiring

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const player = newPlayer(ws);
  players.set(player.id, player);

  const roster = readyPlayers()
    .filter((p) => p.id !== player.id)
    .map((p) => ({ id: p.id, icon: p.icon, x: p.x, y: p.y, locked: p.locked }));

  send(ws, {
    t: 'welcome',
    id: player.id,
    players: roster,
    emojiPool: EMOJI_POOL,
    captureMs: CAPTURE_MS,
    lockMs: LOCK_MS,
  });

  // Sockets that connect and never introduce themselves are dropped.
  player.joinTimer = setTimeout(() => {
    if (!player.ready) ws.close(1008, 'no join');
  }, JOIN_TIMEOUT_MS);

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return; // this protocol is text-only
    if (raw.length > MAX_MESSAGE_BYTES) return;
    if (!allowMessage(player)) return;

    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!message || typeof message !== 'object' || typeof message.t !== 'string') return;

    handleMessage(player, message);
  });

  ws.on('close', () => leave(player));
  ws.on('error', () => leave(player));
});

setInterval(tick, TICK_MS);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`little room is open on http://localhost:${PORT}`);
});
