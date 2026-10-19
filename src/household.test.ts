import { describe, expect, it } from 'vitest';

import { DENIED, LIVING_KITCHEN, TWO_GROUPS, at, fakeSpeaker, ok } from './fakeSpeaker';
import { GROUP_VOLUME, POSITION_INFO, TRANSPORT_ACTIONS, TRANSPORT_INFO } from './fixtures';
import { loadHousehold } from './household';
import type { Endpoint } from './sonos';
import type { AllowedDevices, HttpResponse } from './speaker';

const allowed = (...speakers: Endpoint[]): AllowedDevices => ({ speakers, wrongPort: [] });

/** A coordinator playing the recorded Spotify artist radio track, at volume 32. */
const playing = {
  GetTransportInfo: ok(TRANSPORT_INFO),
  GetPositionInfo: ok(POSITION_INFO),
  GetGroupVolume: ok(GROUP_VOLUME),
  GetCurrentTransportActions: ok(TRANSPORT_ACTIONS),
};

describe('loadHousehold', () => {
  it('reports that nothing is allowed, with the rows on other ports, without any request', async () => {
    const { fetch, calls } = fakeSpeaker({});
    expect(await loadHousehold(fetch, { speakers: [], wrongPort: [at('10.0.0.6', 42814)] }, '')).toEqual({
      status: 'no-devices',
      wrongPort: [at('10.0.0.6', 42814)],
    });
    expect(calls).toHaveLength(0);
  });

  it('reads what each group plays and its volume from the coordinator, with read-only requests', async () => {
    const { fetch, calls } = fakeSpeaker({ GetZoneGroupState: ok(LIVING_KITCHEN), ...playing });
    expect(await loadHousehold(fetch, allowed(at('10.0.0.6'), at('10.0.0.5')), '')).toEqual({
      status: 'ok',
      groups: [
        {
          id: 'RINCON_A',
          room: 'Living',
          rooms: ['Living', 'Kitchen'],
          coordinator: at('10.0.0.5'),
          multiRoom: true,
          playback: {
            state: 'PLAYING',
            nowPlaying: { title: 'You Shook Me All Night Long', artist: 'AC/DC' },
            volume: 32,
            actions: ['Set', 'Stop', 'Pause', 'Play', 'Next'],
          },
        },
      ],
      hotkeyGroupId: 'RINCON_A',
      wrongPort: [],
    });
    expect(calls.map((c) => `${c.action}@${c.host}`).sort()).toEqual([
      'GetCurrentTransportActions@10.0.0.5',
      'GetGroupVolume@10.0.0.5',
      'GetPositionInfo@10.0.0.5',
      'GetTransportInfo@10.0.0.5',
      'GetZoneGroupState@10.0.0.5',
      'GetZoneGroupState@10.0.0.6',
    ]);
  });

  it('marks a group whose coordinator is not allowed, without asking it', async () => {
    const { fetch, calls } = fakeSpeaker({ GetZoneGroupState: ok(LIVING_KITCHEN) });
    const household = await loadHousehold(fetch, allowed(at('10.0.0.6')), '');
    expect(household).toMatchObject({ status: 'ok', groups: [{ room: 'Living', problem: 'needs-permission' }] });
    expect(household.status === 'ok' && household.groups[0]).not.toHaveProperty('playback');
    expect(calls.map((c) => c.action)).toEqual(['GetZoneGroupState']);
  });

  it('lists the groups it can control first, and marks the group the hotkeys control', async () => {
    const { fetch } = fakeSpeaker({ GetZoneGroupState: ok(TWO_GROUPS), ...playing });
    const household = await loadHousehold(fetch, allowed(at('10.0.0.7')), '');
    expect(household).toMatchObject({
      status: 'ok',
      groups: [
        { room: 'Office', rooms: ['Office'], multiRoom: false },
        { room: 'Living', problem: 'needs-permission' },
      ],
      hotkeyGroupId: 'RINCON_C', // no room set: the group of the first allowed speaker
    });
    expect(await loadHousehold(fetch, allowed(at('10.0.0.7')), 'kitchen')).toMatchObject({ hotkeyGroupId: 'RINCON_A' });
  });

  it('keeps the other groups when one coordinator is refused, silent or failing', async () => {
    const twoAllowed = allowed(at('10.0.0.5'), at('10.0.0.7'));
    const problem = async (answer: HttpResponse | Error) => {
      const { fetch } = fakeSpeaker({ GetZoneGroupState: ok(TWO_GROUPS), ...playing, 'GetTransportInfo@10.0.0.7': answer });
      const household = await loadHousehold(fetch, twoAllowed, '');
      if (household.status !== 'ok') throw new Error(household.status);
      expect(household.groups[0]).toMatchObject({ room: 'Living', playback: { state: 'PLAYING' } });
      return household.groups[1].problem;
    };
    expect(await problem(DENIED('10.0.0.7'))).toBe('refused');
    expect(await problem(new Error('operation timed out'))).toBe('unreachable');
    expect(await problem({ status: 500, ok: false, body: '<errorCode>501</errorCode>' })).toBe('error');
  });

  it('shows a group without its volume or actions when the speaker does not report them', async () => {
    const { fetch } = fakeSpeaker({
      GetZoneGroupState: ok(LIVING_KITCHEN),
      ...playing,
      GetGroupVolume: { status: 500, ok: false, body: '' },
      GetCurrentTransportActions: { status: 500, ok: false, body: '' },
    });
    const household = await loadHousehold(fetch, allowed(at('10.0.0.5')), '');
    expect(household).toMatchObject({ status: 'ok', groups: [{ playback: { state: 'PLAYING' } }] });
    const playback = household.status === 'ok' && household.groups[0].playback;
    expect(playback).not.toHaveProperty('volume');
    expect(playback).not.toHaveProperty('actions');
  });

  it('controls the answering speaker when the topology cannot be read', async () => {
    const { fetch } = fakeSpeaker({ GetZoneGroupState: ok('<html/>'), ...playing });
    expect(await loadHousehold(fetch, allowed(at('10.0.0.6')), '')).toMatchObject({
      status: 'ok',
      groups: [{ id: '10.0.0.6:1400', room: '', rooms: [], coordinator: at('10.0.0.6'), playback: { volume: 32 } }],
      hotkeyGroupId: '10.0.0.6:1400',
    });
  });

  it('reports an allowed address the launcher still refuses', async () => {
    const { fetch } = fakeSpeaker({ GetZoneGroupState: DENIED('sonos-5caafd0a1b2c.local') });
    expect(await loadHousehold(fetch, allowed(at('Sonos-5CAAFD0A1B2C.local')), '')).toEqual({
      status: 'refused',
      endpoint: at('sonos-5caafd0a1b2c.local'),
    });
  });

  it('recognises a launcher without network:lan support', async () => {
    const old = new Error("fetch_url: Requests to private or loopback address '10.0.0.6' are not allowed");
    const { fetch } = fakeSpeaker({ GetZoneGroupState: old });
    expect(await loadHousehold(fetch, allowed(at('10.0.0.6')), '')).toEqual({ status: 'unsupported' });
  });

  it('reports an unreachable speaker', async () => {
    const { fetch } = fakeSpeaker({ GetZoneGroupState: new Error('connection timed out') });
    expect(await loadHousehold(fetch, allowed(at('10.0.0.6')), '')).toMatchObject({
      status: 'unreachable',
      endpoint: at('10.0.0.6'),
    });
  });

  it('reports other speaker errors as errors', async () => {
    const { fetch } = fakeSpeaker({ GetZoneGroupState: { status: 500, ok: false, body: '<errorCode>501</errorCode>' } });
    expect(await loadHousehold(fetch, allowed(at('10.0.0.6')), '')).toMatchObject({ status: 'error' });
  });
});
