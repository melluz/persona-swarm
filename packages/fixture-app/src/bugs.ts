/** Bugs planted in the fixture app. Conformance and recall measurements match findings against them. */
export interface PlantedBug {
  id: string
  title: string
  /** Words or phrases only a report about this bug is likely to use (or a pattern): at least one must be there. */
  signals: (string | RegExp)[]
  /** Words such a report often uses, but so do others (the mission's own words): they only add weight. */
  context: string[]
  where: string
}

export const PLANTED_BUGS: PlantedBug[] = [
  {
    id: 'silent-long-name',
    title: 'Creating an order with a customer name over 40 characters silently does nothing',
    signals: ['long', 'too long', 'characters', 'length', 'silent', 'silently', '40'],
    context: ['name', 'customer', 'nothing', 'create', 'save', 'no error', 'no message'],
    where: '/orders/new',
  },
  {
    id: 'search-accents',
    title: 'Search ignores accented names: "jose" does not find "José"',
    signals: ['accent', 'accents', 'accented', 'jose', 'josé', 'diacritic', 'diacritics'],
    context: ['search', 'find', 'not found', 'no results'],
    where: '/',
  },
  {
    id: 'double-submit',
    title: 'Double-clicking Save creates the same order twice',
    signals: ['double', 'twice', 'duplicate', 'duplicated', 'two orders', 'same order', 'double-click', 'double-clicking'],
    context: ['save', 'order', 'click', 'created'],
    where: '/orders/new',
  },
  {
    id: 'crash-on-zero',
    title: 'Quantity 0 shows a raw "Internal Server Error" page',
    signals: ['zero', 'quantity 0', 'internal server error', '500', 'crash', 'crashed', 'crashes'],
    context: ['quantity', 'error', 'server', 'internal'],
    where: '/orders/new',
  },
  {
    id: 'raw-date',
    title: 'The order page shows the delivery date as a raw timestamp',
    // The value itself, quoted from the page: 2026-11-20T00:00:00.000Z.
    signals: ['timestamp', 'iso', 'unformatted', 'raw date', /\d{4}-\d{2}-\d{2}t\d{2}:\d{2}/i],
    context: ['date', 'delivery', 'format', 'raw'],
    where: '/orders/:id',
  },
  {
    id: 'tiny-delete',
    title: 'The delete control is a 12 px icon, too small to tap',
    signals: ['tiny', 'small', 'too small', 'hard to tap', 'hard to hit', '12 px', '12px'],
    context: ['delete', 'icon', 'tap', 'target', 'button'],
    where: '/orders/:id',
  },
  {
    id: 'dark-mode-crash',
    title: 'Turning on dark mode does not stick and logs an error',
    signals: ['dark mode', 'dark', 'theme'],
    context: ['mode', 'setting', 'settings', 'not saved', 'does not stick', 'toggle', 'resets'],
    where: '/settings',
  },
]

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A word or phrase as a whole: "0" is not in "2026", "long" is not in "belong". */
const whole = (phrase: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(phrase)}(?![\\p{L}\\p{N}])`, 'iu')
const PATTERNS = new Map(
  PLANTED_BUGS.map((bug) => [
    bug.id,
    { signals: bug.signals.map((signal) => (typeof signal === 'string' ? whole(signal) : signal)), context: bug.context.map(whole) },
  ]),
)

/**
 * Which planted bug a finding is about, if any: at least one of the bug's own signals and enough
 * weight in all (a signal counts twice), the best score only. A tie is no match: a report that fits
 * two bugs equally is not evidence for either.
 */
export function matchPlantedBug(text: string): PlantedBug | undefined {
  const scored = PLANTED_BUGS.map((bug) => {
    const patterns = PATTERNS.get(bug.id) as { signals: RegExp[]; context: RegExp[] }
    const signals = patterns.signals.filter((pattern) => pattern.test(text)).length
    const context = patterns.context.filter((pattern) => pattern.test(text)).length
    return { bug, signals, score: signals * 2 + context }
  })
    .filter((entry) => entry.signals > 0 && entry.score >= 3)
    .sort((a, b) => b.score - a.score)
  const [best, next] = scored
  return best && (!next || next.score < best.score) ? best.bug : undefined
}
