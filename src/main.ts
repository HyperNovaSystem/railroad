// Iron Dynasty — browser shell. Boots the sim (createRailroad, idle:false so the
// rAF driver runs), then wires the four optional DOMECS packages:
//   @domecs/dom      — declarative views paint the map board (4 slots)
//   @domecs/input    — keyboard hotkeys, polled from world.input each tick
//   @domecs/inspector— the live service-fault stream feeds the fault panel
//   @domecs/persist   — save/load to a hand-rolled localStorage Storage adapter
// Everything outside the board (HUD, command panels) is imperative DOM, driven
// off world.signals.tickEnd and refreshed after each dispatched Command.

import {
  Faulted,
  err,
  isErr,
  normalizeCause,
  ok,
  type DomecsError,
  type Entity,
  type Result,
} from '@domecs/core'
import { defineView, mountDOM } from '@domecs/dom'
import { createInputPlugin } from '@domecs/input'
import { createInspector, type InspectorEntry } from '@domecs/inspector'
import { load, save, type Storage } from '@domecs/persist'
import {
  City,
  GRADE_ORDER,
  POLICIES,
  RailLine,
  Station,
  TECH_TREE,
  TRAIN_MODELS,
  TechNode,
  Train,
  createRailroad,
  effectiveSpeedKm,
  gradeRank,
  trainModel,
  type Command,
  type Good,
  type Grade,
  type PolicyId,
  type TechId,
  type TrainModelId,
} from './index.js'

// ── DOM helpers ────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Iron Dynasty: missing #${id}`)
  return el as T
}
const fmtMoney = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const GOODS: readonly Good[] = ['passengers', 'mail', 'coal', 'steel', 'goods']
const SAVE_SLOT = 'autosave'

// ── Boot the simulation ──────────────────────────────────────────────────────
const REFS = createRailroad({ idle: false, fixedStep: 1.5 })
const world = REFS.world

// @domecs/inspector — surface Faulted components + systemic faults.
const inspector = createInspector({ bufferSize: 256 })
warnIf(world.use(inspector.plugin), 'inspector')
// @domecs/input — collect keyboard each tick; preventDefault game keys so Space
// doesn't scroll the page. We read the snapshot in the tickStart subscriber.
warnIf(world.use(createInputPlugin({ preventDefaultKeys: true })), 'input')

function warnIf(r: Result<unknown, DomecsError>, label: string): void {
  if (!r.ok) console.warn(`Iron Dynasty: ${label} plugin failed to install:`, r.error)
}

// ── @domecs/persist — localStorage-backed Storage adapter ───────────────────
// persist ships only createMemoryStorage(); a browser-durable adapter is left
// to the app. Each op catches at the I/O boundary and returns persist_io.
function createLocalStorage(prefix = 'iron-dynasty:'): Storage {
  const k = (slot: string): string => prefix + slot
  const ioErr = (op: 'save' | 'load', cause: unknown): Result<never, DomecsError> =>
    err({ kind: 'persist_io', op, cause: normalizeCause(cause), retryable: false })
  return {
    read(slot) {
      try {
        return ok(localStorage.getItem(k(slot)))
      } catch (cause) {
        return ioErr('load', cause)
      }
    },
    write(slot, data) {
      try {
        localStorage.setItem(k(slot), data)
        return ok(undefined)
      } catch (cause) {
        return ioErr('save', cause)
      }
    },
    remove(slot) {
      try {
        localStorage.removeItem(k(slot))
        return ok(undefined)
      } catch (cause) {
        return ioErr('save', cause)
      }
    },
    list() {
      try {
        const out: string[] = []
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i)
          if (key && key.startsWith(prefix)) out.push(key.slice(prefix.length))
        }
        return ok(out.sort())
      } catch (cause) {
        return ioErr('load', cause)
      }
    },
  }
}
const storage = createLocalStorage()

// ── Map board views (@domecs/dom) ────────────────────────────────────────────
let buildMode = false
let buildOrigin: Entity | null = null

function cityXY(cityId: Entity): { x: number; y: number } {
  const c = world.getComponent(cityId, City)
  return { x: c?.x ?? 0, y: c?.y ?? 0 }
}

const linesView = defineView({
  slot: 'lines',
  query: [RailLine],
  changedOn: { mode: 'legacy' }, // paint every frame: entities must render correctly even while paused
  create() {
    const d = document.createElement('div')
    d.className = 'rail-line'
    return d
  },
  update(d, e) {
    const ln = e.RailLine
    if (!ln) return // mount guarantees Has(RailLine); satisfies the optional view-field type
    const dx = ln.toX - ln.fromX
    const dy = ln.toY - ln.fromY
    const len = Math.hypot(dx, dy)
    d.style.left = `${ln.fromX}px`
    d.style.top = `${ln.fromY}px`
    d.style.width = `${len}px`
    d.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`
    d.style.opacity = String(0.4 + (ln.condition / 100) * 0.55)
    d.className = `rail-line grade-${ln.grade}`
  },
})

const stationsView = defineView({
  slot: 'stations',
  query: [Station],
  changedOn: { mode: 'legacy' },
  create() {
    const d = document.createElement('div')
    d.className = 'station'
    d.innerHTML = '<span class="fill"></span>'
    return d
  },
  update(d, e) {
    const st = e.Station
    if (!st) return
    const { x, y } = cityXY(st.city)
    d.style.left = `${x}px`
    d.style.top = `${y}px`
    const faulted = world.getComponent(e.id, Faulted)?.faults.some(
      (f) => f.kind === 'railroad/station-overloaded',
    )
    d.classList.toggle('faulted', !!faulted)
    const fill = d.querySelector<HTMLElement>('.fill')
    if (fill) {
      const load = Math.min(1, (st.paxQueue + st.freightQueue) / Math.max(1, st.capacity * 2))
      fill.style.height = `${Math.round(load * 100)}%`
    }
    d.title = `${cityName(st.city)} station L${st.level} — pax ${Math.round(
      st.paxQueue,
    )}/${st.capacity}, freight ${Math.round(st.freightQueue)}/${st.capacity}`
  },
})

const citiesView = defineView({
  slot: 'cities',
  query: [City],
  changedOn: { mode: 'legacy' },
  create(e) {
    const d = document.createElement('div')
    d.className = 'city'
    d.dataset.entity = String(e.id)
    d.innerHTML = '<span class="city-dot"></span><span class="city-label"></span>'
    d.addEventListener('click', () => onCityClick(e.id))
    return d
  },
  update(d, e) {
    const c = e.City
    if (!c) return
    d.style.left = `${c.x}px`
    d.style.top = `${c.y}px`
    const label = d.querySelector<HTMLElement>('.city-label')
    if (label) label.textContent = `${c.name} · ${Math.round(c.population / 1000)}k`
    d.classList.toggle('connected', c.hasStation)
    d.title = `${c.name} — pop ${Math.round(c.population).toLocaleString()}, prosperity ${Math.round(
      c.prosperity,
    )}`
  },
})

const trainsView = defineView({
  slot: 'trains',
  query: [Train],
  changedOn: { mode: 'legacy' }, // redraw every frame so motion is smooth and works while paused
  create() {
    const d = document.createElement('div')
    d.className = 'train'
    return d
  },
  update(d, e) {
    const tr = e.Train
    if (!tr) return
    if (tr.line === null) {
      d.style.display = 'none'
      return
    }
    const ln = world.getComponent(tr.line, RailLine)
    if (!ln) {
      d.style.display = 'none'
      return
    }
    d.style.display = ''
    const x = ln.fromX + (ln.toX - ln.fromX) * tr.position
    const y = ln.fromY + (ln.toY - ln.fromY) * tr.position
    d.style.left = `${x}px`
    d.style.top = `${y}px`
    d.className = `train era-${trainModel(tr.model).era} status-${tr.status}`
    d.title = `${tr.name} (${trainModel(tr.model).name}) — ${tr.cargo}, ${tr.deliveries} deliveries, ${fmtMoney(
      tr.haulRevenue,
    )}`
  },
})

const mountResult = mountDOM(world, {
  slots: {
    lines: $('layer-lines'),
    stations: $('layer-stations'),
    cities: $('layer-cities'),
    trains: $('layer-trains'),
  },
  views: [linesView, stationsView, citiesView, trainsView],
})
if (isErr(mountResult)) {
  const e = mountResult.error
  const detail =
    e.kind === 'plugin_install_failed'
      ? `${e.kind}: ${e.reason}`
      : `${e.kind}: ${e.slot}`
  throw new Error(`Iron Dynasty: failed to mount DOM views — ${detail}`)
}
const mount = mountResult.value
void mount // retained for the lifetime of the page

// ── Naming helpers ───────────────────────────────────────────────────────────
function cityName(id: Entity): string {
  return world.getComponent(id, City)?.name ?? `#${id}`
}
function lineLabel(id: Entity): string {
  const ln = world.getComponent(id, RailLine)
  return ln ? `${cityName(ln.from)} → ${cityName(ln.to)}` : `line #${id}`
}

// ── Command dispatch ─────────────────────────────────────────────────────────
function dispatch(cmd: Command): boolean {
  const accepted = REFS.command(cmd)
  if (accepted) setStatus(describe(cmd), 'ok')
  else setStatus(REFS.treasury().lastError || 'rejected', 'err')
  refreshAll()
  return accepted
}
function describe(cmd: Command): string {
  switch (cmd.kind) {
    case 'build-line':
      return `Laid track ${cityName(cmd.from)} → ${cityName(cmd.to)}.`
    case 'buy-train':
      return `Bought a ${trainModel(cmd.model).name}.`
    case 'assign-train':
      return `Reassigned train to ${lineLabel(cmd.line)}.`
    case 'research':
      return `Began research: ${cmd.tech}.`
    case 'take-loan':
      return `Borrowed ${fmtMoney(cmd.amount)}.`
    case 'repay-loan':
      return `Repaid ${fmtMoney(cmd.amount)}.`
    case 'upgrade-station':
      return `Upgraded a station.`
    case 'upgrade-line':
      return `Upgraded line to ${cmd.grade}.`
    case 'set-fares':
      return `Set fares ×${cmd.fareMult.toFixed(2)} / freight ×${cmd.freightMult.toFixed(2)}.`
    case 'enact-policy':
      return `Enacted ${POLICIES[cmd.policy].name}.`
  }
}

// ── Build-mode interaction ───────────────────────────────────────────────────
function onCityClick(id: Entity): void {
  if (!buildMode) {
    setStatus(`${cityName(id)} — enable Build mode (B) to lay track from here.`)
    return
  }
  if (buildOrigin === null) {
    buildOrigin = id
    markOrigin(id, true)
    setStatus(`Origin: ${cityName(id)}. Click a destination city.`)
    return
  }
  if (buildOrigin === id) {
    markOrigin(id, false)
    buildOrigin = null
    setStatus('Build cancelled.')
    return
  }
  const from = buildOrigin
  markOrigin(from, false)
  buildOrigin = null
  dispatch({ kind: 'build-line', from, to: id })
}
function markOrigin(id: Entity, on: boolean): void {
  document
    .querySelector<HTMLElement>(`.city[data-entity="${id}"]`)
    ?.classList.toggle('origin', on)
}

// ── Time controls ────────────────────────────────────────────────────────────
let scale = 1
let paused = true // start paused so the player can set up the first line

function setPaused(next: boolean): void {
  paused = next
  world.setScale(paused ? 0 : scale)
  const btn = $('btn-pause')
  btn.textContent = paused ? '▶ Resume' : '⏸ Pause'
  setStatus(paused ? 'Paused.' : `Running ${scale}×.`)
  refreshAll()
}
function setSpeed(s: number): void {
  scale = s
  if (!paused) world.setScale(scale)
  for (const b of document.querySelectorAll<HTMLElement>('.spd'))
    b.classList.toggle('is-active', b.dataset.scale === String(s))
  if (!paused) setStatus(`Running ${scale}×.`)
}

// ── Persistence ──────────────────────────────────────────────────────────────
function doSave(): void {
  const r = save(world, storage, SAVE_SLOT)
  setStatus(r.ok ? 'Game saved to browser storage.' : `Save failed: ${r.error.kind}`, r.ok ? 'ok' : 'err')
}
function doLoad(): void {
  const r = load(world, storage, SAVE_SLOT)
  setStatus(r.ok ? 'Game loaded.' : `Load failed: ${r.error.kind}`, r.ok ? 'ok' : 'err')
  refreshAll()
}

// ── HUD + fault panel refresh ────────────────────────────────────────────────
function refreshHud(): void {
  const t = REFS.treasury()
  $('hud-clock').textContent = `${t.year} · ${MONTHS[t.month - 1] ?? '—'}`
  $('hud-era').textContent = t.era
  $('hud-cash').textContent = fmtMoney(t.cash)
  $('hud-debt').textContent = fmtMoney(t.debt)
  $('hud-rating').textContent = t.creditRating
  $('hud-flow').textContent = `${fmtMoney(t.totalRevenue)} / ${fmtMoney(t.totalExpenses)}`
  $('hud-rep').textContent = String(Math.round(t.reputation))
  $('hud-approval').textContent = String(Math.round(t.approval))
  $('hud-reg').textContent = String(Math.round(t.regulation))
  $('hud-dynasty').textContent = `Gen ${t.generation} · ${t.heirTrait}`
  $('hud-legacy').textContent = String(Math.round(t.legacyScore))
  if (t.status !== 'playing') {
    $('hud-clock').textContent += t.status === 'bankrupt' ? ' · BANKRUPT' : ' · RETIRED'
  }
}

function refreshFaults(): void {
  const entries = inspector.view.onlyFaulted().entries
  const recent = entries.slice(-12).reverse()
  const count = $('fault-count')
  count.textContent = String(entries.length)
  count.classList.toggle('zero', entries.length === 0)
  const list = $('fault-list')
  if (recent.length === 0) {
    list.innerHTML = '<li class="muted">No faults reported.</li>'
    return
  }
  list.innerHTML = recent.map(faultRow).join('')
}
function faultRow(e: InspectorEntry): string {
  const who = e.entity !== undefined ? cityish(e.entity) : 'system'
  return `<li>tick ${e.tick} · ${who} · ${escapeHtml(e.kind)}</li>`
}
function cityish(id: Entity): string {
  const st = world.getComponent(id, Station)
  if (st) return `${cityName(st.city)} station`
  return `#${id}`
}

// ── Side panels ──────────────────────────────────────────────────────────────
let activeTab = 'build'
for (const tab of document.querySelectorAll<HTMLElement>('.tab')) {
  tab.addEventListener('click', () => {
    activeTab = tab.dataset.tab ?? 'build'
    for (const t of document.querySelectorAll<HTMLElement>('.tab'))
      t.classList.toggle('is-active', t === tab)
    renderPanel()
  })
}

function renderPanel(): void {
  const host = $('tab-content')
  switch (activeTab) {
    case 'build':
      return renderBuild(host)
    case 'trains':
      return renderTrains(host)
    case 'tech':
      return renderTech(host)
    case 'politics':
      return renderPolitics(host)
    case 'log':
      return renderLog(host)
  }
}

function renderBuild(host: HTMLElement): void {
  const t = REFS.treasury()
  const stations = REFS.stationIds()
  const lines = REFS.lineIds()
  const grades = GRADE_ORDER.filter((g) => gradeRank(g) <= gradeRank(t.maxGrade))
  host.innerHTML = `
    <h3>Network</h3>
    <p class="hint">Toggle <b>Build mode</b> (B), then click two cities to lay track.
       Stations are raised automatically at each end. Track costs scale with distance.</p>
    <div class="row">
      <button class="btn ${buildMode ? '' : 'ghost'}" id="p-build-toggle">${
        buildMode ? 'Build mode: ON' : 'Enable build mode'
      }</button>
    </div>
    <h3>Upgrade station</h3>
    <div class="row">
      <select id="p-station">${stations
        .map((id) => {
          const st = world.getComponent(id, Station)
          return `<option value="${id}">${cityName(st?.city ?? id)} (L${st?.level ?? 1})</option>`
        })
        .join('')}</select>
      <button class="btn sm" id="p-station-up" ${stations.length ? '' : 'disabled'}>Upgrade</button>
    </div>
    <h3>Upgrade line</h3>
    <div class="row">
      <select id="p-line">${lines
        .map((id) => `<option value="${id}">${lineLabel(id)} (${world.getComponent(id, RailLine)?.grade})</option>`)
        .join('')}</select>
    </div>
    <div class="row">
      <select id="p-grade">${grades.map((g) => `<option value="${g}">${g}</option>`).join('')}</select>
      <button class="btn sm" id="p-line-up" ${lines.length ? '' : 'disabled'}>Upgrade grade</button>
    </div>`

  $('p-build-toggle').addEventListener('click', () => setBuildMode(!buildMode))
  $('p-station-up').addEventListener('click', () => {
    const station = Number(selVal('p-station'))
    if (Number.isFinite(station)) dispatch({ kind: 'upgrade-station', station })
  })
  $('p-line-up').addEventListener('click', () => {
    const line = Number(selVal('p-line'))
    const grade = selVal('p-grade') as Grade
    if (Number.isFinite(line)) dispatch({ kind: 'upgrade-line', line, grade })
  })
}

function renderTrains(host: HTMLElement): void {
  const t = REFS.treasury()
  const lines = REFS.lineIds()
  const trains = REFS.trainIds()
  const models = TRAIN_MODELS.filter((m) => t.unlockedModels.includes(m.id))
  host.innerHTML = `
    <h3>Buy rolling stock</h3>
    ${
      lines.length === 0
        ? '<p class="hint">Lay a line first — trains need somewhere to run.</p>'
        : `<div class="row"><label>Line</label><select id="t-line">${lines
            .map((id) => `<option value="${id}">${lineLabel(id)}</option>`)
            .join('')}</select></div>
       <div class="row"><label>Model</label><select id="t-model">${models
         .map((m) => `<option value="${m.id}">${m.name} — ${fmtMoney(m.cost)}</option>`)
         .join('')}</select></div>
       <div class="row"><label>Cargo</label><select id="t-cargo">${GOODS.map(
         (g) => `<option value="${g}">${g}</option>`,
       ).join('')}</select></div>
       <div class="row"><button class="btn" id="t-buy">Buy train</button></div>`
    }
    <h3>Fleet (${trains.length})</h3>
    <div class="cardlist">${trains.map(trainCard).join('') || '<p class="muted">No trains yet.</p>'}</div>`

  if (lines.length > 0) {
    $('t-buy').addEventListener('click', () => {
      const line = Number(selVal('t-line'))
      const model = selVal('t-model') as TrainModelId
      const cargo = selVal('t-cargo') as Good
      if (Number.isFinite(line)) dispatch({ kind: 'buy-train', model, line, cargo })
    })
    for (const id of trains) {
      const sel = document.getElementById(`t-assign-${id}`)
      sel?.addEventListener('change', () => {
        const line = Number((sel as HTMLSelectElement).value)
        if (Number.isFinite(line)) dispatch({ kind: 'assign-train', train: id, line })
      })
    }
  }
}
function trainCard(id: Entity): string {
  const tr = world.getComponent(id, Train)
  if (!tr) return ''
  const m = trainModel(tr.model)
  const lines = REFS.lineIds()
  const assign = lines
    .map((l) => `<option value="${l}" ${l === tr.line ? 'selected' : ''}>${lineLabel(l)}</option>`)
    .join('')
  return `<div class="card">
    <div class="top"><span class="name">${tr.name}</span><span class="tag ${m.era}">${m.era}</span></div>
    <div class="sub">${m.name} · ${tr.cargo} · ${tr.status} · ${tr.deliveries} deliveries · ${fmtMoney(
      tr.haulRevenue,
    )}</div>
    <div class="row"><label>Line</label><select id="t-assign-${id}">${assign}</select></div>
  </div>`
}

function renderTech(host: HTMLElement): void {
  const t = REFS.treasury()
  const researched = new Set<TechId>()
  for (const seed of TECH_TREE) {
    const node = REFS.techByTech.get(seed.id)
    if (node && world.getComponent(node, TechNode)?.researched) researched.add(seed.id)
  }
  host.innerHTML = `
    <h3>Research ${t.activeResearch ? `· active: ${t.activeResearch}` : ''}</h3>
    <p class="hint">${Math.round(t.researchRate)} pts/month. Unlock models, grades, and speed.</p>
    <div class="cardlist">${TECH_TREE.map((seed) => techCard(seed.id, researched)).join('')}</div>`
  for (const seed of TECH_TREE) {
    $(`tech-${seed.id}`)?.addEventListener('click', () => dispatch({ kind: 'research', tech: seed.id }))
  }
}
function techCard(id: TechId, researched: Set<TechId>): string {
  const seed = TECH_TREE.find((s) => s.id === id)!
  const node = REFS.techByTech.get(id)
  const state = node ? world.getComponent(node, TechNode) : undefined
  const t = REFS.treasury()
  const done = state?.researched ?? false
  const prereqsMet = seed.prereqs.every((p) => researched.has(p))
  const active = t.activeResearch === id
  const pct = state && state.cost > 0 ? Math.min(100, (state.progress / state.cost) * 100) : 0
  const tag = done
    ? '<span class="tag done">done</span>'
    : prereqsMet
      ? `<span class="tag ${seed.era}">${seed.era}</span>`
      : '<span class="tag locked">locked</span>'
  const btn = done
    ? ''
    : `<button class="btn sm" id="tech-${id}" ${prereqsMet && !active ? '' : 'disabled'}>${
        active ? 'researching…' : 'Research'
      }</button>`
  return `<div class="card">
    <div class="top"><span class="name">${seed.name}</span>${tag}</div>
    <div class="sub">${escapeHtml(seed.desc)}</div>
    <div class="sub">cost ${seed.cost}${seed.prereqs.length ? ` · needs ${seed.prereqs.join(', ')}` : ''}</div>
    ${active || (state && state.progress > 0 && !done) ? `<div class="progress"><i style="width:${pct}%"></i></div>` : ''}
    <div class="row">${btn}</div>
  </div>`
}

function renderPolitics(host: HTMLElement): void {
  const t = REFS.treasury()
  host.innerHTML = `
    <h3>Fares</h3>
    <div class="row"><label>Passenger ×<span id="pf-v">${t.fareMult.toFixed(2)}</span></label>
      <input type="range" id="pf" min="0.5" max="2" step="0.05" value="${t.fareMult}"></div>
    <div class="row"><label>Freight ×<span id="ff-v">${t.freightMult.toFixed(2)}</span></label>
      <input type="range" id="ff" min="0.5" max="2" step="0.05" value="${t.freightMult}"></div>
    <div class="row"><button class="btn sm" id="p-fares">Apply fares</button></div>
    <h3>Finance</h3>
    <div class="row"><label>Amount</label><input type="number" id="p-amt" value="50000" min="0" step="10000"></div>
    <div class="row">
      <button class="btn sm" id="p-loan">Take loan</button>
      <button class="btn sm ghost" id="p-repay">Repay</button>
    </div>
    <h3>Policies</h3>
    <div class="cardlist">${(Object.keys(POLICIES) as PolicyId[]).map(policyCard).join('')}</div>`

  const pf = $('pf') as HTMLInputElement
  const ff = $('ff') as HTMLInputElement
  pf.addEventListener('input', () => ($('pf-v').textContent = Number(pf.value).toFixed(2)))
  ff.addEventListener('input', () => ($('ff-v').textContent = Number(ff.value).toFixed(2)))
  $('p-fares').addEventListener('click', () =>
    dispatch({ kind: 'set-fares', fareMult: Number(pf.value), freightMult: Number(ff.value) }),
  )
  $('p-loan').addEventListener('click', () =>
    dispatch({ kind: 'take-loan', amount: Number(($('p-amt') as HTMLInputElement).value) }),
  )
  $('p-repay').addEventListener('click', () =>
    dispatch({ kind: 'repay-loan', amount: Number(($('p-amt') as HTMLInputElement).value) }),
  )
  for (const pid of Object.keys(POLICIES) as PolicyId[]) {
    $(`pol-${pid}`)?.addEventListener('click', () => dispatch({ kind: 'enact-policy', policy: pid }))
  }
}
function policyCard(pid: PolicyId): string {
  const p = POLICIES[pid]
  return `<div class="card">
    <div class="top"><span class="name">${p.name}</span><span class="sub">${fmtMoney(p.cost)}</span></div>
    <div class="sub">${escapeHtml(p.desc)}</div>
    <div class="sub">approval ${signed(p.approval)} · rep ${signed(p.reputation)} · reg ${signed(p.regulation)}</div>
    <div class="row"><button class="btn sm" id="pol-${pid}">Enact</button></div>
  </div>`
}

function renderLog(host: HTMLElement): void {
  const log = REFS.treasury().eventLog
  host.innerHTML = `<h3>Event log</h3><div class="log">${
    log.length === 0
      ? '<span class="muted">Nothing yet. Press Resume to start the clock.</span>'
      : [...log].reverse().map((l) => `<div>${escapeHtml(l)}</div>`).join('')
  }</div>`
}

// ── Small utilities ──────────────────────────────────────────────────────────
function setBuildMode(on: boolean): void {
  buildMode = on
  $('btn-build').textContent = `⛏ Build mode: ${on ? 'on' : 'off'}`
  $('btn-build').classList.toggle('is-active', on)
  if (!on && buildOrigin !== null) {
    markOrigin(buildOrigin, false)
    buildOrigin = null
  }
  if (activeTab === 'build') renderPanel()
}
function selVal(id: string): string {
  return (document.getElementById(id) as HTMLSelectElement | null)?.value ?? ''
}
function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n)
}
function setStatus(msg: string, kind: '' | 'ok' | 'err' = ''): void {
  const el = $('status')
  el.textContent = msg
  el.className = `status ${kind}`
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
}

// Panels that show live sim data re-render off a throttle; the politics tab is
// skipped while open so range-slider focus/drag isn't clobbered mid-interaction.
let lastPanelPaint = 0
function refreshAll(): void {
  refreshHud()
  refreshFaults()
  renderPanel()
  lastPanelPaint = world.time.tick
}

// ── Control wiring ───────────────────────────────────────────────────────────
$('btn-pause').addEventListener('click', () => setPaused(!paused))
$('btn-save').addEventListener('click', doSave)
$('btn-load').addEventListener('click', doLoad)
$('btn-build').addEventListener('click', () => setBuildMode(!buildMode))
for (const b of document.querySelectorAll<HTMLElement>('.spd'))
  b.addEventListener('click', () => setSpeed(Number(b.dataset.scale)))

// Keyboard hotkeys via @domecs/input — polled at tickStart so they also work
// while paused (a keypress wakes one frame; the plugin rebuilds world.input).
world.signals.tickStart.subscribe(() => {
  const pressed = world.input.keyDelta.pressed
  if (pressed.size === 0) return
  if (pressed.has('Space')) setPaused(!paused)
  if (pressed.has('KeyB')) setBuildMode(!buildMode)
  if (pressed.has('KeyS')) doSave()
  if (pressed.has('KeyL')) doLoad()
  if (pressed.has('Escape') && buildOrigin !== null) {
    markOrigin(buildOrigin, false)
    buildOrigin = null
    setStatus('Build cancelled.')
  }
  if (pressed.has('Digit1')) setSpeed(0.5)
  if (pressed.has('Digit2')) setSpeed(1)
  if (pressed.has('Digit3')) setSpeed(2)
  if (pressed.has('Digit4')) setSpeed(4)
  if (pressed.has('Equal') || pressed.has('NumpadAdd')) bumpSpeed(1)
  if (pressed.has('Minus') || pressed.has('NumpadSubtract')) bumpSpeed(-1)
})
const SPEEDS = [0.5, 1, 2, 4]
function bumpSpeed(dir: number): void {
  const i = SPEEDS.indexOf(scale)
  const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 1 : i) + dir))]
  if (next !== undefined) setSpeed(next)
}

// HUD/faults follow the sim every tick; the panel repaints on a ~0.5s throttle
// (skipping politics so slider drags survive). Commands force an immediate paint.
world.signals.tickEnd.subscribe(() => {
  refreshHud()
  refreshFaults()
  if (activeTab !== 'politics' && world.time.tick - lastPanelPaint >= 20) {
    renderPanel()
    lastPanelPaint = world.time.tick
  }
})

// ── Go ───────────────────────────────────────────────────────────────────────
world.startLoop()
world.setScale(0) // start paused
renderPanel()
refreshHud()
refreshFaults()
setStatus('Welcome to Iron Dynasty. Build a line (B), buy a train, then Resume.')
