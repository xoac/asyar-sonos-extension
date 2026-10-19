// Logic of the Control Center view that needs no DOM: its texts, key handling, selection and volume sending. Pure, so
// it is unit-tested and ControlCenter.svelte only renders and wires it.
import type { CommandOutcome } from './commands';
import type { GroupItem, GroupPlayback, Household } from './household';
import { SONOS_PORT, clampVolume, formatEndpoint, isPlayingState, type Endpoint } from './sonos';
import { SonosError, type DeviceRequestResult } from './speaker';

/**
 * Key names for the hints. There is no API for an extension to open its Settings page (the launcher's
 * `showSettingsWindow` is internal), so texts name `Mod+,`, which opens Settings (tmp/asyar `launcherKeyboard.ts`).
 * `previous` and `next` are the shortcuts of this view's track actions.
 */
export interface KeyLabels {
  settings: string;
  previous: string;
  next: string;
}

export const MAC_KEY_LABELS: KeyLabels = { settings: '⌘,', previous: '⌘[', next: '⌘]' };
export const OTHER_KEY_LABELS: KeyLabels = { settings: 'Ctrl+,', previous: 'Ctrl+[', next: 'Ctrl+]' };

/** Action shortcuts, in the launcher's `Mod+Key` format (`docs/reference/actions.md`). */
export const PREVIOUS_SHORTCUT = 'Mod+[';
export const NEXT_SHORTCUT = 'Mod+]';

export type HouseholdProblem = Exclude<Household, { status: 'ok' }>;

/** What the view shows instead of the groups when there is nothing to control. */
export interface Notice {
  tone: 'action' | 'error';
  title: string;
  lines: string[];
  /** Offer the Add Speaker button, which opens Asyar's device picker. */
  addSpeaker: boolean;
}

/** The page where allowed devices are listed and removed; extensions cannot remove one themselves. */
const settingsPath = (keys: KeyLabels) =>
  `Asyar Settings (${keys.settings}) → Extensions → Control Sonos → Local network devices`;

export function wrongPortHint(wrongPort: Endpoint[], keys: KeyLabels = MAC_KEY_LABELS): string | undefined {
  if (wrongPort.length === 0) return undefined;
  return `Remove ${wrongPort.map(formatEndpoint).join(', ')} in ${settingsPath(keys)}: Sonos speakers answer only on port 1400.`;
}

/**
 * Shown in Asyar's device picker, under its title. The picker lists every device it finds, and a Sonos speaker also
 * offers other services there (AirPlay on :7000), so the text names the row to choose.
 */
export const PICKER_REASON =
  'Choose your speaker in the row marked SONOS (or ZonePlayer), on port 1400. Control Sonos can then reach that speaker and nothing else.';

/** What to do after the picker allowed a device that is not a Sonos speaker on port 1400. */
export interface PickFix {
  message: string;
  /** The same speaker on the Sonos port, to request instead. */
  retry?: Endpoint & { label?: string };
}

/** Nothing for a Sonos speaker on port 1400, else a note and, for another service of a speaker, its Sonos port. */
export function fixForPick(device: Endpoint & { label?: string }): PickFix | undefined {
  if (device.port === SONOS_PORT) return undefined;
  const name = device.label || device.host;
  if (/sonos/i.test(name)) {
    return {
      message: `${formatEndpoint(device)} is another service of ${name}. Allow its Sonos port, 1400, in the next dialog.`,
      retry: { host: device.host, port: SONOS_PORT, ...(device.label && { label: device.label }) },
    };
  }
  return { message: `${name} is not a Sonos speaker. Press Add Speaker again and choose the row marked SONOS, on port 1400.` };
}

export function problemNotice(problem: HouseholdProblem, keys: KeyLabels = MAC_KEY_LABELS): Notice {
  switch (problem.status) {
    case 'no-devices': {
      const hint = wrongPortHint(problem.wrongPort, keys);
      return {
        tone: 'action',
        title: 'Add your Sonos speaker',
        lines: [
          'Press Add Speaker and pick your speaker from the list Asyar finds. One speaker is enough to see all your groups; this page then asks for the speakers that lead the others.',
          `Not listed? Choose Manual IP & port in the same dialog: the speaker IP (Sonos app: Settings → System → About My System, or your router's list of devices) and port 1400. Allowed speakers are listed in ${settingsPath(keys)}.`,
          ...(hint ? [hint] : []),
        ],
        addSpeaker: true,
      };
    }
    case 'refused':
      return {
        tone: 'error',
        title: `Asyar refused ${formatEndpoint(problem.endpoint)}`,
        lines: [
          'It is on the list of allowed devices, but Asyar did not let the request through.',
          `Remove it in ${settingsPath(keys)}, then add the speaker again with Add Speaker.`,
        ],
        addSpeaker: true,
      };
    case 'unsupported':
      return {
        tone: 'error',
        title: "This Asyar version can't reach local devices",
        lines: [
          'It cannot list the devices you allow or talk to your local network, so it cannot control a Sonos speaker.',
          'Control Sonos needs an Asyar version with local network access (the network:lan permission). Quit this Asyar and start such a version.',
        ],
        addSpeaker: false,
      };
    case 'unreachable':
      return {
        tone: 'error',
        title: `No answer from ${formatEndpoint(problem.endpoint)}`,
        lines: [
          `Check that the speaker is on and that this computer is on the same network. If its IP address changed, add it again with Add Speaker and remove the old entry in ${settingsPath(keys)}.`,
        ],
        addSpeaker: true,
      };
    case 'error':
      return { tone: 'error', title: 'The speaker answered with an error', lines: [problem.message], addSpeaker: false };
  }
}

/** Below the groups when some are dimmed. */
export const ALLOW_HINT =
  'A dimmed group is led by a speaker Control Sonos may not reach yet: press Allow on it. Commands for a group go to the speaker that leads it.';

/** A note after a device request that did not allow anything; nothing to say when the user cancelled. */
export function deviceRequestNote(result: DeviceRequestResult, keys: KeyLabels = MAC_KEY_LABELS): string | undefined {
  switch (result.status) {
    case 'unsupported':
      return `This Asyar build cannot ask for devices: allow the speaker in ${settingsPath(keys)}.`;
    case 'error':
      return `Asyar could not add the speaker: ${result.message}`;
  }
  return undefined;
}

export function groupName(group: GroupItem): string {
  return group.rooms.join(' + ') || 'Your speaker';
}

export function nowPlayingLine(playback: GroupPlayback): string {
  const { state, nowPlaying } = playback;
  const { title, artist, input } = nowPlaying;
  const playing = isPlayingState(state);
  const what = input ?? (title && artist ? `${title} — ${artist}` : title);
  if (!what) return playing ? 'Playing' : state === 'PAUSED_PLAYBACK' ? 'Paused' : 'Nothing playing';
  return playing ? what : `Paused · ${what}`;
}

/** The second line of a group row: what it plays, or why it cannot be controlled. */
export function groupSubtitle(group: GroupItem): string {
  switch (group.problem) {
    case 'needs-permission':
      return `Not allowed yet: led by ${group.room || formatEndpoint(group.coordinator)}`;
    case 'refused':
      return `Asyar refused ${formatEndpoint(group.coordinator)}: remove it in Settings and allow it again`;
    case 'unreachable':
      return 'No answer: is the speaker on?';
    case 'error':
      return 'The speaker answered with an error';
  }
  return group.playback ? nowPlayingLine(group.playback) : '';
}

/** A short note after a command that did not do what was asked; the row itself shows the new state otherwise. */
export function outcomeNote(outcome: CommandOutcome): string | undefined {
  switch (outcome) {
    case 'cant-skip':
      return "Sonos doesn't allow skipping this source";
    case 'cant-go-back':
      return "Sonos doesn't allow going back here, for example on a radio station";
    case 'nothing-to-play':
      return 'Nothing to play: choose music in the Sonos app';
  }
  return undefined;
}

/**
 * Whether the skip button for `action` can work now. A playing group says what it allows; a paused one is started
 * first by a skip, so it counts as allowed.
 */
export function canSkip(playback: GroupPlayback, action: 'Next' | 'Previous'): boolean {
  return playback.state !== 'PLAYING' || !playback.actions || playback.actions.includes(action);
}

export function errorNote(err: unknown): string {
  if (!(err instanceof SonosError)) return 'Something went wrong';
  switch (err.kind) {
    case 'not-configured':
    case 'refused':
      return 'Asyar refused the speaker';
    case 'unsupported':
      return "This Asyar version can't reach local devices";
    case 'unreachable':
      return 'The speaker did not answer';
    case 'upnp':
      return err.upnpCode ? `The speaker refused it (error ${err.upnpCode})` : 'The speaker refused it';
  }
}

const VOLUME_STEP = 5;

/** Volume after ← or →; Shift changes it by 1. */
export function stepVolume(volume: number, key: 'ArrowLeft' | 'ArrowRight', fine: boolean): number {
  const step = fine ? 1 : VOLUME_STEP;
  return clampVolume(volume + (key === 'ArrowRight' ? step : -step));
}

/** The row selected after ↑ (-1) or ↓ (+1), stopping at the ends; the first row when nothing valid is selected. */
export function moveSelection(ids: string[], current: string | undefined, delta: 1 | -1): string | undefined {
  const index = current === undefined ? -1 : ids.indexOf(current);
  if (index === -1) return ids[0];
  return ids[Math.min(ids.length - 1, Math.max(0, index + delta))];
}

/** The row selected after the groups were read again: the same one if still there, else `preferred`, else the first. */
export function selectionAfterRefresh(
  ids: string[],
  selected: string | undefined,
  preferred: string | undefined,
): string | undefined {
  if (selected !== undefined && ids.includes(selected)) return selected;
  return preferred !== undefined && ids.includes(preferred) ? preferred : ids[0];
}

/**
 * Wraps `send` so only the latest value goes out: while a request runs, newer values replace each other and the last
 * one is sent when it finishes. A dragged slider fires many input events a second; the speaker needs where it stops.
 */
export function latestOnly<T>(send: (value: T) => Promise<void>, onError: (err: unknown) => void): (value: T) => Promise<void> {
  let pending: { value: T } | undefined;
  let running: Promise<void> | undefined;
  return (value) => {
    pending = { value };
    running ??= (async () => {
      while (pending) {
        const next = pending.value;
        pending = undefined;
        try {
          await send(next);
        } catch (err) {
          onError(err);
        }
      }
      running = undefined;
    })();
    return running;
  };
}

/**
 * How long after the user last changed a group's volume a polled value is ignored (the speaker may not have caught
 * up), and after which the next change starts a new volume snapshot.
 */
export const VOLUME_SETTLE_MS = 2000;

/** Volume changes for one group: latest value only, with a snapshot at the start of each burst of changes. */
export function volumeSender(
  set: (volume: number, snapshotFirst: boolean) => Promise<void>,
  group: { multiRoom: boolean },
  onError: (err: unknown) => void,
  now: () => number = Date.now,
): (volume: number) => Promise<void> {
  let lastSent = -Infinity;
  return latestOnly(async (volume: number) => {
    const at = now();
    const snapshotFirst = group.multiRoom && at - lastSent > VOLUME_SETTLE_MS;
    lastSent = at;
    await set(volume, snapshotFirst);
  }, onError);
}

/** Volumes the user set recently, by group id, with when they were set. */
export type RecentVolumes = Map<string, { volume: number; at: number }>;

/** Shows the user's own recent volume instead of a polled one that may lag behind. */
export function withRecentVolumes(household: Household, recent: RecentVolumes, now: number): Household {
  if (household.status !== 'ok') return household;
  const groups = household.groups.map((group) => {
    const mine = recent.get(group.id);
    if (!group.playback || !mine || now - mine.at > VOLUME_SETTLE_MS) return group;
    return { ...group, playback: { ...group.playback, volume: mine.volume } };
  });
  return { ...household, groups };
}
