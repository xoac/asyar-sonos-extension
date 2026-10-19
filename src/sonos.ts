// Pure Sonos (UPnP/SOAP) helpers: request building and response parsing. No SDK imports, so it can
// be unit-tested. Sonos speakers answer SOAP over plain HTTP on port 1400. Behaviour follows the
// Raycast "Sonos" extension (MIT, AntonNiklasson), which drives the same actions through
// @svrooij/sonos; this file talks to the speaker directly because the sandbox has no npm/Node.

export const SONOS_PORT = 1400;

interface ServiceInfo {
  /** Control endpoint on the speaker. */
  path: string;
  /** UPnP service type, used in the SOAPACTION header and the body namespace. */
  type: string;
}

const SERVICES = {
  AVTransport: {
    path: '/MediaRenderer/AVTransport/Control',
    type: 'urn:schemas-upnp-org:service:AVTransport:1',
  },
  GroupRenderingControl: {
    path: '/MediaRenderer/GroupRenderingControl/Control',
    type: 'urn:schemas-upnp-org:service:GroupRenderingControl:1',
  },
  ZoneGroupTopology: {
    path: '/ZoneGroupTopology/Control',
    type: 'urn:schemas-upnp-org:service:ZoneGroupTopology:1',
  },
} as const satisfies Record<string, ServiceInfo>;

export type ServiceName = keyof typeof SERVICES;

export type SoapArgs = Record<string, string | number>;

/** The `InstanceID` argument of every AVTransport and GroupRenderingControl action; a speaker has one instance. */
export const INSTANCE_ARGS = { InstanceID: 0 } as const;

export interface SoapRequest {
  url: string;
  options: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    timeout: number;
  };
}

/** Speakers are on the LAN; a slow answer means the speaker is not reachable. */
const REQUEST_TIMEOUT_MS = 5000;

export const MAX_VOLUME = 100;

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** A character reference as text; one outside Unicode is left as it is. */
function decodeCharReference(reference: string, code: number): string {
  return code <= 0x10ffff ? String.fromCodePoint(code) : reference;
}

/** `&amp;` is decoded last so that `&amp;lt;` becomes `&lt;`, not `<`. */
export function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (reference, code: string) => decodeCharReference(reference, Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (reference, code: string) => decodeCharReference(reference, parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

/** Where a speaker answers SOAP: its host and the HTTP port from its `Location` (1400 in practice). */
export interface Endpoint {
  host: string;
  port: number;
}

export function formatEndpoint(target: Endpoint): string {
  return `${target.host}:${target.port}`;
}

export function sameEndpoint(a: Endpoint, b: Endpoint): boolean {
  return a.host.toLowerCase() === b.host.toLowerCase() && a.port === b.port;
}

function serviceUrl(target: Endpoint, service: ServiceName): string {
  return `http://${formatEndpoint(target)}${SERVICES[service].path}`;
}

export function soapAction(service: ServiceName, action: string): string {
  // The header value is quoted by the UPnP spec.
  return `"${SERVICES[service].type}#${action}"`;
}

export function soapEnvelope(service: ServiceName, action: string, args: SoapArgs = {}): string {
  const type = SERVICES[service].type;
  const params = Object.entries(args)
    .map(([name, value]) => `<${name}>${escapeXml(String(value))}</${name}>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${type}">${params}</u:${action}></s:Body></s:Envelope>`
  );
}

export function buildRequest(
  target: Endpoint,
  service: ServiceName,
  action: string,
  args: SoapArgs = {},
): SoapRequest {
  return {
    url: serviceUrl(target, service),
    options: {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPACTION: soapAction(service, action),
      },
      body: soapEnvelope(service, action, args),
      timeout: REQUEST_TIMEOUT_MS,
    },
  };
}

/** Text of the first `<tag>...</tag>`, entity-decoded once. */
export function extractTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? unescapeXml(match[1]) : undefined;
}

export type TransportState = 'PLAYING' | 'PAUSED_PLAYBACK' | 'STOPPED' | 'TRANSITIONING' | 'UNKNOWN';

export function parseTransportState(xml: string): TransportState {
  const state = extractTag(xml, 'CurrentTransportState');
  return state === 'PLAYING' ||
    state === 'PAUSED_PLAYBACK' ||
    state === 'STOPPED' ||
    state === 'TRANSITIONING'
    ? state
    : 'UNKNOWN';
}

/** A transitioning group is about to play, so toggling it should pause. */
export function isPlayingState(state: TransportState): boolean {
  return state === 'PLAYING' || state === 'TRANSITIONING';
}

export function clampVolume(value: number): number {
  return Math.min(MAX_VOLUME, Math.max(0, Math.round(value)));
}

/** `CurrentVolume` of a `GetGroupVolume` answer. */
export function parseGroupVolume(xml: string): number | undefined {
  const text = extractTag(xml, 'CurrentVolume')?.trim();
  return text !== undefined && /^\d+$/.test(text) ? clampVolume(Number(text)) : undefined;
}

/** Actions the group allows now, from `GetCurrentTransportActions`: "Set, Stop, Pause, Play, Next" on a radio station. */
export function parseTransportActions(xml: string): string[] | undefined {
  const text = extractTag(xml, 'Actions');
  if (text === undefined) return undefined;
  return text
    .split(',')
    .map((action) => action.trim())
    .filter((action) => action !== '');
}

/** UPnP error code from a SOAP fault, e.g. 701 "transition not available" when skipping a radio stream. */
export function parseUpnpErrorCode(xml: string): number | undefined {
  const text = extractTag(xml, 'errorCode');
  if (text === undefined || !/^\d+$/.test(text.trim())) return undefined;
  return Number(text);
}

export interface NowPlaying {
  title?: string;
  artist?: string;
  /** An input instead of a track: the TV of a home theater speaker, or a line-in. */
  input?: 'TV' | 'Line-in';
}

/** `text` if it is fit to show: not empty, not a placeholder such as `ZPSTR_CONNECTING`, not a URI such as `x-sonosapi-stream:…`. */
function displayText(text: string | undefined): string | undefined {
  const value = text?.trim();
  if (!value || value.startsWith('ZPSTR_') || /^(x-[\w-]+:|[a-z]+:\/\/)/i.test(value)) return undefined;
  return value;
}

/**
 * What a group plays, from a `GetPositionInfo` answer. `TrackMetaData` is a DIDL-Lite document carried as escaped
 * text, so it is decoded once by `extractTag` and read again. A radio stream puts its current song in
 * `r:streamContent`.
 */
export function parseNowPlaying(xml: string): NowPlaying {
  const uri = extractTag(xml, 'TrackURI') ?? '';
  if (uri.startsWith('x-sonos-htastream:')) return { input: 'TV' };
  if (uri.startsWith('x-rincon-stream:')) return { input: 'Line-in' };
  const meta = extractTag(xml, 'TrackMetaData') ?? '';
  const stream = displayText(extractTag(meta, 'r:streamContent'));
  if (stream) return { title: stream };
  const title = displayText(extractTag(meta, 'dc:title'));
  const artist = displayText(extractTag(meta, 'dc:creator'));
  return { ...(title && { title }), ...(artist && { artist }) };
}

export interface ZoneMember extends Endpoint {
  uuid: string;
  name: string;
}

export interface ZoneGroup {
  coordinatorUuid: string;
  members: ZoneMember[];
}

/** Value of attribute `name` in `attrs`, the text after an element's name. */
function attribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return match ? unescapeXml(match[1]) : undefined;
}

/**
 * Host and port of a member's `Location` (`http://192.168.1.20:1400/xml/device_description.xml`). The port is
 * read rather than assumed, as the Raycast extension's library does (@svrooij/sonos,
 * `src/services/zone-group-topology.service.extension.ts`); 1400 is only the fallback.
 */
export function endpointFromLocation(location: string | undefined): Endpoint | undefined {
  const match = location ? /^https?:\/\/([^:/]+)(?::(\d+))?/i.exec(location) : null;
  if (!match) return undefined;
  const port = match[2] ? Number(match[2]) : SONOS_PORT;
  return { host: match[1], port: port >= 1 && port <= 65535 ? port : SONOS_PORT };
}

/**
 * Parses the `ZoneGroupState` of a `GetZoneGroupState` response. The SOAP body carries that XML
 * document entity-escaped as text, so it is decoded once by `extractTag` and read again here.
 */
export function parseZoneGroupState(responseXml: string): ZoneGroup[] {
  const state = extractTag(responseXml, 'ZoneGroupState');
  if (!state) return [];
  const groups: ZoneGroup[] = [];
  for (const groupMatch of state.matchAll(/<ZoneGroup\s([^>]*)>([\s\S]*?)<\/ZoneGroup>/g)) {
    const coordinatorUuid = attribute(groupMatch[1], 'Coordinator');
    if (!coordinatorUuid) continue;
    const members: ZoneMember[] = [];
    for (const memberMatch of groupMatch[2].matchAll(/<ZoneGroupMember\s([^>]*?)\/?>/g)) {
      // Bonded surrounds and subs are invisible: they share their room's name and never lead a group.
      if (attribute(memberMatch[1], 'Invisible') === '1') continue;
      const uuid = attribute(memberMatch[1], 'UUID');
      const endpoint = endpointFromLocation(attribute(memberMatch[1], 'Location'));
      if (uuid && endpoint) {
        members.push({ uuid, ...endpoint, name: attribute(memberMatch[1], 'ZoneName') ?? '' });
      }
    }
    groups.push({ coordinatorUuid, members });
  }
  return groups;
}

export function coordinatorOf(group: ZoneGroup): ZoneMember | undefined {
  return group.members.find((m) => m.uuid === group.coordinatorUuid);
}

/**
 * Whether `host` names this member: the IP from its `Location`, or the mDNS hostname Sonos speakers announce,
 * `Sonos-<MAC>.local` (the MAC is also in the member's UUID, `RINCON_<MAC>01400`). Asyar's picker saves the IP; a row
 * added by hand, or by an older Asyar build, can hold the hostname.
 */
export function isMemberHost(member: ZoneMember, host: string): boolean {
  const wanted = host.toLowerCase().replace(/\.$/, '');
  if (member.host.toLowerCase() === wanted) return true;
  const mac = /^sonos-([0-9a-f]{12})\.local$/.exec(wanted)?.[1];
  return mac !== undefined && member.uuid.toLowerCase().startsWith(`rincon_${mac}`);
}

/**
 * Where to reach `member`: an allowed endpoint that names it, because Asyar only lets requests through to the
 * address the user approved, else its `Location`.
 */
export function endpointFor(member: ZoneMember, allowed: Endpoint[]): Endpoint {
  const device = allowed.find((d) => d.port === member.port && isMemberHost(member, d.host));
  return device ?? { host: member.host, port: member.port };
}

/**
 * The group commands act on: the one with the chosen room (case-insensitive), else the one with the first of the
 * allowed `speakers` in it, else the only group.
 */
export function findGroup(groups: ZoneGroup[], room: string | undefined, speakers: Endpoint[]): ZoneGroup | undefined {
  const wanted = room?.toLowerCase();
  const withRoom = wanted ? groups.find((g) => g.members.some((m) => m.name.toLowerCase() === wanted)) : undefined;
  if (withRoom) return withRoom;
  for (const speaker of speakers) {
    const withSpeaker = groups.find((g) => g.members.some((m) => isMemberHost(m, speaker.host)));
    if (withSpeaker) return withSpeaker;
  }
  return groups.length === 1 ? groups[0] : undefined;
}

/** Room names of a group, coordinator first, without duplicates (bonded speakers share a room name). */
export function roomNames(group: ZoneGroup | undefined): string[] {
  if (!group) return [];
  const coordinator = coordinatorOf(group);
  const ordered = coordinator ? [coordinator, ...group.members.filter((m) => m !== coordinator)] : group.members;
  return [...new Set(ordered.map((m) => m.name).filter((name) => name !== ''))];
}
