import { createHash } from 'node:crypto'

const STOPWORDS = new Set(
  'a an the and or but if then else of to in on at by for with from as is are was were be been being it its this that these those i me my we our you your he she they them their there here not no do does did done have has had can could should would will just very so too when while after before into onto over under up down out than also only same again any each all some more most'.split(
    ' ',
  ),
)

/**
 * Accents that only decorate a letter (é, ö, ñ; Greek tonos; Hebrew points; Arabic short vowels) are
 * folded away. Marks that make a different word are kept: Indic vowel signs, Thai tone marks,
 * Japanese voicing marks ("फ़ॉर्म खाली" is not "फ़ॉर्म खुला").
 */
const DECORATIVE_MARKS =
  /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7\u064b-\u065f\u0670]/g

/** Lower case, decorative accents and apostrophe variants folded, punctuation to spaces. Any script. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(DECORATIVE_MARKS, '')
    .replace(/[‘’ʼ`´]/g, "'")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}']+/gu, ' ')
    .replace(/'/g, '')
    .trim()
}

/** Scripts written without spaces between words: compared by pairs of characters instead. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u

/** Crude stemming: enough to match "failing", "fails" and "failed". */
function stem(word: string): string {
  for (const suffix of ['ing', 'ed', 'es', 's']) if (word.length > suffix.length + 3 && word.endsWith(suffix)) return word.slice(0, -suffix.length)
  return word
}

export function wordSet(text: string): Set<string> {
  const words = new Set<string>()
  for (const word of normalizeText(text).split(' ')) {
    if (UNSPACED.test(word)) {
      const chars = [...word]
      if (chars.length === 1) words.add(word)
      for (let i = 0; i + 1 < chars.length; i += 1) words.add(`${chars[i]}${chars[i + 1]}`)
    } else if (word.length > 1 && !STOPWORDS.has(word)) words.add(stem(word))
  }
  return words
}

export function trigramSet(text: string): Set<string> {
  const normalized = ` ${normalizeText(text)} `
  const grams = new Set<string>()
  for (let i = 0; i + 3 <= normalized.length; i += 1) grams.add(normalized.slice(i, i + 3))
  return grams
}

/** Overlap of two sets, 0 to 1. Nothing to compare (an empty side) is no evidence of sameness: 0. */
export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 || b.size === 0) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const item of small) if (large.has(item)) shared += 1
  return shared / (a.size + b.size - shared)
}

/** A text's words and trigrams, worked out once: comparing many texts pairwise reuses them. */
export interface TextProfile {
  words: Set<string>
  grams: Set<string>
}

export function textProfile(text: string): TextProfile {
  return { words: wordSet(text), grams: trigramSet(text) }
}

/** 0 to 1: a blend of word overlap (meaning) and character trigrams (wording and typos). */
export function profileSimilarity(a: TextProfile, b: TextProfile): number {
  return 0.6 * jaccard(a.words, b.words) + 0.4 * jaccard(a.grams, b.grams)
}

export function textSimilarity(a: string, b: string): number {
  return profileSimilarity(textProfile(a), textProfile(b))
}

/** A problem report's profiles: its title, and its title with what happened. */
export interface ProblemProfile {
  title: TextProfile
  full: TextProfile
}

export function problemProfile(problem: { title: string; actual?: string }): ProblemProfile {
  return { title: textProfile(problem.title), full: textProfile(`${problem.title} ${problem.actual ?? ''}`) }
}

/**
 * How alike two problem reports are, 0 to 1. Short titles carry the gist and long descriptions add
 * detail but also noise, so the closer of the two comparisons wins.
 */
export function problemProfileSimilarity(a: ProblemProfile, b: ProblemProfile): number {
  return Math.max(profileSimilarity(a.title, b.title), profileSimilarity(a.full, b.full))
}

export function problemSimilarity(a: { title: string; actual?: string }, b: { title: string; actual?: string }): number {
  return problemProfileSimilarity(problemProfile(a), problemProfile(b))
}

const withIds = (path: string) =>
  path
    .split('/')
    .map((segment) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) ||
      /^\d+$/.test(segment) ||
      /^[0-9a-f]{16,}$/i.test(segment) ||
      (/[0-9]/.test(segment) && /[a-z]/i.test(segment) && segment.length >= 12)
        ? ':id'
        : segment,
    )
    .join('/')

/**
 * Replaces ids in a URL path so "/cases/3f2a…" and "/cases/9b1c…" compare equal. An app that routes
 * in the fragment ("/#/orders/7") keeps its route: "/#/orders/:id".
 */
export function routePattern(url: string): string {
  let path: string
  let hash: string
  try {
    const parsed = new URL(url)
    path = parsed.pathname
    hash = parsed.hash
  } catch {
    path = url.split(/[?#]/)[0] ?? ''
    hash = url.includes('#') ? url.slice(url.indexOf('#')) : ''
  }
  const hashRoute = /^#!?\//.test(hash) ? (hash.replace(/^#!?/, '').split('?')[0] ?? '') : ''
  return hashRoute ? `${withIds(path)}#${withIds(hashRoute)}` : withIds(path)
}

/** A stable fingerprint for a problem: the route and the most telling words of its title. */
export function fingerprint(title: string, url: string): string {
  const words = [...wordSet(title)].sort().slice(0, 12).join(' ')
  return createHash('sha1')
    .update(`${routePattern(url)}|${words}`)
    .digest('hex')
    .slice(0, 12)
}
