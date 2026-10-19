# Contributing

## Setup

The extension needs asyar-sdk 4.16.0, which adds the `network:lan` permission and `network.listLanDevices()`,
`requestLanDevice()` and `requestLanHost()` ([Xoshbin/asyar#874](https://github.com/Xoshbin/asyar/issues/874),
implemented in [Xoshbin/asyar#879](https://github.com/Xoshbin/asyar/pull/879)). It is not on npm yet, so `package.json`
takes it from `../tmp/asyar/asyar-sdk`, a checkout of that branch with the SDK built. Create it first, from this folder:

```bash
git clone https://github.com/Xoshbin/asyar ../tmp/asyar
git -C ../tmp/asyar fetch origin pull/879/head
git -C ../tmp/asyar checkout 05916c0
(cd ../tmp/asyar/asyar-sdk && bun install && bun run build)
```

Switch the dependency back to `^4.16.0` once it is published. All dependencies are development tools (the extension is a
static bundle); `bun audit` reports only advisories in the SDK's own CLI dependencies (`tmp`, `braces`).

## Build and test

```bash
bun install
bun run check               # svelte-check (vite build does not type-check)
bun run test:run            # vitest
bunx --bun asyar validate
bunx --bun asyar build
```

Try it on a launcher built from the same checkout, and link the build into it:

```bash
bunx --bun asyar link --copy            # the app's data dir (org.asyar; older releases used org.asyar.app)
bunx --bun asyar link --dev --copy      # launcher run with the dev config (org.asyar.dev)
```

Run `link` again after each rebuild and restart the launcher, which loads extensions only at startup. `--copy` copies
`dist/` instead of symlinking it, because a symlink pointing outside the data dir can be refused by the launcher's asset
server (reported in other extensions' READMEs; not checked here). `asyar attach` has no `--dev` option and always writes
to the installed app's registry.

## How it works

Everything is SOAP (UPnP over HTTP) to the speakers on port 1400, sent through Asyar's `network.fetch`. The Raycast
Sonos extension this one follows drives the speakers through an npm library; this one builds the requests itself,
because Asyar extensions run in a sandbox without Node.

1. `ZoneGroupTopology.GetZoneGroupState` is sent to every allowed speaker at once, and the first answer is used, so a
   speaker that is off costs no wait. It gives the groups and their coordinators; a coordinator's host and port come from
   its `Location` URL. If you allowed the coordinator by its mDNS hostname (`Sonos-<MAC>.local`), requests go to that
   hostname instead, because Asyar only lets requests through to the address you allowed.
2. Everything else goes to the group's coordinator: `AVTransport` `GetTransportInfo` (play state, which also decides how
   play/pause toggles), `GetPositionInfo` (what plays), `GetCurrentTransportActions`, `Pause`/`Play`/`Next`/`Previous`,
   and `GroupRenderingControl` `GetGroupVolume`/`SetGroupVolume`. For a group of several rooms, `SnapshotGroupVolume` is
   sent when you start changing the volume, so each room keeps its share, as in the Sonos app. While you drag the slider,
   only the latest value is sent.

Speakers can push changes only to a server an extension cannot run, so the Control Center reads the groups again every 2
seconds while it is visible. If a paused group takes longer than 3 seconds to start (a stream on a slow connection), Next
and Previous leave it playing without skipping, because Sonos refuses a skip until it plays.

## Verification

- Unit tests cover request building and parsing (on answers recorded from a real speaker, with its address and ids
  replaced), the allowed-device list, how Asyar's refusals are told apart, group and coordinator choice, command logic,
  the Control Center's logic, HUD length and manifest consistency. The tests for the main behaviours were checked by
  breaking the line each one guards and seeing it fail.
- Checked against a real speaker (Sonos/95.1, from a terminal): the parser reads its answers. On a Spotify artist radio
  the speaker allows only `Set, Stop, Pause, Play, Next`, which is why Previous fails there.
- On a launcher built from the `network:lan` branch (`3dd67b8`), the previous version (a setup page and five commands)
  was reported working; which commands were tried was not recorded.
- Not yet verified: the Control Center (now playing, slider, keys, actions, Add Speaker and Allow) on a launcher built
  from `05916c0`; `SetGroupVolume`, play-then-skip and a speaker that is off against real speakers; the link-local
  refusal on a real launcher.
