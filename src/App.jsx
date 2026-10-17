import { useCallback, useEffect, useRef, useState } from 'react'
import { ref, update, set, onValue, get } from 'firebase/database'
import { signInAnonymously } from 'firebase/auth'
import { db, auth } from './firebase'
import ConfigPanel, { DEFAULT_CFG } from './ConfigPanel.jsx'
import MapEditor from './MapEditor.jsx'
import { bfs, buildPlan, ACTION, H } from './nav.js'

const cmdRef = ref(db, 'robot/cmd')
const stRef = ref(db, 'robot/status')

const KEYS = { w: 'F', s: 'B', a: 'L', d: 'R', q: 'Q', e: 'E', arrowup: 'F', arrowdown: 'B', arrowleft: 'L', arrowright: 'R' }
const PAD = [['Q', '↖'], ['F', '▲'], ['E', '↗'], ['L', '◀'], ['S', '■'], ['R', '▶'], null, ['B', '▼'], null]
const SLIDERS = [
  { k: 'base', label: 'Base speed', min: 80, max: 255, step: 1, f: 0, auto: true },
  { k: 'ss', label: 'Slight error: turn strength', min: 5, max: 120, step: 1, f: 0, auto: true },
  { k: 'sp', label: 'Slight error: turn pulse (ms)', min: 10, max: 200, step: 5, f: 0, auto: true },
  { k: 'hs', label: 'Big error: turn strength', min: 10, max: 150, step: 1, f: 0, auto: true },
  { k: 'hp', label: 'Big error: turn pulse (ms)', min: 10, max: 250, step: 5, f: 0, auto: true },
  { k: 'st', label: 'Settle & re-check time (ms)', min: 10, max: 200, step: 5, f: 0, auto: true },
  { k: 'speed', label: 'Manual speed', min: 80, max: 255, step: 1, f: 0, auto: false },
]

export default function App() {
  const [authOk, setAuthOk] = useState(false)
  const [mode, setMode] = useState('auto')
  const [status, setStatus] = useState({})
  const [online, setOnline] = useState(false)
  const [bl, setBl] = useState(1)   // 1 = black reads LOW
  const [cfg, setCfg] = useState(DEFAULT_CFG)
  const [showCfg, setShowCfg] = useState(false)
  const [showMap, setShowMap] = useState(false)
  const [map, setMap] = useState({ nodes: {}, edges: {}, robot: null })
  const [nav, setNav] = useState(null)   // {target, steps, i, state: running|done|error, msg}
  const mapRef = useRef(map), navRef = useRef(null), junctionRef = useRef(), errRef = useRef(), prevState = useRef('')
  mapRef.current = map
  const setNavBoth = (n) => { navRef.current = n; setNav(n) }
  const [tune, setTune] = useState({ base: 150, ss: 25, sp: 40, hs: 60, hp: 50, st: 40, speed: 180 })
  const [logs, setLogs] = useState([])
  const lastCal = useRef(null), lastSteer = useRef(null), lastCk = useRef(null), lastHold = useRef(0), seen = useRef(0), lastHb = useRef(null), lastJ = useRef(null), hold = useRef(null)
  const timers = useRef({}), logEnd = useRef(null)

  const log = useCallback((m) => setLogs((l) => [...l.slice(-60), `${new Date().toLocaleTimeString()}  ${m}`]), [])
  const send = useCallback((o) => update(cmdRef, o).catch((e) => log('Write failed: ' + e.message)), [log])
  const act = useCallback((c) => send({ act: `${c}:${Date.now()}` }), [send])

  // sign in, load saved settings, heartbeat
  useEffect(() => {
    let hb
    signInAnonymously(auth).then(async () => {
      setAuthOk(true); log('Signed in')
      const v = (await get(cmdRef)).val() || {}
      const t = { ...tune }
      for (const k of Object.keys(t)) if (v[k] != null) t[k] = Number(v[k])
      const c = { ...DEFAULT_CFG }
      for (const k of Object.keys(c)) if (v[k] != null) c[k] = Number(v[k])
      if (Number(v.cfgv) !== 2) { c.flip = 0; c.sinv = 0 }   // one-time reset of earlier wiring/steering experiments
      setCfg(c)
      setTune(t); setMode(v.mode || 'auto'); setBl(v.bl != null ? Number(v.bl) : 1)
      send({ mode: v.mode || 'auto', dir: 'S', cfgv: 2, inv: null, bl: v.bl != null ? Number(v.bl) : 1, ...t, ...c })
      hb = setInterval(() => send({ hb: Date.now() }), 1500) // robot stops if the app goes silent
    }).catch((e) => log('Auth failed: ' + e.message + ' (enable Anonymous sign-in)'))
    return () => clearInterval(hb)
    // eslint-disable-next-line
  }, [])

  // robot status
  useEffect(() => onValue(stRef, (snap) => {
    const v = snap.val(); if (!v) return
    if (v.hb !== lastHb.current) { lastHb.current = v.hb; seen.current = Date.now() }
    setStatus(v)
    if (v.state === 'ERROR' && prevState.current !== 'ERROR') errRef.current(v.err)
    const nv = navRef.current
    if (nv && nv.state === 'running' && v.state === 'IDLE' && Date.now() - nv.t > 2500) cancelRoute('Robot stopped – route cancelled')
    prevState.current = v.state
    if (v.hold !== undefined && v.hold !== lastHold.current) { log(v.hold ? `⛔ Obstacle ahead (${v.dist} cm) – holding` : 'Path clear – resuming'); lastHold.current = v.hold }
    const ck = v.ck
    if (ck && ck.n !== lastCk.current) {
      if (lastCk.current !== null) {
        if (ck.res === 1) log('Correction check OK – the robot steers back onto the black line')
        else if (ck.res === -1) { setCfg((c) => ({ ...c, sinv: v.sinv })); update(cmdRef, { sinv: v.sinv }); log('Correction was steering away from the line – direction reversed. Re-centre the robot and run the check again.') }
        else if (ck.res === 2) log('Correction check: put ONLY the centre sensor on the line first')
        else log('Correction check inconclusive – re-centre the robot and try again')
      }
      lastCk.current = ck.n
    }
    const sr = v.steer
    if (sr && sr.n !== lastSteer.current) {
      if (lastSteer.current !== null) {
        if (sr.res === 1) log('Steering check OK – sensor sides match the motors')
        else if (sr.res === -1) { setCfg((c) => ({ ...c, flip: v.flip })); update(cmdRef, { flip: v.flip }); log('Sensors were mirrored – left/right swapped automatically. Run the check again to confirm.') }
        else if (sr.res === 2) log('Steering check: put the centre sensor on the line first')
        else log('Steering check inconclusive – re-centre the robot on the line and try again')
      }
      lastSteer.current = sr.n
    }
    const c = v.cal
    if (c && c.n !== lastCal.current) {
      if (lastCal.current !== null) {
        if (c.ok) { setBl(v.bl); update(cmdRef, { bl: v.bl }); log(`Sensors calibrated – black reads ${v.bl ? 'LOW (0)' : 'HIGH (1)'}`) }
        else log('Calibration failed – put ONLY the centre sensor on the black line, the others on white')
      }
      lastCal.current = c.n
    }
    const j = v.junction
    if (j && j.n !== lastJ.current) {
      if (lastJ.current !== null) junctionRef.current(j)
      lastJ.current = j.n
    }
  }), [log])

  useEffect(() => onValue(ref(db, 'robot/map'), (snap) => {
    const v = snap.val() || {}
    setMap({ nodes: v.nodes || {}, edges: v.edges || {}, robot: v.robot || null })
  }), [])
  useEffect(() => {
    const i = setInterval(() => setOnline(Date.now() - seen.current < 3000), 1000)
    return () => clearInterval(i)
  }, [])
  useEffect(() => { logEnd.current?.scrollTo(0, 1e9) }, [logs])
  useEffect(() => { if (status.state === 'ERROR') log(`Sensor error – invalid pattern [${status.err}] – robot stopped`) }, [status.state, status.err, log])

  const drive = useCallback((d) => {
    clearInterval(hold.current)
    send({ dir: d, hb: Date.now() })
    if (d !== 'S') hold.current = setInterval(() => send({ dir: d, hb: Date.now() }), 250)
  }, [send])

  // ---------- route execution (the app is the "backend" that decides each turn) ----------
  const saveMap = (m) => { setMap(m); set(ref(db, 'robot/map'), { nodes: m.nodes, edges: m.edges, robot: m.robot || null }) }
  const nodeName = (id) => mapRef.current.nodes[id]?.name || 'junction'
  const cancelRoute = (msg) => { const nv = navRef.current; if (nv && nv.state === 'running') { setNavBoth({ ...nv, state: 'error', msg }); log(msg) } }
  const startRoute = (target) => {
    const m = mapRef.current
    if (mode !== 'auto') return log('Switch to Auto mode first')
    if (!m.robot || !m.nodes[m.robot.node]) return log('Set the robot position in the 🗺 map first')
    const route = bfs(m, m.robot.node, target)
    if (!route) return log('No path to ' + nodeName(target) + ' – check the lines in the map')
    if (route.length === 1) return log('Robot is already at ' + nodeName(target))
    const steps = buildPlan(m, route, m.robot.h)
    setNavBoth({ target, steps, i: 1, state: 'running', msg: '', t: Date.now() })
    log(`Route to ${nodeName(target)}: ${steps.slice(0, -1).map((s) => ACTION[s.action]).join(' → ')} → stop`)
    act(steps[0].action)
  }
  junctionRef.current = (j) => {
    const nv = navRef.current
    if (!nv || nv.state !== 'running') return log('Junction detected')
    const step = nv.steps[nv.i]
    update(ref(db, 'robot/map/robot'), { node: step.node, h: step.hin })       // robot is now at this junction
    if (nv.i === nv.steps.length - 1) { setNavBoth({ ...nv, i: nv.i + 1, state: 'done' }); log(`Junction ${nv.i} detected`); if (cfg.boxopen) act('O'); return log('✔ Arrived at ' + nodeName(step.node) + (cfg.boxopen ? ' – opening box' : '')) }
    act(step.action)
    setNavBoth({ ...nv, i: nv.i + 1 })
    log(`Junction ${nv.i} detected → ${ACTION[step.action]}`)
  }
  errRef.current = (pattern) => {          // line ended: valid arrival only at a dead-end destination
    const nv = navRef.current
    if (!nv || nv.state !== 'running') return
    const step = nv.steps[nv.i], m = mapRef.current
    const deg = Object.keys(m.edges).filter((k) => k.split('_').includes(step.node)).length
    if (nv.i === nv.steps.length - 1 && deg === 1 && pattern === '00000') {
      update(ref(db, 'robot/map/robot'), { node: step.node, h: step.hin })
      setNavBoth({ ...nv, i: nv.i + 1, state: 'done' }); if (cfg.boxopen) act('O'); log('✔ Arrived at ' + nodeName(step.node) + ' (end of line)')
    } else cancelRoute('Sensor error during route – route stopped.')
  }

  const changeMode = (m) => { cancelRoute('Route cancelled'); setMode(m); send({ mode: m, dir: 'S', act: `X:${Date.now()}` }); return }
  const setCfgVal = (k, val) => {
    setCfg((c) => ({ ...c, [k]: val }))
    clearTimeout(timers.current['c' + k])
    timers.current['c' + k] = setTimeout(() => send({ [k]: val }), 150)
  }
  const resetCfg = () => { setCfg(DEFAULT_CFG); send(DEFAULT_CFG); log('Config reset to defaults') }
  const toggleInv = () => { const n = bl ? 0 : 1; setBl(n); send({ bl: n }) }
  const estop = () => { cancelRoute('Route cancelled (emergency stop)'); drive('S'); act('X'); log('E-STOP') }
  const setSlider = (k, val) => {
    setTune((t) => ({ ...t, [k]: val }))
    clearTimeout(timers.current[k])
    timers.current[k] = setTimeout(() => send({ [k]: val }), 150)
  }

  // keyboard control
  useEffect(() => {
    let cur = null
    const down = (e) => {
      if (e.repeat || e.target.tagName === 'INPUT') return
      if (e.code === 'Space') { e.preventDefault(); estop(); return }
      const d = KEYS[e.key.toLowerCase()]
      if (d && mode === 'manual') { cur = d; drive(d) }
    }
    const up = (e) => { if (KEYS[e.key.toLowerCase()] === cur) { cur = null; drive('S') } }
    const blur = () => { if (cur) { cur = null; drive('S') } }
    addEventListener('keydown', down); addEventListener('keyup', up); addEventListener('blur', blur)
    return () => { removeEventListener('keydown', down); removeEventListener('keyup', up); removeEventListener('blur', blur) }
    // eslint-disable-next-line
  }, [mode, drive])

  const locs = Object.entries(map.nodes).filter(([, n]) => n.name)
  const sensors = status.sensors || '00000'
  const j = status.junction
  const atJunction = status.state === 'JUNCTION'

  return (
    <div className="app">
      <h1>Line Robot
        <span>
          <button className="gear" onClick={() => setShowMap(true)} title="Map">🗺</button>
          <button className="gear" onClick={() => setShowCfg(true)} title="Robot configuration">⚙</button>
          <span className={'pill ' + (authOk ? 'on' : '')}>{authOk ? 'Firebase ✓' : 'Firebase…'}</span>
          <span className={'pill ' + (online ? 'on' : 'off')}>{online ? 'Robot online' : 'Robot offline'}</span>
        </span>
      </h1>

      <div className="card">
        <div className="seg">
          <button className={mode === 'auto' ? 'sel' : ''} onClick={() => changeMode('auto')}>Auto (line follow)</button>
          <button className={mode === 'manual' ? 'sel' : ''} onClick={() => changeMode('manual')}>Manual</button>
        </div>
        <button className="estop" onClick={estop}>EMERGENCY STOP (Space)</button>
      </div>

      <div className="card">
        <h2>Live sensors</h2>
        <div className="sens">{[0, 1, 2, 3, 4].map((i) => <div key={i} className={'dot' + (sensors[i] === '1' ? ' b' : '')}>{status.raw ? status.raw[i] : ''}</div>)}</div>
        <small style={{ textAlign: 'center' }}>Black dot = sensor sees the black line · white dot = floor · digit = raw pin level</small>
        <div className="track"><div className="mk" style={{ left: `${50 + (status.pos || 0) / 40}%` }} /></div>
        <div className="seg" style={{ margin: '4px 0 10px' }}>
          <button onClick={() => act('C')}>⟲ Calibrate sensors</button>
          <button onClick={toggleInv}>Black reads: <b>{bl ? 'LOW (0)' : 'HIGH (1)'}</b></button>
        </div>
        <div className="row">
          <span>State: <b style={{ color: 'var(--tx)' }}>{status.state || '–'}</b></span>
          <span style={{ color: status.hold ? 'var(--er)' : undefined }}>{status.hold ? '⛔ HOLD ' : ''}Front: <b style={{ color: 'var(--tx)' }}>{status.dist == null ? '–' : status.dist >= 400 ? 'clear' : status.dist + ' cm'}</b></span>
          <span>Raw pins: <b style={{ color: 'var(--tx)' }}>{status.raw || '–'}</b></span>
          <span>Wi-Fi {status.rssi ?? '–'} dBm</span>
        </div>
      </div>

      <div className="card">
        <h2>Box</h2>
        <div className="seg">
          <button onClick={() => act('O')}>📦 Open</button>
          <button onClick={() => act('P')}>Close</button>
        </div>
        <small>Box is {status.box ? 'OPEN' : 'closed'} · opens automatically at the destination (change in ⚙)</small>
      </div>

      {mode === 'auto' ? (
        <>
          <div className="card">
            <h2>Auto mode</h2>
            <div className="seg">
              <button className="go" onClick={() => act('G')}>▶ Start</button>
              <button onClick={() => { cancelRoute('Route cancelled'); act('X') }}>■ Stop</button>
            </div>
            {SLIDERS.filter((s) => s.auto).map((s) => <Slider key={s.k} s={s} v={tune[s.k]} onChange={setSlider} />)}
          </div>
          <div className="card">
            <h2>Locations</h2>
            {!locs.length && <small>No locations yet. Open 🗺 Map, draw the track and name some junctions.</small>}
            <div className="locs">
              {locs.map(([id, n]) => (
                <button key={id} disabled={map.robot?.node === id || nav?.state === 'running'} onClick={() => startRoute(id)}>
                  {map.robot?.node === id ? '📍 ' : '➜ '}{n.name}
                </button>
              ))}
            </div>
            {map.robot && map.nodes[map.robot.node] && <small>Robot at: {nodeName(map.robot.node)} · facing {H[map.robot.h]}</small>}
          </div>
          {nav && (
            <div className="card">
              <h2>Route to {nodeName(nav.target)}</h2>
              {nav.steps.map((s, j) => (
                <div key={j} className={'step ' + (j < nav.i ? 'done' : j === nav.i && nav.state === 'running' ? 'now' : '')}>
                  {j < nav.i ? '✔' : j === nav.i && nav.state === 'running' ? '➜' : '○'}{' '}
                  {j === 0 ? 'Start' : j === nav.steps.length - 1 ? 'Destination' : `Junction ${j}`}:{' '}
                  <b>{s.action ? ACTION[s.action] : 'Stop'}</b>
                </div>
              ))}
              {nav.state === 'done' && <small style={{ color: 'var(--ok)' }}>Arrived.</small>}
              {nav.state === 'error' && <small style={{ color: 'var(--er)' }}>{nav.msg}</small>}
            </div>
          )}
          <div className="card">
            <h2>Junction</h2>
            <div className="jt">{j && j.n ? `Junction ${j.n} detected` : 'None detected'}</div>
            <div className="row" style={{ marginBottom: 8 }}>
              <span>Pattern (L→R): <b>{j?.pattern || '–'}</b></span><span>Choose the next move</span>
            </div>
            <div className="seg">
              {[['L', '↰ Left'], ['S', '↑ Straight'], ['R', '↱ Right'], ['U', '↶ U-turn']].map(([a, t]) =>
                <button key={a} disabled={!atJunction || nav?.state === 'running'} onClick={() => { act(a); log('Command: ' + t) }}>{t}</button>)}
            </div>
          </div>
        </>
      ) : (
        <div className="card">
          <h2>Manual drive (hold) · WASD / arrows</h2>
          <div className="grid">
            {PAD.map((p, i) => p ? (
              <button key={i}
                onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); drive(p[0]) }}
                onPointerUp={() => drive('S')} onPointerCancel={() => drive('S')}>{p[1]}</button>
            ) : <span key={i} />)}
          </div>
          <div className="seg" style={{ marginTop: 12 }}>
            <button onClick={() => act('l')}>90° ↰</button><button onClick={() => act('u')}>180° ↶</button><button onClick={() => act('r')}>90° ↱</button>
          </div>
          {SLIDERS.filter((s) => !s.auto).map((s) => <Slider key={s.k} s={s} v={tune[s.k]} onChange={setSlider} />)}
        </div>
      )}

      {showMap && <MapEditor map={map} save={saveMap} routeNodes={nav?.state === 'running' ? nav.steps.map((s) => s.node) : []} onClose={() => setShowMap(false)} />}
      {showCfg && <ConfigPanel cfg={cfg} set={setCfgVal} act={act} send={send} dist={status.dist} hold={!!status.hold} estop={estop} reset={resetCfg} onClose={() => setShowCfg(false)} />}
      <div className="card">
        <h2>Log</h2>
        <div className="log" ref={logEnd}>{logs.map((l, i) => <div key={i}>{l}</div>)}</div>
      </div>
    </div>
  )
}

function Slider({ s, v, onChange }) {
  return (
    <>
      <label>{s.label} <b>{Number(v).toFixed(s.f)}</b></label>
      <input type="range" min={s.min} max={s.max} step={s.step} value={v} onChange={(e) => onChange(s.k, +e.target.value)} />
    </>
  )
}
