import { describe, expect, it } from 'vitest'
import type { Entity } from '@domecs/core'
import {
  TUTORIAL_STEPS,
  createRailroad,
  tutorialProgress,
  type RailroadRefs,
} from '../src/index.js'

const TEST_SEED = 0xc0ffee

function fresh(overrides = {}): RailroadRefs {
  return createRailroad({ seed: TEST_SEED, headless: true, idle: true, ...overrides })
}

function connect(r: RailroadRefs, fromKey: string, toKey: string) {
  const from = r.cityByKey.get(fromKey) as Entity
  const to = r.cityByKey.get(toKey) as Entity
  r.command({ kind: 'build-line', from, to })
  return { from, to, line: r.lineBetween(from, to) as Entity }
}

describe('tutorial mode', () => {
  it('starts with every step pending and lay-track current', () => {
    const p = tutorialProgress(fresh())
    expect(p.steps).toHaveLength(TUTORIAL_STEPS.length)
    expect(p.steps.every((s) => !s.done)).toBe(true)
    expect(p.current).toBe(0)
    expect(p.steps[0]!.step.id).toBe('lay-track')
    expect(p.complete).toBe(false)
  })

  it('advances through the steps as the player acts', () => {
    const r = fresh()
    const idAt = (i: number | null) => (i === null ? null : tutorialProgress(r).steps[i]!.step.id)

    const { line } = connect(r, 'ashford', 'brightwater')
    expect(idAt(tutorialProgress(r).current)).toBe('buy-train')

    r.command({ kind: 'buy-train', model: 'mule', line, cargo: 'passengers' })
    expect(idAt(tutorialProgress(r).current)).toBe('start-clock')

    r.advanceMonths(1) // calendar moves → start-clock done; no delivery yet
    expect(idAt(tutorialProgress(r).current)).toBe('first-delivery')

    r.advanceMonths(17) // mule crosses the line and unloads within 18 months
    expect(r.treasury().trainsDelivered).toBeGreaterThan(0)
    expect(idAt(tutorialProgress(r).current)).toBe('research')

    r.command({ kind: 'research', tech: 'iron-rails' })
    const p = tutorialProgress(r)
    expect(p.complete).toBe(true)
    expect(p.current).toBeNull()
  })

  it('evaluates steps independently when done out of order', () => {
    const r = fresh()
    r.command({ kind: 'research', tech: 'iron-rails' })
    const p = tutorialProgress(r)
    expect(p.steps[4]!.done).toBe(true) // research underway
    expect(p.current).toBe(0) // but lay-track is still the first gap
    expect(p.complete).toBe(false)
  })

  it('counts completed research even after activeResearch clears', () => {
    const r = fresh()
    r.command({ kind: 'research', tech: 'iron-rails' })
    r.advanceMonths(7) // cost 80 at 12/month → research lands, activeResearch → null
    expect(r.treasury().activeResearch).toBeNull()
    expect(tutorialProgress(r).steps[4]!.done).toBe(true)
  })
})
