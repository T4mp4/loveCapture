'use strict';

/**
 * smoke.js — end-to-end check of the room protocol.
 *
 * Starts the real server on a spare port and talks to it over real WebSockets,
 * covering the parts that are easy to get subtly wrong:
 *   - everyone lands in the same room and sees each other
 *   - a broken overlap resets the capture timer instead of accumulating
 *   - a continuous overlap produces exactly one capture
 *   - a locked player cannot move
 *   - the lock expires on its own
 *
 * Run with: npm run smoke
 */

const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 3999;
const HOST = '127.0.0.1';
const URL = `ws://${HOST}:${PORT}`;

const TICK_MS = 100;
const CAPTURE_MS = 5000;
const LOCK_MS = 3000;

const results = [];

function check(name, passed, detail) {
  results.push({ name, passed, detail });
  const mark = passed ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A test client that records everything the server sends it. */
function connect(name) {
  const socket = new WebSocket(URL);
  const client = { name, socket, id: null, log: [], captures: [], unlocks: [] };

  client.ready = new Promise((resolve, reject) => {
    socket.on('open', resolve);
    socket.on('error', reject);
    setTimeout(() => reject(new Error(`${name}: connect timeout`)), 5000);
  });

  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    client.log.push(message);
    if (message.t === 'welcome') client.id = message.id;
    if (message.t === 'capture') {
      client.captures.push(message);
      if (message.target === client.id) client.capturedAt = Date.now();
    }
    if (message.t === 'unlock') {
      client.unlocks.push(message);
      if (message.id === client.id) client.releasedAt = Date.now();
    }
  });

  client.send = (payload) => socket.send(JSON.stringify(payload));

  client.join = (x, y, icon = '🧑') =>
    client.send({ t: 'join', icon, x, y, w: 1440, h: 900 });

  client.move = (x, y) => client.send({ t: 'move', x, y });

  client.messagesOfType = (type) => client.log.filter((m) => m.t === type);

  client.movesFor = (id) => client.messagesOfType('move').filter((m) => m.id === id);

  /** A position can arrive either as `joined` or as a later `move`. */
  client.knowsPositionOf = (id) =>
    client.log.some((m) => (m.t === 'move' || m.t === 'joined') && m.id === id);

  client.close = () => socket.close();

  return client;
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  server.stderr.on('data', (data) => process.stderr.write(`  server: ${data}`));

  try {
    // Wait for the port to accept connections.
    const deadline = Date.now() + 8000;
    for (;;) {
      const probe = new WebSocket(URL);
      const opened = await new Promise((resolve) => {
        probe.on('open', () => resolve(true));
        probe.on('error', () => resolve(false));
        setTimeout(() => resolve(false), 400);
      });
      probe.close();
      if (opened) break;
      if (Date.now() > deadline) throw new Error('server never came up');
      await sleep(200);
    }

    console.log('\nroom membership');
    const a = connect('A');
    await a.ready;
    a.join(0.2, 0.5);
    await waitFor(() => a.id, 2000, 'A id');

    const b = connect('B');
    await b.ready;
    b.join(0.8, 0.5);
    await waitFor(() => b.id, 2000, 'B id');

    const c = connect('C');
    await c.ready;
    c.join(0.5, 0.9);
    await waitFor(() => c.id, 2000, 'C id');

    await sleep(400);

    check('three players get distinct ids', new Set([a.id, b.id, c.id]).size === 3, `${a.id} / ${b.id} / ${c.id}`);
    check('a newcomer is told about existing players', b.messagesOfType('welcome')[0].players.length >= 1);
    check('a third player is announced to everyone', a.messagesOfType('joined').some((m) => m.id === c.id) && b.messagesOfType('joined').some((m) => m.id === c.id));
    check('positions reached the other clients', a.knowsPositionOf(b.id) && b.knowsPositionOf(c.id));
    const cJoin = a.messagesOfType('joined').find((m) => m.id === c.id);
    check('the announce message carries the new position', Boolean(cJoin) && cJoin.x === 0.5 && cJoin.y === 0.9);
    check('server ships its capture rules to the client', a.messagesOfType('welcome')[0].captureMs === CAPTURE_MS && Array.isArray(a.messagesOfType('welcome')[0].emojiPool));

    console.log('\noverlap timer resets when contact breaks');
    a.captures.length = 0;
    b.captures.length = 0;
    // Same spot = overlapping.
    a.move(0.3, 0.4);
    await sleep(40);
    b.move(0.3, 0.4);
    await sleep(2500); // 2.5s of contact, not enough on its own
    b.move(0.9, 0.9); // break it
    await sleep(CAPTURE_MS + 800); // longer than a full capture window
    check('partial overlap never accumulates into a capture', a.captures.length === 0 && b.captures.length === 0, `${a.captures.length} captures`);

    console.log('\ncontinuous overlap produces exactly one capture');
    a.captures.length = 0;
    b.captures.length = 0;
    c.captures.length = 0;
    a.move(0.4, 0.4);
    await sleep(40);
    b.move(0.4, 0.4);
    // C piles onto the same spot to try to steal the capture.
    await sleep(40);
    c.move(0.4, 0.4);

    await waitFor(() => a.captures.length > 0, CAPTURE_MS + 3000, 'a capture');

    const capture = a.captures[0];
    check('a pile-up produces exactly one capture, not a chain', a.captures.length === 1, `${a.captures.length} on A, ${b.captures.length} on B, ${c.captures.length} on C`);
    check('capture names a catcher and a victim', typeof capture.by === 'string' && typeof capture.target === 'string' && capture.by !== capture.target);
    check('the catcher is the player who moved onto the victim', capture.by === b.id, `by=${capture.by === b.id ? 'B' : capture.by === a.id ? 'A' : 'C'}`);
    check('capture carries an emoji and a location', typeof capture.emoji === 'string' && capture.emoji.length > 0 && Number.isFinite(capture.x) && Number.isFinite(capture.y));
    check('everyone is told about the same capture', b.captures.length === 1 && c.captures.length === 1);

    // Only the victim should be locked; C piling on must not have stolen it.
    check('the victim, not the third player, is locked', capture.target === a.id, `target=${capture.target === a.id ? 'A' : capture.target === b.id ? 'B' : 'C'}`);

    console.log('\nlocked player is frozen');
    const movesBefore = c.movesFor(a.id).length;
    a.move(0.55, 0.55);
    a.move(0.6, 0.6);
    await sleep(500);
    check('a locked player cannot move', c.movesFor(a.id).length === movesBefore, `${c.movesFor(a.id).length - movesBefore} leaked moves`);
    check('a locked player cannot be captured again', a.captures.length === 1);

    console.log('\nlock expires on its own');
    await waitFor(() => a.unlocks.length > 0, LOCK_MS + 3000, 'unlock');
    check('the lock releases without being asked', a.unlocks[0].id === a.id);
    const heldMs = a.releasedAt - a.capturedAt;
    check('the lock held for about three seconds', Math.abs(heldMs - LOCK_MS) < 500, `${heldMs}ms`);

    await sleep(300);
    const movesAfter = c.movesFor(a.id).length;
    a.move(0.65, 0.65);
    await sleep(400);
    check('the player can move again after release', c.movesFor(a.id).length > movesAfter);

    console.log('\ndisconnect cleanup');
    const joinedCountBefore = a.messagesOfType('joined').length;
    c.close();
    await waitFor(() => a.messagesOfType('left').some((m) => m.id === c.id), 3000, 'C leaving');
    check('a disconnect removes the player from the room', true);
    check('the departed player is not re-announced', a.messagesOfType('joined').length === joinedCountBefore);

    a.close();
    b.close();
  } finally {
    server.kill();
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('failed:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\nsmoke test crashed: ${error.message}`);
  process.exitCode = 1;
});
