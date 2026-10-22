import { useRef, useState } from 'react'

export const DEFAULT_CFG = { lg: 100, rg: 100, lmin: 70, rmin: 70, l90l: -130, l90r: 130, l90t: 350, r90l: 130, r90r: -130, r90t: 350, ul: -130, ur: 130, ut: 700, udir: 0, tspd: 130, tsp: 150, tex: 250, tcatch: 1, advl: 130, advr: 130, advu: 130, buzz: 1, obsd: 15, obsen: 1, flip: 0, linv: 0, rinv: 0, sinv: 0, sc: 0, so: 90, sspd: 120, sauto: 0, spmin: 500, spmax: 2400, shold: 0, boxopen: 1 }

function Num({ label, hint, k, cfg, set, min, max, step = 1, unit = '' }) {
  const v = cfg[k]
  const nudge = (d) => set(k, Math.min(max, Math.max(min, +(v + d * step).toFixed(3))))
  return (
    <div className="num">
      <label>{label} <b>{v}{unit}</b></label>
      <div className="fine">
        <button className="mini" onClick={() => nudge(-1)}>−</button>
        <input type="range" min={min} max={max} step={step} value={v} onChange={(e) => set(k, +e.target.value)} />
        <button className="mini" onClick={() => nudge(1)}>+</button>
      </div>
      {hint && <small>{hint}</small>}
    </div>
  )
}

export default function ConfigPanel({ cfg, set, act, send, dist, hold, onClose, estop, reset }) {
  const [ang, setAng] = useState(90)
  const last = useRef(0)
  const moveTo = (v, final) => {
    setAng(v)
    if (final || Date.now() - last.current > 80) { last.current = Date.now(); send({ sang: v }) }   // live, throttled
  }
  const [deg, setDeg] = useState('')
  const p = { cfg, set }
  const setUdir = (d) => {          // changing the U-turn side mirrors its two motor speeds
    if (d === cfg.udir) return
    set('udir', d); set('ul', cfg.ur); set('ur', cfg.ul)
  }
  const veer = (side) => {   // robot drifts toward `side` => the opposite wheel is too strong
    const k = side === 'left' ? 'rg' : 'lg'
    set(k, Math.max(30, cfg[k] - 1))
  }
  const applySpin = () => {
    const d = parseFloat(deg); if (!(d > 5)) return
    const v = cfg.tspd, t90 = Math.round((90 / d) * 1000), t180 = Math.round((180 / d) * 1000), u = cfg.udir ? v : -v
    set('l90l', -v); set('l90r', v); set('l90t', t90)         // 90° left
    set('r90l', v); set('r90r', -v); set('r90t', t90)         // 90° right
    set('ul', u); set('ur', -u); set('ut', t180); setDeg('')  // U-turn (chosen side)
  }
  return (
    <div className="sheet">
      <div className="bar"><b>⚙ Robot settings</b><span style={{ color: 'var(--mu)', fontSize: 12 }}>Applies to Auto and Manual</span>
        <button onClick={onClose}>Done</button></div>
      <div className="app">
        <div className="card">
          <h2>1 · Straight-line balance</h2>
          <small>Balance motor power so the robot drives straight without pulling to either side.</small>
          <Num {...p} k="lg" label="Left motor power" min={50} max={100} unit="%" />
          <Num {...p} k="rg" label="Right motor power" min={50} max={100} unit="%" />
          <Num {...p} k="tsp" label="Test speed" min={80} max={255} />
          <div className="seg" style={{ marginTop: 10 }}>
            <button className="go" onClick={() => act('f')}>▶ Test drive (2s)</button>
          </div>
          <div className="seg" style={{ marginTop: 8 }}>
            <button onClick={() => veer('left')}>↶ Drifts LEFT</button>
            <button onClick={() => veer('right')}>Drifts RIGHT ↷</button>
          </div>
          <small>Tap if the robot drifts until it drives straight.</small>
        </div>

        <div className="card">
          <h2>2 · Minimum motor power</h2>
          <small>Lowest power required for the wheels to start rolling smoothly.</small>
          <Num {...p} k="lmin" label="Left minimum power" min={0} max={200} />
          <Num {...p} k="rmin" label="Right minimum power" min={0} max={200} />
        </div>

        <div className="card">
          <h2>3 · Turn calibration</h2>
          <Num {...p} k="tspd" label="Turn speed" min={60} max={255} hint="Speed used during turns and test maneuvers." />
          <div className="seg" style={{ margin: '10px 0' }}>
            <button onClick={() => act('s')}>↻ Spin test (1s)</button>
            <input className="inp" type="number" placeholder="degrees turned" value={deg} onChange={(e) => setDeg(e.target.value)} />
            <button className="go" onClick={applySpin}>Auto-adjust</button>
          </div>
          <small>Run a spin test to auto-estimate turn times, or manually adjust them below.</small>

          <h2 style={{ marginTop: 16 }}>90° left turn</h2>
          <Num {...p} k="l90l" label="Left motor" min={-255} max={255} />
          <Num {...p} k="l90r" label="Right motor" min={-255} max={255} />
          <Num {...p} k="l90t" label="Duration" min={20} max={1500} step={5} unit=" ms" />
          <Num {...p} k="advl" label="Roll forward before turn" min={0} max={1500} step={5} unit=" ms" hint="Short forward move before turning." />
          <div className="seg" style={{ marginTop: 8 }}>
            <button onClick={() => act('l')}>Test 90° ↰</button>
            <button onClick={() => act('v')}>Forward only</button>
          </div>

          <h2 style={{ marginTop: 16 }}>90° right turn</h2>
          <Num {...p} k="r90l" label="Left motor" min={-255} max={255} />
          <Num {...p} k="r90r" label="Right motor" min={-255} max={255} />
          <Num {...p} k="r90t" label="Duration" min={20} max={1500} step={5} unit=" ms" />
          <Num {...p} k="advr" label="Roll forward before turn" min={0} max={1500} step={5} unit=" ms" hint="Short forward move before turning." />
          <div className="seg" style={{ marginTop: 8 }}>
            <button onClick={() => act('r')}>Test 90° ↱</button>
            <button onClick={() => act('w')}>Forward only</button>
          </div>

          <h2 style={{ marginTop: 16 }}>180° U-turn</h2>
          <div className="seg">
            <button className={!cfg.udir ? 'sel' : ''} onClick={() => setUdir(0)}>Turn LEFT</button>
            <button className={cfg.udir ? 'sel' : ''} onClick={() => setUdir(1)}>Turn RIGHT</button>
          </div>
          <Num {...p} k="ul" label="Left motor" min={-255} max={255} />
          <Num {...p} k="ur" label="Right motor" min={-255} max={255} />
          <Num {...p} k="ut" label="Duration" min={20} max={3000} step={5} unit=" ms" />
          <Num {...p} k="advu" label="Roll forward before U-turn" min={0} max={1500} step={5} unit=" ms" hint="Short forward move before U-turn." />
          <div className="seg" style={{ marginTop: 8 }}>
            <button onClick={() => act('u')}>Test 180° {cfg.udir ? '↷' : '↶'}</button>
            <button onClick={() => act('y')}>Forward only</button>
          </div>
          <small>If the turn overshoots, reduce duration; if it falls short, increase duration.</small>
        </div>

        <div className="card">
          <h2>4 · Junction handling</h2>
          <button style={{ width: '100%', marginTop: 8 }} onClick={() => set('tcatch', cfg.tcatch ? 0 : 1)}>
            Auto-lock onto line after turn: <b>{cfg.tcatch ? 'ON' : 'OFF'}</b>
          </button>
          <small>Stops turning as soon as the line is detected again.</small>
          <Num {...p} k="tex" label="Line search timeout" min={0} max={800} step={10} unit=" ms" hint="Extra time allowed to find the line." />
        </div>

        <div className="card">
          <h2>5 · Direction & sensor check</h2>
          <small>Ensure the motors and sensors turn the robot in the right direction.</small>
          <div className="seg" style={{ marginTop: 10, flexWrap: 'wrap' }}>
            <button onClick={() => set('linv', cfg.linv ? 0 : 1)}>Reverse left motor: <b>{cfg.linv ? 'ON' : 'OFF'}</b></button>
            <button onClick={() => set('rinv', cfg.rinv ? 0 : 1)}>Reverse right motor: <b>{cfg.rinv ? 'ON' : 'OFF'}</b></button>
          </div>
          <button style={{ width: '100%', marginTop: 8 }} onClick={() => set('flip', cfg.flip ? 0 : 1)}>Swap left/right sensors: <b>{cfg.flip ? 'ON' : 'OFF'}</b></button>
          <button className="go" style={{ width: '100%', marginTop: 8 }} onClick={() => act('T')}>⟲ Test steering direction</button>
          <button style={{ width: '100%', marginTop: 8 }} onClick={() => set('sinv', cfg.sinv ? 0 : 1)}>Invert line correction: <b>{cfg.sinv ? 'ON' : 'OFF'}</b></button>
          <button className="go" style={{ width: '100%', marginTop: 8 }} onClick={() => act('K')}>✔ Test line correction</button>
          <small>Place the robot with its centre sensor on the line before testing.</small>
        </div>

        <div className="card">
          <h2>6 · Delivery box lid</h2>
          <small>Adjust the slider to find and save the open and closed positions.</small>
          <div className="num">
            <label>Test position <b>{ang}°</b></label>
            <div className="fine">
              <button className="mini" onClick={() => moveTo(Math.max(0, ang - 1), true)}>−</button>
              <input type="range" min={0} max={180} value={ang} onChange={(e) => moveTo(+e.target.value, false)} onPointerUp={(e) => moveTo(+e.target.value, true)} />
              <button className="mini" onClick={() => moveTo(Math.min(180, ang + 1), true)}>+</button>
            </div>
          </div>
          <div className="seg" style={{ marginTop: 8 }}>
            <button onClick={() => set('sc', ang)}>Save {ang}° as CLOSED</button>
            <button onClick={() => set('so', ang)}>Save {ang}° as OPEN</button>
          </div>
          <Num {...p} k="sc" label="Closed position" min={0} max={180} unit="°" />
          <Num {...p} k="so" label="Open position" min={0} max={180} unit="°" />
          <Num {...p} k="sspd" label="Movement speed" min={10} max={720} step={10} unit="°/s" hint="Controls how smoothly the lid moves." />
          <Num {...p} k="sauto" label="Auto-close delay" min={0} max={60} unit=" s" hint="Seconds before closing automatically (0 = stays open)." />
          <div className="seg" style={{ marginTop: 10 }}>
            <button className="go" onClick={() => act('O')}>📦 Open</button>
            <button onClick={() => act('P')}>Close</button>
            <button onClick={() => { act('O'); setTimeout(() => act('P'), 2500) }}>Open (2.5s) then close</button>
          </div>
          <button style={{ width: '100%', marginTop: 8 }} onClick={() => set('boxopen', cfg.boxopen ? 0 : 1)}>Auto-open on arrival: <b>{cfg.boxopen ? 'ON' : 'OFF'}</b></button>
          <button style={{ width: '100%', marginTop: 8 }} onClick={() => set('shold', cfg.shold ? 0 : 1)}>Hold lid firmly in position: <b>{cfg.shold ? 'ON' : 'OFF'}</b></button>
          <small>Keep ON if the lid slips after moving.</small>
          <div className="seg" style={{ marginTop: 8 }}>
            <button onClick={() => set('buzz', cfg.buzz ? 0 : 1)}>Sound alert while open: <b>{cfg.buzz ? 'ON' : 'OFF'}</b></button>
            <button onClick={() => act('B')}>🔔 Test sound</button>
          </div>
          <small>Beeps while the box is open to alert users.</small>
          <Num {...p} k="spmin" label="Closed limit" min={300} max={1200} step={10} unit=" µs" hint="Fine-tune only if lid cannot close fully." />
          <Num {...p} k="spmax" label="Open limit" min={1800} max={2700} step={10} unit=" µs" hint="Fine-tune only if lid cannot open fully." />
        </div>

        <div className="card">
          <h2>7 · Front obstacle detection</h2>
          <small>Stops the robot when an object is in front, and resumes once clear.</small>
          <div className="row" style={{ margin: '10px 0' }}>
            <span>Distance ahead: <b style={{ color: 'var(--tx)' }}>{dist == null ? '–' : dist >= 400 ? 'clear' : dist + ' cm'}</b></span>
            <span style={{ color: hold ? 'var(--er)' : 'var(--ok)' }}>{hold ? '⛔ STOPPED (obstacle)' : '✔ Path clear'}</span>
          </div>
          <Num {...p} k="obsd" label="Stop distance" min={5} max={60} unit=" cm" hint="Distance to stop in front of an obstacle." />
          <button style={{ width: '100%', marginTop: 8 }} onClick={() => set('obsen', cfg.obsen ? 0 : 1)}>Obstacle auto-stop: <b>{cfg.obsen ? 'ON' : 'OFF'}</b></button>
        </div>

        <div className="card">
          <button className="estop" style={{ marginTop: 0 }} onClick={estop}>EMERGENCY STOP</button>
          <button style={{ width: '100%', marginTop: 10 }} onClick={reset}>Reset all to defaults</button>
        </div>
      </div>
    </div>
  )
}
