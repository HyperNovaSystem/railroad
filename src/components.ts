// Iron Dynasty — ECS component, resource, and event definitions.
//
// Entity components: City, Industry, Station, RailLine, Train, TechNode.
// Singleton resource: Treasury (the company ledger + nation-state mood).
// Transient component: Render (per-train screen state, excluded from snapshots).
// Event: Command (the single player/AI intent channel).

import { defineComponent, defineResource, defineEvent, type Entity } from '@domecs/core'
import type {
  CreditRating,
  Era,
  GameStatus,
  Good,
  Grade,
  HeirTrait,
  PolicyId,
  TechId,
  TrainModelId,
  TrainStatus,
} from './types.js'

// ─── Validators ──────────────────────────────────────────────────────────
// Mirror the tessera exemplar: small named helpers returning `true | string`.

function finite(name: string, value: number): true | string {
  return Number.isFinite(value) ? true : `${name} must be finite`
}

function nonNegative(name: string, value: number): true | string {
  return Number.isFinite(value) && value >= 0 ? true : `${name} must be a non-negative number`
}

function inRange(name: string, value: number, min: number, max: number): true | string {
  return Number.isFinite(value) && value >= min && value <= max
    ? true
    : `${name} must be within [${min}, ${max}]`
}

function nonNegativeInteger(name: string, value: number): true | string {
  return Number.isInteger(value) && value >= 0 ? true : `${name} must be a non-negative integer`
}

function nullableEntity(name: string, value: Entity | null): true | string {
  return value === null ? true : nonNegativeInteger(name, value)
}

// ─── City ──────────────────────────────────────────────────────────────────
// A population centre. Generates passengers (and demands goods) once it has a
// Station on the network. Coordinates are screen-space for the DOM view.

export interface CityState {
  name: string
  x: number
  y: number
  population: number
  maxPopulation: number
  growthRate: number // monthly fraction when connected
  prosperity: number // 0..100, scales fares + growth
  hasStation: boolean // derived: a Station entity references this city
}

export const City = defineComponent<CityState>('City', {
  defaults: {
    name: '',
    x: 0,
    y: 0,
    population: 1000,
    maxPopulation: 1_000_000,
    growthRate: 0.004,
    prosperity: 50,
    hasStation: false,
  },
  validate: (v) => {
    const pop = nonNegative('population', v.population)
    if (pop !== true) return pop
    const prosperity = inRange('prosperity', v.prosperity, 0, 100)
    if (prosperity !== true) return prosperity
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return 'x/y must be finite'
    return true
  },
})

// ─── Industry ────────────────────────────────────────────────────────────
// Produces a good at its host city, accumulating a stockpile that a Station
// turns into a freight queue.

export interface IndustryState {
  city: Entity
  good: Good
  rate: number // units produced per sim-month
  stockpile: number
  stockCap: number
}

export const Industry = defineComponent<IndustryState>('Industry', {
  defaults: { city: 0, good: 'goods', rate: 10, stockpile: 0, stockCap: 400 },
  validate: (v) => {
    const city = nonNegativeInteger('city', v.city)
    if (city !== true) return city
    const rate = nonNegative('rate', v.rate)
    if (rate !== true) return rate
    return nonNegative('stockpile', v.stockpile)
  },
})

// ─── Station ─────────────────────────────────────────────────────────────
// Built infrastructure at a city node. Holds the passenger + freight queues
// that trains load from. Overflowing a queue is a service failure (see the
// trains/cities systems) that erodes reputation.

export interface StationState {
  city: Entity
  level: number // 1..5; raises capacity + throughput
  paxQueue: number
  freightQueue: number
  capacity: number // per-queue soft cap; overflow is lost demand
  good: Good // dominant freight good at this station
}

export const Station = defineComponent<StationState>('Station', {
  defaults: { city: 0, level: 1, paxQueue: 0, freightQueue: 0, capacity: 200, good: 'goods' },
  validate: (v) => {
    const city = nonNegativeInteger('city', v.city)
    if (city !== true) return city
    const level = inRange('level', v.level, 1, 5)
    if (level !== true) return level
    const pax = nonNegative('paxQueue', v.paxQueue)
    if (pax !== true) return pax
    return nonNegative('freightQueue', v.freightQueue)
  },
})

// ─── RailLine ─────────────────────────────────────────────────────────────
// A bidirectional track segment connecting two cities' stations. `grade`
// caps train speed; `condition` decays and is restored by maintenance.

export interface RailLineState {
  from: Entity // city
  to: Entity // city
  fromStation: Entity
  toStation: Entity
  length: number // km
  grade: Grade
  condition: number // 0..100
  maxTrains: number
  trainCount: number
  fromX: number
  fromY: number
  toX: number
  toY: number
}

export const RailLine = defineComponent<RailLineState>('RailLine', {
  defaults: {
    from: 0,
    to: 0,
    fromStation: 0,
    toStation: 0,
    length: 1,
    grade: 'standard',
    condition: 100,
    maxTrains: 2,
    trainCount: 0,
    fromX: 0,
    fromY: 0,
    toX: 0,
    toY: 0,
  },
  validate: (v) => {
    if (v.from === v.to) return 'a line must connect two distinct cities'
    const length = nonNegative('length', v.length)
    if (length !== true) return length
    return inRange('condition', v.condition, 0, 100)
  },
})

// ─── Train ───────────────────────────────────────────────────────────────
// Rolling stock. Shuttles along its assigned line, loading at one end and
// unloading (banking revenue) at the other. `position` is 0..1 along the line.

export interface TrainState {
  name: string
  model: TrainModelId
  line: Entity | null
  position: number // 0..1
  dir: 1 | -1
  status: TrainStatus
  speedKm: number // effective km/month after tech + grade caps
  capacityPax: number
  capacityFreight: number
  loadPax: number
  loadFreight: number
  cargo: Good // freight good this train is configured to haul
  age: number // months in service
  maintenance: number // $/month
  haulRevenue: number // lifetime revenue, for reporting
  deliveries: number // completed unloads
}

export const Train = defineComponent<TrainState>('Train', {
  defaults: {
    name: '',
    model: 'mule',
    line: null,
    position: 0,
    dir: 1,
    status: 'idle',
    speedKm: 60,
    capacityPax: 40,
    capacityFreight: 60,
    loadPax: 0,
    loadFreight: 0,
    cargo: 'goods',
    age: 0,
    maintenance: 200,
    haulRevenue: 0,
    deliveries: 0,
  },
  validate: (v) => {
    const line = nullableEntity('line', v.line)
    if (line !== true) return line
    const position = inRange('position', v.position, 0, 1)
    if (position !== true) return position
    if (v.dir !== 1 && v.dir !== -1) return 'dir must be 1 or -1'
    const cap = nonNegative('capacityPax', v.capacityPax)
    if (cap !== true) return cap
    return nonNegative('maintenance', v.maintenance)
  },
})

// ─── TechNode ────────────────────────────────────────────────────────────
// One node of the research graph. `researched` flips when `progress >= cost`;
// the reactive tech-unlock system then folds its bonuses into the Treasury.

export interface TechNodeState {
  tech: TechId
  name: string
  era: Era
  cost: number // research points to complete
  progress: number
  researched: boolean
  prereqs: TechId[]
  unlocksModel: TrainModelId | null
  unlocksGrade: Grade | null
  speedBonus: number // additive to Treasury.speedMult
  capacityBonus: number // additive to Treasury.capacityMult
  maintenanceFactor: number // multiplicative into Treasury.maintenanceMult (<=1 saves)
  extraTrains: number // additive to every line's maxTrains
  desc: string
  x: number // tree layout
  y: number
}

export const TechNode = defineComponent<TechNodeState>('TechNode', {
  defaults: {
    tech: 'iron-rails',
    name: '',
    era: 'steam',
    cost: 100,
    progress: 0,
    researched: false,
    prereqs: [],
    unlocksModel: null,
    unlocksGrade: null,
    speedBonus: 0,
    capacityBonus: 0,
    maintenanceFactor: 1,
    extraTrains: 0,
    desc: '',
    x: 0,
    y: 0,
  },
  validate: (v) => {
    const cost = nonNegative('cost', v.cost)
    if (cost !== true) return cost
    return nonNegative('progress', v.progress)
  },
})

// ─── Render (transient) ──────────────────────────────────────────────────
// Per-train presentation state, recomputed every animation tick from the
// train's line + position. Transient ⇒ excluded from snapshots, so the smooth
// real-time interpolation never perturbs deterministic save/replay hashes.

export interface RenderState {
  x: number
  y: number
  angle: number // radians, for orienting the marker
  label: string
  kind: string // css modifier (era / status)
}

export const Render = defineComponent<RenderState>('Render', {
  defaults: { x: 0, y: 0, angle: 0, label: '', kind: 'steam' },
  transient: true,
  validate: (v) => {
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return 'x/y must be finite'
    return finite('angle', v.angle)
  },
})

// ─── Treasury (resource) ──────────────────────────────────────────────────
// The company ledger fused with the political climate. A world singleton so
// it exercises the resource + ChangedResource reactive path. Tech-derived
// modifiers (unlockedModels, maxGrade, *Mult) are recomputed by the reactive
// tech-unlock system; everything else is driven by the fixed sim systems.

export interface TreasuryState {
  // money
  cash: number
  debt: number
  interestRate: number // annual fraction
  creditRating: CreditRating
  // calendar
  year: number
  month: number // 1..12
  foundingYear: number
  era: Era
  // dynasty
  generation: number // 1-based
  generationLengthYears: number
  heirTrait: HeirTrait
  legacyScore: number
  // politics & society
  reputation: number // 0..100 public goodwill
  approval: number // 0..100 political approval
  regulation: number // 0..100 regulatory burden
  // pricing
  fareMult: number
  freightMult: number
  // tech-derived (recomputed reactively from TechNode state)
  unlockedModels: TrainModelId[]
  maxGrade: Grade
  speedMult: number
  capacityMult: number
  maintenanceMult: number
  bonusTrains: number
  // research
  activeResearch: TechId | null
  researchRate: number // points per sim-month
  // status / telemetry
  status: GameStatus
  lastError: string
  totalRevenue: number
  totalExpenses: number
  trainsDelivered: number
  eventLog: string[] // capped rolling log of notable events
}

export function freshTreasury(): TreasuryState {
  return {
    cash: 150_000,
    debt: 0,
    interestRate: 0.08,
    creditRating: 'A',
    year: 1880,
    month: 1,
    foundingYear: 1880,
    era: 'steam',
    generation: 1,
    generationLengthYears: 25,
    heirTrait: 'engineer',
    legacyScore: 0,
    reputation: 50,
    approval: 50,
    regulation: 20,
    fareMult: 1,
    freightMult: 1,
    unlockedModels: ['mule'],
    maxGrade: 'standard',
    speedMult: 1,
    capacityMult: 1,
    maintenanceMult: 1,
    bonusTrains: 0,
    activeResearch: null,
    researchRate: 12,
    status: 'playing',
    lastError: '',
    totalRevenue: 0,
    totalExpenses: 0,
    trainsDelivered: 0,
    eventLog: [],
  }
}

export const Treasury = defineResource<TreasuryState>('Treasury', {
  default: freshTreasury,
  validate: (v) => {
    const rep = inRange('reputation', v.reputation, 0, 100)
    if (rep !== true) return rep
    const approval = inRange('approval', v.approval, 0, 100)
    if (approval !== true) return approval
    const regulation = inRange('regulation', v.regulation, 0, 100)
    if (regulation !== true) return regulation
    const month = inRange('month', v.month, 1, 12)
    if (month !== true) return month
    return finite('cash', v.cash)
  },
})

// ─── Command event ───────────────────────────────────────────────────────
// The single intent channel. The UI / AI / tests dispatch a Command via
// `world.turn(CommandEvent, cmd)`; the event-scheduled resolver validates and
// applies it, recording failures as data on Treasury.lastError.

export type Command =
  | { kind: 'build-line'; from: Entity; to: Entity }
  | { kind: 'buy-train'; model: TrainModelId; line: Entity; cargo: Good; name?: string }
  | { kind: 'assign-train'; train: Entity; line: Entity }
  | { kind: 'research'; tech: TechId }
  | { kind: 'take-loan'; amount: number }
  | { kind: 'repay-loan'; amount: number }
  | { kind: 'upgrade-station'; station: Entity }
  | { kind: 'upgrade-line'; line: Entity; grade: Grade }
  | { kind: 'set-fares'; fareMult: number; freightMult: number }
  | { kind: 'enact-policy'; policy: PolicyId }

export const CommandEvent = defineEvent<Command>('Command')

// Convenience re-exports so downstream modules import scalar types from a
// single place alongside the components that use them.
export type {
  CreditRating,
  Era,
  GameStatus,
  Good,
  Grade,
  HeirTrait,
  PolicyId,
  TechId,
  TrainModelId,
  TrainStatus,
} from './types.js'
