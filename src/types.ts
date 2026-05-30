// Iron Dynasty — pure scalar/string-union types shared across the codebase.
// No runtime values live here (those are in data.ts); keeping the type-only
// vocabulary in one dependency-free module avoids import cycles between
// components.ts (which references model/tech ids) and data.ts (which
// references the world's Era/Good/Grade vocabulary).

/** Technological epoch. Ordering is meaningful — see ERA_ORDER in data.ts. */
export type Era = 'steam' | 'diesel' | 'electric' | 'maglev'

/** What a train hauls / a city demands. `passengers` is the universal good. */
export type Good = 'passengers' | 'mail' | 'coal' | 'steel' | 'goods'

/** Track class. Ordering is meaningful — see GRADE_ORDER in data.ts. */
export type Grade = 'standard' | 'heavy' | 'electrified' | 'maglev'

/** Bond-style credit rating derived from the debt/cash ratio. */
export type CreditRating = 'AAA' | 'AA' | 'A' | 'BBB' | 'BB' | 'B' | 'CCC' | 'D'

/** A heir's inherited disposition; biases the next generation's economics. */
export type HeirTrait = 'engineer' | 'tycoon' | 'diplomat' | 'visionary' | 'spendthrift'

/** Top-level run state. */
export type GameStatus = 'playing' | 'bankrupt' | 'retired'

/** Per-train lifecycle phase. */
export type TrainStatus = 'idle' | 'enroute' | 'loading'

/** Enactable political/social levers. */
export type PolicyId =
  | 'safety-board'
  | 'green-initiative'
  | 'lobby-campaign'
  | 'austerity'
  | 'public-works'

/** Rolling-stock model identifiers (catalogue lives in data.ts). */
export type TrainModelId =
  | 'mule'
  | 'ironhorse'
  | 'pioneer'
  | 'dh-goods'
  | 'zephyr'
  | 'sparrow-emu'
  | 'shinrai'
  | 'maglev-x'

/** Tech-tree node identifiers (graph lives in data.ts). */
export type TechId =
  | 'iron-rails'
  | 'heavy-freight'
  | 'telegraph'
  | 'air-brakes'
  | 'diesel-traction'
  | 'streamlining'
  | 'electrification'
  | 'signaling-ctc'
  | 'welded-rail'
  | 'high-speed'
  | 'tunneling'
  | 'maglev'
