// Extension implementation for Sonos, free of boot side effects so it can be unit-tested.
// Each background command reads the speakers the user allowed (`network.listLanDevices`), talks to them through
// `network.fetch` (permissions `network` + `network:lan`) and reports the result as a HUD, because the host hides
// the launcher as soon as it dispatches a background command. worker.ts wires this into the SDK bridge.
import type {
  Extension,
  ExtensionContext,
  IFeedbackService,
  ILogService,
  INetworkService,
} from 'asyar-sdk/contracts';

import {
  CONTROL_CENTER_COMMAND_ID,
  ROOM_PREFERENCE,
  hudErrorText,
  isCommandId,
  runBackgroundCommand,
  sleep,
} from './commands';
import { errorMessage, loadDevices, type Fetch } from './speaker';

/** How long a command waits for `initialize` before it is dropped. */
export const INIT_WAIT_MS = 2000;

interface Initialized {
  context: ExtensionContext;
  log: ILogService;
  feedback: IFeedbackService;
  network: INetworkService;
}

export function createExtension(): Extension {
  let init: Initialized | undefined;
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  return {
    async initialize(ctx: ExtensionContext) {
      init = {
        context: ctx,
        log: ctx.getService<ILogService>('log'),
        feedback: ctx.getService<IFeedbackService>('feedback'),
        network: ctx.getService<INetworkService>('network'),
      };
      markReady();
    },
    async activate() {},
    async deactivate() {},
    async executeCommand(commandId) {
      // A command can race with initialize; wait briefly instead of silently dropping it.
      if (!init) await Promise.race([ready, sleep(INIT_WAIT_MS)]);
      if (!init) {
        // No services means no log/HUD either, so console is the only channel left.
        console.error(`Sonos: command "${commandId}" dropped, extension not initialized`);
        return undefined;
      }
      const { context, log, feedback, network } = init;
      // The Control Center is a view; its iframe handles it.
      if (commandId === CONTROL_CENTER_COMMAND_ID) return undefined;
      if (!isCommandId(commandId)) {
        log.warn(`Sonos: unknown command "${commandId}"`);
        return undefined;
      }
      // Re-read on every command: the user may have used another group or changed the allowed devices.
      const prefs = context.preferences.values as Record<string, unknown>;
      try {
        const { speakers } = await loadDevices(() => network.listLanDevices());
        const message = await runBackgroundCommand(commandId, {
          fetch: network.fetch.bind(network) as Fetch,
          speakers,
          room: prefs[ROOM_PREFERENCE],
        });
        await feedback.showHUD(message);
      } catch (err) {
        log.error(`Sonos: ${commandId} failed: ${errorMessage(err)}`);
        await feedback.showHUD(hudErrorText(err));
      }
      return undefined;
    },
    onUnload() {},
  };
}
