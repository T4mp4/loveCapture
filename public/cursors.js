/**
 * cursors.js — everything about drawing cursors.
 *
 * Two kinds:
 *   - the local cursor, which snaps straight to the real pointer
 *   - remote cursors, which ease toward the last position the server sent, so
 *     they glide instead of teleporting between network updates
 *
 * Elements are created once and then only moved with a CSS transform. Nothing
 * here rebuilds DOM during the loop.
 *
 * Positions are stored normalized (0..1). When painting, a value is turned
 * into `vw`/`vh` units, which means a window resize needs no extra handling.
 */

import { INTERP, SNAP_NORM } from './config.js';

export function createCursorLayer(layer) {
  /** @type {Map<string, object>} remote player id -> cursor record */
  const remote = new Map();

  // The local cursor is tracked as a record like any remote one, so `frame`
  // and `draw` can treat them identically. It has to carry its element in the
  // same `el` field or drawing it will blow up.
  const self = {
    el: null,
    x: 0.5,
    y: 0.5,
    tx: 0.5,
    ty: 0.5,
    locked: false,
    drawnX: null,
    drawnY: null,
  };

  function makeElement(modifier) {
    const el = document.createElement('div');
    el.className = `cursor cursor--${modifier}`;

    const ring = document.createElement('span');
    ring.className = 'cursor__ring';

    const glyph = document.createElement('span');
    glyph.className = 'cursor__glyph';

    el.append(ring, glyph);
    layer.appendChild(el);
    return el;
  }

  const glyphOf = (el) => el.querySelector('.cursor__glyph');

  /** Normalized coordinates straight into viewport units. */
  function paint(el, x, y) {
    el.style.transform = `translate3d(${(x * 100).toFixed(4)}vw, ${(y * 100).toFixed(4)}vh, 0)`;
  }

  function draw(record, x, y) {
    if (record.drawnX === x && record.drawnY === y) return;
    paint(record.el, x, y);
    record.drawnX = x;
    record.drawnY = y;
  }

  // -------------------------------------------------------------- local cursor

  function ensureSelf() {
    if (self.el) return self.el;
    const element = makeElement('self');
    self.el = element;
    paint(element, self.x, self.y);
    self.drawnX = self.x;
    self.drawnY = self.y;
    return element;
  }

  function setSelfIcon(icon) {
    glyphOf(ensureSelf()).textContent = icon;
  }

  /** Called on every raw pointer event: the local cursor follows instantly. */
  function setSelfTarget(x, y) {
    self.tx = x;
    self.ty = y;
  }

  function setSelfLocked(locked) {
    self.locked = locked;
    if (self.el) self.el.classList.toggle('is-locked', locked);
  }

  // -------------------------------------------------------------- remote cursors

  function upsert(id, icon, x, y) {
    let record = remote.get(id);

    if (!record) {
      const el = makeElement('remote');
      record = {
        el,
        x,
        y,
        tx: x,
        ty: y,
        drawnX: null,
        drawnY: null,
      };
      glyphOf(el).textContent = icon;
      paint(el, x, y);
      record.drawnX = x;
      record.drawnY = y;
      remote.set(id, record);
      return;
    }

    if (icon) glyphOf(record.el).textContent = icon;
    record.tx = x;
    record.ty = y;
  }

  function setTarget(id, x, y) {
    const record = remote.get(id);
    if (!record) return;
    record.tx = x;
    record.ty = y;
  }

  function setIcon(id, icon) {
    const record = remote.get(id);
    if (!record) return;
    glyphOf(record.el).textContent = icon;
  }

  function setLocked(id, locked) {
    const record = remote.get(id);
    if (!record) return;
    record.el.classList.toggle('is-locked', locked);
  }

  function remove(id) {
    const record = remote.get(id);
    if (!record) return;
    record.el.remove();
    remote.delete(id);
  }

  function clear() {
    for (const id of [...remote.keys()]) remove(id);
  }

  // -------------------------------------------------------------- frame

  /**
   * Snap every cursor straight to its latest known position.
   *
   * Used when the tab becomes visible again. While a tab is hidden the render
   * loop is paused, so positions received in the meantime would otherwise be
   * eased into view as a slow glide from wherever the cursors were left.
   */
  function snapAll() {
    for (const record of remote.values()) {
      record.x = record.tx;
      record.y = record.ty;
      record.drawnX = null; // force a repaint
      record.drawnY = null;
    }

    if (self.el && !self.locked) {
      self.x = self.tx;
      self.y = self.ty;
      self.drawnX = null;
      self.drawnY = null;
    }
  }

  /** Called once per animation frame by the app's loop. */
  function frame() {
    if (self.el && !self.locked) {
      self.x = self.tx;
      self.y = self.ty;
      draw(self, self.x, self.y);
    }

    for (const record of remote.values()) {
      const dx = record.tx - record.x;
      const dy = record.ty - record.y;

      if (Math.abs(dx) < SNAP_NORM && Math.abs(dy) < SNAP_NORM) {
        record.x = record.tx;
        record.y = record.ty;
      } else {
        record.x += dx * INTERP;
        record.y += dy * INTERP;
      }

      draw(record, record.x, record.y);
    }
  }

  return {
    frame,
    snapAll,
    ensureSelf,
    setSelfIcon,
    setSelfTarget,
    setSelfLocked,
    upsert,
    setTarget,
    setIcon,
    setLocked,
    remove,
    clear,
    count: () => remote.size,
  };
}
