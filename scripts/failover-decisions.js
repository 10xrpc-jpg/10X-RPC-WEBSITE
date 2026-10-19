// 10X RPC — Pillar failover DECISION CORE (pure, dependency-free).
//
// Shared by the supervisor (index.js lease controller). Kept as a pure
// function so the adoption/release rules can be exercised directly against
// scenario matrices without a database.
//
// Cluster contract:
//   • Every supervisor writes a lease row every 15s: { nodeId, roles[] } —
//     roles = its own DAEMON_ROLE pillar(s) + any pillar it currently runs as
//     a failover child.
//   • A lease older than the TTL is not "fresh" — the node counts as DOWN.
//   • A pillar with NO fresh owner is ORPHANED. The designated survivor (the
//     lexicographically lowest fresh nodeId) adopts it — exactly one node
//     takes over, so the pillar never runs on two nodes for more than one
//     beat. When the original owner's lease goes fresh again, the adopter
//     releases (its close handler stops the failover child without restart).
'use strict'

const PILLARS = ['status', 'rpc', 'game']

/**
 * @param {{
 *   myNodeId: string,
 *   baseCoverage: string[],          // pillars this node owns by right
 *   runningChildRoles: string[],     // failover children currently running
 *   freshLeases: Array<{ nodeId: string, roles: string[] }>, // includes SELF
 * }} input
 * @returns {{ adopt: string[], release: string[], designatedId: string | null }}
 */
function computeFailoverDecisions(input) {
  const { myNodeId, baseCoverage, runningChildRoles, freshLeases } = input
  const designatedId =
    (Array.isArray(freshLeases) && freshLeases.length > 0)
      ? freshLeases.map(f => String(f.nodeId)).sort()[0]
      : null

  const decisions = { adopt: [], release: [], designatedId }

  for (const pillar of PILLARS) {
    if (baseCoverage.includes(pillar)) continue // mine by right — never adopt/release
    const ownerAlive = (freshLeases || []).some(
      f => f && f.nodeId !== myNodeId && Array.isArray(f.roles) && f.roles.includes(pillar),
    )
    const adoptedByMe = (runningChildRoles || []).includes(pillar)

    if (!ownerAlive && !adoptedByMe && designatedId === myNodeId) {
      decisions.adopt.push(pillar)
    } else if (ownerAlive && adoptedByMe) {
      decisions.release.push(pillar)
    }
  }
  return decisions
}

module.exports = { PILLARS, computeFailoverDecisions }
