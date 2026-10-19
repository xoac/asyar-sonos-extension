import { describe, expect, it, vi } from 'vitest';

import type { CommandOutcome } from './commands';
import {
  OTHER_KEY_LABELS,
  VOLUME_SETTLE_MS,
  canSkip,
  deviceRequestNote,
  errorNote,
  fixForPick,
  groupName,
  groupSubtitle,
  latestOnly,
  moveSelection,
  nowPlayingLine,
  outcomeNote,
  problemNotice,
  selectionAfterRefresh,
  stepVolume,
  volumeSender,
  withRecentVolumes,
  wrongPortHint,
  type RecentVolumes,
} from './controlCenter';
import type { GroupItem, Household } from './household';
import { SonosError } from './speaker';

const living: GroupItem = {
  id: 'RINCON_A',
  room: 'Living',
  rooms: ['Living', 'Kitchen'],
  coordinator: { host: '10.0.0.5', port: 1400 },
  multiRoom: true,
  playback: { state: 'PLAYING', nowPlaying: { title: 'Get Lucky', artist: 'Daft Punk' }, volume: 30 },
};

describe('problemNotice', () => {
  it('offers Add Speaker when nothing is allowed, and names the Settings page with the platform shortcut', () => {
    const mac = problemNotice({ status: 'no-devices', wrongPort: [] });
    expect(mac).toMatchObject({ tone: 'action', addSpeaker: true });
    expect(mac.lines).toHaveLength(2);
    expect(mac.lines.join(' ')).toContain('Settings (⌘,)');
    expect(problemNotice({ status: 'no-devices', wrongPort: [] }, OTHER_KEY_LABELS).lines.join(' ')).toContain(
      'Settings (Ctrl+,)',
    );
  });

  it('asks to remove allowed rows on other ports', () => {
    const notice = problemNotice({ status: 'no-devices', wrongPort: [{ host: '10.0.0.5', port: 42814 }] });
    expect(notice.lines).toHaveLength(3);
    expect(notice.lines[2]).toBe(wrongPortHint([{ host: '10.0.0.5', port: 42814 }]));
    expect(notice.lines[2]).toContain('10.0.0.5:42814');
    expect(wrongPortHint([])).toBeUndefined();
  });

  it('names the endpoint Asyar refused or that did not answer, and offers Add Speaker again', () => {
    const endpoint = { host: '10.0.0.5', port: 1400 };
    for (const problem of [{ status: 'refused', endpoint }, { status: 'unreachable', endpoint, message: 'timeout' }] as const) {
      const notice = problemNotice(problem);
      expect(notice).toMatchObject({ tone: 'error', addSpeaker: true });
      expect(notice.title).toContain('10.0.0.5:1400');
    }
  });

  it('offers no Add Speaker when it cannot help: an Asyar without LAN access, or a speaker error', () => {
    expect(problemNotice({ status: 'unsupported' })).toMatchObject({ tone: 'error', addSpeaker: false });
    expect(problemNotice({ status: 'error', message: 'boom' })).toMatchObject({ addSpeaker: false, lines: ['boom'] });
  });
});

describe('group rows', () => {
  it('names the rooms of a group', () => {
    expect(groupName(living)).toBe('Living + Kitchen');
    expect(groupName({ ...living, rooms: [] })).toBe('Your speaker');
  });

  it('says what a group plays, and when it is paused', () => {
    const line = (state: 'PLAYING' | 'PAUSED_PLAYBACK' | 'STOPPED', nowPlaying = living.playback!.nowPlaying) =>
      nowPlayingLine({ state, nowPlaying });
    expect(line('PLAYING')).toBe('Get Lucky — Daft Punk');
    expect(line('PAUSED_PLAYBACK')).toBe('Paused · Get Lucky — Daft Punk');
    expect(line('PLAYING', { title: 'Artist - Song' })).toBe('Artist - Song');
    expect(line('PLAYING', { input: 'TV' })).toBe('TV');
    expect(line('PLAYING', {})).toBe('Playing');
    expect(line('PAUSED_PLAYBACK', {})).toBe('Paused');
    expect(line('STOPPED', {})).toBe('Nothing playing');
  });

  it('says why a group cannot be controlled, naming its leader by room or address', () => {
    const { playback: _, ...idle } = living;
    expect(groupSubtitle(living)).toBe('Get Lucky — Daft Punk');
    expect(groupSubtitle({ ...idle, problem: 'needs-permission' })).toContain('Living');
    expect(groupSubtitle({ ...idle, room: '', problem: 'needs-permission' })).toContain('10.0.0.5:1400');
    expect(groupSubtitle({ ...idle, problem: 'refused' })).toContain('10.0.0.5:1400');
    expect(groupSubtitle({ ...idle, problem: 'unreachable' })).not.toBe(groupSubtitle({ ...idle, problem: 'error' }));
    expect(groupSubtitle(idle)).toBe('');
  });
});

describe('notes after an action', () => {
  it('stay quiet when the action did what was asked, or the user cancelled', () => {
    const done: CommandOutcome[] = ['paused', 'playing', 'next-track', 'previous-track'];
    for (const outcome of done) expect(outcomeNote(outcome)).toBeUndefined();
    for (const outcome of ['cant-skip', 'cant-go-back', 'nothing-to-play'] as const) expect(outcomeNote(outcome)).toBeTruthy();
    expect(deviceRequestNote({ status: 'cancelled' })).toBeUndefined();
    expect(deviceRequestNote({ status: 'allowed', device: { host: '10.0.0.5', port: 1400 } })).toBeUndefined();
  });

  it('explain device requests that allowed nothing, and failures', () => {
    expect(deviceRequestNote({ status: 'unsupported' }, OTHER_KEY_LABELS)).toContain('Settings (Ctrl+,)');
    expect(deviceRequestNote({ status: 'error', message: 'LAN_PICKER_BUSY' })).toContain('LAN_PICKER_BUSY');
    expect(errorNote(new SonosError('upnp', 'x', { upnpCode: 800 }))).toContain('800');
    expect(errorNote(new SonosError('unreachable', 'x'))).not.toBe(errorNote(new Error('x')));
  });
});

describe('skip buttons', () => {
  it('are off only when a playing group says the action is not allowed', () => {
    const radio = { state: 'PLAYING' as const, nowPlaying: {}, actions: ['Set', 'Stop', 'Pause', 'Play', 'Next'] };
    expect(canSkip(radio, 'Previous')).toBe(false);
    expect(canSkip(radio, 'Next')).toBe(true);
    // A skip starts a paused group first, and a speaker that did not say allows a try.
    expect(canSkip({ ...radio, state: 'PAUSED_PLAYBACK' }, 'Previous')).toBe(true);
    expect(canSkip({ state: 'PLAYING', nowPlaying: {} }, 'Previous')).toBe(true);
  });
});

describe('fixForPick', () => {
  it('accepts a speaker on the Sonos port', () => {
    expect(fixForPick({ host: '10.0.0.5', port: 1400, label: 'Sonos-5CAAFD0A1B2C.local' })).toBeUndefined();
  });

  it('offers port 1400 when another service of the speaker was picked', () => {
    const fix = fixForPick({ host: '10.0.0.5', port: 7000, label: 'Sonos-5CAAFD0A1B2C.local' });
    expect(fix?.message).toContain('10.0.0.5:7000');
    expect(fix?.retry).toEqual({ host: '10.0.0.5', port: 1400, label: 'Sonos-5CAAFD0A1B2C.local' });
  });

  it('explains that another device is not a speaker, without offering it again', () => {
    const fix = fixForPick({ host: '10.0.0.23', port: 7000, label: 'MacBook-Pro.local' });
    expect(fix?.message).toContain('MacBook-Pro.local');
    expect(fix?.retry).toBeUndefined();
  });
});

describe('keyboard and selection', () => {
  it('steps the volume by 5, or by 1 with Shift, within 0-100', () => {
    expect(stepVolume(30, 'ArrowRight', false)).toBe(35);
    expect(stepVolume(30, 'ArrowLeft', true)).toBe(29);
    expect(stepVolume(98, 'ArrowRight', false)).toBe(100);
    expect(stepVolume(2, 'ArrowLeft', false)).toBe(0);
  });

  it('moves the selection and stops at the ends', () => {
    const ids = ['a', 'b', 'c'];
    expect(moveSelection(ids, 'a', 1)).toBe('b');
    expect(moveSelection(ids, 'c', 1)).toBe('c');
    expect(moveSelection(ids, 'a', -1)).toBe('a');
    expect(moveSelection(ids, 'gone', 1)).toBe('a');
    expect(moveSelection(ids, undefined, -1)).toBe('a');
    expect(moveSelection([], undefined, 1)).toBeUndefined();
  });

  it('keeps the selection across a refresh, else selects the hotkey group, else the first', () => {
    const ids = ['a', 'b', 'c'];
    expect(selectionAfterRefresh(ids, 'c', 'b')).toBe('c');
    expect(selectionAfterRefresh(ids, 'gone', 'b')).toBe('b');
    expect(selectionAfterRefresh(ids, undefined, 'b')).toBe('b');
    expect(selectionAfterRefresh(ids, undefined, 'gone')).toBe('a');
    expect(selectionAfterRefresh([], 'a', 'b')).toBeUndefined();
  });
});

describe('volume changes', () => {
  it('sends only the latest value while a request runs', async () => {
    const sent: number[] = [];
    let finish: () => void = () => {};
    const send = latestOnly(
      (value: number) => {
        sent.push(value);
        return new Promise<void>((resolve) => (finish = resolve));
      },
      () => {},
    );
    const done = send(10);
    void send(20);
    void send(30);
    finish();
    await vi.waitFor(() => expect(sent).toEqual([10, 30]));
    finish();
    await done;
  });

  it('reports a failed request and keeps sending', async () => {
    const sent: number[] = [];
    const errors: unknown[] = [];
    const send = latestOnly(
      async (value: number) => {
        sent.push(value);
        if (value === 1) throw new Error('nope');
      },
      (err) => errors.push(err),
    );
    await send(1);
    await send(2);
    expect(sent).toEqual([1, 2]);
    expect(errors).toHaveLength(1);
  });

  it('takes a volume snapshot at the start of each burst, for groups of several rooms only', async () => {
    let now = 0;
    const calls: [number, boolean][] = [];
    const set = async (volume: number, snapshotFirst: boolean) => {
      calls.push([volume, snapshotFirst]);
    };
    const multi = volumeSender(set, { multiRoom: true }, () => {}, () => now);
    await multi(10);
    now += 100;
    await multi(12);
    now += VOLUME_SETTLE_MS + 1;
    await multi(14);
    expect(calls).toEqual([
      [10, true],
      [12, false],
      [14, true],
    ]);
    calls.length = 0;
    await volumeSender(set, { multiRoom: false }, () => {}, () => now)(20);
    expect(calls).toEqual([[20, false]]);
  });

  it('shows the volume the user just set instead of a lagging polled one', () => {
    const household: Household = { status: 'ok', groups: [living], wrongPort: [] };
    const recent: RecentVolumes = new Map([['RINCON_A', { volume: 55, at: 1000 }]]);
    const shown = (now: number) => {
      const result = withRecentVolumes(household, recent, now);
      return result.status === 'ok' ? result.groups[0].playback?.volume : undefined;
    };
    expect(shown(1000 + VOLUME_SETTLE_MS)).toBe(55);
    expect(shown(1001 + VOLUME_SETTLE_MS)).toBe(30);
    expect(withRecentVolumes({ status: 'unsupported' }, recent, 0)).toEqual({ status: 'unsupported' });
  });
});
