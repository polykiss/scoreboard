# scoreboard

Minimal local-network scoreboard. Run a small Node server on any machine on your LAN; open the display view on a TV/projector and the controller view on your phone. Tap `+1`, the number updates everywhere instantly.

## Run

```bash
npm install
node server.js
```

The server listens on port **3000** and binds to `0.0.0.0` so it's reachable from other devices on the same network. On startup it prints the two URLs:

```
Scoreboard listening on 0.0.0.0:3000
  Display:    http://<your-lan-ip>:3000/display
  Controller: http://<your-lan-ip>:3000/control
```

- Open `/display` on the screen you want to show the count on (fullscreen browser, black background, big number).
- Open `/control` on your phone (mobile-first UI with `+1` / `−1` / Set / Reset, plus a collapsible Setup panel for font size, alignment, offsets, flash-on-update, and glow).
- Multiple controllers can be connected at once — every change is broadcast to every client, so they stay in sync.

State is persisted to `state.json` in the project root (gitignored). Delete it to reset to defaults.

## Font

The display uses **JD LED5** (from dafont.com). Drop the file at:

```
public/fonts/jd_led5.ttf
```

The display view references it via `@font-face` with `font-display: block`, so if the file is missing the number won't render until it's present.

## Power controls (shutdown / reboot)

The controller has hold-to-confirm buttons for shutting down or rebooting the host machine (useful when running headless on a Raspberry Pi). These require passwordless sudo for the `shutdown` and `reboot` commands.

Create the sudoers rule (replace `sx` with your user if different):

```bash
sudo visudo -f /etc/sudoers.d/scoreboard
```

Paste this single line:

```
sx ALL=(ALL) NOPASSWD: /usr/sbin/shutdown, /usr/sbin/reboot
```

`visudo` validates the syntax before saving. If the rule is missing, the shutdown/reboot buttons will set the state flag and show the status message but the actual system command will fail silently.

## Security note

There's no authentication. Anyone on the same network can hit `/control` and change the scoreboard. This is intended for trusted LANs only — don't expose port 3000 to the public internet.
