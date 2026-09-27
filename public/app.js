/**
 * app.js — wiring.
 *
 * Reads as a list of what the room does:
 *   boot -> connect -> react to messages -> send throttled movements
 *
 * The server owns capture and lock. We only render what it tells us, plus one
 * local shortcut: freezing our own cursor the moment we hear we were caught,
 * so the player feels it immediately instead of waiting for a round trip.
 */

import {
  DEFAULT_ICON,
  DEFAULT_OVERLAY,
  FALLBACK_EMOJI_POOL,
  SEND_INTERVAL_MS,
  STORAGE,
} from './config.js';
import { createNet } from './net.js';
import { createCursorLayer } from './cursors.js';
import { createEffects } from './effects.js';
import { createDock } from './dock.js';

const el = (id) => document.getElementById(id);

const scene = {
  bg: el('bg'),
  scrim: el('bg-scrim'),
  cursors: el('cursors'),
  effects: el('effects'),
  hint: el('hint'),
  status: el('status'),
  statusText: el('status-text'),
  dockbar: el('dockbar'),
  dock: el('dock'),
  panel: el('panel'),
};

const STATE_TEXT = {
  connecting: 'connecting…',
  offline: 'reconnecting…',
  online: '',
};

const cursors = createCursorLayer(scene.cursors);
const effects = createEffects(scene.effects);

const state = {
  selfId: null,
  icon: readStored(STORAGE.icon) || DEFAULT_ICON,
  emojiPool: FALLBACK_EMOJI_POOL,
  locked: false,
  lockTimer: 0,
  lastSentX: null,
  lastSentY: null,
  pointer: { x: 0.5, y: 0.5 },
  seenPointer: false,
  hintDismissed: false,
};

function readStored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

// ---------------------------------------------------------------- networking

const net = createNet({
  onOpen: () => sendJoin(),
  onMessage: handleMessage,
  onStatus: (status) => {
    scene.status.dataset.state = status;
    scene.statusText.textContent = STATE_TEXT[status] || '';
  },
});

function sendJoin() {
  net.send({
    t: 'join',
    icon: state.icon,
    x: state.pointer.x,
    y: state.pointer.y,
    w: window.innerWidth,
    h: window.innerHeight,
  });
  // A reconnect gets a brand new identity, so nothing from the old session
  // should linger on screen.
  state.lastSentX = null;
  state.lastSentY = null;
}

function handleMessage(message) {
  switch (message.t) {
    case 'welcome': {
      state.selfId = message.id;
      if (Array.isArray(message.emojiPool) && message.emojiPool.length) {
        state.emojiPool = message.emojiPool;
      }
      // The roster is the full truth for this connection.
      cursors.clear();
      for (const player of message.players || []) {
        cursors.upsert(player.id, player.icon, player.x, player.y);
        cursors.setLocked(player.id, Boolean(player.locked));
      }
      unlockSelf();
      break;
    }

    case 'joined':
      cursors.upsert(message.id, message.icon, message.x, message.y);
      break;

    case 'left':
      cursors.remove(message.id);
      break;

    case 'move':
      cursors.setTarget(message.id, message.x, message.y);
      break;

    case 'icon':
      cursors.setIcon(message.id, message.icon);
      break;

    case 'capture': {
      effects.burst(message.emoji, message.x, message.y);
      cursors.setLocked(message.target, true);
      if (message.target === state.selfId) lockSelf(message.until);
      break;
    }

    case 'unlock':
      cursors.setLocked(message.id, false);
      if (message.id === state.selfId) unlockSelf();
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------- lock state

function lockSelf(until) {
  clearTimeout(state.lockTimer);
  state.locked = true;
  cursors.setSelfLocked(true);

  const remaining = Math.max(0, Number(until) - Date.now()) + 60;
  state.lockTimer = setTimeout(unlockSelf, remaining);
}

function unlockSelf() {
  clearTimeout(state.lockTimer);
  state.locked = false;
  cursors.setSelfLocked(false);
}

// ---------------------------------------------------------------- pointer input

function onPointerMove(clientX, clientY) {
  const x = clamp01(clientX / Math.max(1, window.innerWidth));
  const y = clamp01(clientY / Math.max(1, window.innerHeight));

  state.pointer.x = x;
  state.pointer.y = y;

  if (!state.seenPointer) {
    state.seenPointer = true;
    dismissHintSoon();
  }

  // Local cursor tracks the real pointer with no delay.
  cursors.setSelfTarget(x, y);
}

window.addEventListener(
  'mousemove',
  (event) => onPointerMove(event.clientX, event.clientY),
  { passive: true },
);

window.addEventListener(
  'touchmove',
  (event) => {
    const touch = event.touches[0];
    if (touch) onPointerMove(touch.clientX, touch.clientY);
  },
  { passive: true },
);

window.addEventListener(
  'touchstart',
  (event) => {
    const touch = event.touches[0];
    if (touch) onPointerMove(touch.clientX, touch.clientY);
  },
  { passive: true },
);

// Tell the server our size again after a resize. It only needs this to judge
// cursor overlap in pixels; the cursors themselves re-place for free.
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    net.send({ t: 'size', w: window.innerWidth, h: window.innerHeight });
  }, 250);
});

/**
 * Throttled, change-only position sending.
 *
 * Raw mousemove fires far more often than 30/s and most of those events are
 * noise. We push at a fixed cadence and skip frames where nothing moved, so an
 * idle player generates no traffic at all.
 */
setInterval(() => {
  if (state.locked) return;
  if (!net.isOpen()) return;
  if (state.lastSentX === state.pointer.x && state.lastSentY === state.pointer.y) return;

  state.lastSentX = state.pointer.x;
  state.lastSentY = state.pointer.y;
  net.send({ t: 'move', x: state.pointer.x, y: state.pointer.y });
}, SEND_INTERVAL_MS);

// ---------------------------------------------------------------- hint

function dismissHintSoon() {
  if (state.hintDismissed) return;
  state.hintDismissed = true;
  setTimeout(() => scene.hint.classList.add('is-gone'), 10000);
}

function setUpHint() {
  let seen = false;
  try {
    seen = localStorage.getItem(STORAGE.hintSeen) === '1';
  } catch {
    seen = false;
  }

  writeStored(STORAGE.hintSeen, '1');

  if (seen) {
    scene.hint.remove();
    state.hintDismissed = true;
    return;
  }
  setTimeout(() => scene.hint.classList.add('is-gone'), 6000);
}

// ---------------------------------------------------------------- background

function applyBackground(background) {
  if (!background) return;
  scene.bg.style.backgroundImage = `url("${background.file}")`;
  scene.scrim.style.opacity = String(
    Number.isFinite(background.overlay) ? background.overlay : DEFAULT_OVERLAY,
  );
}

// ---------------------------------------------------------------- render loop

function loop() {
  // The next frame is scheduled before the work is done. If anything in a
  // single frame ever throws, the room keeps rendering instead of going
  // permanently still.
  requestAnimationFrame(loop);
  cursors.frame();
}

// While a tab is hidden the browser pauses animation frames, so nothing gets
// drawn. On the way back, jump every cursor to where it actually is rather
// than gliding there from a stale position.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') cursors.snapAll();
});

// ---------------------------------------------------------------- boot

async function boot() {
  setUpHint();

  cursors.setSelfIcon(state.icon);
  cursors.setSelfTarget(state.pointer.x, state.pointer.y);

  await createDock({
    dockEl: scene.dock,
    panelEl: scene.panel,
    dockbarEl: scene.dockbar,
    initialIcon: state.icon,
    getEmojiPool: () => state.emojiPool,
    onIcon: (icon) => {
      state.icon = icon;
      cursors.setSelfIcon(icon);
      net.send({ t: 'icon', icon });
    },
    onBackground: applyBackground,
  });

  requestAnimationFrame(loop);
  net.connect();
}

boot();
