// Transport and volume actions on a group coordinator, shared by the Control Center, and the background commands that
// run them for hotkeys and report the result as a HUD. No SDK imports: `fetch` is injected.
import {
  INSTANCE_ARGS,
  clampVolume,
  isPlayingState,
  parseTransportState,
  type Endpoint,
  type TransportState,
} from './sonos';
import { SonosError, parseRoomPreference, readTopology, soapCall, type Fetch } from './speaker';

/** Background commands handled by the worker, meant for hotkeys. They control the group of `ROOM_PREFERENCE`. */
export const COMMAND_IDS = ['play-pause', 'next-track', 'previous-track'] as const;

export type CommandId = (typeof COMMAND_IDS)[number];

export function isCommandId(value: string): value is CommandId {
  return (COMMAND_IDS as readonly string[]).includes(value);
}

/** The view command: controls every group, and is where the user allows speakers. */
export const CONTROL_CENTER_COMMAND_ID = 'control-center';
/** The manifest `component` of that command, part of its view path. */
export const CONTROL_CENTER_COMPONENT = 'ControlCenter';

/** The preference naming the room whose group the background commands control; the Control Center sets it. */
export const ROOM_PREFERENCE = 'room';

/** UPnP error 701: the action is not available now, e.g. skipping a radio stream. */
const TRANSITION_NOT_AVAILABLE = 701;

function isTransitionNotAvailable(err: unknown): boolean {
  return err instanceof SonosError && err.upnpCode === TRANSITION_NOT_AVAILABLE;
}

/** What a transport command did. */
export type CommandOutcome =
  | 'paused'
  | 'playing'
  | 'nothing-to-play'
  | 'next-track'
  | 'previous-track'
  | 'cant-skip'
  | 'cant-go-back';

export const HUD_OUTCOME_TEXT: Record<CommandOutcome, string> = {
  paused: 'Sonos: paused',
  playing: 'Sonos: playing',
  'nothing-to-play': 'Sonos: nothing to play',
  'next-track': 'Sonos: next track',
  'previous-track': 'Sonos: previous track',
  'cant-skip': "Sonos: can't skip this",
  'cant-go-back': "Sonos: can't go back here",
};

export type Sleep = (ms: number) => Promise<void>;

export const sleep: Sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** How long a skip waits for a group it started to play, checking every `PLAY_CHECK_MS`. */
export const PLAY_WAIT_MS = 3000;
export const PLAY_CHECK_MS = 200;

async function transportState(fetch: Fetch, coordinator: Endpoint): Promise<TransportState> {
  return parseTransportState(await soapCall(fetch, coordinator, 'AVTransport', 'GetTransportInfo', INSTANCE_ARGS));
}

/** Plays; false when there is nothing to play (a stopped group with nothing queued refuses Play with 701). */
async function tryPlay(fetch: Fetch, coordinator: Endpoint): Promise<boolean> {
  try {
    await soapCall(fetch, coordinator, 'AVTransport', 'Play', { ...INSTANCE_ARGS, Speed: 1 });
    return true;
  } catch (err) {
    if (isTransitionNotAvailable(err)) return false;
    throw err;
  }
}

/** Whether the group reaches `PLAYING` within `PLAY_WAIT_MS`. */
async function waitUntilPlaying(fetch: Fetch, coordinator: Endpoint, wait: Sleep): Promise<boolean> {
  for (let waited = 0; waited < PLAY_WAIT_MS; waited += PLAY_CHECK_MS) {
    await wait(PLAY_CHECK_MS);
    if ((await transportState(fetch, coordinator)) === 'PLAYING') return true;
  }
  return false;
}

/**
 * Skips forward or back. A paused group plays first, because the user asked for music and Sonos refuses skipping on a
 * paused station. Sonos also refuses a skip while the group is still `TRANSITIONING`, so the skip waits until it plays;
 * a group that is slower than that (a stream on a slow connection) is left playing. Sonos never allows going back on a
 * radio station, such as a Spotify artist radio (`GetCurrentTransportActions` then lists no `Previous`).
 */
async function skip(fetch: Fetch, coordinator: Endpoint, action: 'Next' | 'Previous', wait: Sleep): Promise<CommandOutcome> {
  const state = await transportState(fetch, coordinator);
  if (!isPlayingState(state) && !(await tryPlay(fetch, coordinator))) return 'nothing-to-play';
  if (state !== 'PLAYING' && !(await waitUntilPlaying(fetch, coordinator, wait))) return 'playing';
  try {
    await soapCall(fetch, coordinator, 'AVTransport', action, INSTANCE_ARGS);
    return action === 'Next' ? 'next-track' : 'previous-track';
  } catch (err) {
    if (isTransitionNotAvailable(err)) return action === 'Next' ? 'cant-skip' : 'cant-go-back';
    throw err;
  }
}

/** Runs one transport command on the group `coordinator` leads. Throws `SonosError` on failure. */
export async function runTransportCommand(
  fetch: Fetch,
  coordinator: Endpoint,
  commandId: CommandId,
  wait: Sleep = sleep,
): Promise<CommandOutcome> {
  switch (commandId) {
    case 'play-pause':
      if (isPlayingState(await transportState(fetch, coordinator))) {
        await soapCall(fetch, coordinator, 'AVTransport', 'Pause', INSTANCE_ARGS);
        return 'paused';
      }
      return (await tryPlay(fetch, coordinator)) ? 'playing' : 'nothing-to-play';
    case 'next-track':
      return skip(fetch, coordinator, 'Next', wait);
    case 'previous-track':
      return skip(fetch, coordinator, 'Previous', wait);
  }
}

export interface CommandContext {
  fetch: Fetch;
  /** Allowed speakers, from `loadDevices`. */
  speakers: Endpoint[];
  /** Raw value of `ROOM_PREFERENCE`. */
  room: unknown;
}

/** Runs one background command and returns the message to show as a HUD. Throws `SonosError` on failure. */
export async function runBackgroundCommand(commandId: CommandId, ctx: CommandContext, wait: Sleep = sleep): Promise<string> {
  const { coordinator } = await readTopology(ctx.fetch, ctx.speakers, parseRoomPreference(ctx.room));
  return HUD_OUTCOME_TEXT[await runTransportCommand(ctx.fetch, coordinator, commandId, wait)];
}

/**
 * Sets the volume of the group `coordinator` leads. Sonos changes each room in proportion to the group's last volume
 * snapshot, so a group of several rooms takes a fresh one when the user starts changing it (`snapshotFirst`), as the
 * Sonos app does.
 */
export async function setGroupVolume(
  fetch: Fetch,
  coordinator: Endpoint,
  volume: number,
  snapshotFirst: boolean,
): Promise<void> {
  if (snapshotFirst) await soapCall(fetch, coordinator, 'GroupRenderingControl', 'SnapshotGroupVolume', INSTANCE_ARGS);
  await soapCall(fetch, coordinator, 'GroupRenderingControl', 'SetGroupVolume', {
    ...INSTANCE_ARGS,
    DesiredVolume: clampVolume(volume),
  });
}

/**
 * The HUD is a fixed 360×80 px window shown for 1.5 s (tmp/asyar `hud_window/service.rs`), so every message is kept to
 * this many characters; details go to the log.
 */
export const HUD_MAX_CHARS = 32;

/**
 * HUD text for a failure. The launcher is hidden by then and a background command cannot open a view, so setup
 * problems point to the Control Center by name.
 */
export function hudErrorText(err: unknown): string {
  if (!(err instanceof SonosError)) return 'Sonos: something went wrong';
  switch (err.kind) {
    case 'not-configured':
    case 'refused':
      return 'Sonos: open Control Center';
    case 'unsupported':
      return 'Sonos: needs a newer Asyar';
    case 'unreachable':
      return 'Sonos: speaker not reachable';
    case 'upnp':
      return err.upnpCode ? `Sonos: speaker error ${err.upnpCode}` : 'Sonos: speaker refused request';
  }
}
