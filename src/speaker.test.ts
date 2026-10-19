import { describe, expect, it } from 'vitest';

import { DENIED, LIVING_KITCHEN, NO_ANSWER, TWO_GROUPS, at, fakeSpeaker, member, ok, topology } from './fakeSpeaker';
import { loadDevices, parseDeniedEndpoint, readTopology, requestDevice, soapCall } from './speaker';

describe('soapCall', () => {
  const failing = (answer: Error | { status: number; ok: false; body: string }) =>
    soapCall(fakeSpeaker({ GetTransportInfo: answer }).fetch, at('10.0.0.5'), 'AVTransport', 'GetTransportInfo');

  it('classifies what Asyar refuses, naming the refused endpoint', async () => {
    await expect(failing(DENIED('10.0.0.6'))).rejects.toMatchObject({ kind: 'refused', endpoint: at('10.0.0.6') });
    // A `.local` name that also resolves to a link-local IPv6 address (tmp/asyar `network/service.rs`).
    const linkLocal = new Error("Requests to loopback, link-local, or metadata address 'sonos-5caafd0a1b2c.local' are not allowed");
    await expect(failing(linkLocal)).rejects.toMatchObject({ kind: 'refused', endpoint: at('10.0.0.5') });
  });

  it('recognises a launcher without network:lan support', async () => {
    // Exact refusal of Asyar 0.1.1-51 (seen in its log).
    const old = new Error("fetch_url: Requests to private or loopback address '10.0.0.5' are not allowed");
    await expect(failing(old)).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it('treats other failures as an unreachable speaker, and HTTP errors as UPnP errors with their code', async () => {
    await expect(failing(new Error('operation timed out'))).rejects.toMatchObject({
      kind: 'unreachable',
      endpoint: at('10.0.0.5'),
    });
    await expect(failing({ status: 500, ok: false, body: '<errorCode>501</errorCode>' })).rejects.toMatchObject({
      kind: 'upnp',
      upnpCode: 501,
    });
  });

  it('reads host and port from the launcher refusal', () => {
    expect(parseDeniedEndpoint(DENIED('10.0.0.6').message)).toEqual(at('10.0.0.6'));
    expect(parseDeniedEndpoint('timeout')).toBeUndefined();
  });
});

describe('loadDevices', () => {
  it('keeps the Sonos port and sets other ports aside', async () => {
    const devices = await loadDevices(async () => [
      { host: '10.0.0.5', port: 1400, label: 'Linux UPnP/1.0 Sonos/97.2 (ZPS30)' },
      { host: '10.0.0.5', port: 42814, label: 'old scan' },
      { host: 'Sonos-ABC.local', port: 1400, label: 'Sonos-ABC.local' },
      { nonsense: true },
    ]);
    expect(devices).toEqual({
      speakers: [at('10.0.0.5'), at('Sonos-ABC.local')],
      wrongPort: [at('10.0.0.5', 42814)],
    });
  });

  it('recognises a launcher without listLanDevices', async () => {
    // An unknown method resolves to undefined, it does not throw.
    await expect(loadDevices(async () => undefined)).rejects.toMatchObject({ kind: 'unsupported' });
    await expect(
      loadDevices(async () => {
        throw new Error('boom');
      }),
    ).rejects.toMatchObject({ kind: 'unsupported' });
  });
});

describe('requestDevice', () => {
  it('returns the device the user allowed, or that they cancelled', async () => {
    expect(await requestDevice(async () => ({ host: '10.0.0.5', port: 1400, label: 'Living' }))).toEqual({
      status: 'allowed',
      device: { ...at('10.0.0.5'), label: 'Living' },
    });
    expect(await requestDevice(async () => null)).toEqual({ status: 'cancelled' });
  });

  it('recognises a launcher without the device dialogs', async () => {
    // An unknown method resolves to undefined, it does not throw.
    expect(await requestDevice(async () => undefined)).toEqual({ status: 'unsupported' });
  });

  it('ignores a second dialog while one is open, and reports other failures', async () => {
    const failing = (message: string) => async () => {
      throw new Error(message);
    };
    expect(await requestDevice(failing('LAN_PICKER_ALREADY_OPEN'))).toEqual({ status: 'cancelled' });
    expect(await requestDevice(failing('LAN_PICKER_REQUIRES_VIEW'))).toEqual({
      status: 'error',
      message: 'LAN_PICKER_REQUIRES_VIEW',
    });
  });
});

describe('readTopology', () => {
  it('finds the group of the chosen room and sends its commands to the coordinator', async () => {
    const { fetch } = fakeSpeaker({ GetZoneGroupState: ok(TWO_GROUPS) });
    const speakers = [at('10.0.0.6'), at('10.0.0.7')];
    expect(await readTopology(fetch, speakers, 'office')).toMatchObject({ coordinator: at('10.0.0.7') });
    // No room: the group of the first allowed speaker, Kitchen, led by Living.
    expect(await readTopology(fetch, speakers, undefined)).toMatchObject({ coordinator: at('10.0.0.5') });
  });

  it('sends commands to the hostname the user allowed for the coordinator', async () => {
    const mac = topology('<ZoneGroup Coordinator="RINCON_5CAAFD0A1B2C01400">' + member('RINCON_5CAAFD0A1B2C01400', '10.0.0.5', 'Living') + '</ZoneGroup>');
    const { fetch } = fakeSpeaker({ GetZoneGroupState: ok(mac) });
    const { coordinator } = await readTopology(fetch, [at('Sonos-5CAAFD0A1B2C.local')], undefined);
    expect(coordinator).toEqual(at('Sonos-5CAAFD0A1B2C.local'));
  });

  it('uses another allowed speaker when one is off, refused or failing', async () => {
    for (const answer of [new Error('operation timed out'), DENIED('10.0.0.6'), { status: 500, ok: false, body: '' }]) {
      const { fetch } = fakeSpeaker({ 'GetZoneGroupState@10.0.0.6': answer, GetZoneGroupState: ok(LIVING_KITCHEN) });
      expect(await readTopology(fetch, [at('10.0.0.6'), at('10.0.0.5')], undefined)).toMatchObject({
        speaker: at('10.0.0.5'),
        coordinator: at('10.0.0.5'),
      });
    }
  });

  it('does not wait for a speaker that never answers, and still follows the order of the allowed list', async () => {
    const { fetch } = fakeSpeaker({ 'GetZoneGroupState@10.0.0.7': NO_ANSWER, GetZoneGroupState: ok(TWO_GROUPS) });
    // Office is listed first: its group is controlled, although Living answered.
    expect(await readTopology(fetch, [at('10.0.0.7'), at('10.0.0.5')], undefined)).toMatchObject({
      speaker: at('10.0.0.5'),
      coordinator: at('10.0.0.7'),
    });
  });

  it('reports the failure of the first allowed speaker when none answers', async () => {
    const { fetch } = fakeSpeaker({ GetZoneGroupState: new Error('operation timed out') });
    await expect(readTopology(fetch, [at('10.0.0.6'), at('10.0.0.5')], undefined)).rejects.toMatchObject({
      kind: 'unreachable',
      endpoint: at('10.0.0.6'),
    });
  });

  it('fails clearly when no speaker is allowed, before any request', async () => {
    const { fetch, calls } = fakeSpeaker({});
    await expect(readTopology(fetch, [], undefined)).rejects.toMatchObject({ kind: 'not-configured' });
    expect(calls).toHaveLength(0);
  });

  it('uses the answering speaker when the topology cannot be parsed', async () => {
    const { fetch } = fakeSpeaker({ GetZoneGroupState: ok('<html/>') });
    expect(await readTopology(fetch, [at('10.0.0.6')], undefined)).toMatchObject({
      groups: [],
      coordinator: at('10.0.0.6'),
    });
  });
});
