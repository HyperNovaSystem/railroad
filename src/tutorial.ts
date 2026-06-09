// Iron Dynasty — tutorial mode. Pure step definitions + progress evaluation
// over RailroadRefs. No DOM in here: the browser shell (main.ts) renders the
// checklist and owns visibility/dismissal, so the sequencing logic stays
// headless-testable alongside the rest of the sim.

import { TechNode } from './components.js'
import type { RailroadRefs } from './railroad.js'

export type TutorialStepId =
  | 'lay-track'
  | 'buy-train'
  | 'start-clock'
  | 'first-delivery'
  | 'research'

export interface TutorialStep {
  id: TutorialStepId
  title: string
  /** Instruction shown while this is the current step. */
  how: string
  /** Pure predicate over live sim state; steps complete in any order. */
  isDone(refs: RailroadRefs): boolean
}

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    id: 'lay-track',
    title: 'Lay your first line',
    how: 'Enable Build mode (B), then click two cities on the map to connect them. Stations are raised automatically at both ends.',
    isDone: (r) => r.lineIds().length > 0,
  },
  {
    id: 'buy-train',
    title: 'Buy a train',
    how: 'Open the Trains tab, pick your new line and a cargo, then press “Buy train”. Only the Mule 0-4-0 is unlocked at first.',
    isDone: (r) => r.trainIds().length > 0,
  },
  {
    id: 'start-clock',
    title: 'Start the clock',
    how: 'Press Resume (Space). Each fixed step is one sim-month; use the speed buttons (1–4) to go faster.',
    isDone: (r) => {
      const t = r.treasury()
      return t.month !== 1 || t.year !== t.foundingYear
    },
  },
  {
    id: 'first-delivery',
    title: 'Complete a delivery',
    how: 'Let your train shuttle the line. When it unloads at the far station, the fare is banked — watch Cash and the train’s tooltip.',
    isDone: (r) => r.treasury().trainsDelivered > 0,
  },
  {
    id: 'research',
    title: 'Research a technology',
    how: 'Open the Tech tab and start “Iron Rails”. Research unlocks faster models, higher track grades, and cheaper upkeep.',
    isDone: (r) =>
      r.treasury().activeResearch !== null ||
      r.techIds.some((id) => r.world.getComponent(id, TechNode)?.researched === true),
  },
]

export interface TutorialProgress {
  steps: ReadonlyArray<{ step: TutorialStep; done: boolean }>
  /** Index of the first incomplete step, or null when everything is done. */
  current: number | null
  complete: boolean
}

/** Evaluate every step against live sim state. Cheap; safe to call per frame. */
export function tutorialProgress(refs: RailroadRefs): TutorialProgress {
  const steps = TUTORIAL_STEPS.map((step) => ({ step, done: step.isDone(refs) }))
  const current = steps.findIndex((s) => !s.done)
  return {
    steps,
    current: current === -1 ? null : current,
    complete: current === -1,
  }
}
