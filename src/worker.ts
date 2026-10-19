import { ExtensionContext as WorkerContext, extensionBridge } from 'asyar-sdk/worker';
import manifest from '../manifest.json';
import { createExtension } from './extension';

const id = manifest.id;
new WorkerContext().setExtensionId(id);
extensionBridge.registerManifest(manifest as never);
extensionBridge.registerExtensionImplementation(id, createExtension());
void extensionBridge.initializeExtensions();
