// View entry: the Sonos Control Center command. One ExtensionContext for this iframe; services are resolved here and
// passed to the component as props.
import 'asyar-sdk/tokens.css';
import { mount } from 'svelte';
import {
  ExtensionContext,
  extensionBridge,
  registerIconElement,
  type Extension,
  type IActionService,
  type IExtensionManager,
  type ILogService,
  type INetworkService,
} from 'asyar-sdk/view';

import manifest from '../manifest.json';
import { CONTROL_CENTER_COMMAND_ID, CONTROL_CENTER_COMPONENT } from './commands';
import { MAC_KEY_LABELS, OTHER_KEY_LABELS } from './controlCenter';
import ControlCenter from './ControlCenter.svelte';

const id = manifest.id;
const VIEW_PATH = `${id}/${CONTROL_CENTER_COMPONENT}`;

const context = new ExtensionContext();
// Also tells Asyar the view has loaded (`asyar:extension:loaded` with role `view`, asyar-sdk `ExtensionContextCore.ts`).
context.setExtensionId(id);
registerIconElement();

const extensions = context.getService<IExtensionManager>('extensions');

const extension: Extension = {
  async initialize() {},
  async activate() {},
  async deactivate() {},
  async executeCommand(commandId) {
    if (commandId !== CONTROL_CENTER_COMMAND_ID) return undefined;
    extensions.navigateToView(VIEW_PATH);
    return { type: 'view', viewPath: VIEW_PATH };
  },
  onUnload() {},
};

extensionBridge.registerManifest(manifest as never);
extensionBridge.registerExtensionImplementation(id, extension);

mount(ControlCenter, {
  target: document.getElementById('app')!,
  props: {
    context,
    network: context.getService<INetworkService>('network'),
    log: context.getService<ILogService>('log'),
    actions: context.getService<IActionService>('actions'),
    keyLabels: /mac/i.test(navigator.userAgent) ? MAC_KEY_LABELS : OTHER_KEY_LABELS,
    extensionId: id,
  },
});
