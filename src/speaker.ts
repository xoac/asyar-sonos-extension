// Talking to the speakers through Asyar: the SOAP call and how its failures are classified, the devices the user
// allowed, and the topology read that finds the group to control. The HTTP and device functions are injected (worker
// and view pass `network.fetch` and `network.listLanDevices`), so this module has no SDK imports and is tested with
// fakes.
import {
  SONOS_PORT,
  buildRequest,
  coordinatorOf,
  endpointFor,
  findGroup,
  parseUpnpErrorCode,
  parseZoneGroupState,
  type Endpoint,
  type ServiceName,
  type SoapArgs,
  type SoapRequest,
  type ZoneGroup,
} from './sonos';

export interface HttpResponse {
  status: number;
  ok: boolean;
  body: string;
}

export type Fetch = (url: string, options: SoapRequest['options']) => Promise<HttpResponse>;

/** `network.listLanDevices`: resolves to `{ host, port, label }[]` on a launcher that has it. */
export type ListDevices = () => Promise<unknown>;

export type SonosErrorKind = 'not-configured' | 'refused' | 'unsupported' | 'unreachable' | 'upnp';

export class SonosError extends Error {
  readonly upnpCode?: number;
  /** For `refused` and `unreachable`: the endpoint that was refused or did not answer. */
  readonly endpoint?: Endpoint;

  constructor(
    readonly kind: SonosErrorKind,
    message: string,
    details: { upnpCode?: number; endpoint?: Endpoint } = {},
  ) {
    super(message);
    this.name = 'SonosError';
    this.upnpCode = details.upnpCode;
    this.endpoint = details.endpoint;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}

/**
 * Asyar refused the request: the endpoint is not one the user allowed ("LAN endpoint '…' is not declared in
 * permissionArgs.network:lan", tmp/asyar `network/lan_policy.rs`), or its name resolves to an address Asyar never lets
 * through ("Requests to loopback, link-local, or metadata address '…' are not allowed", `network/service.rs`), such as
 * the link-local IPv6 address of a speaker's `.local` name.
 */
const LAUNCHER_REFUSAL = /network:lan|link-local/;

/**
 * A launcher without `network:lan` support (Asyar 0.1.1-51 and older) refuses every LAN request with "Requests to
 * private or loopback address '…' are not allowed" (`validate_url_for_ssrf`, `network/service.rs`).
 */
const LAUNCHER_WITHOUT_LAN = /private or loopback address/;

/**
 * The endpoint named in the launcher's refusal, "LAN endpoint '192.168.1.20:1400' is not declared in
 * permissionArgs.network:lan" (tmp/asyar PR #879, `network/lan_policy.rs` `denied`).
 */
export function parseDeniedEndpoint(message: string): Endpoint | undefined {
  const match = /LAN endpoint '([^']+):(\d+)'/.exec(message);
  return match ? { host: match[1], port: Number(match[2]) } : undefined;
}

/** Sends one SOAP action to `target` and returns the answer's body. Throws `SonosError` on failure. */
export async function soapCall(
  fetch: Fetch,
  target: Endpoint,
  service: ServiceName,
  action: string,
  args: SoapArgs = {},
): Promise<string> {
  const request = buildRequest(target, service, action, args);
  let response: HttpResponse;
  try {
    response = await fetch(request.url, request.options);
  } catch (err) {
    const message = errorMessage(err);
    if (LAUNCHER_REFUSAL.test(message)) {
      throw new SonosError('refused', message, { endpoint: parseDeniedEndpoint(message) ?? target });
    }
    if (LAUNCHER_WITHOUT_LAN.test(message)) throw new SonosError('unsupported', message, { endpoint: target });
    throw new SonosError('unreachable', message, { endpoint: target });
  }
  if (!response.ok) {
    throw new SonosError('upnp', `${action} failed with HTTP ${response.status}`, {
      upnpCode: parseUpnpErrorCode(response.body),
    });
  }
  return response.body;
}

export interface AllowedDevices {
  /** Allowed endpoints on the Sonos port, in the order Asyar lists them. */
  speakers: Endpoint[];
  /** Allowed endpoints on other ports: a Sonos speaker does not answer there. */
  wrongPort: Endpoint[];
}

function isEndpoint(value: unknown): value is Endpoint {
  const device = value as Partial<Endpoint> | null;
  return typeof device?.host === 'string' && typeof device.port === 'number';
}

/**
 * The devices the user allowed under Settings → Extensions → Control Sonos → Local network devices. A launcher
 * without `network.listLanDevices` answers the call with nothing (tmp/asyar `ExtensionIpcRouter.ts`
 * `dispatchApiCall` returns `undefined` for an unknown method), so anything but a list means it is too old.
 */
export async function loadDevices(list: ListDevices): Promise<AllowedDevices> {
  let devices: unknown;
  try {
    devices = await list();
  } catch (err) {
    throw new SonosError('unsupported', errorMessage(err));
  }
  if (!Array.isArray(devices)) throw new SonosError('unsupported', 'network.listLanDevices is not available');
  const all = devices.filter(isEndpoint).map(({ host, port }) => ({ host, port }));
  return {
    speakers: all.filter((d) => d.port === SONOS_PORT),
    wrongPort: all.filter((d) => d.port !== SONOS_PORT),
  };
}

export type DeviceRequestResult =
  | { status: 'allowed'; device: Endpoint & { label?: string } }
  | { status: 'cancelled' }
  /** The launcher has no device picker (before tmp/asyar PR #879 commit `05916c0`). */
  | { status: 'unsupported' }
  | { status: 'error'; message: string };

/**
 * Runs `network.requestLanDevice` or `network.requestLanHost`: the launcher shows its own dialog, saves the device the
 * user allows to Local network devices and resolves to it, or to `null` when the user cancels. Like `listLanDevices`,
 * an unknown method answers `undefined` on an older launcher.
 */
export async function requestDevice(openDialog: () => Promise<unknown>): Promise<DeviceRequestResult> {
  let device: unknown;
  try {
    device = await openDialog();
  } catch (err) {
    const message = errorMessage(err);
    // A dialog of this extension is already open (`lanDevicePickerService.svelte.ts`): the user is on it.
    if (message.includes('LAN_PICKER_ALREADY_OPEN')) return { status: 'cancelled' };
    return { status: 'error', message };
  }
  if (device === null) return { status: 'cancelled' };
  if (!isEndpoint(device)) return { status: 'unsupported' };
  const { label } = device as { label?: unknown };
  return {
    status: 'allowed',
    device: { host: device.host, port: device.port, ...(typeof label === 'string' && { label }) },
  };
}

/** The room preference as a room name; empty means none. */
export function parseRoomPreference(raw: unknown): string | undefined {
  const room = typeof raw === 'string' ? raw.trim() : '';
  return room || undefined;
}

export interface Topology {
  /** The allowed speaker whose answer was used. */
  speaker: Endpoint;
  groups: ZoneGroup[];
  /** The group the background commands control. */
  group?: ZoneGroup;
  /** Where transport commands go: the group coordinator, at its allowed address if it has one. */
  coordinator: Endpoint;
}

/**
 * Asks every allowed speaker for the topology at once and uses the first answer: every speaker knows all groups, so a
 * speaker that is off, or whose address changed, costs no wait. Then finds the group to control and its coordinator;
 * without a known group the answering speaker is used as is.
 */
export async function readTopology(fetch: Fetch, speakers: Endpoint[], room: string | undefined): Promise<Topology> {
  if (speakers.length === 0) throw new SonosError('not-configured', 'no speaker is allowed under Local network devices');
  let answer: { speaker: Endpoint; groups: ZoneGroup[] };
  try {
    answer = await Promise.any(
      speakers.map(async (speaker) => ({
        speaker,
        groups: parseZoneGroupState(await soapCall(fetch, speaker, 'ZoneGroupTopology', 'GetZoneGroupState')),
      })),
    );
  } catch (err) {
    // No speaker answered: report the failure of the first one Asyar lists.
    throw err instanceof AggregateError ? err.errors[0] : err;
  }
  const { speaker, groups } = answer;
  const group = findGroup(groups, room, speakers);
  const coordinator = group && coordinatorOf(group);
  return { speaker, groups, group, coordinator: coordinator ? endpointFor(coordinator, speakers) : speaker };
}
