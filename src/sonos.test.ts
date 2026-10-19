import { describe, expect, it } from 'vitest';

import { GROUP_VOLUME, POSITION_INFO, TRANSPORT_ACTIONS, TRANSPORT_INFO, ZONE_GROUP_STATE } from './fixtures';
import {
  buildRequest,
  clampVolume,
  endpointFor,
  endpointFromLocation,
  escapeXml,
  extractTag,
  findGroup,
  isMemberHost,
  isPlayingState,
  parseGroupVolume,
  parseNowPlaying,
  parseTransportActions,
  parseTransportState,
  parseUpnpErrorCode,
  parseZoneGroupState,
  roomNames,
  soapAction,
  soapEnvelope,
  unescapeXml,
  type ZoneGroup,
} from './sonos';

/** A `GetZoneGroupState` answer around `inner`, escaped as a speaker does. */
function topologyResponse(inner: string): string {
  return (
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
    '<u:GetZoneGroupStateResponse xmlns:u="urn:schemas-upnp-org:service:ZoneGroupTopology:1">' +
    `<ZoneGroupState>${escapeXml(inner)}</ZoneGroupState>` +
    '</u:GetZoneGroupStateResponse></s:Body></s:Envelope>'
  );
}

const TOPOLOGY = topologyResponse(
  '<ZoneGroups>' +
    '<ZoneGroup Coordinator="RINCON_AAA01400" ID="RINCON_AAA01400:1">' +
    '<ZoneGroupMember UUID="RINCON_AAA01400" Location="http://192.168.1.20:1400/xml/device_description.xml" ZoneName="Living &amp; Dining"/>' +
    '<ZoneGroupMember UUID="RINCON_BBB01400" Location="http://192.168.1.21:1400/xml/device_description.xml" ZoneName="Kitchen"/>' +
    '</ZoneGroup>' +
    '<ZoneGroup Coordinator="RINCON_CCC01400" ID="RINCON_CCC01400:2">' +
    '<ZoneGroupMember UUID="RINCON_CCC01400" Location="http://192.168.1.30:1400/xml/device_description.xml" ZoneName="Office"/>' +
    '</ZoneGroup>' +
    '</ZoneGroups>',
);

describe('xml helpers', () => {
  it('escapes the five XML characters, and decodes them back with &amp; last', () => {
    const raw = `a & b < c > "d" 'e'`;
    expect(escapeXml(raw)).toBe('a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos;');
    expect(unescapeXml(escapeXml(raw))).toBe(raw);
    expect(unescapeXml('&amp;lt;')).toBe('&lt;');
  });

  it('decodes decimal and hex character references, and leaves impossible ones as text', () => {
    expect(unescapeXml('Beyonc&#233; &#x2014; Halo&#X21;')).toBe('Beyoncé — Halo!');
    expect(unescapeXml('&#99999999; &#x110000;')).toBe('&#99999999; &#x110000;');
    expect(unescapeXml('&amp;#39;')).toBe('&#39;');
  });

  it('extracts tag text and ignores attributes', () => {
    expect(extractTag('<a><Foo x="1">hi &amp; bye</Foo></a>', 'Foo')).toBe('hi & bye');
    expect(extractTag('<a/>', 'Foo')).toBeUndefined();
  });
});

describe('SOAP request building', () => {
  it('quotes the SOAPACTION header', () => {
    expect(soapAction('AVTransport', 'Play')).toBe('"urn:schemas-upnp-org:service:AVTransport:1#Play"');
  });

  it('builds an envelope with escaped arguments', () => {
    const xml = soapEnvelope('AVTransport', 'Play', { InstanceID: 0, Speed: '1<' });
    expect(xml).toContain('<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">');
    expect(xml).toContain('<InstanceID>0</InstanceID><Speed>1&lt;</Speed>');
    expect(xml).toContain('</u:Play>');
  });

  it('targets the control endpoint of the given host and port, with a timeout', () => {
    const req = buildRequest({ host: '192.168.1.20', port: 1400 }, 'GroupRenderingControl', 'SetGroupVolume', {
      InstanceID: 0,
      DesiredVolume: 35,
    });
    expect(req.url).toBe('http://192.168.1.20:1400/MediaRenderer/GroupRenderingControl/Control');
    expect(buildRequest({ host: '10.0.0.9', port: 1401 }, 'AVTransport', 'Play').url).toBe(
      'http://10.0.0.9:1401/MediaRenderer/AVTransport/Control',
    );
    expect(req.options.method).toBe('POST');
    expect(req.options.headers['Content-Type']).toBe('text/xml; charset="utf-8"');
    expect(req.options.body).toContain('<DesiredVolume>35</DesiredVolume>');
    // Without a timeout, a speaker that is off would hold the command forever.
    expect(req.options.timeout).toBeGreaterThan(0);
  });
});

describe('response parsing', () => {
  it('reads the transport state and decides what toggling does', () => {
    const state = (s: string) => `<u:R><CurrentTransportState>${s}</CurrentTransportState></u:R>`;
    expect(parseTransportState(TRANSPORT_INFO)).toBe('PLAYING');
    expect(parseTransportState(state('PAUSED_PLAYBACK'))).toBe('PAUSED_PLAYBACK');
    expect(parseTransportState(state('weird'))).toBe('UNKNOWN');
    expect(parseTransportState('')).toBe('UNKNOWN');
    expect(isPlayingState('PLAYING')).toBe(true);
    expect(isPlayingState('TRANSITIONING')).toBe(true);
    expect(isPlayingState('STOPPED')).toBe(false);
    expect(isPlayingState('UNKNOWN')).toBe(false);
  });

  it('reads the group volume, within 0-100, and UPnP error codes', () => {
    expect(parseGroupVolume(GROUP_VOLUME)).toBe(32);
    expect(parseGroupVolume('<CurrentVolume>250</CurrentVolume>')).toBe(100);
    expect(parseGroupVolume('<CurrentVolume>x</CurrentVolume>')).toBeUndefined();
    expect(parseGroupVolume('')).toBeUndefined();
    expect(clampVolume(-3)).toBe(0);
    expect(clampVolume(41.6)).toBe(42);
    expect(parseUpnpErrorCode('<UPnPError><errorCode>701</errorCode></UPnPError>')).toBe(701);
    expect(parseUpnpErrorCode('<html/>')).toBeUndefined();
  });

  it('lists the actions a group allows now', () => {
    expect(parseTransportActions(TRANSPORT_ACTIONS)).toEqual(['Set', 'Stop', 'Pause', 'Play', 'Next']);
    expect(parseTransportActions('<Actions></Actions>')).toEqual([]);
    expect(parseTransportActions('<html/>')).toBeUndefined();
  });
});

describe('now playing', () => {
  /** A `GetPositionInfo` answer: the DIDL-Lite metadata is entity-escaped text. */
  const position = (uri: string, item: string) =>
    `<TrackURI>${escapeXml(uri)}</TrackURI><TrackMetaData>${escapeXml(
      '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/">' +
        `<item id="-1" parentID="-1">${item}</item></DIDL-Lite>`,
    )}</TrackMetaData>`;

  it('reads title and artist of the track a speaker plays', () => {
    expect(parseNowPlaying(POSITION_INFO)).toEqual({ title: 'You Shook Me All Night Long', artist: 'AC/DC' });
  });

  it('decodes entities in the inner document and keeps titles that only look like URIs', () => {
    const xml = position(
      'x-sonos-spotify:spotify%3atrack%3a1?sid=9',
      '<r:streamContent></r:streamContent><dc:title>Re:Stacks</dc:title><dc:creator>Simon &amp; Garfunkel</dc:creator>',
    );
    expect(parseNowPlaying(xml)).toEqual({ title: 'Re:Stacks', artist: 'Simon & Garfunkel' });
  });

  it('reads the current song of a radio stream and skips placeholders and URIs', () => {
    const radio = (stream: string) =>
      position('x-rincon-mp3radio://example.com/live', `<r:streamContent>${stream}</r:streamContent><dc:title>x-sonosapi-stream:s1?sid=254</dc:title>`);
    expect(parseNowPlaying(radio('Artist - Song'))).toEqual({ title: 'Artist - Song' });
    expect(parseNowPlaying(radio('ZPSTR_CONNECTING'))).toEqual({});
  });

  it('names the TV and line-in inputs', () => {
    expect(parseNowPlaying(position('x-sonos-htastream:RINCON_A01400:spdif', ''))).toEqual({ input: 'TV' });
    expect(parseNowPlaying(position('x-rincon-stream:RINCON_A01400', ''))).toEqual({ input: 'Line-in' });
  });

  it('returns nothing for an empty queue', () => {
    expect(parseNowPlaying('<TrackURI></TrackURI><TrackMetaData>NOT_IMPLEMENTED</TrackMetaData>')).toEqual({});
    expect(parseNowPlaying('')).toEqual({});
  });
});

describe('zone group topology', () => {
  it('parses the answer of a real speaker: an inner ZoneGroupState wrapper and many extra attributes', () => {
    expect(parseZoneGroupState(ZONE_GROUP_STATE)).toEqual([
      {
        coordinatorUuid: 'RINCON_5CAAFD0A1B2C01400',
        members: [{ uuid: 'RINCON_5CAAFD0A1B2C01400', host: '192.168.1.20', port: 1400, name: 'Living Room' }],
      },
    ]);
  });

  it('parses several groups and decodes names', () => {
    const groups = parseZoneGroupState(TOPOLOGY);
    expect(groups.map((g) => g.coordinatorUuid)).toEqual(['RINCON_AAA01400', 'RINCON_CCC01400']);
    expect(groups[0].members.map((m) => m.host)).toEqual(['192.168.1.20', '192.168.1.21']);
    expect(groups[0].members[0].name).toBe('Living & Dining');
  });

  it('leaves out invisible members (bonded surrounds and subs)', () => {
    const groups = parseZoneGroupState(
      topologyResponse(
        '<ZoneGroups><ZoneGroup Coordinator="RINCON_A">' +
          '<ZoneGroupMember UUID="RINCON_A" Location="http://10.0.0.5:1400/x" ZoneName="Living" Invisible="0"/>' +
          '<ZoneGroupMember UUID="RINCON_S" Location="http://10.0.0.8:1400/x" ZoneName="Living" Invisible="1"/>' +
          '</ZoneGroup></ZoneGroups>',
      ),
    );
    expect(groups[0].members.map((m) => m.uuid)).toEqual(['RINCON_A']);
  });

  it('reads host and port from a Location, with 1400 as the fallback', () => {
    expect(endpointFromLocation('http://192.168.1.20:1400/xml/device_description.xml')).toEqual({
      host: '192.168.1.20',
      port: 1400,
    });
    expect(endpointFromLocation('http://10.0.0.9:1401/xml')).toEqual({ host: '10.0.0.9', port: 1401 });
    expect(endpointFromLocation('http://10.0.0.9/xml')).toEqual({ host: '10.0.0.9', port: 1400 });
    expect(endpointFromLocation('http://10.0.0.9:99999/xml')).toEqual({ host: '10.0.0.9', port: 1400 });
    expect(endpointFromLocation('nonsense')).toBeUndefined();
    expect(endpointFromLocation(undefined)).toBeUndefined();
  });

  it('matches a member by IP or by the Sonos mDNS hostname that carries its MAC', () => {
    const living = { uuid: 'RINCON_5CAAFD0A1B2C01400', host: '192.168.1.20', port: 1400, name: 'Living' };
    expect(isMemberHost(living, '192.168.1.20')).toBe(true);
    expect(isMemberHost(living, 'Sonos-5CAAFD0A1B2C.local')).toBe(true);
    expect(isMemberHost(living, 'sonos-5caafd0a1b2c.local.')).toBe(true);
    expect(isMemberHost(living, 'Sonos-000000000000.local')).toBe(false);
    expect(isMemberHost(living, '192.168.1.2')).toBe(false);
  });

  it('reaches a member at its allowed address, else at its Location', () => {
    const living = { uuid: 'RINCON_5CAAFD0A1B2C01400', host: '192.168.1.20', port: 1401, name: 'Living' };
    expect(endpointFor(living, [{ host: 'Sonos-5CAAFD0A1B2C.local', port: 1401 }])).toEqual({
      host: 'Sonos-5CAAFD0A1B2C.local',
      port: 1401,
    });
    // The port from Location is kept, as the Raycast extension's library does.
    expect(endpointFor(living, [{ host: '192.168.1.20', port: 1400 }])).toEqual({ host: '192.168.1.20', port: 1401 });
  });

  it('finds the group by room, then by the first allowed speaker in it, then the only group', () => {
    const groups = parseZoneGroupState(TOPOLOGY);
    const speakers = (...hosts: string[]) => hosts.map((host) => ({ host, port: 1400 }));
    expect(findGroup(groups, 'office', speakers('192.168.1.21'))).toBe(groups[1]);
    expect(findGroup(groups, 'Gone', speakers('192.168.1.21'))).toBe(groups[0]);
    // The order of the allowed speakers decides, not which one answered.
    expect(findGroup(groups, undefined, speakers('192.168.1.99', '192.168.1.30', '192.168.1.21'))).toBe(groups[1]);
    expect(findGroup(groups, undefined, speakers('kitchen.local'))).toBeUndefined();
    expect(findGroup([groups[1]], undefined, speakers('office.local'))).toBe(groups[1]);
    expect(findGroup([], undefined, speakers('x.local'))).toBeUndefined();
  });

  it('lists room names of a group, coordinator first, without duplicates or empty names', () => {
    const group: ZoneGroup = {
      coordinatorUuid: 'RINCON_L1',
      members: [
        { uuid: 'RINCON_K', host: '10.0.0.6', port: 1400, name: 'Kitchen' },
        { uuid: 'RINCON_L1', host: '10.0.0.5', port: 1400, name: 'Living' },
        { uuid: 'RINCON_L2', host: '10.0.0.8', port: 1400, name: 'Living' },
        { uuid: 'RINCON_X', host: '10.0.0.9', port: 1400, name: '' },
      ],
    };
    expect(roomNames(group)).toEqual(['Living', 'Kitchen']);
    expect(roomNames(undefined)).toEqual([]);
  });
});
