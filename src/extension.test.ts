import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionContext } from 'asyar-sdk/contracts';

import { INIT_WAIT_MS, createExtension } from './extension';
import { TWO_GROUPS, fakeSpeaker, ok } from './fakeSpeaker';
import type { SoapRequest } from './sonos';

const OFFICE = { host: '10.0.0.7', port: 1400, label: 'Office' };
const LIVING = { host: '10.0.0.5', port: 1400, label: 'Living' };

function setup(allowed: unknown[] = [LIVING], room = '') {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const feedback = { showHUD: vi.fn(async () => {}) };
  const devices = { allowed };
  const speaker = fakeSpeaker({ GetZoneGroupState: ok(TWO_GROUPS) });
  const network = {
    listLanDevices: vi.fn(async () => devices.allowed),
    fetch: vi.fn(async function (this: unknown, url: string, options: SoapRequest['options']) {
      // The SDK's `NetworkServiceProxy.fetch` uses `this.broker`, so the extension must call it on the service.
      if (this !== network) throw new Error('network.fetch called without its service');
      return speaker.fetch(url, options);
    }),
  };
  const values: Record<string, unknown> = { room };
  const services: Record<string, unknown> = { log, feedback, network };
  const ctx = {
    getService: (name: string) => services[name],
    preferences: {
      get values() {
        return values;
      },
    },
  } as unknown as ExtensionContext;
  return { log, feedback, network, devices, ctx, calls: speaker.calls };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('executeCommand', () => {
  it('runs a command and shows the result as a HUD', async () => {
    const { ctx, feedback, log } = setup();
    const ext = createExtension();
    await ext.initialize(ctx);
    await ext.executeCommand('next-track', {});
    expect(log.error).not.toHaveBeenCalled();
    expect(feedback.showHUD).toHaveBeenCalledWith('Sonos: next track');
  });

  it('controls the group of the room preference', async () => {
    const { ctx, calls } = setup([LIVING, OFFICE], 'Office');
    const ext = createExtension();
    await ext.initialize(ctx);
    await ext.executeCommand('next-track', {});
    // Without the preference, the group of the first allowed speaker, Living, would skip.
    expect(calls.at(-1)).toMatchObject({ action: 'Next', host: '10.0.0.7' });
  });

  it('re-reads the allowed devices on every command', async () => {
    const { ctx, feedback, devices, network } = setup([]);
    const ext = createExtension();
    await ext.initialize(ctx);
    await ext.executeCommand('play-pause', {});
    expect(feedback.showHUD).toHaveBeenLastCalledWith('Sonos: open Control Center');
    expect(network.fetch).not.toHaveBeenCalled();
    devices.allowed = [LIVING];
    await ext.executeCommand('previous-track', {});
    expect(feedback.showHUD).toHaveBeenLastCalledWith('Sonos: previous track');
  });

  it('tells the user when the launcher cannot list allowed devices', async () => {
    const { ctx, feedback, network } = setup();
    network.listLanDevices.mockResolvedValue(undefined as never);
    const ext = createExtension();
    await ext.initialize(ctx);
    await ext.executeCommand('next-track', {});
    expect(feedback.showHUD).toHaveBeenCalledWith('Sonos: needs a newer Asyar');
  });

  it('logs and shows a HUD when the speaker is not allowed', async () => {
    const { ctx, feedback, log, network } = setup();
    network.fetch.mockRejectedValue(new Error("LAN endpoint '10.0.0.5:1400' is not declared in permissionArgs.network:lan"));
    const ext = createExtension();
    await ext.initialize(ctx);
    await ext.executeCommand('next-track', {});
    expect(log.error).toHaveBeenCalled();
    expect(feedback.showHUD).toHaveBeenCalledWith('Sonos: open Control Center');
  });

  it('warns about an unknown command and does nothing', async () => {
    const { ctx, feedback, log, network } = setup();
    const ext = createExtension();
    await ext.initialize(ctx);
    await ext.executeCommand('nope', {});
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('nope'));
    expect(network.listLanDevices).not.toHaveBeenCalled();
    expect(network.fetch).not.toHaveBeenCalled();
    expect(feedback.showHUD).not.toHaveBeenCalled();
  });

  it('leaves the Control Center command to the view without warning', async () => {
    const { ctx, feedback, log, network } = setup();
    const ext = createExtension();
    await ext.initialize(ctx);
    await ext.executeCommand('control-center', {});
    expect(log.warn).not.toHaveBeenCalled();
    expect(network.fetch).not.toHaveBeenCalled();
    expect(feedback.showHUD).not.toHaveBeenCalled();
  });

  it('waits for initialize when a command arrives early', async () => {
    const { ctx, feedback } = setup();
    const ext = createExtension();
    const pending = ext.executeCommand('next-track', {});
    await ext.initialize(ctx);
    await pending;
    expect(feedback.showHUD).toHaveBeenCalledWith('Sonos: next track');
  });

  it('drops a command, with a console error, if never initialized', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ext = createExtension();
    const pending = ext.executeCommand('play-pause', {});
    await vi.advanceTimersByTimeAsync(INIT_WAIT_MS);
    await pending;
    expect(error).toHaveBeenCalledWith(expect.stringContaining('dropped'));
  });
});
