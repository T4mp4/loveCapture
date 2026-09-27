/**
 * net.js — the only place that knows about WebSockets.
 *
 * Wraps reconnection and JSON parsing so the rest of the app just reacts to
 * messages. Messages are never queued: if the socket is down, a position
 * update is worthless by the time it reconnects, so it is dropped instead.
 */

const MAX_RETRY_DELAY_MS = 8000;

export function createNet({ onOpen, onMessage, onStatus }) {
  let socket = null;
  let retryCount = 0;
  let retryTimer = 0;
  let stopped = false;
  let state = 'connecting';

  const endpoint = () => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}`;
  };

  function setState(next) {
    if (state === next) return;
    state = next;
    onStatus(next);
  }

  function scheduleReconnect() {
    retryCount += 1;
    // Exponential backoff with a little jitter, capped so we never go quiet
    // for long. The server sleeps on free hosting tiers, so patience matters.
    const backoff = Math.min(MAX_RETRY_DELAY_MS, 400 * 2 ** Math.min(retryCount, 4));
    const delay = backoff + Math.random() * 250;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, delay);
  }

  function connect() {
    if (stopped) return;
    clearTimeout(retryTimer);
    setState('connecting');

    try {
      socket = new WebSocket(endpoint());
    } catch {
      socket = null;
      setState('offline');
      scheduleReconnect();
      return;
    }

    socket.addEventListener('open', () => {
      retryCount = 0;
      setState('online');
      onOpen();
    });

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message || typeof message !== 'object' || typeof message.t !== 'string') return;
      onMessage(message);
    });

    socket.addEventListener('close', () => {
      socket = null;
      if (stopped) return;
      setState('offline');
      scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // 'close' always follows, and that is where the retry is scheduled.
      try {
        if (socket) socket.close();
      } catch {
        /* nothing useful to do here */
      }
    });
  }

  function send(payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }

  return {
    connect,
    send,
    isOpen: () => Boolean(socket) && socket.readyState === WebSocket.OPEN,
  };
}
