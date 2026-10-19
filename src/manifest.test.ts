import { describe, expect, it } from 'vitest';

import manifest from '../manifest.json';
import { COMMAND_IDS, CONTROL_CENTER_COMMAND_ID, CONTROL_CENTER_COMPONENT, ROOM_PREFERENCE } from './commands';

describe('manifest', () => {
  it('has a background command for every worker command and one Control Center view', () => {
    const background = manifest.commands.filter((c) => c.mode === 'background').map((c) => c.id);
    expect(background.sort()).toEqual([...COMMAND_IDS].sort());
    const views = manifest.commands.filter((c) => c.mode === 'view');
    expect(views).toHaveLength(1);
    // view.ts navigates to `<id>/<component>`.
    expect(views[0]).toMatchObject({ id: CONTROL_CENTER_COMMAND_ID, component: CONTROL_CENTER_COMPONENT });
  });

  it('requests network:lan without pre-declared hosts, and nothing else beyond its own preferences', () => {
    expect(manifest.permissions).toEqual(['network', 'network:lan', 'preferences:write']);
    // The user allows speakers in Asyar's dialogs; the extension declares no LAN endpoints of its own.
    expect(manifest).not.toHaveProperty('permissionArgs');
  });

  it('declares the preference the code reads, not required, so the Control Center can open first', () => {
    expect(manifest.preferences.map((p) => p.name)).toEqual([ROOM_PREFERENCE]);
    expect(manifest.preferences.every((p) => p.required === false)).toBe(true);
  });
});
