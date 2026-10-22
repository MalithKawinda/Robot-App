import { useState } from 'react'
import { key, H } from './nav.js'

const COLS = 9, ROWS = 7, C = 46, P = 24
const px = (g) => P + g * C
const TOOLS = [['node', '➕ Junction'], ['line', '🔗 Line'], ['name', '📍 Location'], ['robot', '🤖 Robot']]
const HELP = {
  node: 'Tap the grid to add or remove junctions.',
  line: 'Tap two junctions to connect them with a track line.',
  name: 'Tap a junction to name it as a destination (e.g. "Kitchen").',
  robot: 'Tap where the robot currently is and set its facing direction.',
}

export default function MapEditor({ map, save, onClose, routeNodes = [] }) {
  const [tool, setTool] = useState('node')
  const [sel, setSel] = useState(null)
  const [msg, setMsg] = useState('')
  const nodeAt = (x, y) => Object.entries(map.nodes).find(([, n]) => n.x === x && n.y === y)?.[0]
  const clone = () => ({ nodes: { ...map.nodes }, edges: { ...map.edges }, robot: map.robot || null })
  const routeKeys = new Set(routeNodes.slice(1).map((id, i) => key(routeNodes[i], id)))

  const tap = (x, y) => {
    const id = nodeAt(x, y), m = clone()
    setMsg('')
    if (tool === 'node') {
      if (!id) m.nodes['n' + Date.now().toString(36)] = { x, y }
      else {
        delete m.nodes[id]
        for (const k of Object.keys(m.edges)) if (k.split('_').includes(id)) delete m.edges[k]
        if (m.robot?.node === id) m.robot = null
      }
      return save(m)
    }
    if (!id) return setSel(null)
    if (tool === 'line') {
      if (!sel) return setSel(id)
      if (sel === id) return setSel(null)
      const a = m.nodes[sel], b = m.nodes[id]
      setSel(null)
      if (a.x !== b.x && a.y !== b.y) return setMsg('Lines must be straight (same row or column).')
      const between = Object.values(m.nodes).some((n) => n !== a && n !== b &&
        ((a.x === b.x && n.x === a.x && n.y > Math.min(a.y, b.y) && n.y < Math.max(a.y, b.y)) ||
         (a.y === b.y && n.y === a.y && n.x > Math.min(a.x, b.x) && n.x < Math.max(a.x, b.x))))
      if (between) return setMsg('Another junction is in between – connect neighbouring junctions only.')
      const k = key(sel, id)
      if (m.edges[k]) delete m.edges[k]; else m.edges[k] = true
      return save(m)
    }
    if (tool === 'name') {
      const nm = window.prompt('Location name (empty = not a location)', m.nodes[id].name || '')
      if (nm === null) return
      m.nodes[id] = { ...m.nodes[id] }
      if (nm.trim()) m.nodes[id].name = nm.trim(); else delete m.nodes[id].name
      return save(m)
    }
    if (tool === 'robot') { m.robot = { node: id, h: m.robot?.h ?? 0 }; save(m) }
  }
  const setHeading = (h) => map.robot && save({ ...clone(), robot: { ...map.robot, h } })
  const clear = () => window.confirm('Delete the whole map?') && save({ nodes: {}, edges: {}, robot: null })

  const pts = []
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) pts.push([x, y])
  return (
    <div className="sheet">
      <div className="bar"><b>🗺 Map editor</b><button onClick={onClose}>Done</button></div>
      <div className="app">
        <div className="card">
          <div className="seg" style={{ flexWrap: 'wrap' }}>
            {TOOLS.map(([t, l]) => <button key={t} className={tool === t ? 'sel' : ''} onClick={() => { setTool(t); setSel(null); setMsg('') }}>{l}</button>)}
          </div>
          <small>{HELP[tool]}</small>
          {msg && <small style={{ color: 'var(--er)' }}>{msg}</small>}
          {tool === 'robot' && map.robot && (
            <div className="seg" style={{ marginTop: 8 }}>
              {H.map((n, i) => <button key={n} className={map.robot.h === i ? 'sel' : ''} onClick={() => setHeading(i)}>{n[0]}</button>)}
            </div>
          )}
        </div>
        <div className="card" style={{ padding: 6 }}>
          <svg viewBox={`0 0 ${P * 2 + (COLS - 1) * C} ${P * 2 + (ROWS - 1) * C}`} style={{ width: '100%', touchAction: 'manipulation' }}>
            {pts.map(([x, y]) => <circle key={x + '-' + y} cx={px(x)} cy={px(y)} r="2" fill="#2a3140" />)}
            {Object.keys(map.edges).map((k) => {
              const [a, b] = k.split('_'), A = map.nodes[a], B = map.nodes[b]
              return A && B && <line key={k} x1={px(A.x)} y1={px(A.y)} x2={px(B.x)} y2={px(B.y)}
                stroke={routeKeys.has(k) ? '#f5a623' : '#8b94a7'} strokeWidth={routeKeys.has(k) ? 7 : 5} strokeLinecap="round" />
            })}
            {Object.entries(map.nodes).map(([id, n]) => (
              <g key={id}>
                <circle cx={px(n.x)} cy={px(n.y)} r="10" fill={id === sel ? '#f5a623' : n.name ? '#2ecc71' : '#4f8cff'} stroke="#0f1218" strokeWidth="2" />
                {n.name && <text x={px(n.x)} y={px(n.y) + 25} fontSize="11" fill="#e8ecf3" textAnchor="middle">{n.name}</text>}
              </g>
            ))}
            {map.robot && map.nodes[map.robot.node] && (
              <polygon points="0,-15 8,8 -8,8" fill="#ff4d4f" stroke="#0f1218" strokeWidth="1.5"
                transform={`translate(${px(map.nodes[map.robot.node].x)},${px(map.nodes[map.robot.node].y)}) rotate(${map.robot.h * 90})`} />
            )}
            {pts.map(([x, y]) => <circle key={'t' + x + '-' + y} cx={px(x)} cy={px(y)} r={C / 2.3} fill="transparent" onClick={() => tap(x, y)} />)}
          </svg>
          <small style={{ textAlign: 'center' }}>Top is North. Draw the track as seen from above.</small>
        </div>
        <div className="card">
          <h2>Route navigation</h2>
          <small>The robot automatically calculates the shortest path between junctions to reach the selected destination.</small>
          <button style={{ width: '100%', marginTop: 10 }} onClick={clear}>Clear map</button>
        </div>
      </div>
    </div>
  )
}
