// Iron Dynasty — public entry point. Re-exports the factory, components,
// data, and pure economics so consumers (the browser shell, tests, future
// tooling) import from one stable surface.

export * from './types.js'
export * from './components.js'
export * from './data.js'
export * from './economy.js'
export {
  createRailroad,
  snapshotHash,
  type RailroadOptions,
  type RailroadRefs,
  type RailroadFault,
} from './railroad.js'
