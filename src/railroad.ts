// Iron Dynasty — world factory. Spawns the starting map + tech tree, wires
// every DOMECS schedule (once / fixed / event / reactive / tick), and exposes
// a small imperative surface (command(), advanceMonths(), queries) for the UI
// and tests. One fixed step == one sim-month; 12 months == one year.

import {
  Changed,
  ChangedResource,
  createWorld,
  entry,
  Faulted,
  type Entity,
  type SystemFault,
  type SystemResult,
  type World,
  type WorldSnapshot,
} from '@domecs/core'
import { createSnapshotHistory, type SnapshotHistory } from '@domecs/persist'
import {
  City,
  CommandEvent,
  Industry,
  RailLine,
  Render,
  Station,
  TechNode,
  Train,
  Treasury,
  freshTreasury,
  type Command,
  type Grade,
  type TreasuryState,
} from './components.js'
import {
  ECONOMY,
  GRADE_BUILD_MULT,
  HEIR_TRAITS,
  MAP_CITIES,
  POLICIES,
  TECH_TREE,
  eraForYear,
  gradeRank,
  trainModel,
} from './data.js'
import {
  creditTierFor,
  deliveryRevenue,
  distanceKm,
  effectiveMaxTrains,
  effectiveSpeedKm,
  lineBuildCost,
  recomputeTechMods,
  trainCapacity,
} from './economy.js'
import type { Good, HeirTrait, PolicyId, TrainModelId } from './types.js'

// ─── Public surface ──────────────────────────────────────────────────────

export interface RailroadOptions {
  seed?: number
  startCash?: number
  foundingYear?: number
  generationLengthYears?: number
  /** Real seconds per sim-month when driven by world.start(). Tests step manually. */
  fixedStep?: number
  headless?: boolean
  /** Keep the RAF driver parked (tests + deterministic stepping). Default true. */
  idle?: boolean
}

export interface RailroadRefs {
  world: World
  cityIds: readonly Entity[]
  techIds: readonly Entity[]
  cityByKey: ReadonlyMap<string, Entity>
  techByTech: ReadonlyMap<string, Entity>
  history: SnapshotHistory
  /** Dispatch a Command; returns whether it was accepted (no lastError set). */
  command(cmd: Command): boolean
  /** Current Treasury value (live, mutable). */
  treasury(): TreasuryState
  /** Advance `n` whole sim-months deterministically. */
  advanceMonths(n: number): void
  lineBetween(a: Entity, b: Entity): Entity | null
  stationAt(city: Entity): Entity | null
  trainIds(): Entity[]
  lineIds(): Entity[]
  stationIds(): Entity[]
}

/** App-level fault surfaced as data on a Station entity. */
export type RailroadFault = {
  kind: 'railroad/station-overloaded'
  city: string
  queue: number
}

const DEFAULT_SEED = 0x1_2071
const PASSENGER_RATE = 0.0006 // monthly pax generated per capita (× prosperity)
const EVENT_LOG_CAP = 40
const TRAIT_KEYS = Object.keys(HEIR_TRAITS) as HeirTrait[]

export function createRailroad(options: RailroadOptions = {}): RailroadRefs {
  const seed = (Math.trunc(options.seed ?? DEFAULT_SEED) >>> 0) || DEFAULT_SEED
  const world = createWorld({
    seed,
    headless: options.headless ?? false,
    fixedStep: options.fixedStep ?? 1, // 1 fixed step = 1 sim-month
    idle: options.idle ?? true,
  })

  // ── Treasury (resource) seeded from options ──────────────────────────
  const treasuryState = freshTreasury()
  if (options.startCash !== undefined) treasuryState.cash = options.startCash
  if (options.foundingYear !== undefined) {
    treasuryState.foundingYear = options.foundingYear
    treasuryState.year = options.foundingYear
    treasuryState.era = eraForYear(options.foundingYear)
  }
  if (options.generationLengthYears !== undefined) {
    treasuryState.generationLengthYears = options.generationLengthYears
  }
  treasuryState.researchRate = ECONOMY.researchPerMonthBase
  world.setResource(Treasury, treasuryState)

  // ── Map: cities + their industries ───────────────────────────────────
  const cityIds: Entity[] = []
  const cityByKey = new Map<string, Entity>()
  for (const seed of MAP_CITIES) {
    const id = world.spawn([
      entry(
        City,
        City.create({
          name: seed.name,
          x: seed.x,
          y: seed.y,
          population: seed.population,
          maxPopulation: seed.maxPopulation,
          prosperity: seed.prosperity,
          growthRate: seed.growthRate,
          hasStation: false,
        }),
      ),
    ])
    cityIds.push(id)
    cityByKey.set(seed.key, id)
    for (const ind of seed.industries) {
      world.spawn([
        entry(
          Industry,
          Industry.create({ city: id, good: ind.good, rate: ind.rate, stockCap: ind.stockCap }),
        ),
      ])
    }
  }

  // ── Tech tree ────────────────────────────────────────────────────────
  const techIds: Entity[] = []
  const techByTech = new Map<string, Entity>()
  for (const t of TECH_TREE) {
    const id = world.spawn([
      entry(
        TechNode,
        TechNode.create({
          tech: t.id,
          name: t.name,
          era: t.era,
          cost: t.cost,
          prereqs: t.prereqs.slice(),
          unlocksModel: t.unlocksModel,
          unlocksGrade: t.unlocksGrade,
          speedBonus: t.speedBonus,
          capacityBonus: t.capacityBonus,
          maintenanceFactor: t.maintenanceFactor,
          extraTrains: t.extraTrains,
          desc: t.desc,
          x: t.x,
          y: t.y,
        }),
      ),
    ])
    techIds.push(id)
    techByTech.set(t.id, id)
  }

  const stationByCity = new Map<Entity, Entity>()
  let trainSeq = 0

  // ── Helpers ──────────────────────────────────────────────────────────
  const t = (): TreasuryState => world.resource(Treasury) as TreasuryState

  function log(message: string): void {
    const s = t()
    s.eventLog.push(message)
    if (s.eventLog.length > EVENT_LOG_CAP) s.eventLog.splice(0, s.eventLog.length - EVENT_LOG_CAP)
  }

  function reject(message: string): false {
    t().lastError = message
    world.markResourceChanged(Treasury)
    return false
  }

  function ensureStation(city: Entity): Entity {
    const existing = stationByCity.get(city)
    if (existing !== undefined) return existing
    const cityState = world.getComponent(city, City)
    const good = dominantGood(city)
    const id = world.spawn([
      entry(Station, Station.create({ city, level: 1, capacity: 200, good })),
    ])
    stationByCity.set(city, id)
    if (cityState) {
      cityState.hasStation = true
      world.markChanged(city, City)
    }
    return id
  }

  function dominantGood(city: Entity): Good {
    for (const { value } of world.entitiesWith(Industry)) {
      if (value.city === city) return value.good
    }
    return 'goods'
  }

  function applyTrainPerf(train: ReturnType<typeof Train.create>, grade: Grade): void {
    const s = t()
    train.speedKm = effectiveSpeedKm(train.model, s.speedMult, grade)
    const cap = trainCapacity(train.model, s.capacityMult)
    train.capacityPax = cap.pax
    train.capacityFreight = cap.freight
  }

  function lineBetween(a: Entity, b: Entity): Entity | null {
    for (const { id, value } of world.entitiesWith(RailLine)) {
      if ((value.from === a && value.to === b) || (value.from === b && value.to === a)) return id
    }
    return null
  }

  function gradeOfLine(line: Entity | null): Grade {
    if (line === null) return 'standard'
    return world.getComponent(line, RailLine)?.grade ?? 'standard'
  }

  // ── Systems ───────────────────────────────────────────────────────────

  // 'once' — founding stamp (exercises the once schedule).
  world.system('founding', { schedule: 'once' }, () => {
    const s = t()
    log(`House Ironwright founded in ${s.foundingYear}.`)
  })

  // 'fixed' calendar (priority 0 → runs first each month).
  world.system('calendar', { schedule: 'fixed', priority: 0 }, () => {
    const s = t()
    if (s.status !== 'playing') return
    s.month += 1
    if (s.month > 12) {
      s.month = 1
      s.year += 1
      s.era = eraForYear(s.year)
    }
    world.markResourceChanged(Treasury)
  })

  // 'fixed' cities — growth + passenger generation + overflow penalty.
  world.system('cities', { schedule: 'fixed', priority: 1 }, () => {
    const s = t()
    if (s.status !== 'playing') return
    for (const { id, value: city } of world.entitiesWith(City)) {
      if (!city.hasStation) continue
      const stationId = stationByCity.get(id)
      if (stationId === undefined) continue
      const station = world.getComponent(stationId, Station)
      if (!station) continue
      // population growth
      const growth = city.growthRate * (city.prosperity / 50)
      city.population = Math.min(city.maxPopulation, Math.round(city.population * (1 + growth)))
      world.markChanged(id, City)
      // passengers
      const generated = Math.round(city.population * PASSENGER_RATE * (city.prosperity / 50))
      station.paxQueue += generated
      if (station.paxQueue > station.capacity) {
        const lost = station.paxQueue - station.capacity
        station.paxQueue = station.capacity
        s.reputation = clamp(s.reputation - Math.min(2, lost / 200), 0, 100)
      }
      world.markChanged(stationId, Station)
    }
    world.markResourceChanged(Treasury)
  })

  // 'fixed' industry — production flows into the host station's freight queue.
  world.system('industry', { schedule: 'fixed', priority: 2 }, () => {
    const s = t()
    if (s.status !== 'playing') return
    for (const { id, value: ind } of world.entitiesWith(Industry)) {
      ind.stockpile = Math.min(ind.stockCap, ind.stockpile + ind.rate)
      const stationId = stationByCity.get(ind.city)
      if (stationId !== undefined) {
        const station = world.getComponent(stationId, Station)
        if (station) {
          const headroom = Math.max(0, station.capacity - station.freightQueue)
          const move = Math.min(ind.stockpile, headroom)
          if (move > 0) {
            station.freightQueue += move
            ind.stockpile -= move
            station.good = ind.good
            world.markChanged(stationId, Station)
          }
        }
      }
      world.markChanged(id, Industry)
    }
  })

  // 'fixed' trains — move, unload (bank revenue), reload.
  world.system('trains', { schedule: 'fixed', priority: 3 }, () => {
    const s = t()
    if (s.status !== 'playing') return
    let banked = 0
    for (const { id, value: tr } of world.entitiesWith(Train)) {
      if (tr.line === null) {
        if (tr.status !== 'idle') {
          tr.status = 'idle'
          world.markChanged(id, Train)
        }
        continue
      }
      const ln = world.getComponent(tr.line, RailLine)
      if (!ln) {
        tr.line = null
        tr.status = 'idle'
        world.markChanged(id, Train)
        continue
      }
      tr.status = 'enroute'
      tr.age += 1
      const atFrom = tr.position <= 0
      const atTo = tr.position >= 1
      if (atFrom || atTo) {
        banked += arrive(tr, id, atFrom ? ln.fromStation : ln.toStation)
        tr.dir = atFrom ? 1 : -1
      }
      const length = Math.max(ln.length, 1)
      tr.position = clamp(tr.position + tr.dir * (tr.speedKm / length), 0, 1)
      world.markChanged(id, Train)
    }
    if (banked > 0) {
      s.cash += banked
      s.totalRevenue += banked
      world.markResourceChanged(Treasury)
    }
  })

  function arrive(tr: ReturnType<typeof Train.create>, id: Entity, stationId: Entity): number {
    let revenue = 0
    if (tr.loadPax > 0 || tr.loadFreight > 0) {
      revenue = deliveryRevenue(tr.loadPax, tr.loadFreight, t())
      tr.haulRevenue += revenue
      tr.deliveries += 1
      t().trainsDelivered += 1
      tr.loadPax = 0
      tr.loadFreight = 0
    }
    const station = world.getComponent(stationId, Station)
    if (station) {
      const pax = Math.min(tr.capacityPax, station.paxQueue)
      station.paxQueue -= pax
      tr.loadPax = pax
      const freight = Math.min(tr.capacityFreight, station.freightQueue)
      station.freightQueue -= freight
      tr.loadFreight = freight
      tr.cargo = station.good
      world.markChanged(stationId, Station)
    }
    void id
    return revenue
  }

  // 'fixed' finance — interest, maintenance, wear, legacy, solvency.
  world.system('finance', { schedule: 'fixed', priority: 4 }, () => {
    const s = t()
    if (s.status !== 'playing') return
    const interest = Math.round((s.debt * s.interestRate) / 12)
    let maintenance = 0
    for (const { value: tr } of world.entitiesWith(Train)) {
      maintenance += tr.maintenance * s.maintenanceMult
    }
    for (const { id, value: ln } of world.entitiesWith(RailLine)) {
      maintenance += ln.length * ECONOMY.maintenancePerKm
      ln.condition = clamp(ln.condition - ECONOMY.conditionDecayPerMonth, 0, 100)
      world.markChanged(id, RailLine)
    }
    const upkeep = interest + Math.round(maintenance)
    s.cash -= upkeep
    s.totalExpenses += upkeep
    s.legacyScore += (ECONOMY.legacyPerYear / 12) * (s.reputation / 50)
    if (s.cash < ECONOMY.bankruptcyFloor) {
      s.status = 'bankrupt'
      log(`The dynasty fell into bankruptcy in ${s.year}.`)
    }
    world.markResourceChanged(Treasury)
  })

  // 'fixed' research — accrue progress toward the active tech.
  world.system('research', { schedule: 'fixed', priority: 5 }, () => {
    const s = t()
    if (s.status !== 'playing' || s.activeResearch === null) return
    const nodeId = techByTech.get(s.activeResearch)
    if (nodeId === undefined) {
      s.activeResearch = null
      return
    }
    const node = world.getComponent(nodeId, TechNode)
    if (!node || node.researched) {
      s.activeResearch = null
      return
    }
    node.progress += s.researchRate
    if (node.progress >= node.cost) {
      node.progress = node.cost
      node.researched = true
      log(`Completed research: ${node.name}.`)
      s.activeResearch = null
    }
    world.markChanged(nodeId, TechNode) // → reactive tech-unlock
    world.markResourceChanged(Treasury)
  })

  // 'fixed' politics — deterministic annual review (seeded RNG).
  world.system('politics', { schedule: 'fixed', priority: 6 }, () => {
    const s = t()
    if (s.status !== 'playing') return
    if (s.month !== 1 || s.year <= s.foundingYear) return
    const roll = world.rand.roll(100) // 1..100, seeded
    if (s.reputation < 40 || roll <= s.regulation) {
      s.regulation = clamp(s.regulation + 5, 0, 100)
      s.approval = clamp(s.approval - 4, 0, 100)
      log(`Regulatory crackdown of ${s.year}.`)
    } else {
      s.approval = clamp(s.approval + 3, 0, 100)
      s.reputation = clamp(s.reputation + 2, 0, 100)
      log(`Public commendation of ${s.year}.`)
    }
    world.markResourceChanged(Treasury)
  })

  // 'fixed' generations — dynastic succession on schedule.
  world.system('generations', { schedule: 'fixed', priority: 7 }, () => {
    const s = t()
    if (s.status !== 'playing') return
    const elapsed = s.year - s.foundingYear
    const expected = Math.floor(elapsed / s.generationLengthYears) + 1
    while (s.generation < expected) succeed(s)
  })

  function succeed(s: TreasuryState): void {
    s.generation += 1
    const trait = world.rand.pick(TRAIT_KEYS) as HeirTrait
    s.heirTrait = trait
    const p = HEIR_TRAITS[trait]
    s.fareMult = round2(s.fareMult * p.fareBias)
    s.freightMult = round2(s.freightMult * p.freightBias)
    s.approval = clamp(s.approval + p.approvalBias, 0, 100)
    s.researchRate = round2(s.researchRate * p.researchBias)
    s.cash += p.cashGift
    s.legacyScore += 50
    log(`Generation ${s.generation}: a ${trait} takes the helm in ${s.year}.`)
    world.markResourceChanged(Treasury)
  }

  // 'fixed' service-monitor — saturated stations surface as Faulted data.
  world.system(
    'service-monitor',
    { schedule: 'fixed', priority: 8 },
    (): SystemResult<RailroadFault> => {
      const errors: SystemFault<RailroadFault>[] = []
      for (const { id, value: station } of world.entitiesWith(Station)) {
        const saturated = station.paxQueue >= station.capacity
        const faulted = world.getComponent(id, Faulted)
        const already = faulted?.faults.some((f) => f.kind === 'railroad/station-overloaded') ?? false
        if (saturated && !already) {
          const cityName = world.getComponent(station.city, City)?.name ?? 'unknown'
          errors.push({
            entity: id,
            component: Station.name,
            error: { kind: 'railroad/station-overloaded', city: cityName, queue: station.paxQueue },
            recoverable: true,
          })
        } else if (!saturated && already) {
          world.removeComponent(id, Faulted)
        }
      }
      return { errors }
    },
  )

  // 'event' command-resolution.
  world.system('command-resolution', { schedule: 'event', triggers: [CommandEvent] }, (ctx) => {
    for (const cmd of ctx.events.of(CommandEvent)) applyCommand(cmd)
  })

  // 'reactive' tech-unlock — fold researched tech into Treasury modifiers.
  world.system('tech-unlock', { schedule: 'reactive', reactsTo: Changed(TechNode) }, () => {
    const states = techIds
      .map((id) => world.getComponent(id, TechNode))
      .filter((n): n is NonNullable<typeof n> => n !== undefined)
    const mods = recomputeTechMods(states)
    const s = t()
    s.speedMult = mods.speedMult
    s.capacityMult = mods.capacityMult
    s.maintenanceMult = mods.maintenanceMult
    s.bonusTrains = mods.bonusTrains
    s.unlockedModels = mods.unlockedModels
    s.maxGrade = mods.maxGrade
    // existing rolling stock benefits immediately
    for (const { id, value: tr } of world.entitiesWith(Train)) {
      applyTrainPerf(tr, gradeOfLine(tr.line))
      world.markChanged(id, Train)
    }
    world.markResourceChanged(Treasury)
  })

  // 'reactive' credit-rating — ChangedResource(Treasury). Idempotent: never
  // re-marks the resource, so it converges and cannot loop.
  world.system(
    'credit-rating',
    { schedule: 'reactive', reactsTo: ChangedResource(Treasury) },
    () => {
      const s = t()
      const { rating, rate } = creditTierFor(s.debt, s.cash)
      s.creditRating = rating
      s.interestRate = rate
    },
  )

  // 'tick' render — transient per-train screen state (excluded from snapshots).
  world.system('render', { schedule: 'tick' }, () => {
    for (const { id, value: tr } of world.entitiesWith(Train)) {
      if (tr.line === null) continue
      const ln = world.getComponent(tr.line, RailLine)
      if (!ln) continue
      const x = ln.fromX + (ln.toX - ln.fromX) * tr.position
      const y = ln.fromY + (ln.toY - ln.fromY) * tr.position
      const angle = Math.atan2((ln.toY - ln.fromY) * tr.dir, (ln.toX - ln.fromX) * tr.dir)
      const kind = `${trainModel(tr.model).era} ${tr.status}`
      if (world.has(id, Render)) {
        const r = world.getComponent(id, Render)
        if (r) {
          r.x = x
          r.y = y
          r.angle = angle
          r.label = tr.name
          r.kind = kind
          world.markChanged(id, Render)
        }
      } else {
        world.addComponent(id, Render, Render.create({ x, y, angle, label: tr.name, kind }))
      }
    }
  })

  // ── Command application ──────────────────────────────────────────────
  function applyCommand(cmd: Command): boolean {
    const s = t()
    if (s.status !== 'playing') return reject('the dynasty is no longer operating')
    switch (cmd.kind) {
      case 'build-line':
        return buildLine(cmd.from, cmd.to)
      case 'buy-train':
        return buyTrain(cmd.model, cmd.line, cmd.cargo, cmd.name)
      case 'assign-train':
        return assignTrain(cmd.train, cmd.line)
      case 'research':
        return beginResearch(cmd.tech)
      case 'take-loan':
        return takeLoan(cmd.amount)
      case 'repay-loan':
        return repayLoan(cmd.amount)
      case 'upgrade-station':
        return upgradeStation(cmd.station)
      case 'upgrade-line':
        return upgradeLine(cmd.line, cmd.grade)
      case 'set-fares':
        return setFares(cmd.fareMult, cmd.freightMult)
      case 'enact-policy':
        return enactPolicy(cmd.policy)
    }
  }

  function buildLine(from: Entity, to: Entity): boolean {
    if (from === to) return reject('a line must connect two distinct cities')
    const a = world.getComponent(from, City)
    const b = world.getComponent(to, City)
    if (!a || !b) return reject('unknown city')
    if (lineBetween(from, to) !== null) return reject('these cities are already connected')
    const length = distanceKm(a.x, a.y, b.x, b.y)
    const stationsToBuild = (stationByCity.has(from) ? 0 : 1) + (stationByCity.has(to) ? 0 : 1)
    const cost = lineBuildCost(length, 'standard', stationsToBuild)
    const s = t()
    if (s.cash < cost) return reject(`insufficient funds: need $${cost}`)
    s.cash -= cost
    s.totalExpenses += cost
    const fromStation = ensureStation(from)
    const toStation = ensureStation(to)
    world.spawn([
      entry(
        RailLine,
        RailLine.create({
          from,
          to,
          fromStation,
          toStation,
          length,
          grade: 'standard',
          condition: 100,
          maxTrains: 2,
          trainCount: 0,
          fromX: a.x,
          fromY: a.y,
          toX: b.x,
          toY: b.y,
        }),
      ),
    ])
    log(`Opened the ${a.name}–${b.name} line (${length} km, $${cost}).`)
    world.markResourceChanged(Treasury)
    return true
  }

  function buyTrain(model: TrainModelId, line: Entity, cargo: Good, name?: string): boolean {
    const s = t()
    if (!s.unlockedModels.includes(model)) return reject(`${model} is not unlocked yet`)
    const ln = world.getComponent(line, RailLine)
    if (!ln) return reject('unknown line')
    if (ln.trainCount >= effectiveMaxTrains(ln.maxTrains, s.bonusTrains)) {
      return reject('line is at train capacity')
    }
    const cost = trainModel(model).cost
    if (s.cash < cost) return reject(`insufficient funds: need $${cost}`)
    s.cash -= cost
    s.totalExpenses += cost
    trainSeq += 1
    const train = Train.create({
      name: name ?? `${trainModel(model).name} #${trainSeq}`,
      model,
      line,
      position: 0,
      dir: 1,
      status: 'enroute',
      cargo,
      maintenance: trainModel(model).maintenance,
    })
    applyTrainPerf(train, ln.grade)
    world.spawn([entry(Train, train)])
    ln.trainCount += 1
    world.markChanged(line, RailLine)
    log(`Commissioned ${train.name} on the line.`)
    world.markResourceChanged(Treasury)
    return true
  }

  function assignTrain(train: Entity, line: Entity): boolean {
    const tr = world.getComponent(train, Train)
    if (!tr) return reject('unknown train')
    const ln = world.getComponent(line, RailLine)
    if (!ln) return reject('unknown line')
    const s = t()
    if (tr.line !== line && ln.trainCount >= effectiveMaxTrains(ln.maxTrains, s.bonusTrains)) {
      return reject('line is at train capacity')
    }
    if (tr.line !== null && tr.line !== line) {
      const old = world.getComponent(tr.line, RailLine)
      if (old) {
        old.trainCount = Math.max(0, old.trainCount - 1)
        world.markChanged(tr.line, RailLine)
      }
    }
    if (tr.line !== line) {
      ln.trainCount += 1
      world.markChanged(line, RailLine)
    }
    tr.line = line
    tr.position = 0
    tr.dir = 1
    tr.status = 'enroute'
    applyTrainPerf(tr, ln.grade)
    world.markChanged(train, Train)
    world.markResourceChanged(Treasury)
    return true
  }

  function beginResearch(tech: string): boolean {
    const nodeId = techByTech.get(tech)
    if (nodeId === undefined) return reject('unknown technology')
    const node = world.getComponent(nodeId, TechNode)
    if (!node) return reject('unknown technology')
    if (node.researched) return reject('already researched')
    for (const pre of node.prereqs) {
      const preId = techByTech.get(pre)
      const preNode = preId === undefined ? undefined : world.getComponent(preId, TechNode)
      if (!preNode?.researched) return reject(`requires ${pre} first`)
    }
    const s = t()
    s.activeResearch = node.tech
    log(`Began research: ${node.name}.`)
    world.markResourceChanged(Treasury)
    return true
  }

  function takeLoan(amount: number): boolean {
    if (!(amount > 0)) return reject('loan amount must be positive')
    const s = t()
    const ceiling = 500_000
    if (s.debt + amount > ceiling) return reject('credit limit reached')
    s.cash += amount
    s.debt += amount
    log(`Borrowed $${amount}.`)
    world.markResourceChanged(Treasury)
    return true
  }

  function repayLoan(amount: number): boolean {
    if (!(amount > 0)) return reject('repayment must be positive')
    const s = t()
    const pay = Math.min(amount, s.debt, Math.max(0, s.cash))
    if (pay <= 0) return reject('nothing to repay or no cash on hand')
    s.cash -= pay
    s.debt -= pay
    log(`Repaid $${pay}.`)
    world.markResourceChanged(Treasury)
    return true
  }

  function upgradeStation(station: Entity): boolean {
    const st = world.getComponent(station, Station)
    if (!st) return reject('unknown station')
    if (st.level >= 5) return reject('station already at maximum level')
    const cost = ECONOMY.stationUpgradeBase * st.level
    const s = t()
    if (s.cash < cost) return reject(`insufficient funds: need $${cost}`)
    s.cash -= cost
    s.totalExpenses += cost
    st.level += 1
    st.capacity += 150
    world.markChanged(station, Station)
    log(`Upgraded a station to level ${st.level}.`)
    world.markResourceChanged(Treasury)
    return true
  }

  function upgradeLine(line: Entity, grade: Grade): boolean {
    const ln = world.getComponent(line, RailLine)
    if (!ln) return reject('unknown line')
    const s = t()
    if (gradeRank(grade) <= gradeRank(ln.grade)) return reject('line is already at least this grade')
    if (gradeRank(grade) > gradeRank(s.maxGrade)) return reject(`${grade} track is not unlocked`)
    const cost = Math.round(ln.length * ECONOMY.costPerKm * (GRADE_BUILD_MULT[grade] - 1))
    if (s.cash < cost) return reject(`insufficient funds: need $${cost}`)
    s.cash -= cost
    s.totalExpenses += cost
    ln.grade = grade
    ln.condition = 100
    world.markChanged(line, RailLine)
    for (const { id, value: tr } of world.entitiesWith(Train)) {
      if (tr.line === line) {
        applyTrainPerf(tr, grade)
        world.markChanged(id, Train)
      }
    }
    log(`Upgraded a line to ${grade} grade.`)
    world.markResourceChanged(Treasury)
    return true
  }

  function setFares(fareMult: number, freightMult: number): boolean {
    const s = t()
    s.fareMult = clamp(fareMult, 0.5, 2)
    s.freightMult = clamp(freightMult, 0.5, 2)
    // gouging erodes goodwill; generosity restores it
    s.reputation = clamp(s.reputation - (s.fareMult - 1) * 6, 0, 100)
    log(`Set fares ×${s.fareMult.toFixed(2)} / freight ×${s.freightMult.toFixed(2)}.`)
    world.markResourceChanged(Treasury)
    return true
  }

  function enactPolicy(policy: PolicyId): boolean {
    const eff = POLICIES[policy]
    const s = t()
    if (s.cash < eff.cost) return reject(`insufficient funds: need $${eff.cost}`)
    s.cash -= eff.cost
    s.totalExpenses += eff.cost
    s.approval = clamp(s.approval + eff.approval, 0, 100)
    s.reputation = clamp(s.reputation + eff.reputation, 0, 100)
    s.regulation = clamp(s.regulation + eff.regulation, 0, 100)
    log(`Enacted policy: ${eff.name}.`)
    world.markResourceChanged(Treasury)
    return true
  }

  // ── History (exercises @domecs/persist createSnapshotHistory) ─────────
  const history = createSnapshotHistory(world, { limit: 200, captureInitial: true })

  // ── Public refs ──────────────────────────────────────────────────────
  const refs: RailroadRefs = {
    world,
    cityIds,
    techIds,
    cityByKey,
    techByTech,
    history,
    command(cmd) {
      const before = t()
      before.lastError = ''
      world.turn(CommandEvent, cmd)
      const accepted = t().lastError === ''
      if (accepted) history.push()
      return accepted
    },
    treasury: () => t(),
    advanceMonths(n) {
      world.stepN(Math.max(0, Math.trunc(n)), 1)
    },
    lineBetween,
    stationAt: (city) => stationByCity.get(city) ?? null,
    trainIds: () => [...world.entitiesWith(Train)].map((e) => e.id),
    lineIds: () => [...world.entitiesWith(RailLine)].map((e) => e.id),
    stationIds: () => [...world.entitiesWith(Station)].map((e) => e.id),
  }
  return refs
}

/** Stable hash of a world snapshot for determinism assertions. */
export function snapshotHash(snapshot: WorldSnapshot): string {
  return JSON.stringify(snapshot)
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
function round2(n: number): number {
  return Math.round(n * 100) / 100
}
