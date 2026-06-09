import { describe, expect, it } from 'vitest'
import { Faulted, type Entity } from '@domecs/core'
import { createMemoryStorage, load, save } from '@domecs/persist'
import {
  City,
  ECONOMY,
  RailLine,
  Station,
  TechNode,
  Train,
  conditionSpeedFactor,
  createRailroad,
  creditTierFor,
  effectiveSpeedKm,
  lineMaintainCost,
  recomputeTechMods,
  snapshotHash,
  type RailroadRefs,
} from '../src/index.js'

const TEST_SEED = 0xc0ffee

function fresh(overrides = {}): RailroadRefs {
  return createRailroad({ seed: TEST_SEED, headless: true, idle: true, ...overrides })
}

function connect(r: RailroadRefs, fromKey: string, toKey: string) {
  const from = r.cityByKey.get(fromKey) as Entity
  const to = r.cityByKey.get(toKey) as Entity
  const accepted = r.command({ kind: 'build-line', from, to })
  return { accepted, from, to, line: r.lineBetween(from, to) as Entity }
}

describe('map construction', () => {
  it('spawns every city and tech node with valid starting treasury', () => {
    const r = fresh()
    expect(r.cityIds.length).toBe(7)
    expect(r.techIds.length).toBe(12)
    const t = r.treasury()
    expect(t.cash).toBe(150_000)
    expect(t.year).toBe(1880)
    expect(t.era).toBe('steam')
    expect(t.unlockedModels).toEqual(['mule'])
  })

  it('runs the once-scheduled founding system on first step', () => {
    const r = fresh()
    expect(r.treasury().eventLog.some((e) => e.includes('founded'))).toBe(false)
    r.advanceMonths(1)
    expect(r.treasury().eventLog.some((e) => e.includes('founded'))).toBe(true)
  })
})

describe('building the network', () => {
  it('builds a line, raising stations and charging the treasury', () => {
    const r = fresh()
    const cashBefore = r.treasury().cash
    const { accepted, from, to, line } = connect(r, 'ashford', 'brightwater')
    expect(accepted).toBe(true)
    expect(line).not.toBeNull()
    expect(r.treasury().cash).toBeLessThan(cashBefore)
    expect(r.world.getComponent(from, City)?.hasStation).toBe(true)
    expect(r.world.getComponent(to, City)?.hasStation).toBe(true)
    expect(r.stationIds().length).toBe(2)
  })

  it('rejects duplicate, self, and unaffordable lines', () => {
    const r = fresh()
    connect(r, 'ashford', 'brightwater')
    expect(connect(r, 'ashford', 'brightwater').accepted).toBe(false)
    const a = r.cityByKey.get('ashford') as Entity
    expect(r.command({ kind: 'build-line', from: a, to: a })).toBe(false)
    const poor = fresh({ startCash: 1_000 })
    const p1 = poor.cityByKey.get('ashford') as Entity
    const p2 = poor.cityByKey.get('granitefalls') as Entity
    expect(poor.command({ kind: 'build-line', from: p1, to: p2 })).toBe(false)
    expect(poor.treasury().lastError).toMatch(/insufficient/)
  })
})

describe('rolling stock and revenue', () => {
  it('buys a train onto a line and refuses locked models', () => {
    const r = fresh()
    const { line } = connect(r, 'ashford', 'brightwater')
    expect(r.command({ kind: 'buy-train', model: 'ironhorse', line, cargo: 'passengers' })).toBe(false)
    const cashBefore = r.treasury().cash
    expect(r.command({ kind: 'buy-train', model: 'mule', line, cargo: 'passengers' })).toBe(true)
    expect(r.trainIds().length).toBe(1)
    expect(r.world.getComponent(line, RailLine)?.trainCount).toBe(1)
    expect(r.treasury().cash).toBe(cashBefore - 12_000)
  })

  it('earns revenue once trains complete deliveries', () => {
    const r = fresh()
    const { line } = connect(r, 'ashford', 'brightwater')
    r.command({ kind: 'buy-train', model: 'mule', line, cargo: 'coal' })
    expect(r.treasury().totalRevenue).toBe(0)
    r.advanceMonths(18)
    expect(r.treasury().totalRevenue).toBeGreaterThan(0)
    expect(r.treasury().trainsDelivered).toBeGreaterThan(0)
  })

  it('enforces per-line train capacity', () => {
    const r = fresh({ startCash: 5_000_000 })
    const { line } = connect(r, 'ashford', 'brightwater')
    expect(r.command({ kind: 'buy-train', model: 'mule', line, cargo: 'goods' })).toBe(true)
    expect(r.command({ kind: 'buy-train', model: 'mule', line, cargo: 'goods' })).toBe(true)
    // base maxTrains is 2 → the third is refused
    expect(r.command({ kind: 'buy-train', model: 'mule', line, cargo: 'goods' })).toBe(false)
    expect(r.treasury().lastError).toMatch(/capacity/)
  })
})

describe('finance, loans, and the reactive credit rating', () => {
  it('accrues interest and worsens the credit rating after borrowing', () => {
    const r = fresh()
    r.advanceMonths(1) // settle initial AAA (no debt) via the reactive system
    const rateBefore = r.treasury().interestRate
    expect(r.treasury().creditRating).toBe('AAA')
    expect(r.command({ kind: 'take-loan', amount: 450_000 })).toBe(true)
    expect(r.treasury().debt).toBe(450_000)
    expect(r.treasury().creditRating).not.toBe('AAA')
    expect(r.treasury().interestRate).toBeGreaterThan(rateBefore)
  })

  it('charges monthly maintenance that draws down idle cash', () => {
    const r = fresh()
    const { line } = connect(r, 'ashford', 'coalridge')
    r.command({ kind: 'buy-train', model: 'mule', line, cargo: 'coal' })
    const cash0 = r.treasury().cash
    const expenses0 = r.treasury().totalExpenses
    r.advanceMonths(6)
    expect(r.treasury().totalExpenses).toBeGreaterThan(expenses0)
    // expenses strictly grew regardless of revenue timing
    expect(r.treasury().cash).not.toBe(cash0)
  })
})

describe('research, unlocks, and the reactive tech path', () => {
  it('completes research and unlocks a model that can then be purchased', () => {
    const r = fresh()
    const { line } = connect(r, 'ashford', 'brightwater')
    expect(r.command({ kind: 'buy-train', model: 'ironhorse', line, cargo: 'passengers' })).toBe(false)
    expect(r.command({ kind: 'research', tech: 'iron-rails' })).toBe(true)
    // cost 80 at 12/month → completes within 7 months
    r.advanceMonths(7)
    const node = r.techByTech.get('iron-rails') as Entity
    expect(r.world.getComponent(node, TechNode)?.researched).toBe(true)
    expect(r.treasury().unlockedModels).toContain('ironhorse')
    expect(r.treasury().speedMult).toBeGreaterThan(1)
    expect(r.command({ kind: 'buy-train', model: 'ironhorse', line, cargo: 'passengers' })).toBe(true)
  })

  it('refuses research whose prerequisites are unmet', () => {
    const r = fresh()
    expect(r.command({ kind: 'research', tech: 'diesel-traction' })).toBe(false)
    expect(r.treasury().lastError).toMatch(/requires/)
  })
})

describe('politics and generations are deterministic', () => {
  it('fires a seeded annual political event at a known tick', () => {
    const r = fresh()
    r.advanceMonths(12) // → January 1881
    const political = r.treasury().eventLog.filter((e) => /of 1881\.$/.test(e))
    expect(political.length).toBe(1)
    // same seed reproduces the exact same outcome
    const r2 = fresh()
    r2.advanceMonths(12)
    expect(r2.treasury().eventLog.filter((e) => /of 1881\.$/.test(e))).toEqual(political)
  })

  it('turns over a generation on schedule and draws an heir', () => {
    const r = fresh({ generationLengthYears: 2 })
    expect(r.treasury().generation).toBe(1)
    r.advanceMonths(24) // two years → succession
    expect(r.treasury().generation).toBeGreaterThanOrEqual(2)
    expect(r.treasury().eventLog.some((e) => /takes the helm/.test(e))).toBe(true)
  })
})

describe('determinism and persistence', () => {
  function play(seed: number): string {
    const r = createRailroad({ seed, headless: true, idle: true, generationLengthYears: 1 })
    const { line } = connect(r, 'ashford', 'coalridge')
    r.command({ kind: 'buy-train', model: 'mule', line, cargo: 'coal' })
    r.advanceMonths(18)
    r.command({ kind: 'take-loan', amount: 50_000 })
    r.advanceMonths(6)
    return snapshotHash(r.world.snapshot())
  }

  it('produces identical snapshots for identical seed + command streams', () => {
    expect(play(11)).toBe(play(11))
  })

  it('diverges for different seeds (RNG-driven heirs/politics)', () => {
    expect(play(11)).not.toBe(play(22))
  })

  it('keeps simulating correctly after loading a save into a fresh boot', () => {
    const a = createRailroad({ seed: 7, headless: true, idle: true })
    connect(a, 'ashford', 'brightwater')
    const storage = createMemoryStorage()
    expect(save(a.world, storage, 'slot1').ok).toBe(true)

    const b = createRailroad({ seed: 7, headless: true, idle: true })
    expect(load(b.world, storage, 'slot1').ok).toBe(true)
    // The cities system must find the restored stations (the lookup is derived
    // from world state, not a boot-time closure) and keep feeding them.
    b.advanceMonths(2)
    const anyPax = b.stationIds().some((id) => {
      const st = b.world.getComponent(id, Station)
      return st !== undefined && st.paxQueue > 0
    })
    expect(anyPax).toBe(true)
    // And building onward from a restored city must reuse its station.
    const from = b.cityByKey.get('ashford') as Entity
    const to = b.cityByKey.get('coalridge') as Entity
    expect(b.command({ kind: 'build-line', from, to })).toBe(true)
    expect(b.stationIds().length).toBe(3)
  })

  it('round-trips through @domecs/persist with an identical hash', () => {
    const a = createRailroad({ seed: 7, headless: true, idle: true })
    const { line } = connect(a, 'ashford', 'brightwater')
    a.command({ kind: 'buy-train', model: 'mule', line, cargo: 'goods' })
    a.advanceMonths(12)
    const hashA = snapshotHash(a.world.snapshot())

    const storage = createMemoryStorage()
    expect(save(a.world, storage, 'slot1').ok).toBe(true)

    const b = createRailroad({ seed: 7, headless: true, idle: true })
    expect(load(b.world, storage, 'slot1').ok).toBe(true)
    expect(snapshotHash(b.world.snapshot())).toBe(hashA)
  })
})

describe('errors-as-data: station overload surfaces a Faulted', () => {
  it('flags a saturated station with a station-overloaded fault', () => {
    const r = fresh()
    connect(r, 'ashford', 'brightwater') // stations, but no trains to drain them
    r.advanceMonths(18)
    const overloaded = r.stationIds().some((id) => {
      const f = r.world.getComponent(id, Faulted)
      return f?.faults.some((x) => x.kind === 'railroad/station-overloaded') ?? false
    })
    expect(overloaded).toBe(true)
    // the saturated station is, in fact, at capacity
    const saturated = r.stationIds().some((id) => {
      const st = r.world.getComponent(id, Station)
      return st !== undefined && st.paxQueue >= st.capacity
    })
    expect(saturated).toBe(true)
  })
})

describe('track condition and maintenance', () => {
  it('worn track slows trains; maintain-line restores it for a fee', () => {
    const r = fresh()
    const { line } = connect(r, 'ashford', 'brightwater')
    r.advanceMonths(12) // 0.4/month decay
    const worn = r.world.getComponent(line, RailLine)!
    expect(worn.condition).toBeLessThan(100)
    const cost = lineMaintainCost(worn.length, worn.condition)
    expect(cost).toBeGreaterThan(0)
    const cashBefore = r.treasury().cash
    expect(r.command({ kind: 'maintain-line', line })).toBe(true)
    expect(r.world.getComponent(line, RailLine)!.condition).toBe(100)
    expect(r.treasury().cash).toBe(cashBefore - cost)
    // a pristine line has nothing to maintain
    expect(r.command({ kind: 'maintain-line', line })).toBe(false)
    expect(r.treasury().lastError).toMatch(/perfect condition/)
  })

  it('scales speed linearly from 1.0 (pristine) to 0.5 (worn out)', () => {
    expect(conditionSpeedFactor(100)).toBe(1)
    expect(conditionSpeedFactor(50)).toBe(0.75)
    expect(conditionSpeedFactor(0)).toBe(0.5)
    expect(conditionSpeedFactor(-10)).toBe(0.5) // clamped
  })
})

describe('cargo configuration matters', () => {
  function everLoadedFreight(r: RailroadRefs, train: Entity, months: number): boolean {
    for (let i = 0; i < months; i++) {
      r.advanceMonths(1)
      const tr = r.world.getComponent(train, Train)
      if (tr && tr.loadFreight > 0) return true
    }
    return false
  }

  it('loads freight only when the station good matches the train cargo', () => {
    const r = fresh({ startCash: 500_000 })
    const { line } = connect(r, 'ashford', 'coalridge') // coalridge produces coal
    r.command({ kind: 'buy-train', model: 'mule', line, cargo: 'coal' })
    r.command({ kind: 'buy-train', model: 'mule', line, cargo: 'mail' })
    const [coalTrain, mailTrain] = r.trainIds() as [Entity, Entity]
    expect(everLoadedFreight(r, coalTrain, 24)).toBe(true)
    expect(everLoadedFreight(r, mailTrain, 24)).toBe(false) // nothing ships mail here
    // the configured cargo is the player's choice; arrivals don't overwrite it
    expect(r.world.getComponent(coalTrain, Train)?.cargo).toBe('coal')
    expect(r.world.getComponent(mailTrain, Train)?.cargo).toBe('mail')
  })
})

describe('retirement', () => {
  it('retires the dynasty once the legacy goal is reached', () => {
    const r = fresh()
    r.treasury().legacyScore = ECONOMY.retirementLegacy // live, mutable resource
    r.advanceMonths(1)
    expect(r.treasury().status).toBe('retired')
    expect(r.treasury().eventLog.some((e) => /retires in glory/.test(e))).toBe(true)
    // a retired dynasty accepts no further commands
    const a = r.cityByKey.get('ashford') as Entity
    const b = r.cityByKey.get('brightwater') as Entity
    expect(r.command({ kind: 'build-line', from: a, to: b })).toBe(false)
  })
})

describe('pure economics', () => {
  it('maps debt/cash positions onto the credit ladder', () => {
    expect(creditTierFor(0, 100_000).rating).toBe('AAA')
    expect(creditTierFor(50_000, 100_000).rating).toBe('AA')
    expect(creditTierFor(300_000, 100_000).rating).toBe('BB') // ratio 3.0
    expect(creditTierFor(400_000, 100_000).rating).toBe('B') // ratio 4.0
  })

  it('caps train speed by track grade', () => {
    // a maglev-X (base 360) is throttled to the standard-grade cap of 100
    expect(effectiveSpeedKm('maglev-x', 1, 'standard')).toBe(100)
    expect(effectiveSpeedKm('mule', 1, 'maglev')).toBe(60)
  })

  it('folds researched tech into stacked modifiers', () => {
    const base = recomputeTechMods([])
    expect(base.speedMult).toBe(1)
    expect(base.unlockedModels).toEqual(['mule'])
  })
})
