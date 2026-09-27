# little room

> Tweaking the look, or putting it online? See **[HELP.md](HELP.md)** — it covers which
> setting does what and how to deploy. This file covers how the thing works.

A tiny shared room on the internet. Open the URL and you are in it — no account, no signup,
no lobby. Everyone who visits shares one global room, and everyone is an emoji cursor.

Move your cursor over someone and hold it there for five uninterrupted seconds. They freeze
for three seconds with an emoji bursting above them, then everyone keeps playing.

That's the whole product.

---

## Run it locally

```bash
npm install
npm start
```

Then open <http://localhost:3000>.

To test on your own, open the URL in two or three **separate windows** and move your cursor
between them. Use separate windows rather than tabs: a browser only ever renders one tab at a
 time, and it pauses animation frames in the others, so a background tab will look frozen even
 when everything is working.

Or run a headless partner that drifts around the room by itself:

```bash
npm run partner          # in a second terminal
```

The partner prints a line whenever someone joins, leaves, or gets caught, which is the easiest
way to watch the capture engine from the outside.

## Test

```bash
npm run smoke
```

Starts a real server on port 3999 and drives three WebSocket clients through the room
protocol: joining, roster sync, the timer resetting when contact breaks, a continuous overlap
producing exactly one capture, a locked player being unable to move, and the lock expiring on
its own. 20 checks, about 20 seconds.

```bash
npm run browser-test
```

Opens two real Chrome windows, moves the pointer in each one, and checks that the other window
actually repaints the remote cursor. This covers the half the protocol test cannot see — the
render loop — and it is what caught the bug where one exception in a single frame used to kill
animation for the rest of the session.

Requires Chrome or Chromium. It skips itself if it cannot find one; set `CHROME_PATH` to point
at a specific binary.

---

## Project structure

```
server.js                 static files + the WebSocket room and capture engine
test/smoke.js             end-to-end protocol test
test/fake-cursor.js       a headless partner for local testing
public/
  index.html              the scene (there is no page layout)
  style.css               all visual style
  app.js                  wiring: boot, input, messages, render loop
  net.js                  WebSocket connect/reconnect
  cursors.js              cursor rendering, interpolation, lock visuals
  effects.js              the capture emoji burst
  dock.js                 floating dock, pickers, panels
  config.js               icons, timings, storage keys
  assets/backgrounds/
    backgrounds.json      the background list — edit this to add wallpapers
    Love-Lake.png
    Love-Lake-Camp.png
```

---

## Adding a background

Drop an image into `public/assets/backgrounds/` and add one line to
`public/assets/backgrounds/backgrounds.json`:

```json
{
  "id": "starry-night",
  "name": "Starry Night",
  "file": "/assets/backgrounds/Star-Night.png",
  "overlay": 0.2
}
```

Refresh the page. It appears in the background picker with a thumbnail. No code changes.

- `id` — any unique string; this is what gets remembered per browser
- `file` — path to the image, relative to the site root
- `overlay` — `0` to `1`. A translucent veil drawn over the image that keeps cursors readable.
  Raise it for busy or bright images, lower it for dark ones.

There are nine themes sketched in `DevGuide.md`; only the two Love-Lake images exist so far.
Use 16:9 source images. The site is not locked to 16:9 — the background crops with
`background-size: cover`, so it adapts to desktop, tablet and phone without distorting.

---

## Tuning

Frontend knobs live in `public/config.js`: the icon list, the send rate, and how smoothly
remote cursors ease. The server owns the rules that matter and they are all at the top of
`server.js`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `TICK_MS` | `100` | how often the room is evaluated |
| `CAPTURE_MS` | `5000` | how long an overlap must last to capture |
| `LOCK_MS` | `3000` | how long a captured player stays frozen |
| `CAPTURE_RADIUS_PX` | `48` | how close two cursors must be to count as overlapping |
| `EMOJI_POOL` | 14 emoji | what can appear on a capture |

---

## How capture works

The server decides everything. Clients only report where their cursor is and render what they
are told. That single rule is what stops two people from "capturing" the same victim at the
same moment.

- **Overlap** is measured in pixels, not in the normalized `0..1` space, so the aspect ratio of
  a screen does not skew what "close" means. Both players' viewports are taken into account.
- **The timer is continuous.** Any break in contact resets it to zero. Partial overlap time is
  never banked, so three seconds of contact followed by a break is worth nothing.
- **The catcher is the one who moved last.** If both cursors sit on each other, the player who
  moved onto the other gets the capture. Ties fall back to a stable id order.
- **A pile-up produces one capture, not a chain.** When a capture resolves, both the catcher
  and the victim step out of the capture game until the lock expires. Without that, a third
  cursor parked on the same spot would immediately capture the catcher, and one pile-up would
  become a chain of captures. After those three seconds, everyone can be caught again.
- **A locked player cannot move.** Their mouse still moves, but the server ignores their
  position updates and their cursor stays where it is. They are not hidden.
- **Multiplayer is genuinely N-player.** Every player is checked against every other player,
  and lock state is tracked per player, not per pair.

Positions are sent as normalized `0..1` coordinates and throttled to about 30 updates per
second. Updates are only sent when the position actually changed, so a player sitting still
generates no network traffic at all.

---

## Deploying

The app is a normal Node process with one dependency (`ws`) and no database, so it runs on any
host with a persistent process and WebSocket support.

1. Make sure the host passes through its `PORT` environment variable — `server.js` already
   reads `process.env.PORT`.
2. Make sure WebSockets are supported on the plan you pick. Static-only or request/response
   hosting will not work.
3. **Check the provider's current free-tier terms before you commit to them.** Free tiers
   change: RAM, idle sleep behaviour, bandwidth, concurrent connection limits and WebSocket
   support are all things that get adjusted. Do not assume today's limits are permanent.
4. Expect an idle sleep to drop every connection at once. That is survivable — clients
   reconnect on their own with a backoff — but the room will empty out while the host is
   asleep.

No paid infrastructure is needed for this.

---

## Deliberately not included

Accounts, persistence, chat, private rooms, leaderboards, global background synchronisation.
Background choice is per browser and stored in `localStorage`. The code is arranged so that
global background sync could be added later without rearranging anything, but it is not part of
this build.
