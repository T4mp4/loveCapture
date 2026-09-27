/**
 * dock.js — the floating dock and the little panels that grow out of it.
 *
 * The background list is not hardcoded. It is read from
 * ./assets/backgrounds/backgrounds.json, so adding a new wallpaper later means
 * dropping an image in the folder and adding one line of JSON. No code changes.
 */

import { ICONS, STORAGE, DEFAULT_BACKGROUND, DEFAULT_OVERLAY } from './config.js';

const MANIFEST_URL = './assets/backgrounds/backgrounds.json';

const DOCK_ITEMS = [
  { key: 'icon', glyph: '👤', label: 'My Icon' },
  { key: 'background', glyph: '🌄', label: 'Background' },
  { key: 'emoji', glyph: '🎯', label: 'Emoji' },
  // { key: 'about', glyph: 'ℹ️', label: 'About' },
];

const PANEL_HIDE_MS = 300;
const HOVER_OPEN_MS = 150; // a beat of intent before a hover opens a panel
const DOCK_CLOSE_MS = 250; // grace period when the pointer leaves the dock

/**
 * Strip anything that could break out of a CSS url() or point somewhere odd.
 * Background paths come from our own manifest, but they are still treated as
 * untrusted text.
 */
function safeAssetUrl(file) {
  return String(file)
    .replace(/["'()\\\s]/g, '')
    .replace(/^\/+/, '/');
}

async function loadBackgrounds() {
  try {
    const response = await fetch(MANIFEST_URL, { cache: 'no-cache' });
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json();
    const list = Array.isArray(data.backgrounds) ? data.backgrounds : [];

    return list
      .filter((b) => b && typeof b.id === 'string' && typeof b.file === 'string')
      .map((b) => ({
        id: b.id,
        name: typeof b.name === 'string' && b.name ? b.name : b.id,
        file: safeAssetUrl(b.file),
        overlay: Number.isFinite(b.overlay) ? b.overlay : DEFAULT_OVERLAY,
      }));
  } catch {
    // Missing or broken manifest: fall back to the built-in gradient.
    return [];
  }
}

function readStored(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode, or storage full — the room still works */
  }
}

export async function createDock({
  dockEl,
  panelEl,
  dockbarEl,
  initialIcon,
  onIcon,
  onBackground,
  getEmojiPool,
}) {
  const backgrounds = await loadBackgrounds();
  const buttons = new Map();

  let currentIcon = initialIcon;
  let currentBackgroundId = readStored(STORAGE.background, DEFAULT_BACKGROUND);
  let openKey = null;
  let hoverTimer = 0;
  let closeTimer = 0;

  // ------------------------------------------------------------ dock buttons

  for (const item of DOCK_ITEMS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dock__item';
    button.dataset.key = item.key;
    button.setAttribute('aria-label', item.label);

    const glyph = document.createElement('span');
    glyph.className = 'dock__glyph';
    glyph.textContent = item.glyph;

    const tip = document.createElement('span');
    tip.className = 'dock__tip';
    tip.textContent = item.label;

    button.append(glyph, tip);

    button.addEventListener('mouseenter', () => {
      clearTimeout(closeTimer);
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => open(item.key), HOVER_OPEN_MS);
    });

    button.addEventListener('focus', () => open(item.key));

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      clearTimeout(hoverTimer);
      if (openKey === item.key) close();
      else open(item.key);
    });

    dockEl.appendChild(button);
    buttons.set(item.key, button);
  }

  dockEl.addEventListener('mouseleave', () => clearTimeout(hoverTimer));

  // The dock and the panel share a wrapper, so moving the pointer from one to
  // the other does not count as leaving.
  dockbarEl.addEventListener('mouseenter', () => clearTimeout(closeTimer));
  dockbarEl.addEventListener('mouseleave', () => {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(close, DOCK_CLOSE_MS);
  });

  document.addEventListener('pointerdown', (event) => {
    if (!dockbarEl.contains(event.target)) close();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });

  // ------------------------------------------------------------ open / close

  function open(key) {
    clearTimeout(closeTimer);
    if (openKey === key && !panelEl.hidden) return;

    openKey = key;
    for (const [k, button] of buttons) button.classList.toggle('is-active', k === key);

    panelEl.replaceChildren(buildPanel(key));
    panelEl.hidden = false;
    requestAnimationFrame(() => panelEl.classList.add('is-open'));
  }

  function close() {
    if (openKey === null) return;
    const closingKey = openKey;
    openKey = null;

    for (const button of buttons.values()) button.classList.remove('is-active');
    panelEl.classList.remove('is-open');

    setTimeout(() => {
      if (openKey === null && closingKey) {
        panelEl.hidden = true;
        panelEl.replaceChildren();
      }
    }, PANEL_HIDE_MS);
  }

  function buildPanel(key) {
    if (key === 'icon') return buildIconPanel();
    if (key === 'background') return buildBackgroundPanel();
    if (key === 'emoji') return buildEmojiPanel();
    return buildAboutPanel();
  }

  /** Panels are fragments: [title, content..., note?] */
  function panelShell(title) {
    const fragment = document.createDocumentFragment();

    const heading = document.createElement('p');
    heading.className = 'panel__title';
    heading.textContent = title;
    fragment.appendChild(heading);

    return fragment;
  }

  function note(text) {
    const el = document.createElement('p');
    el.className = 'panel__note';
    el.textContent = text;
    return el;
  }

  function grid(modifier) {
    const el = document.createElement('div');
    el.className = `panel__grid panel__grid--${modifier}`;
    return el;
  }

  function markCurrent(container, node) {
    for (const child of container.children) child.classList.remove('is-current');
    node.classList.add('is-current');
  }

  // ------------------------------------------------------------ panels

  function buildIconPanel() {
    const fragment = panelShell('Choose your cursor');
    const container = grid('icons');

    for (const icon of ICONS) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'icon-chip';
      chip.textContent = icon;
      chip.setAttribute('aria-label', `Use ${icon}`);
      if (icon === currentIcon) chip.classList.add('is-current');

      chip.addEventListener('click', () => {
        currentIcon = icon;
        store(STORAGE.icon, icon);
        markCurrent(container, chip);
        onIcon(icon);
      });

      container.appendChild(chip);
    }

    fragment.appendChild(container);
    return fragment;
  }

  function buildBackgroundPanel() {
    const fragment = panelShell('Background');

    if (backgrounds.length === 0) {
      fragment.appendChild(note('No backgrounds found. Add images to assets/backgrounds and list them in backgrounds.json.'));
      return fragment;
    }

    const container = grid('thumbs');

    for (const background of backgrounds) {
      const thumb = document.createElement('button');
      thumb.type = 'button';
      thumb.className = 'thumb';
      thumb.title = background.name;
      thumb.setAttribute('aria-label', background.name);
      thumb.style.backgroundImage = `url("${background.file}")`;
      if (background.id === currentBackgroundId) thumb.classList.add('is-current');

      thumb.addEventListener('click', () => {
        currentBackgroundId = background.id;
        store(STORAGE.background, background.id);
        markCurrent(container, thumb);
        onBackground(background);
      });

      container.appendChild(thumb);
    }

    fragment.appendChild(container);
    return fragment;
  }

  function buildEmojiPanel() {
    const fragment = panelShell('Capture reactions');
    const container = grid('icons');

    for (const emoji of getEmojiPool()) {
      const chip = document.createElement('span');
      chip.className = 'icon-chip icon-chip--static';
      chip.textContent = emoji;
      container.appendChild(chip);
    }

    fragment.appendChild(container);
    fragment.appendChild(note('One of these pops up when you catch someone.'));
    return fragment;
  }

  function buildAboutPanel() {
    const fragment = panelShell('little room');
    fragment.appendChild(
      note('Move your cursor over someone and stay close for five seconds. They freeze for three, then everyone keeps playing.'),
    );
    return fragment;
  }

  // ------------------------------------------------------------ initial state

  const initial =
    backgrounds.find((b) => b.id === currentBackgroundId) || backgrounds[0] || null;

  if (initial) {
    currentBackgroundId = initial.id;
    onBackground(initial);
  }

  return { backgrounds, applyCurrentBackground: () => initial && onBackground(initial), close };
}
