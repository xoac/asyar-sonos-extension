// Test helpers: fake speakers behind `fetch`, and topologies to answer with. Used by the tests only.
import { escapeXml, type Endpoint } from './sonos';
import type { Fetch, HttpResponse } from './speaker';

export const ok = (body = ''): HttpResponse => ({ status: 200, ok: true, body });

export const state = (s: string) => ok(`<CurrentTransportState>${s}</CurrentTransportState>`);

export const REFUSED_701: HttpResponse = {
  status: 500,
  ok: false,
  body: '<UPnPError><errorCode>701</errorCode></UPnPError>',
};

/** A speaker that is off: the request never answers. */
export const NO_ANSWER: Promise<never> = new Promise(() => {});

/** Asyar's refusal of an endpoint the user did not allow. */
export const DENIED = (host: string) =>
  new Error(`LAN endpoint '${host}:1400' is not declared in permissionArgs.network:lan`);

/** A skip waits for a group it started; tests do not. */
export const noWait = async () => {};

export const at = (host: string, port = 1400): Endpoint => ({ host, port });

/** A `GetZoneGroupState` answer with these `<ZoneGroup>` elements. */
export const topology = (groups: string) =>
  '<ZoneGroupState>' + escapeXml(`<ZoneGroups>${groups}</ZoneGroups>`) + '</ZoneGroupState>';

export const member = (uuid: string, ip: string, room: string) =>
  `<ZoneGroupMember UUID="${uuid}" Location="http://${ip}:1400/xml/device_description.xml" ZoneName="${room}"/>`;

/** One group led by Living (10.0.0.5) with Kitchen (10.0.0.6). */
export const LIVING_KITCHEN = topology(
  '<ZoneGroup Coordinator="RINCON_A">' +
    member('RINCON_A', '10.0.0.5', 'Living') +
    member('RINCON_B', '10.0.0.6', 'Kitchen') +
    '</ZoneGroup>',
);

/** Two groups: Living + Kitchen, and Office (10.0.0.7) on its own. */
export const TWO_GROUPS = topology(
  '<ZoneGroup Coordinator="RINCON_A">' +
    member('RINCON_A', '10.0.0.5', 'Living') +
    member('RINCON_B', '10.0.0.6', 'Kitchen') +
    '</ZoneGroup><ZoneGroup Coordinator="RINCON_C">' +
    member('RINCON_C', '10.0.0.7', 'Office') +
    '</ZoneGroup>',
);

/** Speakers play unless a test says otherwise, so skips go straight through. */
const DEFAULTS: Record<string, HttpResponse> = { GetTransportInfo: state('PLAYING') };

export interface Call {
  url: string;
  host: string;
  action: string;
  body: string;
}

export type Answer = HttpResponse | Error | Promise<never>;

/**
 * Fake speakers: answer by SOAP action, or by `Action@host` for one speaker, and record every request. A list of
 * answers is given out in order, its last one repeating.
 */
export function fakeSpeaker(answers: Record<string, Answer | Answer[]>) {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, options) => {
    const action = /#(\w+)"$/.exec(options.headers.SOAPACTION)?.[1] ?? '?';
    const host = new URL(url).hostname;
    calls.push({ url, host, action, body: options.body });
    const given = answers[`${action}@${host}`] ?? answers[action] ?? DEFAULTS[action] ?? ok();
    const answer = Array.isArray(given) ? (given.length > 1 ? given.shift()! : given[0]) : given;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { fetch, calls };
}
