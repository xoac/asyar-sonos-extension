import { describe, expect, it } from 'vitest';

import {
  HUD_MAX_CHARS,
  HUD_OUTCOME_TEXT,
  PLAY_CHECK_MS,
  PLAY_WAIT_MS,
  hudErrorText,
  runBackgroundCommand,
  setGroupVolume,
} from './commands';
import { DENIED, LIVING_KITCHEN, REFUSED_701, TWO_GROUPS, at, fakeSpeaker, noWait, ok, state } from './fakeSpeaker';
import { SonosError, type SonosErrorKind } from './speaker';

/** Kitchen and Living are allowed, Kitchen first, so commands must find their way to the coordinator. */
const prefs = { speakers: [at('10.0.0.6'), at('10.0.0.5')], room: '' };

const speaker = (answers: Parameters<typeof fakeSpeaker>[0]) =>
  fakeSpeaker({ GetZoneGroupState: ok(LIVING_KITCHEN), ...answers });

const actions = (calls: { action: string }[]) => calls.map((c) => c.action);

describe('runBackgroundCommand', () => {
  it('pauses a playing group, talking to the coordinator, not the first allowed member', async () => {
    const { fetch, calls } = speaker({ GetTransportInfo: state('PLAYING') });
    expect(await runBackgroundCommand('play-pause', { fetch, ...prefs })).toBe('Sonos: paused');
    // Both speakers are asked for the topology; transport goes to the coordinator only.
    expect(calls.filter((c) => c.action !== 'GetZoneGroupState').map((c) => `${c.action}@${c.host}`)).toEqual([
      'GetTransportInfo@10.0.0.5',
      'Pause@10.0.0.5',
    ]);
  });

  it('pauses a group that is about to play', async () => {
    const { fetch, calls } = speaker({ GetTransportInfo: state('TRANSITIONING') });
    expect(await runBackgroundCommand('play-pause', { fetch, ...prefs })).toBe('Sonos: paused');
    expect(calls.at(-1)?.action).toBe('Pause');
  });

  it('plays a paused group', async () => {
    const { fetch, calls } = speaker({ GetTransportInfo: state('PAUSED_PLAYBACK') });
    expect(await runBackgroundCommand('play-pause', { fetch, ...prefs })).toBe('Sonos: playing');
    expect(calls.at(-1)?.action).toBe('Play');
    expect(calls.at(-1)?.body).toContain('<Speed>1</Speed>');
  });

  it('explains a stopped group with nothing to play', async () => {
    const { fetch } = speaker({ GetTransportInfo: state('STOPPED'), Play: REFUSED_701 });
    expect(await runBackgroundCommand('play-pause', { fetch, ...prefs })).toBe('Sonos: nothing to play');
  });

  it('skips tracks forward and back on a playing group', async () => {
    const next = speaker({});
    expect(await runBackgroundCommand('next-track', { fetch: next.fetch, ...prefs })).toBe('Sonos: next track');
    expect(actions(next.calls).slice(-2)).toEqual(['GetTransportInfo', 'Next']);
    const previous = speaker({});
    expect(await runBackgroundCommand('previous-track', { fetch: previous.fetch, ...prefs })).toBe('Sonos: previous track');
    expect(actions(previous.calls).slice(-2)).toEqual(['GetTransportInfo', 'Previous']);
  });

  it('starts a paused group and skips once it plays', async () => {
    const waits: number[] = [];
    const { fetch, calls } = speaker({
      GetTransportInfo: [state('PAUSED_PLAYBACK'), state('TRANSITIONING'), state('PLAYING')],
    });
    const wait = async (ms: number) => {
      waits.push(ms);
    };
    expect(await runBackgroundCommand('next-track', { fetch, ...prefs }, wait)).toBe('Sonos: next track');
    expect(actions(calls).filter((a) => a !== 'GetZoneGroupState')).toEqual([
      'GetTransportInfo',
      'Play',
      'GetTransportInfo',
      'GetTransportInfo',
      'Next',
    ]);
    expect(waits).toEqual([PLAY_CHECK_MS, PLAY_CHECK_MS]);
  });

  it('leaves a group playing, without a skip Sonos would refuse, when it is slow to start', async () => {
    const { fetch, calls } = speaker({ GetTransportInfo: state('TRANSITIONING') });
    expect(await runBackgroundCommand('previous-track', { fetch, ...prefs }, noWait)).toBe('Sonos: playing');
    // The first check, then one every PLAY_CHECK_MS for PLAY_WAIT_MS.
    expect(actions(calls).filter((a) => a === 'GetTransportInfo')).toHaveLength(1 + PLAY_WAIT_MS / PLAY_CHECK_MS);
    expect(actions(calls)).not.toContain('Play'); // already starting
    expect(actions(calls)).not.toContain('Previous');
  });

  it('gives up a skip when there is nothing to play', async () => {
    const { fetch, calls } = speaker({ GetTransportInfo: state('STOPPED'), Play: REFUSED_701 });
    expect(await runBackgroundCommand('next-track', { fetch, ...prefs }, noWait)).toBe('Sonos: nothing to play');
    expect(calls.at(-1)?.action).toBe('Play');
  });

  it('reports a source that cannot be skipped, or not gone back on, instead of failing', async () => {
    const { fetch } = speaker({ Next: REFUSED_701, Previous: REFUSED_701 });
    expect(await runBackgroundCommand('next-track', { fetch, ...prefs })).toBe("Sonos: can't skip this");
    expect(await runBackgroundCommand('previous-track', { fetch, ...prefs })).toBe("Sonos: can't go back here");
  });

  it('controls the group of the chosen room', async () => {
    const { fetch, calls } = fakeSpeaker({ GetZoneGroupState: ok(TWO_GROUPS) });
    // Without the room, the group of the first allowed speaker (Kitchen, led by Living at 10.0.0.5) would be used.
    await runBackgroundCommand('next-track', { fetch, speakers: [at('10.0.0.6'), at('10.0.0.7')], room: ' office ' });
    expect(calls.at(-1)).toMatchObject({ action: 'Next', host: '10.0.0.7' });
  });

  it('classifies a coordinator the user has not allowed', async () => {
    const { fetch } = speaker({ 'Next@10.0.0.5': DENIED('10.0.0.5') });
    await expect(runBackgroundCommand('next-track', { fetch, ...prefs, speakers: [at('10.0.0.6')] })).rejects.toMatchObject({
      kind: 'refused',
      endpoint: at('10.0.0.5'),
    });
  });

  it('keeps the UPnP code of other speaker errors', async () => {
    const { fetch } = speaker({ GetTransportInfo: { status: 500, ok: false, body: '<errorCode>501</errorCode>' } });
    await expect(runBackgroundCommand('play-pause', { fetch, ...prefs })).rejects.toMatchObject({
      kind: 'upnp',
      upnpCode: 501,
    });
  });
});

describe('HUD text', () => {
  const kinds: SonosErrorKind[] = ['not-configured', 'refused', 'unsupported', 'unreachable', 'upnp'];

  it('points setup problems to the Control Center, and names the UPnP error code', () => {
    const setup = hudErrorText(new SonosError('not-configured', 'x'));
    expect(setup).toContain('Control Center');
    expect(hudErrorText(new SonosError('refused', 'x', { endpoint: at('10.0.0.6') }))).toBe(setup);
    expect(hudErrorText(new SonosError('upnp', 'x', { upnpCode: 714 }))).toContain('714');
  });

  it(`keeps every message within ${HUD_MAX_CHARS} characters`, () => {
    const messages = [
      ...Object.values(HUD_OUTCOME_TEXT),
      ...kinds.map((kind) => hudErrorText(new SonosError(kind, 'x'))),
      hudErrorText(new SonosError('upnp', 'x', { upnpCode: 99999 })),
      hudErrorText(new Error('a long technical message nobody can read in 1.5 s')),
    ];
    for (const message of messages) expect(message.length, message).toBeLessThanOrEqual(HUD_MAX_CHARS);
  });
});

describe('setGroupVolume', () => {
  it('sets the group volume on the coordinator, within 0-100', async () => {
    const { fetch, calls } = fakeSpeaker({});
    await setGroupVolume(fetch, at('10.0.0.5'), 140, false);
    expect(actions(calls)).toEqual(['SetGroupVolume']);
    expect(calls[0].url).toBe('http://10.0.0.5:1400/MediaRenderer/GroupRenderingControl/Control');
    expect(calls[0].body).toContain('<DesiredVolume>100</DesiredVolume>');
  });

  it('takes a volume snapshot first when asked', async () => {
    const { fetch, calls } = fakeSpeaker({});
    await setGroupVolume(fetch, at('10.0.0.5'), 35, true);
    expect(actions(calls)).toEqual(['SnapshotGroupVolume', 'SetGroupVolume']);
  });
});
