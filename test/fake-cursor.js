'use strict';

/**
 * fake-cursor.js — a headless partner, for testing without a second person.
 *
 * Joins the room as an ordinary cursor and drifts around in a slow circle.
 * Handy for checking remote rendering, and for feeling out the capture timing
 * on your own.
 *
 *   npm start                 (in one terminal)
 *   npm run partner           (in another)
 *   open http://localhost:3000
 */

const WebSocket = require('ws');

const URL = process.env.ROOM_URL || 'ws://localhost:3000';
const ICON = process.env.PARTNER_ICON || '🐻';
const PERIOD_MS = Number(process.env.PARTNER_PERIOD_MS) || 33;

const radius = 0.22;
let angle = 0;

const socket = new WebSocket(URL);

socket.on('open', () => {
  console.log(`a partner (${ICON}) drifted into ${URL}`);
  console.log('watching the room... (ctrl-c to leave)');
  socket.send(JSON.stringify({ t: 'join', icon: ICON, x: 0.5, y: 0.5, w: 1440, h: 900 }));

  setInterval(() => {
    angle += 0.02;
    const x = 0.5 + Math.cos(angle) * radius;
    const y = 0.5 + Math.sin(angle) * radius * 0.6;
    socket.send(JSON.stringify({ t: 'move', x, y }));
  }, PERIOD_MS);
});

// Watching the room from a terminal is genuinely useful: you can see exactly
// when someone arrives, leaves, or gets caught.
socket.on('message', (raw) => {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (message.t === 'joined') console.log(`  + a player (${message.icon}) joined the room`);
  if (message.t === 'left') console.log('  - a player left the room');
  if (message.t === 'capture') console.log(`  <3 capture! ${message.emoji}`);
});

socket.on('close', () => {
  console.log('connection closed');
  process.exit(0);
});

socket.on('error', (error) => {
  console.error(`could not connect: ${error.message}`);
  process.exit(1);
});
