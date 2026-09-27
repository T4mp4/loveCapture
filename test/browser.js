'use strict';

/**
 * browser.js — real-browser end-to-end check.
 *
 * The smoke test proves the server protocol works. This proves the browser
 * actually renders it: two separate Chrome windows, each its own browser, both
 * visible, driven over the DevTools protocol.
 *
 * Two windows rather than two tabs is the whole point. Only one tab in a
 * browser window is ever visible, and hidden tabs have their
 * requestAnimationFrame loop paused, so a tab-vs-tab test measures nothing.
 *
 * Run with: npm run browser-test
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOM_PORT = 3998;
const ROOM_URL = `http://127.0.0.1:${ROOM_PORT}/`;

const results = [];

function check(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

/** Minimal DevTools protocol client over a raw WebSocket. */
function connectCdp(wsUrl, label = 'page') {
  return new Promise((ready, failed) => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 1;

    socket.on('error', failed);
    socket.on('open', () => ready({ send, close: () => socket.close() }));

    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Surface anything the page itself complains about.
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        const text = details.exception?.description || details.text;
        console.log(`  !! ${label} exception: ${String(text).split('\n')[0]}`);
        return;
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        const text = (message.params.args || []).map((a) => a.value ?? a.description).join(' ');
        console.log(`  !! ${label} console.error: ${text}`);
        return;
      }

      if (!message.id || !pending.has(message.id)) return;
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });

    function send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          reject(new Error(`DevTools call timed out: ${method}`));
        }, 15000);
      });
    }
  });
}

async function waitForDebugger(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`DevTools never came up on port ${port}`);
}

async function evaluate(cdp, expression, awaitPromise = false) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

/** Counts animation frames over a window, to prove the render loop can tick. */
const RAF_PROBE = `new Promise((resolve) => {
  let ticks = 0;
  const started = performance.now();
  function step() {
    ticks += 1;
    if (performance.now() - started < 500) requestAnimationFrame(step);
    else resolve(ticks);
  }
  requestAnimationFrame(step);
})`;

/** Instruments the page so we can count real pointer events. */
function instrumentPointer(cdp) {
  return evaluate(
    cdp,
    "window.__pointerEvents = 0; addEventListener('mousemove', () => { window.__pointerEvents += 1; }, { passive: true }); true",
  );
}

/** Boots a whole Chrome window pointed at the room. */
async function openWindow(chromePath, debugPort, profileDir) {
  const child = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=1200,800',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const wsUrl = await waitForDebugger(debugPort, 20000);
  const cdp = await connectCdp(wsUrl, `window ${debugPort}`);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: ROOM_URL });

  // Give the page time to boot, fetch the manifest, and open its socket.
  await sleep(2500);

  return { child, cdp };
}

const REMOTE_CURSOR_COUNT = "document.querySelectorAll('.cursor--remote').length";
const REMOTE_TRANSFORM = "document.querySelector('.cursor--remote')?.style.transform ?? null";
const SELF_TRANSFORM = "document.querySelector('.cursor--self')?.style.transform ?? null";
const MOVED_FROM_START = "translate3d(50vw, 50vh, 0px)";

/** Samples a value repeatedly so we can see whether it ever changed. */
async function sample(cdp, expression, times, gapMs) {
  const seen = new Set();
  for (let i = 0; i < times; i += 1) {
    seen.add(await evaluate(cdp, expression));
    await sleep(gapMs);
  }
  return [...seen];
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) {
    console.log('SKIP: no Chrome/Chromium found. Set CHROME_PATH to run this test.');
    return;
  }

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(ROOM_PORT) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  const stamp = Date.now();
  const profileA = path.join(os.tmpdir(), `little-room-a-${stamp}`);
  const profileB = path.join(os.tmpdir(), `little-room-b-${stamp}`);

  let windowA = null;
  let windowB = null;

  try {
    // Wait for the room's HTTP port.
    const deadline = Date.now() + 10000;
    for (;;) {
      try {
        await fetch(ROOM_URL);
        break;
      } catch {
        if (Date.now() > deadline) throw new Error('room server never came up');
        await sleep(200);
      }
    }

    console.log('\ntwo real browser windows');
    windowA = await openWindow(chromePath, 9222, profileA);
    console.log('  window A open');

    windowB = await openWindow(chromePath, 9223, profileB);
    console.log('  window B open');
    await sleep(800);

    const dockCount = await evaluate(windowA.cdp, "document.querySelectorAll('.dock__item').length");
    check('the scene boots in a real browser', dockCount === 4, `${dockCount} dock items`);

    for (const [label, win] of [['A', windowA], ['B', windowB]]) {
      const visibility = await evaluate(win.cdp, 'document.visibilityState');
      check(`window ${label} is actually visible`, visibility === 'visible', visibility);
      const ticks = await evaluate(win.cdp, RAF_PROBE, true);
      check(`window ${label} animation frames are firing`, ticks > 10, `${ticks} frames in 500ms`);
      await instrumentPointer(win.cdp);
    }

    const statusA = await evaluate(windowA.cdp, "document.getElementById('status').dataset.state");
    check('the socket opened', statusA === 'online', statusA);

    // Each window should have been told about the other over the wire.
    const remoteInA = await evaluate(windowA.cdp, REMOTE_CURSOR_COUNT);
    const remoteInB = await evaluate(windowB.cdp, REMOTE_CURSOR_COUNT);
    check('each window sees one remote cursor', remoteInA === 1 && remoteInB === 1, `A=${remoteInA} B=${remoteInB}`);
    check('the remote cursor carries the other player icon', (await evaluate(windowB.cdp, "document.querySelector('.cursor--remote .cursor__glyph')?.textContent")) === '🧑');

    console.log('\nlive movement A -> B');
    const before = await evaluate(windowB.cdp, REMOTE_TRANSFORM);
    check('window B has a cursor to position', typeof before === 'string' && before.length > 0, before || 'none');

    // Move the pointer around inside window A for a couple of seconds.
    for (let i = 0; i < 40; i += 1) {
      await windowA.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: 120 + i * 22,
        y: 160 + Math.round(Math.sin(i / 3) * 180) + 200,
        button: 'none',
      });
      await sleep(35);
    }
    await sleep(600);

    const after = await evaluate(windowB.cdp, REMOTE_TRANSFORM);
    check(
      'moving the mouse in A updates the rendered cursor in B',
      typeof after === 'string' && after !== before,
      `${before} -> ${after}`,
    );

    // If A's own cursor never moved, A's render loop or pointer handling is
    // broken, which is a completely different problem from sync.
    const selfA = await evaluate(windowA.cdp, SELF_TRANSFORM);
    check('window A followed its own pointer', selfA !== MOVED_FROM_START, selfA || 'none');

    console.log('\nlive movement B -> A');
    const beforeBack = await evaluate(windowA.cdp, REMOTE_TRANSFORM);
    check('window A reports itself visible', (await evaluate(windowA.cdp, 'document.visibilityState')) === 'visible');

    for (let i = 0; i < 40; i += 1) {
      await windowB.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: 900 - i * 18,
        y: 620 - Math.round(Math.cos(i / 4) * 150),
        button: 'none',
      });
      await sleep(35);
    }
    await sleep(600);

    const afterBack = await evaluate(windowA.cdp, REMOTE_TRANSFORM);
    check(
      'moving the mouse in B updates the rendered cursor in A',
      typeof afterBack === 'string' && afterBack !== beforeBack,
      `${beforeBack} -> ${afterBack}`,
    );

    // Narrow down which side failed.
    const distinctInA = await sample(windowA.cdp, REMOTE_TRANSFORM, 6, 150);
    console.log(`    A pointer events received: ${await evaluate(windowA.cdp, 'window.__pointerEvents')}`);
    console.log(`    B pointer events received: ${await evaluate(windowB.cdp, 'window.__pointerEvents')}`);
    console.log(`    A own cursor: ${await evaluate(windowA.cdp, SELF_TRANSFORM)}`);
    console.log(`    A self cursor count: ${await evaluate(windowA.cdp, "document.querySelectorAll('.cursor--self').length")}`);
    console.log(`    B own cursor: ${await evaluate(windowB.cdp, SELF_TRANSFORM)}`);
    console.log(`    A remote cursor samples: ${JSON.stringify(distinctInA)}`);
    console.log(`    A remote cursor count: ${await evaluate(windowA.cdp, REMOTE_CURSOR_COUNT)}`);
    console.log(`    A status: ${await evaluate(windowA.cdp, "document.getElementById('status').dataset.state")}`);

    console.log('\ncursor positions stay on screen');
    const onScreen = await evaluate(
      windowB.cdp,
      `(() => {
         const el = document.querySelector('.cursor--remote');
         if (!el) return false;
         const box = el.getBoundingClientRect();
         return box.left > -50 && box.top > -50 && box.left < innerWidth + 50 && box.top < innerHeight + 50;
       })()`,
    );
    check('the remote cursor is inside the viewport', onScreen === true);

    console.log('\ndisconnect removes the cursor');
    windowB.child.kill();
    await sleep(1500);
    const remoteAfterLeave = await evaluate(windowA.cdp, REMOTE_CURSOR_COUNT);
    check('closing a window removes its cursor from the others', remoteAfterLeave === 0, `${remoteAfterLeave} left`);
  } finally {
    if (windowA) windowA.child.kill();
    if (windowB) windowB.child.kill();
    server.kill();

    // Chrome holds file handles for a moment after being killed, so removing
    // the profile directories needs a couple of attempts.
    for (const dir of [profileA, profileB]) {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          break;
        } catch {
          await sleep(300);
        }
      }
    }
  }

  const failed = results.filter((entry) => !entry.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('failed:');
    for (const entry of failed) console.log(`  - ${entry.name}${entry.detail ? ` (${entry.detail})` : ''}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\nbrowser test crashed: ${error.message}`);
  process.exitCode = 1;
});
