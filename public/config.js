/**
 * config.js — the knobs worth changing.
 *
 * Timings here are only used for display and for the local freeze; the server
 * owns the real ones and tells us what they are when we connect.
 */

/** Cursor identities offered in the dock. Add or remove freely. */
export const ICONS = [
  '👩',
  '👨',
  '🧑',
  '👩‍❤️‍👨',
  '👨‍❤️‍👨',
  '👩‍❤️‍👩',
  '🐱',
  '🐻',
  '🦊',
  '🐰',
  '💝',
  '🦄',
];

export const DEFAULT_ICON = '🧑';

/** Shown in the 💕 panel until the server tells us the real pool. */
export const FALLBACK_EMOJI_POOL = ['❤️', '💕', '💖', '✨'];

/**
 * How often we push our position to the server, in milliseconds.
 * We only send when the position actually changed, so sitting still costs
 * zero network traffic.
 */
export const SEND_INTERVAL_MS = 33; // ~30 updates/second

/** Remote cursor easing. Higher = snappier, lower = smoother. */
export const INTERP = 0.25;

/** Stop easing once a remote cursor is this close (in normalized units). */
export const SNAP_NORM = 0.0009;

/** Used only if a background has no explicit overlay value. */
export const DEFAULT_OVERLAY = 0.12;

export const STORAGE = {
  icon: 'little-room.icon',
  background: 'little-room.background',
  hintSeen: 'little-room.hint-seen',
};

/** Background used when nothing is stored and the manifest is unavailable. */
export const DEFAULT_BACKGROUND = 'love-lake';
