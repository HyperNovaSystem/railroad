// Iron Dynasty — pure economic functions. No world, no RNG, no mutation:
// just deterministic math the systems call. Unit-testable in isolation.

import {
  CREDIT_LADDER,
  ECONOMY,
  GRADE_BUILD_MULT,
  GRADE_SPEED_CAP,
  GRADE_ORDER,
  gradeRank,
  trainModel,
} from './data.js'
import type { TechNodeState, TreasuryState } from './components.js'
import type { CreditRating, Grade, TrainModelId } from './types.js'

/** Effective monthly track speed: model base × tech multiplier, capped by grade. */
export function effectiveSpeedKm(model: TrainModelId, speedMult: number, grade: Grade): number {
  const base = trainModel(model).baseSpeed * speedMult
  return Math.min(base, GRADE_SPEED_CAP[grade])
}

/** Effective hauling capacity after the tech capacity multiplier. */
export function trainCapacity(
  model: TrainModelId,
  capacityMult: number,
): { pax: number; freight: number } {
  const m = trainModel(model)
  return {
    pax: Math.round(m.capacityPax * capacityMult),
    freight: Math.round(m.capacityFreight * capacityMult),
  }
}

/** Cost to lay a line of `length` km at `grade`, plus any stations to build. */
export function lineBuildCost(length: number, grade: Grade, stationsToBuild: number): number {
  const track = length * ECONOMY.costPerKm * GRADE_BUILD_MULT[grade]
  return Math.round(track + stationsToBuild * ECONOMY.stationBuildCost)
}

/** Straight-line distance (treated as km) between two screen points. */
export function distanceKm(ax: number, ay: number, bx: number, by: number): number {
  return Math.round(Math.hypot(bx - ax, by - ay))
}

/** Pick the credit tier (rating + interest) for a debt/cash position. */
export function creditTierFor(debt: number, cash: number): { rating: CreditRating; rate: number } {
  if (debt <= 0) return { rating: 'AAA', rate: CREDIT_LADDER[0]!.rate }
  const ratio = debt / Math.max(cash, 1)
  for (const tier of CREDIT_LADDER) {
    if (ratio <= tier.maxRatio) return { rating: tier.rating, rate: tier.rate }
  }
  const last = CREDIT_LADDER[CREDIT_LADDER.length - 1]!
  return { rating: last.rating, rate: last.rate }
}

/** Aggregate tech modifiers folded into the Treasury when research lands. */
export interface TechModifiers {
  speedMult: number
  capacityMult: number
  maintenanceMult: number
  bonusTrains: number
  unlockedModels: TrainModelId[]
  maxGrade: Grade
}

/** Recompute Treasury tech modifiers from the full set of TechNode states. */
export function recomputeTechMods(techStates: readonly TechNodeState[]): TechModifiers {
  let speedMult = 1
  let capacityMult = 1
  let maintenanceMult = 1
  let bonusTrains = 0
  const unlocked = new Set<TrainModelId>(['mule'])
  let maxGrade: Grade = 'standard'
  for (const t of techStates) {
    if (!t.researched) continue
    speedMult += t.speedBonus
    capacityMult += t.capacityBonus
    maintenanceMult *= t.maintenanceFactor
    bonusTrains += t.extraTrains
    if (t.unlocksModel) unlocked.add(t.unlocksModel)
    if (t.unlocksGrade && gradeRank(t.unlocksGrade) > gradeRank(maxGrade)) maxGrade = t.unlocksGrade
  }
  // Stable, era-ordered model list for reproducible snapshots/UI.
  const unlockedModels = orderModels(unlocked)
  return {
    speedMult: round4(speedMult),
    capacityMult: round4(capacityMult),
    maintenanceMult: round4(maintenanceMult),
    bonusTrains,
    unlockedModels,
    maxGrade,
  }
}

const MODEL_ORDER: readonly TrainModelId[] = [
  'mule',
  'ironhorse',
  'pioneer',
  'dh-goods',
  'zephyr',
  'sparrow-emu',
  'shinrai',
  'maglev-x',
]

function orderModels(set: ReadonlySet<TrainModelId>): TrainModelId[] {
  return MODEL_ORDER.filter((m) => set.has(m))
}

/** Effective per-line train cap including tech bonus. */
export function effectiveMaxTrains(baseMaxTrains: number, bonusTrains: number): number {
  return baseMaxTrains + bonusTrains
}

/** Revenue banked when a train unloads pax + freight at a station. */
export function deliveryRevenue(
  loadPax: number,
  loadFreight: number,
  treasury: Pick<TreasuryState, 'fareMult' | 'freightMult'>,
): number {
  const pax = loadPax * ECONOMY.farePerPax * treasury.fareMult
  const freight = loadFreight * ECONOMY.freightPerUnit * treasury.freightMult
  return Math.round(pax + freight)
}

/** Highest grade index — exported for UI gating. */
export function maxGradeRank(): number {
  return GRADE_ORDER.length - 1
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000
}
