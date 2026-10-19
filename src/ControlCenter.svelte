<script lang="ts">
  // Sonos Control Center: every group with what it plays, play/pause and track buttons and a volume slider, for mouse
  // and keyboard. Speakers are allowed from here through Asyar's own dialogs: Add Speaker opens its device picker, and
  // Allow on a dimmed group asks for the speaker that leads it. Wording and key handling live in ./controlCenter.ts.
  import { onDestroy, onMount } from 'svelte';
  import {
    ActionCategory,
    ActionContext,
    type ExtensionContext,
    type IActionService,
    type ILogService,
    type INetworkService,
  } from 'asyar-sdk/view';

  import { ROOM_PREFERENCE, runTransportCommand, setGroupVolume, type CommandId } from './commands';
  import {
    ALLOW_HINT,
    NEXT_SHORTCUT,
    PICKER_REASON,
    PREVIOUS_SHORTCUT,
    canSkip,
    deviceRequestNote,
    errorNote,
    fixForPick,
    groupName,
    groupSubtitle,
    moveSelection,
    outcomeNote,
    problemNotice,
    selectionAfterRefresh,
    stepVolume,
    volumeSender,
    withRecentVolumes,
    wrongPortHint,
    type KeyLabels,
    type RecentVolumes,
  } from './controlCenter';
  import { loadHousehold, type GroupItem, type Household } from './household';
  import { MAX_VOLUME, formatEndpoint, isPlayingState, type TransportState } from './sonos';
  import { SonosError, errorMessage, loadDevices, requestDevice, type DeviceRequestResult, type Fetch } from './speaker';

  let {
    context,
    network,
    log,
    actions,
    keyLabels,
    extensionId,
  }: {
    context: ExtensionContext;
    network: INetworkService;
    log: ILogService;
    actions: IActionService;
    keyLabels: KeyLabels;
    extensionId: string;
  } = $props();

  /** How often the groups are read again while the view is visible. */
  const POLL_MS = 2000;
  /** Delay before reading a group again after an action, so the speaker reports the new track. */
  const AFTER_ACTION_MS = 400;
  const FLASH_MS = 5000;

  /** mDNS service Sonos speakers announce; the picker browses it (Asyar already does by default). */
  const SONOS_SERVICE = '_sonos._tcp.local';
  const ADD_ACTION = 'add-speaker';

  const ACTIONS: { id: CommandId; title: string; shortcut?: string }[] = [
    { id: 'play-pause', title: 'Play / Pause' },
    { id: 'next-track', title: 'Next Track', shortcut: NEXT_SHORTCUT },
    { id: 'previous-track', title: 'Previous Track', shortcut: PREVIOUS_SHORTCUT },
  ];

  let household = $state<Household | null>(null);
  let selected = $state<string | undefined>();
  let flash = $state<string | null>(null);
  /** An Asyar device dialog is open. */
  let asking = $state(false);

  // Reads the prop on each call: binding `network.fetch` here would read it once (svelte-check state_referenced_locally).
  const fetch: Fetch = (url, options) => (network.fetch.bind(network) as Fetch)(url, options);
  const recentVolumes: RecentVolumes = new Map();
  const volumeSenders = new Map<string, (volume: number) => Promise<void>>();
  let refreshing = false;
  /** Bumped by every action, so a read that started before it cannot undo what the action showed. */
  let generation = 0;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  const groups = $derived(household?.status === 'ok' ? household.groups : []);
  const controllable = $derived(groups.filter((g) => g.playback));
  const selectedGroup = $derived(controllable.find((g) => g.id === selected));
  const notice = $derived(household && household.status !== 'ok' ? problemNotice(household, keyLabels) : null);
  const hotkeyGroupId = $derived(
    household?.status === 'ok' && controllable.length > 1 ? household.hotkeyGroupId : undefined,
  );
  const wrongPortText = $derived(
    household?.status === 'ok' ? wrongPortHint(household.wrongPort, keyLabels) : undefined,
  );
  const anyNeedsPermission = $derived(groups.some((g) => g.problem === 'needs-permission'));

  function flashMessage(message: string) {
    flash = message;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (flash = null), FLASH_MS);
  }

  function stopPolling() {
    if (pollTimer !== undefined) clearInterval(pollTimer);
    pollTimer = undefined;
  }

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    const started = generation;
    try {
      const devices = await loadDevices(() => network.listLanDevices());
      const next = await loadHousehold(fetch, devices, context.preferences.values[ROOM_PREFERENCE]);
      if (started !== generation) return;
      household = withRecentVolumes(next, recentVolumes, Date.now());
      selected = selectionAfterRefresh(
        controllable.map((g) => g.id),
        selected,
        household.status === 'ok' ? household.hotkeyGroupId : undefined,
      );
    } catch (err) {
      log.error(`Sonos Control Center: ${String(err)}`);
      if (err instanceof SonosError && err.kind === 'unsupported') {
        household = { status: 'unsupported' };
        stopPolling();
      } else {
        household = { status: 'error', message: errorMessage(err) };
      }
    } finally {
      refreshing = false;
    }
  }

  function reportError(err: unknown) {
    log.error(`Sonos Control Center: ${String(err)}`);
    flashMessage(errorNote(err));
    void refresh();
  }

  /** The background commands follow the group the user last used here. */
  async function rememberHotkeyGroup(group: GroupItem) {
    if (household?.status !== 'ok' || !group.room || household.hotkeyGroupId === group.id) return;
    household = { ...household, hotkeyGroupId: group.id };
    try {
      await context.preferences.set('extension', ROOM_PREFERENCE, group.room);
    } catch (err) {
      log.error(`Sonos Control Center: could not save the room: ${String(err)}`);
    }
  }

  function showTransportState(id: string, state: TransportState) {
    if (household?.status !== 'ok') return;
    household = {
      ...household,
      groups: household.groups.map((g) =>
        g.id === id && g.playback ? { ...g, playback: { ...g.playback, state } } : g,
      ),
    };
  }

  async function runOnGroup(group: GroupItem, command: CommandId) {
    selected = group.id;
    generation++;
    try {
      const outcome = await runTransportCommand(fetch, group.coordinator, command);
      generation++;
      const note = outcomeNote(outcome);
      if (note) flashMessage(note);
      if (outcome === 'playing' || outcome === 'paused') {
        showTransportState(group.id, outcome === 'playing' ? 'PLAYING' : 'PAUSED_PLAYBACK');
      }
      void rememberHotkeyGroup(group);
      setTimeout(() => void refresh(), AFTER_ACTION_MS);
    } catch (err) {
      reportError(err);
    }
  }

  function setVolume(group: GroupItem, volume: number) {
    if (household?.status !== 'ok' || !group.playback) return;
    selected = group.id;
    recentVolumes.set(group.id, { volume, at: Date.now() });
    household = withRecentVolumes(household, recentVolumes, Date.now());
    const key = `${group.id}@${formatEndpoint(group.coordinator)}`;
    let send = volumeSenders.get(key);
    if (!send) {
      const { coordinator } = group;
      send = volumeSender((v, snapshotFirst) => setGroupVolume(fetch, coordinator, v, snapshotFirst), group, reportError);
      volumeSenders.set(key, send);
    }
    void send(volume);
    void rememberHotkeyGroup(group);
  }

  /** Opens an Asyar device dialog; an allowed device is saved by Asyar and shows up on the next read. */
  async function openDeviceDialog(open: () => Promise<unknown>): Promise<DeviceRequestResult | undefined> {
    if (asking) return undefined;
    asking = true;
    try {
      const result = await requestDevice(open);
      const note = deviceRequestNote(result, keyLabels);
      if (note) flashMessage(note);
      if (result.status === 'allowed') await refresh();
      return result;
    } finally {
      asking = false;
    }
  }

  /** The picker lists every device, so a pick can be another service of the speaker, or not a speaker at all. */
  async function addSpeaker() {
    const result = await openDeviceDialog(() =>
      network.requestLanDevice({ reason: PICKER_REASON, serviceTypes: [SONOS_SERVICE] }),
    );
    const fix = result?.status === 'allowed' ? fixForPick(result.device) : undefined;
    if (!fix) return;
    flashMessage(fix.message);
    const { retry } = fix;
    if (retry) await openDeviceDialog(() => network.requestLanHost(retry));
  }

  /** Asks to allow the speaker that leads `group`, at the address the topology gives for it. */
  const allowGroup = (group: GroupItem) =>
    openDeviceDialog(() =>
      network.requestLanHost({ ...group.coordinator, ...(group.room && { label: group.room }) }),
    );

  function handleKey(key: string, shift: boolean): boolean {
    switch (key) {
      case 'ArrowUp':
      case 'ArrowDown':
        selected = moveSelection(
          controllable.map((g) => g.id),
          selected,
          key === 'ArrowUp' ? -1 : 1,
        );
        return true;
      case 'ArrowLeft':
      case 'ArrowRight':
        if (selectedGroup?.playback?.volume !== undefined) {
          setVolume(selectedGroup, stepVolume(selectedGroup.playback.volume, key, shift));
        }
        return true;
      case 'Enter':
      case ' ':
        if (selectedGroup) void runOnGroup(selectedGroup, 'play-pause');
        return true;
    }
    return false;
  }

  /** Keys typed while the launcher's search bar has focus: it forwards arrows and Enter to the active view. */
  function onMessage(event: MessageEvent) {
    if (event.source !== window.parent) return;
    const data = event.data as { type?: unknown; payload?: { key?: unknown; shiftKey?: unknown } } | null;
    if (data?.type !== 'asyar:view:keydown' || typeof data.payload?.key !== 'string') return;
    handleKey(data.payload.key, data.payload.shiftKey === true);
  }

  /**
   * Keys typed while the view has focus: it takes focus when it opens, so Space works too (the launcher forwards only
   * arrows, Enter and Tab from its search bar). A focused slider or button handles its own keys.
   */
  function onKeydown(event: KeyboardEvent) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if ((event.target as HTMLElement | null)?.closest('input, button')) return;
    if (handleKey(event.key, event.shiftKey)) event.preventDefault();
  }

  function onVisibilityChange() {
    if (!document.hidden) void refresh();
  }

  /** Buttons keep focus where it was, so the arrow keys keep working after a click. */
  const keepFocus = (event: MouseEvent) => event.preventDefault();

  $effect(() => {
    if (selected) document.getElementById(`group-${selected}`)?.scrollIntoView({ block: 'nearest' });
  });

  let root: HTMLElement | undefined = $state();

  onMount(() => {
    root?.focus({ preventScroll: true });
    void refresh();
    pollTimer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_MS);
    for (const action of ACTIONS) {
      actions.registerAction({
        id: `${extensionId}:${action.id}`,
        title: action.title,
        description: 'Selected group',
        extensionId,
        category: ActionCategory.PRIMARY,
        context: ActionContext.EXTENSION_VIEW,
        ...(action.shortcut && { shortcut: action.shortcut }),
        execute: () => {
          if (selectedGroup) void runOnGroup(selectedGroup, action.id);
        },
      });
    }
    actions.registerAction({
      id: `${extensionId}:${ADD_ACTION}`,
      title: 'Add Speaker…',
      description: "Allow a speaker from Asyar's list of devices",
      extensionId,
      category: ActionCategory.PRIMARY,
      context: ActionContext.EXTENSION_VIEW,
      execute: () => addSpeaker(),
    });
  });

  onDestroy(() => {
    stopPolling();
    clearTimeout(flashTimer);
    for (const action of ACTIONS) actions.unregisterAction(`${extensionId}:${action.id}`);
    actions.unregisterAction(`${extensionId}:${ADD_ACTION}`);
  });
</script>

<svelte:window onmessage={onMessage} onkeydown={onKeydown} />
<svelte:document onvisibilitychange={onVisibilityChange} />

<main class="center" tabindex="-1" bind:this={root}>
  {#if notice}
    {#if household?.status === 'no-devices'}
      <header class="intro">
        <asyar-icon name="lock" size="20"></asyar-icon>
        <div>
          <h1>Control Sonos runs in Asyar's sandbox</h1>
          <p>It can reach only the speakers you allow in Asyar Settings, and nothing else on your network.</p>
        </div>
      </header>
    {/if}
    <section class="card {notice.tone}" aria-live="polite">
      <h2>
        <asyar-icon name={notice.tone === 'action' ? 'settings' : 'info'} size="16"></asyar-icon>
        {notice.title}
      </h2>
      {#each notice.lines as line (line)}
        <p>{line}</p>
      {/each}
      {#if notice.addSpeaker}
        <button type="button" class="primary" disabled={asking} onclick={addSpeaker}>Add Speaker…</button>
      {/if}
    </section>
  {:else if household === null}
    <p class="muted">Looking for your speakers…</p>
  {:else}
    <ul class="groups" role="listbox" aria-label="Sonos groups">
      {#each groups as group (group.id)}
        {@const playback = group.playback}
        {@const playing = playback ? isPlayingState(playback.state) : false}
        <li
          id="group-{group.id}"
          class="group"
          class:selected={group.id === selected}
          class:dimmed={!playback}
          role="option"
          tabindex="-1"
          aria-selected={group.id === selected}
          aria-disabled={!playback}
          onpointerdown={() => {
            if (playback) selected = group.id;
          }}
        >
          {#if playback}
            <div class="transport">
              <button
                type="button"
                class="icon"
                title={canSkip(playback, 'Previous') ? `Previous track (${keyLabels.previous})` : 'Sonos does not allow going back here'}
                aria-label="Previous track"
                disabled={!canSkip(playback, 'Previous')}
                onmousedown={keepFocus}
                onclick={() => runOnGroup(group, 'previous-track')}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h2v14H6zM19 5v14L9 12z" /></svg>
              </button>
              <button
                type="button"
                class="icon play"
                title={playing ? 'Pause (Enter)' : 'Play (Enter)'}
                aria-label={playing ? 'Pause' : 'Play'}
                onmousedown={keepFocus}
                onclick={() => runOnGroup(group, 'play-pause')}
              >
                {#if playing}
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>
                {:else}
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
                {/if}
              </button>
              <button
                type="button"
                class="icon"
                title={canSkip(playback, 'Next') ? `Next track (${keyLabels.next})` : 'Sonos does not allow skipping this source'}
                aria-label="Next track"
                disabled={!canSkip(playback, 'Next')}
                onmousedown={keepFocus}
                onclick={() => runOnGroup(group, 'next-track')}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 5h2v14h-2zM5 5v14l10-7z" /></svg>
              </button>
            </div>
          {/if}
          <div class="info">
            <div class="name">
              <span class="rooms">{groupName(group)}</span>
              {#if group.id === hotkeyGroupId}
                <span class="badge" title="Sonos Play / Pause, Next Track and Previous Track control this group">Hotkeys</span>
              {/if}
            </div>
            <div class="line">{groupSubtitle(group)}</div>
          </div>
          {#if playback?.volume !== undefined}
            <div class="volume">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 9h4l5-4v14l-5-4H4z" />
                <path class="wave" d="M16 9a4 4 0 0 1 0 6" />
              </svg>
              <input
                type="range"
                min="0"
                max={MAX_VOLUME}
                step="1"
                value={playback.volume}
                aria-label="Volume of {groupName(group)}"
                oninput={(event) => setVolume(group, Number(event.currentTarget.value))}
                onchange={(event) => event.currentTarget.blur()}
              />
              <span class="level">{playback.volume}</span>
            </div>
          {:else if group.problem === 'needs-permission'}
            <div class="volume">
              <button
                type="button"
                class="primary"
                disabled={asking}
                title="Allow {formatEndpoint(group.coordinator)}"
                onclick={() => allowGroup(group)}>Allow…</button
              >
            </div>
          {/if}
        </li>
      {/each}
    </ul>
    {#if anyNeedsPermission}
      <p class="hint">{ALLOW_HINT}</p>
    {/if}
    {#if wrongPortText}
      <p class="hint">{wrongPortText}</p>
    {/if}
    {#if hotkeyGroupId}
      <p class="hint">
        Sonos Play / Pause, Next Track and Previous Track control the group marked Hotkeys: the one you last used here.
      </p>
    {/if}
  {/if}

  {#if flash}
    <p class="flash" role="status">{flash}</p>
  {/if}

  {#if controllable.length}
    <footer class="keys">
      <span><kbd>↑</kbd><kbd>↓</kbd> Group</span>
      <span><kbd>←</kbd><kbd>→</kbd> Volume</span>
      <span><kbd>↵</kbd> Play / Pause</span>
      <span><kbd>{keyLabels.previous}</kbd><kbd>{keyLabels.next}</kbd> Track</span>
    </footer>
  {/if}
</main>

<style>
  .center {
    outline: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-3);
    color: var(--text-primary);
    font-family: var(--font-ui);
    font-size: var(--font-size-sm);
    line-height: 1.5;
  }
  .intro {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    color: var(--text-secondary);
  }
  h1 {
    margin: 0 0 var(--space-1);
    font-size: var(--font-size-md);
    color: var(--text-primary);
  }
  h2 {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    margin: 0 0 var(--space-2);
    font-size: var(--font-size-sm);
  }
  .intro p {
    margin: 0;
  }
  .muted {
    margin: 0;
    color: var(--text-secondary);
  }
  .card {
    padding: var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--bg-secondary);
  }
  .card.action h2 {
    color: var(--accent-warning);
  }
  .card.error h2 {
    color: var(--accent-danger);
  }
  .card p {
    margin: 0 0 var(--space-2);
    color: var(--text-secondary);
  }
  .primary {
    padding: var(--space-1-5) var(--space-3);
    border: none;
    border-radius: var(--radius-md);
    background: var(--accent-primary-fill);
    color: var(--text-on-accent);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }
  .primary:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .groups {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .group {
    display: grid;
    grid-template-areas: 'transport info volume';
    grid-template-columns: auto minmax(0, 1fr) minmax(120px, 200px);
    gap: var(--space-3);
    align-items: center;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    outline: none;
  }
  .group:hover:not(.dimmed) {
    background: var(--bg-hover);
  }
  .group.selected {
    background: var(--bg-selected);
  }
  .group.dimmed .info {
    opacity: 0.6;
  }
  .transport {
    grid-area: transport;
    display: flex;
    gap: var(--space-1);
    align-items: center;
  }
  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: none;
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .icon:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .icon:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .icon.play {
    width: 32px;
    height: 32px;
    background: var(--accent-primary-fill);
    color: var(--text-on-accent);
  }
  .icon svg {
    width: 16px;
    height: 16px;
    fill: currentColor;
  }
  .info {
    grid-area: info;
    min-width: 0;
  }
  .name {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    font-weight: 600;
  }
  .rooms,
  .line {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .line {
    color: var(--text-secondary);
    font-size: var(--font-size-xs);
  }
  .badge {
    flex: none;
    padding: 0 var(--space-1-5);
    border-radius: var(--radius-full);
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    font-size: var(--font-size-2xs);
    font-weight: normal;
  }
  .volume {
    grid-area: volume;
    display: flex;
    gap: var(--space-2);
    align-items: center;
    color: var(--text-secondary);
  }
  .volume svg {
    flex: none;
    width: 16px;
    height: 16px;
    fill: currentColor;
  }
  .volume .wave {
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
  }
  .volume input {
    flex: 1;
    min-width: 0;
    accent-color: var(--accent-primary);
  }
  .level {
    width: 3ch;
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    text-align: right;
  }
  .hint {
    margin: 0;
    color: var(--text-tertiary);
    font-size: var(--font-size-xs);
  }
  .flash {
    margin: 0;
    color: var(--accent-warning);
  }
  .keys {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4);
    color: var(--text-tertiary);
    font-size: var(--font-size-xs);
  }
  kbd {
    margin-right: var(--space-0-5);
    padding: 0 var(--space-1);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-xs);
    font-family: inherit;
  }
</style>
