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
      <div className="bar"><b>⚙ Robot configuration</b><span style={{ color: 'var(--mu)', fontSize: 12 }}>Applies to Auto and Manual</span>
        <button onClick={onClose}>Done</button></div>
      <div className="app">
        <div className="card">
          <h2>1 · Motor balance (go straight)</h2>
          <small>Lift the robot off the floor first, then test on the floor. Always lower the stronger motor; 100% is the maximum.</small>
          <Num {...p} k="lg" label="Left motor power" min={50} max={100} unit="%" />
          <Num {...p} k="rg" label="Right motor power" min={50} max={100} unit="%" />
          <Num {...p} k="tsp" label="Test speed" min={80} max={255} />
          <div className="seg" style={{ marginTop: 10 }}>
            <button className="go" onClick={() => act('f')}>▶ Drive straight 2 s</button>
          </div>
          <div className="seg" style={{ marginTop: 8 }}>
            <button onClick={() => veer('left')}>↶ It veered LEFT</button>
            <button onClick={() => veer('right')}>It veered RIGHT ↷</button>
          </div>
          <small>Each tap trims the opposite motor by 1%. Repeat test → tap → test until the path is straight.</small>
        </div>

        <div className="card">
          <h2>2 · Motor start-up (dead-band)</h2>
          <small>Lowest PWM that makes each wheel actually move. Raise it until the wheel just starts turning at slow speeds.</small>
          <Num {...p} k="lmin" label="Left min PWM" min={0} max={200} />
          <Num {...p} k="rmin" label="Right min PWM" min={0} max={200} />
        </div>

        <div className="card">
          <h2>3 · Turn calibration</h2>
          <Num {...p} k="tspd" label="Spin-test / check speed" min={60} max={255} hint="Used by the spin test, steering check and correction check." />
          <div className="seg" style={{ margin: '10px 0' }}>
            <button onClick={() => act('s')}>↻ Spin test (1 s)</button>
            <input className="inp" type="number" placeholder="degrees turned" value={deg} onChange={(e) => setDeg(e.target.value)} />
            <button className="go" onClick={applySpin}>Calculate</button>
          </div>
          <small>Run the spin test, estimate the angle it turned (e.g. ¾ turn = 270), enter it and press Calculate. Then fine-tune below.</small>
          <small>Calculate sets both motors to ±turn speed and the times for 90° and 180°. Then fine-tune each motor below.</small>
          <small>Each turn sets the LEFT and RIGHT motor separately: negative = backwards, opposite signs = spin on the spot, one motor at 0 = swing around the other wheel. Different values compensate for unequal motors.</small>

          <h2 style={{ marginTop: 16 }}>90° left turn</h2>
          <Num {...p} k="l90l" label="Left motor" min={-255} max={255} />
          <Num {...p} k="l90r" label="Right motor" min={-255} max={255} />
          <Num {...p} k="l90t" label="Duration" min={20} max={1500} step={5} unit=" ms" />
          <Num {...p} k="advl" label="Forward before this turn" min={0} max={1500} step={5} unit=" ms" hint="0 = no forward move before this turn." />
          <div className="seg" style={{ marginTop: 8 }}>
            <button onClick={() => act('l')}>Test 90° ↰</button>
            <button onClick={() => act('v')}>Forward only</button>
          </div>

          <h2 style={{ marginTop: 16 }}>90° right turn</h2>
          <Num {...p} k="r90l" label="Left motor" min={-255} max={255} />
          <Num {...p} k="r90r" label="Right motor" min={-255} max={255} />
          <Num {...p} k="r90t" label="Duration" min={20} max={1500} step={5} unit=" ms" />
          <Num {...p} k="advr" label="Forward before this turn" min={0} max={1500} step={5} unit=" ms" hint="0 = no forward move before this turn." />
          <div className="seg" style={{ marginTop: 8 }}>
            <button onClick={() => act('r')}>Test 90° ↱</button>
            <button onClick={() => act('w')}>Forward only</button>
          </div>

          <h2 style={{ marginTop: 16 }}>180° U-turn</h2>
          <div className="seg">
            <button className={!cfg.udir ? 'sel' : ''} onClick={() => setUdir(0)}>Always LEFT</button>
            <button className={cfg.udir ? 'sel' : ''} onClick={() => setUdir(1)}>Always RIGHT</button>
          </div>
          <Num {...p} k="ul" label="Left motor" min={-255} max={255} />
          <Num {...p} k="ur" label="Right motor" min={-255} max={255} />
          <Num {...p} k="ut" label="Duration" min={20} max={3000} step={5} unit=" ms" />
          <Num {...p} k="advu" label="Forward before U-turn" min={0} max={1500} step={5} unit=" ms" hint="0 = no forward move before the U-turn." />
          <div className="seg" style={{ marginTop: 8 }}>
            <button onClick={() => act('u')}>Test 180° {cfg.udir ? '↷' : '↶'}</button>
            <button onClick={() => act('y')}>Forward only</button>
          </div>
          <small>The test buttons use pure timing, so what you see is what the settings give. Overshoots → shorten the duration; falls short → lengthen it.</small>
        </div>

        <div className="card">
          <h2>4 · Junction behaviour</h2>
          <small>Forward-before-turn is now set separately for each turn in section 3.</small>
          <button style={{ width: '100%', marginTop: 10 }} onClick={() => set('tcatch', cfg.tcatch ? 0 : 1)}>
            Line catch after turn: <b>{cfg.tcatch ? 'ON' : 'OFF'}</b>
          </button>
          <small>ON: the turn ends exactly when the centre sensor re-finds the line (within the time window below). OFF: pure timed turn.</small>
          <Num {...p} k="tex" label="Extra catch window" min={0} max={800} step={10} unit=" ms" />
        </div>

        <div className="card">
          <h2>5 · Wiring check</h2>
          <small>First, in Manual mode press ◀ — the robot must turn LEFT and ▲ must drive forward. If not, fix it here with the motor switches. Then run the steering check.</small>
          <div className="seg" style={{ marginTop: 10, flexWrap: 'wrap' }}>
            <button onClick={() => set('linv', cfg.linv ? 0 : 1)}>Left motor reversed: <b>{cfg.linv ? 'ON' : 'OFF'}</b></button>
            <button onClick={() => set('rinv', cfg.rinv ? 0 : 1)}>Right motor reversed: <b>{cfg.rinv ? 'ON' : 'OFF'}</b></button>
          </div>
          <button style={{ width: '100%', marginTop: 8 }} onClick={() => set('flip', cfg.flip ? 0 : 1)}>Swap left/right sensors: <b>{cfg.flip ? 'ON' : 'OFF'}</b></button>
          <button className="go" style={{ width: '100%', marginTop: 8 }} onClick={() => act('T')}>⟲ Steering check</button>
          <button style={{ width: '100%', marginTop: 8 }} onClick={() => set('sinv', cfg.sinv ? 0 : 1)}>Reverse line-correction direction: <b>{cfg.sinv ? 'ON' : 'OFF'}</b></button>
          <button className="go" style={{ width: '100%', marginTop: 8 }} onClick={() => act('K')}>✔ Correction check</button>
          <small>Correction check: the robot knocks itself slightly off the line, lets the line-following correction act, and reverses the correction direction automatically if it steers away from the black line. Put ONLY the centre sensor on the line first.</small>
          <small>Put ONLY the centre sensor on the line. The robot nudges left and watches which side the line moves to. If it is the wrong side, the sensors are swapped automatically.</small>
        </div>

        <div className="card">
          <h2>6 · Box servo (pin D32)</h2>
          <small>Use the slider to move the servo live, find the angle where the box is shut and where it is open, and save them below. Power the servo from its own 5 V supply (shared GND), not the ESP32 pin.</small>
          <div className="num">
            <label>Test angle <b>{ang}°</b></label>
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
          <Num {...p} k="sc" label="Closed angle" min={0} max={180} unit="°" />
          <Num {...p} k="so" label="Open angle" min={0} max={180} unit="°" />
          <Num {...p} k="sspd" label="Opening speed" min={10} max={720} step={10} unit="°/s" hint="Lower = gentler, no jerk for the contents." />
          <Num {...p} k="sauto" label="Auto-close after" min={0} max={60} unit=" s" hint="0 = stay open until you press Close." />
          <div className="seg" style={{ marginTop: 10 }}>
            <button className="go" onClick={() => act('O')}>📦 Open</button>
            <button onClick={() => act('P')}>Close</button>
            <button onClick={() => { act('O'); setTimeout(() => act('P'), 2500) }}>Open · 2.5 s · Close</button>
          </div>
          <button style={{ width: '100%', marginTop: 8 }} onClick={() => set('boxopen', cfg.boxopen ? 0 : 1)}>Open box at destination: <b>{cfg.boxopen ? 'ON' : 'OFF'}</b></button>
          <button style={{ width: '100%', marginTop: 8 }} onClick={() => set('shold', cfg.shold ? 0 : 1)}>Hold position after moving: <b>{cfg.shold ? 'ON' : 'OFF'}</b></button>
          <small>OFF releases the servo after it settles (no buzzing, saves battery). Turn ON if the lid pushes the arm back.</small>
          <div className="seg" style={{ marginTop: 8 }}>
            <button onClick={() => set('buzz', cfg.buzz ? 0 : 1)}>Buzzer alarm while open: <b>{cfg.buzz ? 'ON' : 'OFF'}</b></button>
            <button onClick={() => act('B')}>🔔 Test buzzer</button>
          </div>
          <small>Buzzer (pin D2) beeps 0.5 s on / 0.5 s off while the box is open and stops when it closes.</small>
          <Num {...p} k="spmin" label="Pulse at 0°" min={300} max={1200} step={10} unit=" µs" hint="Only change if the servo does not reach its full range (typical 500)." />
          <Num {...p} k="spmax" label="Pulse at 180°" min={1800} max={2700} step={10} unit=" µs" hint="Typical 2400." />
        </div>

        <div className="card">
          <h2>7 · Front obstacle sensor</h2>
          <small>When something is closer than the hold distance, the robot stops (Auto and Manual forward). It continues by itself as soon as the path is clear. Reverse and turning in Manual mode still work.</small>
          <div className="row" style={{ margin: '10px 0' }}>
            <span>Distance now: <b style={{ color: 'var(--tx)' }}>{dist == null ? '–' : dist >= 400 ? 'clear (> 4 m)' : dist + ' cm'}</b></span>
            <span style={{ color: hold ? 'var(--er)' : 'var(--ok)' }}>{hold ? '⛔ HOLDING' : '✔ path clear'}</span>
          </div>
          <Num {...p} k="obsd" label="Hold distance" min={5} max={60} unit=" cm" hint="Leave room to brake: the robot needs a few cm to stop. 15 cm is a good start. It resumes at this distance + 5 cm." />
          <button style={{ width: '100%', marginTop: 8 }} onClick={() => set('obsen', cfg.obsen ? 0 : 1)}>Obstacle hold: <b>{cfg.obsen ? 'ON' : 'OFF'}</b></button>
        </div>

        <div className="card">
          <button className="estop" style={{ marginTop: 0 }} onClick={estop}>EMERGENCY STOP</button>
          <button style={{ width: '100%', marginTop: 10 }} onClick={reset}>Reset all to defaults</button>
        </div>
      </div>
    </div>
  )
}
