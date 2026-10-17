// Map = graph.  nodes: {id:{x,y,name?}}  edges: {"a_b":true}  robot: {node, h}
// Headings: 0 North, 1 East, 2 South, 3 West (up = North on the editor grid).
export const H = ['North', 'East', 'South', 'West']
export const ACTION = { S: 'Straight', L: 'Left', R: 'Right', U: 'U-turn' }
export const key = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`)

// compass direction of the line leading from point p to point q (they share a row or column)
export const dirOf = (p, q) => (q.x > p.x ? 1 : q.x < p.x ? 3 : q.y < p.y ? 0 : 2)

export function neighbours(map, id) {
  const out = [], n = map.nodes
  for (const k of Object.keys(map.edges)) {
    const [a, b] = k.split('_')
    if (a === id) out.push({ to: b, dir: dirOf(n[a], n[b]) })
    else if (b === id) out.push({ to: a, dir: dirOf(n[b], n[a]) })
  }
  return out
}

// Breadth-first search: explore junctions ring by ring (1 junction away, then 2, ...).
// The first time we reach the target is the route with the fewest junctions.
export function bfs(map, from, to) {
  const prev = { [from]: null }, queue = [from]
  while (queue.length) {
    const cur = queue.shift()
    if (cur === to) break
    for (const { to: nx } of neighbours(map, cur)) if (!(nx in prev)) { prev[nx] = cur; queue.push(nx) }
  }
  if (!(to in prev)) return null
  const route = []
  for (let c = to; c !== null; c = prev[c]) route.unshift(c)
  return route
}

// the turn needed to change heading hin -> hout, from the robot's point of view
export const turnOf = (hin, hout) => ['S', 'R', 'U', 'L'][(hout - hin + 4) % 4]

// steps[i] = what to do at route[i]. hin = heading on arrival, action = turn to take there (null at the destination)
export function buildPlan(map, route, h0) {
  const dirs = route.slice(0, -1).map((id, i) => dirOf(map.nodes[id], map.nodes[route[i + 1]]))
  return route.map((node, i) => {
    const hin = i === 0 ? h0 : dirs[i - 1]
    return { node, hin, action: i === route.length - 1 ? null : turnOf(hin, dirs[i]) }
  })
}

// Which side exits should exist at `id` when we arrive with heading hin (used to verify the robot's position)
export function expectedArms(map, id, hin) {
  const d = neighbours(map, id).map((x) => x.dir)
  return { L: d.includes((hin + 3) % 4), R: d.includes((hin + 1) % 4) }
}
export const sensedArms = (t) => ({ L: t === 'LEFT' || t === 'BOTH', R: t === 'RIGHT' || t === 'BOTH' })
