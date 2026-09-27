/**
 * effects.js — short-lived visual reactions.
 *
 * Only one effect exists: the emoji that pops up where a capture happened.
 * Nodes are created on demand and removed when their animation ends, so
 * nothing accumulates on screen.
 */

const MAX_LIFETIME_MS = 1600; // safety net in case animationend never fires

export function createEffects(layer) {
  function burst(emoji, x, y) {
    const el = document.createElement('span');
    el.className = 'burst';
    el.textContent = emoji;
    // Normalized position -> viewport units, same trick the cursors use.
    el.style.left = `${(x * 100).toFixed(4)}vw`;
    el.style.top = `${(y * 100).toFixed(4)}vh`;

    layer.appendChild(el);

    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      el.remove();
    };

    el.addEventListener('animationend', remove, { once: true });
    setTimeout(remove, MAX_LIFETIME_MS);
  }

  return { burst };
}
