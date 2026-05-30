// Iron Dynasty — static game data: the starting map, rolling-stock catalogue,
// tech-tree graph, and the ordering/economic constants the systems read.
//
// Everything here is frozen, pure data — no RNG, no Date — so the simulation
// stays deterministic. Coordinates are screen-space on a ~960×600 board.

import type { Era, Good, Grade, PolicyId, TechId, TrainModelId } from './types.js'

// ─── Orderings ─────────────────────────────────────────────────────────────

export const ERA_ORDER: readonly Era[] = ['steam', 'diesel', 'electric', 'maglev']
export const GRADE_ORDER: readonly Grade[] = ['standard', 'heavy', 'electrified', 'maglev']

export function eraRank(era: Era): number {
  return ERA_ORDER.indexOf(era)
}
export function gradeRank(grade: Grade): number {
  return GRADE_ORDER.indexOf(grade)
}

/** Year at which the company-wide era advances (gates ambient growth/mood). */
export const ERA_START_YEAR: Readonly<Record<Era, number>> = {
  steam: 1880,
  diesel: 1935,
  electric: 1965,
  maglev: 2005,
}

export function eraForYear(year: number): Era {
  let era: Era = 'steam'
  for (const e of ERA_ORDER) {
    if (year >= ERA_START_YEAR[e]) era = e
  }
  return era
}

/** Top track speed (km/sim-month) a given grade physically permits. */
export const GRADE_SPEED_CAP: Readonly<Record<Grade, number>> = {
  standard: 100,
  heavy: 135,
  electrified: 210,
  maglev: 420,
}

// ─── Economic constants ────────────────────────────────────────────────────

export const ECONOMY = Object.freeze({
  costPerKm: 220, // $ to lay one km of standard track
  stationBuildCost: 8_000, // $ to erect a station at a city
  stationUpgradeBase: 12_000, // $ × level to raise a station
  farePerPax: 9, // base $ per passenger delivered
  freightPerUnit: 6, // base $ per freight unit delivered
  loanMaxRatio: 4, // max debt as a multiple of monthly-ish capacity proxy
  bankruptcyFloor: -50_000, // cash below this with debt ⇒ bankrupt
  conditionDecayPerMonth: 0.4, // line wear
  maintenancePerKm: 1.2, // $/km/month track upkeep
  researchPerMonthBase: 12,
  legacyPerYear: 4, // legacy score accrual baseline
})

/** Cost multiplier to *build* a line at a non-standard grade. */
export const GRADE_BUILD_MULT: Readonly<Record<Grade, number>> = {
  standard: 1,
  heavy: 1.6,
  electrified: 2.4,
  maglev: 4,
}

// ─── Starting map ──────────────────────────────────────────────────────────

export interface CitySeed {
  key: string
  name: string
  x: number
  y: number
  population: number
  maxPopulation: number
  prosperity: number
  growthRate: number
  industries: ReadonlyArray<{ good: Good; rate: number; stockCap: number }>
}

export const MAP_CITIES: readonly CitySeed[] = Object.freeze([
  {
    key: 'ashford',
    name: 'Ashford',
    x: 130,
    y: 300,
    population: 52_000,
    maxPopulation: 600_000,
    prosperity: 60,
    growthRate: 0.005,
    industries: [{ good: 'goods', rate: 14, stockCap: 240 }],
  },
  {
    key: 'brightwater',
    name: 'Brightwater',
    x: 300,
    y: 130,
    population: 41_000,
    maxPopulation: 500_000,
    prosperity: 58,
    growthRate: 0.005,
    industries: [{ good: 'goods', rate: 22, stockCap: 300 }],
  },
  {
    key: 'coalridge',
    name: 'Coalridge',
    x: 270,
    y: 470,
    population: 30_000,
    maxPopulation: 320_000,
    prosperity: 45,
    growthRate: 0.004,
    industries: [{ good: 'coal', rate: 40, stockCap: 480 }],
  },
  {
    key: 'drayton',
    name: 'Drayton',
    x: 520,
    y: 300,
    population: 36_000,
    maxPopulation: 540_000,
    prosperity: 52,
    growthRate: 0.0045,
    industries: [{ good: 'steel', rate: 28, stockCap: 360 }],
  },
  {
    key: 'eastvale',
    name: 'Eastvale',
    x: 720,
    y: 175,
    population: 28_000,
    maxPopulation: 480_000,
    prosperity: 55,
    growthRate: 0.005,
    industries: [{ good: 'mail', rate: 18, stockCap: 260 }],
  },
  {
    key: 'fairhaven',
    name: 'Fairhaven',
    x: 765,
    y: 450,
    population: 33_000,
    maxPopulation: 520_000,
    prosperity: 54,
    growthRate: 0.0048,
    industries: [{ good: 'goods', rate: 20, stockCap: 300 }],
  },
  {
    key: 'granitefalls',
    name: 'Granite Falls',
    x: 910,
    y: 320,
    population: 21_000,
    maxPopulation: 360_000,
    prosperity: 48,
    growthRate: 0.004,
    industries: [{ good: 'steel', rate: 24, stockCap: 320 }],
  },
])

// ─── Rolling-stock catalogue ───────────────────────────────────────────────

export interface TrainModel {
  id: TrainModelId
  name: string
  era: Era
  baseSpeed: number // km/sim-month before tech/grade modifiers
  capacityPax: number
  capacityFreight: number
  cost: number
  maintenance: number // $/month
}

export const TRAIN_MODELS: readonly TrainModel[] = Object.freeze([
  { id: 'mule', name: 'Mule 0-4-0', era: 'steam', baseSpeed: 60, capacityPax: 40, capacityFreight: 60, cost: 12_000, maintenance: 200 },
  { id: 'ironhorse', name: 'Iron Horse 4-4-0', era: 'steam', baseSpeed: 80, capacityPax: 70, capacityFreight: 90, cost: 24_000, maintenance: 320 },
  { id: 'pioneer', name: 'Pioneer 2-8-0', era: 'steam', baseSpeed: 95, capacityPax: 90, capacityFreight: 140, cost: 38_000, maintenance: 420 },
  { id: 'dh-goods', name: 'DH-Goods Diesel', era: 'diesel', baseSpeed: 120, capacityPax: 60, capacityFreight: 220, cost: 60_000, maintenance: 500 },
  { id: 'zephyr', name: 'Zephyr Streamliner', era: 'diesel', baseSpeed: 150, capacityPax: 170, capacityFreight: 80, cost: 72_000, maintenance: 560 },
  { id: 'sparrow-emu', name: 'Sparrow EMU', era: 'electric', baseSpeed: 175, capacityPax: 210, capacityFreight: 70, cost: 90_000, maintenance: 480 },
  { id: 'shinrai', name: 'Shinrai HSR', era: 'electric', baseSpeed: 245, capacityPax: 290, capacityFreight: 60, cost: 140_000, maintenance: 620 },
  { id: 'maglev-x', name: 'Maglev-X', era: 'maglev', baseSpeed: 360, capacityPax: 360, capacityFreight: 40, cost: 260_000, maintenance: 900 },
])

const MODEL_BY_ID = new Map<TrainModelId, TrainModel>(TRAIN_MODELS.map((m) => [m.id, m]))

export function trainModel(id: TrainModelId): TrainModel {
  const m = MODEL_BY_ID.get(id)
  if (!m) throw new Error(`unknown train model: ${id}`)
  return m
}

// ─── Tech-tree graph ───────────────────────────────────────────────────────

export interface TechSeed {
  id: TechId
  name: string
  era: Era
  cost: number
  prereqs: TechId[]
  unlocksModel: TrainModelId | null
  unlocksGrade: Grade | null
  speedBonus: number
  capacityBonus: number
  maintenanceFactor: number
  extraTrains: number
  desc: string
  x: number
  y: number
}

export const TECH_TREE: readonly TechSeed[] = Object.freeze([
  { id: 'iron-rails', name: 'Iron Rails', era: 'steam', cost: 80, prereqs: [], unlocksModel: 'ironhorse', unlocksGrade: null, speedBonus: 0.05, capacityBonus: 0, maintenanceFactor: 1, extraTrains: 0, desc: 'Wrought-iron rail; faster, sturdier road.', x: 80, y: 60 },
  { id: 'heavy-freight', name: 'Heavy Freight', era: 'steam', cost: 120, prereqs: ['iron-rails'], unlocksModel: 'pioneer', unlocksGrade: 'heavy', speedBonus: 0, capacityBonus: 0.1, maintenanceFactor: 1, extraTrains: 0, desc: 'Reinforced roadbed for heavy consolidation locos.', x: 80, y: 150 },
  { id: 'telegraph', name: 'Telegraph', era: 'steam', cost: 100, prereqs: ['iron-rails'], unlocksModel: null, unlocksGrade: null, speedBonus: 0, capacityBonus: 0, maintenanceFactor: 1, extraTrains: 1, desc: 'Lineside wires let more trains share a line safely.', x: 80, y: 240 },
  { id: 'air-brakes', name: 'Air Brakes', era: 'steam', cost: 140, prereqs: ['heavy-freight'], unlocksModel: null, unlocksGrade: null, speedBonus: 0.05, capacityBonus: 0, maintenanceFactor: 0.95, extraTrains: 0, desc: 'Westinghouse brakes: faster, cheaper to run.', x: 230, y: 150 },
  { id: 'diesel-traction', name: 'Diesel Traction', era: 'diesel', cost: 220, prereqs: ['air-brakes'], unlocksModel: 'dh-goods', unlocksGrade: null, speedBonus: 0.05, capacityBonus: 0.05, maintenanceFactor: 1, extraTrains: 0, desc: 'Compression-ignition power ends the steam age.', x: 380, y: 150 },
  { id: 'streamlining', name: 'Streamlining', era: 'diesel', cost: 260, prereqs: ['diesel-traction'], unlocksModel: 'zephyr', unlocksGrade: null, speedBonus: 0.1, capacityBonus: 0, maintenanceFactor: 1, extraTrains: 0, desc: 'Aerodynamic shells for record-breaking flyers.', x: 530, y: 90 },
  { id: 'signaling-ctc', name: 'Centralized Traffic Control', era: 'electric', cost: 300, prereqs: ['telegraph', 'diesel-traction'], unlocksModel: null, unlocksGrade: null, speedBonus: 0, capacityBonus: 0.05, maintenanceFactor: 1, extraTrains: 2, desc: 'Dispatcher-controlled signals pack lines tight.', x: 380, y: 260 },
  { id: 'electrification', name: 'Electrification', era: 'electric', cost: 360, prereqs: ['streamlining'], unlocksModel: 'sparrow-emu', unlocksGrade: 'electrified', speedBonus: 0.05, capacityBonus: 0.05, maintenanceFactor: 0.95, extraTrains: 0, desc: 'Overhead catenary; clean, fast multiple units.', x: 680, y: 90 },
  { id: 'welded-rail', name: 'Continuous Welded Rail', era: 'electric', cost: 320, prereqs: ['air-brakes'], unlocksModel: null, unlocksGrade: null, speedBonus: 0.05, capacityBonus: 0, maintenanceFactor: 0.9, extraTrains: 0, desc: 'Jointless rail: smoother, far cheaper upkeep.', x: 230, y: 320 },
  { id: 'high-speed', name: 'High-Speed Rail', era: 'electric', cost: 480, prereqs: ['electrification', 'signaling-ctc'], unlocksModel: 'shinrai', unlocksGrade: null, speedBonus: 0.15, capacityBonus: 0, maintenanceFactor: 1, extraTrains: 0, desc: 'Dedicated 250 km/h passenger corridors.', x: 680, y: 200 },
  { id: 'tunneling', name: 'Tunnelling', era: 'electric', cost: 280, prereqs: ['heavy-freight'], unlocksModel: null, unlocksGrade: null, speedBonus: 0, capacityBonus: 0.05, maintenanceFactor: 1, extraTrains: 1, desc: 'Bores straighten the road and add capacity.', x: 230, y: 410 },
  { id: 'maglev', name: 'Magnetic Levitation', era: 'maglev', cost: 700, prereqs: ['high-speed', 'welded-rail'], unlocksModel: 'maglev-x', unlocksGrade: 'maglev', speedBonus: 0.2, capacityBonus: 0.05, maintenanceFactor: 1, extraTrains: 0, desc: 'Frictionless levitation; the dynasty\'s apex.', x: 680, y: 320 },
])

const TECH_BY_ID = new Map<TechId, TechSeed>(TECH_TREE.map((t) => [t.id, t]))

export function techSeed(id: TechId): TechSeed {
  const t = TECH_BY_ID.get(id)
  if (!t) throw new Error(`unknown tech: ${id}`)
  return t
}

// ─── Heir traits ───────────────────────────────────────────────────────────
// Drawn (seeded) at each generational turnover; each biases the new heir's
// economics. Kept here so the generations system stays data-driven.

export interface HeirProfile {
  fareBias: number // multiplier applied to fareMult on succession
  freightBias: number
  approvalBias: number // additive to approval
  researchBias: number // multiplier on researchRate
  cashGift: number // inherited capital injection
}

export const HEIR_TRAITS = Object.freeze({
  engineer: { fareBias: 1, freightBias: 1.05, approvalBias: 0, researchBias: 1.2, cashGift: 0 },
  tycoon: { fareBias: 1.1, freightBias: 1.1, approvalBias: -5, researchBias: 0.9, cashGift: 40_000 },
  diplomat: { fareBias: 1, freightBias: 1, approvalBias: 12, researchBias: 1, cashGift: 0 },
  visionary: { fareBias: 1.05, freightBias: 1, approvalBias: 2, researchBias: 1.35, cashGift: -10_000 },
  spendthrift: { fareBias: 0.95, freightBias: 0.95, approvalBias: 5, researchBias: 0.85, cashGift: -25_000 },
} satisfies Record<string, HeirProfile>)

// ─── Policies ──────────────────────────────────────────────────────────────
// One-shot political levers enacted via a Command. Effects are applied by the
// command resolver; costs are immediate.

export interface PolicyEffect {
  name: string
  cost: number
  approval: number // additive
  reputation: number // additive
  regulation: number // additive
  desc: string
}

export const POLICIES: Readonly<Record<PolicyId, PolicyEffect>> = Object.freeze({
  'safety-board': { name: 'Railway Safety Board', cost: 20_000, approval: 8, reputation: 10, regulation: 12, desc: 'Buys public trust at the price of red tape.' },
  'green-initiative': { name: 'Green Initiative', cost: 30_000, approval: 6, reputation: 14, regulation: 6, desc: 'Electrify and plant; the press approves.' },
  'lobby-campaign': { name: 'Lobby Campaign', cost: 25_000, approval: 12, reputation: -6, regulation: -10, desc: 'Grease the legislature; cut your own leash.' },
  austerity: { name: 'Austerity Drive', cost: 0, approval: -10, reputation: -8, regulation: -4, desc: 'Slash spending; markets cheer, workers don\'t.' },
  'public-works': { name: 'Public Works Pact', cost: 45_000, approval: 14, reputation: 12, regulation: 4, desc: 'Co-fund civic projects for lasting goodwill.' },
})

// ─── Credit rating ladder ──────────────────────────────────────────────────
// Maps a debt-to-equity-ish ratio to a rating + the interest rate it commands.
// Evaluated top-down; first row whose threshold the ratio is <= wins.

export interface CreditTier {
  rating: import('./types.js').CreditRating
  maxRatio: number // debt / max(cash, 1) ceiling for this tier
  rate: number // annual interest fraction
}

export const CREDIT_LADDER: readonly CreditTier[] = Object.freeze([
  { rating: 'AAA', maxRatio: 0.25, rate: 0.05 },
  { rating: 'AA', maxRatio: 0.5, rate: 0.06 },
  { rating: 'A', maxRatio: 1, rate: 0.08 },
  { rating: 'BBB', maxRatio: 2, rate: 0.1 },
  { rating: 'BB', maxRatio: 3.5, rate: 0.13 },
  { rating: 'B', maxRatio: 5, rate: 0.16 },
  { rating: 'CCC', maxRatio: 8, rate: 0.2 },
  { rating: 'D', maxRatio: Infinity, rate: 0.26 },
])
