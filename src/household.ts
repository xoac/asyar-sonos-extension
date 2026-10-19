// What the Control Center shows: every group of the household with what it plays and its volume, or why there is
// nothing to show. Read-only requests only; `fetch` is injected, so no SDK imports.
import {
  INSTANCE_ARGS,
  coordinatorOf,
  endpointFor,
  formatEndpoint,
  parseGroupVolume,
  parseNowPlaying,
  parseTransportActions,
  parseTransportState,
  roomNames,
  sameEndpoint,
  type Endpoint,
  type NowPlaying,
  type TransportState,
  type ZoneGroup,
} from './sonos';
import {
  SonosError,
  errorMessage,
  parseRoomPreference,
  readTopology,
  soapCall,
  type AllowedDevices,
  type Fetch,
  type Topology,
} from './speaker';

export interface GroupPlayback {
  state: TransportState;
  nowPlaying: NowPlaying;
  /** Group volume, 0-100; missing when the speaker did not say. */
  volume?: number;
  /** Transport actions allowed now, e.g. no `Previous` on a radio station; missing when the speaker did not say. */
  actions?: string[];
}

/**
 * Why a group cannot be controlled: its coordinator is not allowed yet, or is allowed but Asyar refused it anyway, or it
 * did not answer.
 */
export type GroupProblem = 'needs-permission' | 'refused' | 'unreachable' | 'error';

export interface GroupItem {
  /** The coordinator's UUID, stable while the group exists. */
  id: string;
  /** The coordinator's room: what the room preference stores. Empty when the topology could not be read. */
  room: string;
  /** Room names, coordinator first. */
  rooms: string[];
  /** Where commands for the group go: the coordinator, at its allowed address when it has one. */
  coordinator: Endpoint;
  /** More than one speaker, so a volume change scales each room. */
  multiRoom: boolean;
  /** Set when the coordinator answered. */
  playback?: GroupPlayback;
  problem?: GroupProblem;
}

export type Household =
  | { status: 'no-devices'; wrongPort: Endpoint[] }
  /** The launcher refused every allowed speaker, although they are on the allowed list. */
  | { status: 'refused'; endpoint: Endpoint }
  | { status: 'unsupported' }
  | { status: 'unreachable'; endpoint: Endpoint; message: string }
  | { status: 'error'; message: string }
  | {
      status: 'ok';
      /** Groups that can be controlled first, then by room name. */
      groups: GroupItem[];
      /** Id of the group the background commands control. */
      hotkeyGroupId?: string;
      wrongPort: Endpoint[];
    };

function householdFromError(err: unknown, speakers: Endpoint[]): Household {
  if (err instanceof SonosError) {
    const { endpoint } = err;
    if (err.kind === 'refused' && endpoint && speakers.some((s) => sameEndpoint(s, endpoint))) {
      return { status: 'refused', endpoint };
    }
    if (err.kind === 'unsupported') return { status: 'unsupported' };
    if (err.kind === 'unreachable' && endpoint) return { status: 'unreachable', endpoint, message: err.message };
  }
  return { status: 'error', message: errorMessage(err) };
}

function toGroupItem(group: ZoneGroup, speakers: Endpoint[]): GroupItem | undefined {
  const coordinator = coordinatorOf(group);
  if (!coordinator) return undefined;
  const endpoint = endpointFor(coordinator, speakers);
  return {
    id: coordinator.uuid,
    room: coordinator.name,
    rooms: roomNames(group),
    coordinator: endpoint,
    multiRoom: group.members.length > 1,
    // Commands go to the coordinator only, so the group can be controlled exactly when its coordinator is allowed.
    ...(speakers.some((s) => sameEndpoint(s, endpoint)) ? {} : { problem: 'needs-permission' as const }),
  };
}

async function readPlayback(fetch: Fetch, coordinator: Endpoint): Promise<GroupPlayback> {
  const [transport, position, volume, actions] = await Promise.all([
    soapCall(fetch, coordinator, 'AVTransport', 'GetTransportInfo', INSTANCE_ARGS),
    soapCall(fetch, coordinator, 'AVTransport', 'GetPositionInfo', INSTANCE_ARGS),
    // The rest of the row is still useful without these.
    soapCall(fetch, coordinator, 'GroupRenderingControl', 'GetGroupVolume', INSTANCE_ARGS).then(
      parseGroupVolume,
      () => undefined,
    ),
    soapCall(fetch, coordinator, 'AVTransport', 'GetCurrentTransportActions', INSTANCE_ARGS).then(
      parseTransportActions,
      () => undefined,
    ),
  ]);
  return {
    state: parseTransportState(transport),
    nowPlaying: parseNowPlaying(position),
    ...(volume !== undefined && { volume }),
    ...(actions !== undefined && { actions }),
  };
}

function groupProblemFrom(err: unknown): GroupProblem {
  if (err instanceof SonosError) {
    // Only allowed coordinators are asked, so a refusal is of an allowed address.
    if (err.kind === 'refused') return 'refused';
    if (err.kind === 'unreachable') return 'unreachable';
  }
  return 'error';
}

/**
 * Everything the Control Center shows: the topology from an allowed speaker, then the playback of each group whose
 * coordinator is allowed. `room` is the raw room preference, which marks the group the background commands control.
 */
export async function loadHousehold(fetch: Fetch, devices: AllowedDevices, room: unknown): Promise<Household> {
  const { speakers, wrongPort } = devices;
  if (speakers.length === 0) return { status: 'no-devices', wrongPort };

  let topology: Topology;
  try {
    topology = await readTopology(fetch, speakers, parseRoomPreference(room));
  } catch (err) {
    return householdFromError(err, speakers);
  }
  const { speaker, groups, group } = topology;
  const items: GroupItem[] = groups.length
    ? groups.map((g) => toGroupItem(g, speakers)).filter((item): item is GroupItem => item !== undefined)
    : // A topology that could not be read: the answering speaker is all there is to control.
      [{ id: formatEndpoint(speaker), room: '', rooms: [], coordinator: speaker, multiRoom: false }];

  await Promise.all(
    items
      .filter((item) => !item.problem)
      .map(async (item) => {
        try {
          item.playback = await readPlayback(fetch, item.coordinator);
        } catch (err) {
          item.problem = groupProblemFrom(err);
        }
      }),
  );
  const rank = (item: GroupItem) => (item.problem === 'needs-permission' ? 1 : 0);
  items.sort((a, b) => rank(a) - rank(b) || a.room.localeCompare(b.room));

  const hotkeyGroupId = groups.length ? group && coordinatorOf(group)?.uuid : items[0].id;
  return hotkeyGroupId
    ? { status: 'ok', groups: items, hotkeyGroupId, wrongPort }
    : { status: 'ok', groups: items, wrongPort };
}
