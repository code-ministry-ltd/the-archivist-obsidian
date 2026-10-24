// The plugin uses the window's timers, as Obsidian asks; under Node the window is the global.
Object.assign(globalThis, { window: globalThis });
