import type { TranscriptSegment } from './types'

const INDEX_THRESHOLD = 8

export function mergeDelta(prev: TranscriptSegment[], delta: TranscriptSegment[]): TranscriptSegment[] {
  const next = [...prev]
  let changed = false
  const idx = delta.length > INDEX_THRESHOLD ? new Map(next.map((s, i) => [s.id, i])) : null

  for (const seg of delta) {
    let at: number | undefined
    if (idx) {
      at = idx.get(seg.id)
    } else {
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].id === seg.id) {
          at = i
          break
        }
      }
    }

    if (at === undefined) {
      idx?.set(seg.id, next.length)
      next.push(seg)
      changed = true
    } else if (seg.revision > next[at].revision) {
      next[at] = seg
      changed = true
    }
  }
  return changed ? next : prev
}
