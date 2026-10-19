# Control Sonos for Asyar

Control your [Sonos](https://www.sonos.com/) speakers from the [Asyar](https://github.com/Xoshbin/asyar) launcher: a
control center with every group, what it plays, play/pause, track buttons and a volume slider, plus play/pause and track
commands to put on global hotkeys.

This is an unofficial community project and is **not affiliated with, endorsed by or sponsored by Sonos, Inc.** "Sonos" is
a trademark of its owner.

The behaviour follows the Raycast [Sonos extension](https://github.com/raycast/extensions/tree/main/extensions/sonos)
(MIT, by AntonNiklasson and contributors), which was used as a reference. No code was copied: that extension drives the
speakers through an npm library, while this one sends the UPnP/SOAP requests itself, because Asyar extensions run in a
sandbox without Node.

> **Status: requires an Asyar build that supports the `network:lan` permission.** Asyar's `network.fetch` normally refuses
> private LAN addresses, so this extension depends on the `network:lan` permission and `network.listLanDevices()`,
> `requestLanDevice()` and `requestLanHost()` (asyar-sdk 4.16.0), proposed in
> [Xoshbin/asyar#874](https://github.com/Xoshbin/asyar/issues/874) and implemented in
> [Xoshbin/asyar#879](https://github.com/Xoshbin/asyar/pull/879) (built against commit `05916c0`). Until that is in a release,
> asyar-sdk 4.16.0 is not on npm, so the extension builds against the SDK from that branch (see
> [Development](#development)) and can only be tried on a launcher built from it. See [Verification](#verification) for
> what has been tested.
>
> Test it **only** on that build. The released launcher can load the extension (for example from a shared data folder)
> but shows `network:lan` as "Not recognized" and refuses every request to the speaker.

## Commands

| Command | What it does |
| --- | --- |
| **Sonos Control Center** | Lists every group with what it plays, and controls it with buttons, a volume slider or the keyboard. Until a speaker is allowed, it explains how to allow one |
| **Sonos Play / Pause** | Toggles playback: pauses if the group is playing, otherwise plays |
| **Sonos Next Track** | Skips to the next track; a paused group starts playing first |
| **Sonos Previous Track** | Goes back to the previous track; a paused group starts playing first. Sonos does not allow going back on a radio station (such as a Spotify artist radio), and the command says so |

If a paused group takes longer than 3 seconds to start (a stream on a slow connection), Next and Previous leave it
playing without skipping, because Sonos refuses a skip until it plays.

The three playback commands are meant for global hotkeys: select one in Asyar, press **⌘K** (**Ctrl+K** on Windows and
Linux) and choose **Assign Shortcut** (or use the Shortcut cell in Settings → Extensions). On Linux under Wayland, Asyar's
global shortcuts do not fire; bind a desktop shortcut that opens `asyar://extensions/io.github.xoac.sonos/play-pause`
instead (or `next-track`, `previous-track`), using Asyar's deep links.
They are background commands: Asyar hides the launcher and the result appears as a short HUD message. They control the
group you last used in the Control Center, marked **Hotkeys** there (saved as the **Hotkey room** preference). If
something is not set up yet, the message tells you to open the Control Center (a background command cannot open a
window itself).

### Keyboard in the Control Center

| Key | Action |
| --- | --- |
| **↑** / **↓** | Select a group |
| **←** / **→** | Volume down / up by 5 (with **Shift**: by 1) |
| **Enter** | Play / pause the selected group |
| **⌘[** / **⌘]** (**Ctrl+[** / **Ctrl+]**) | Previous / next track (also in the **⌘K** actions) |

The launcher passes the arrow keys and Enter to the view while its search bar has focus, so they work right after the
view opens. The view reads the groups again every 2 seconds while it is visible.

## Setup

Control Sonos runs in Asyar's sandbox: it can reach only the devices you allow, on the port you allow. Asyar finds the
speakers on your network and asks you; the extension never sees the rest of your network.

1. Make sure this computer is on the same network as your Sonos system.
2. Open **Sonos Control Center** in Asyar and accept the permissions it asks for.
3. Press **Add Speaker…**. Asyar opens its device picker: choose your speaker in the row marked `SONOS` (or
   `ZonePlayer`), on port **1400**. If it is not listed, use **Manual IP & port** in the same dialog with its IP address
   (Sonos app: **Settings → System → About My System**, or your router's list of devices) and port 1400.
4. Your groups appear. One allowed speaker is enough to see all of them; a dimmed group is led by a speaker that is not
   allowed yet, because commands for a group go to the speaker that leads it. Press **Allow…** on it and confirm in
   Asyar's dialog, which names that speaker's address.

Allowed speakers are listed, and can be removed, in Asyar Settings (**⌘,** / **Ctrl+,**) → **Extensions** → **Control Sonos** →
**Local network devices**; that page also has its own scan. An extension cannot remove a device or open that page, so
the Control Center names it when something there needs a change, such as an entry on a port other than 1400.

## Permissions

| Permission | Why |
| --- | --- |
| `network` | Required by `network:lan`; sends the SOAP requests through Asyar's `network.fetch` |
| `network:lan` | Lets the extension reach devices on your local network, read the list of devices you allowed for it, and ask you to allow one through Asyar's dialogs. It declares **no** hosts of its own: only the devices you allow are reachable |
| `preferences:write` | Lets the Control Center save the group the hotkey commands control (this extension's own preferences only) |

No other permissions are requested. The extension does not run programs, use the clipboard, the filesystem or the
internet.

## How it works

Everything is SOAP (UPnP over HTTP) to the speakers on port 1400:

1. `ZoneGroupTopology.GetZoneGroupState`, sent to every allowed speaker at once (the first answer is used, so a speaker
   that is off costs no wait), gives the groups and their coordinators. A coordinator's host and port come from its `Location` URL in that answer, as in the
   library the Raycast extension uses. If you allowed the coordinator by its mDNS hostname (`Sonos-<MAC>.local`),
   requests go to that hostname instead, because Asyar only lets requests through to the address you allowed.
2. Everything else goes to the group's coordinator: `AVTransport` `GetTransportInfo` (play state), `GetPositionInfo`
   (what plays), `Pause`/`Play`/`Next`/`Previous`, and `GroupRenderingControl` `GetGroupVolume`/`SetGroupVolume`. For a
   group of several rooms, `SnapshotGroupVolume` is sent when you start changing the volume, so each room keeps its share,
   as in the Sonos app. While you drag the slider, only the latest value is sent.

For play/pause, `GetTransportInfo` decides which way to toggle. Speakers can push changes only to a server the extension
cannot run, so the Control Center polls instead.

## Not included

- A menu-bar item, mute, per-room volume inside a group, album art, queue and favorites.

## Verification

- Unit tests (`bun run test:run`) cover request building and parsing (on answers recorded from a real speaker, with its
  address and ids replaced), the allowed-device list, how Asyar's refusals are told apart, group and coordinator choice
  (IP and hostname, a speaker that is off), command logic, the Control Center's group list, volume, selection and key
  handling with fake speakers, HUD length, and manifest consistency. The tests for the main behaviours were checked by
  breaking the line each one guards and seeing it fail.
- `bun run check` (svelte-check, TypeScript included), `asyar validate` and `asyar build` pass with asyar-sdk 4.16.0 from
  the `network:lan` branch.
- Checked against a real speaker (Sonos/95.1, from a terminal): the parser reads its `GetZoneGroupState`,
  `GetTransportInfo`, `GetPositionInfo`, `GetCurrentTransportActions` and group volume answers. On a Spotify artist
  radio the speaker allows only `Set, Stop, Pause, Play, Next`, which is why Previous fails there.
- On a launcher built from the `network:lan` branch (`3dd67b8`), the previous version (a setup page and five commands)
  was reported working; which commands were tried was not recorded.
- Not yet verified: the Control Center (now playing, slider, keys, actions, Add Speaker and Allow) on a launcher built
  from `05916c0`; `SetGroupVolume`, play-then-skip and a speaker that is off against real speakers; the link-local
  refusal on a real launcher.

## Development

```bash
bun install
bun run check        # svelte-check (vite build does not type-check)
bun run test:run     # vitest
bun run build        # vite build -> dist/
```

`package.json` takes `asyar-sdk` from `../tmp/asyar/asyar-sdk`, a checkout of Asyar on the `network:lan` branch with the
SDK built (`dist/`), because 4.16.0 is not on npm yet. Create it first, from this folder:

```bash
git clone https://github.com/Xoshbin/asyar ../tmp/asyar
git -C ../tmp/asyar fetch origin pull/879/head
git -C ../tmp/asyar checkout 05916c0
(cd ../tmp/asyar/asyar-sdk && bun install && bun run build)
```

Switch it back to `^4.16.0` once it is published. All dependencies are development tools (the extension is a static
bundle); `bun audit` reports only advisories in the SDK's own CLI dependencies (`tmp`, `braces`). The SDK also provides
the CLI:

```bash
bunx --bun asyar validate
bunx --bun asyar build
bunx --bun asyar link --copy            # the app's data dir (org.asyar; older releases used org.asyar.app)
bunx --bun asyar link --dev --copy      # launcher run with the dev config (org.asyar.dev)
```

`asyar attach` has no `--dev` option and always writes to the installed app's registry. `--copy` copies `dist/` instead of
symlinking it, because a symlink pointing outside the data dir can be refused by the launcher's asset server (reported in
other extensions' READMEs; not checked here). Run `link` again after each rebuild, and restart the launcher to load the
extension.

## License

[MIT](LICENSE)
