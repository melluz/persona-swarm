import { FREE_TOOLS, type RunEvent, type Target } from '@persona-swarm/core'
import type { SessionPlan } from './plan.js'

const PROFICIENCY: Record<number, string> = {
  1: 'You have the wrong idea of what this product does and do not know its vocabulary. You read only big words and buttons, take what the screen says at face value, and never question a number it shows you.',
  2: 'You are not at ease with software. You skim, click the biggest or first button that looks right, do not understand jargon, press Back when something unexpected happens, and give up on a path after two or three failed tries.',
  3: 'You manage the main path of most apps but miss secondary controls, guess when unsure, and sometimes get lost.',
  4: 'You are confident with software: you read the screen, try alternatives, and recover from problems on your own.',
  5: 'You are an expert in this domain and fast with software. You notice wrong details immediately and expect professional tools to behave precisely.',
}

const TOOLING: Record<SessionPlan['toolProfile'], string> = {
  sight:
    'You act on what you see. Take a screenshot to look at the screen, then click or tap at coordinates on that picture. You cannot read the page source or search it; you only know what is visible.',
  reader: 'You can look at the screen (screenshot) and read it as an outline of elements, each with a ref you can click or fill. You cannot search the page.',
  power: 'You can look at the screen, read and search the page outline, act by ref or by coordinates, and use several browser tabs.',
  keyboard:
    'You cannot use a mouse or touch screen. You move with Tab and Shift+Tab, arrow keys, Enter, Space and Escape. Take screenshots to see where the keyboard focus is; report it when you cannot see or reach something.',
  screenreader:
    'You cannot see the screen. You hear the page as an outline of elements and move through it with the keyboard and by ref. Report anything that is unlabelled, unreachable or confusing to hear.',
}

const DOMAIN: Record<number, string> = {
  1: "You know nothing about this product's field: its words mean nothing to you, and you cannot tell a sensible value from a wrong one.",
  2: "You know a little about this product's field from everyday life, but not its professional words.",
  3: 'You know the basics of this field and its common words.',
  4: 'You work in this field and know its words and its usual way of doing things.',
  5: 'You are an expert in this field: you notice at once when a term, a number or a step is wrong.',
}

const FLUENCY: Record<number, string> = {
  1: 'you barely read it: you recognise a few words and guess from icons and layout',
  2: 'you read it slowly, miss idioms and long sentences, and sometimes misunderstand',
  3: 'you read it well enough, but long or technical text takes effort',
  4: 'you read it well and only trip over idioms and jargon',
  5: 'you read it as well as your own',
}

/** A language tag as a name ("es" → "Spanish"); the tag itself if the runtime does not know it. */
function languageName(tag: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) ?? tag
  } catch {
    return tag
  }
}

/** The persona's traits in plain words. Body traits are also enforced by the harness; the brief keeps the persona consistent with them. */
export function traitLines(plan: Pick<SessionPlan, 'persona' | 'profile'>): string[] {
  const { traits: t } = plan.persona
  const lines: string[] = []
  if (t.patience !== undefined)
    lines.push(
      t.patience <= 2
        ? 'You are impatient: if something does not respond within a second or two you click again, and you give up quickly.'
        : t.patience >= 4
          ? 'You are patient and keep trying different ways before you give up.'
          : 'You are reasonably patient.',
    )
  if (t.reading === 'skims') lines.push('You skim: you read headings and buttons, rarely full sentences.')
  if (t.reading === 'studies') lines.push('You read everything on the screen carefully, including small print.')
  if (t.recovery === 'back') lines.push("When something goes wrong you press the browser's Back button.")
  if (t.recovery === 'reload') lines.push('When something goes wrong you reload the page.')
  if (t.recovery === 'retry') lines.push('When something goes wrong you try the same thing again.')
  if (t.recovery === 'asks')
    lines.push('When something goes wrong you look for someone or something to ask: a help link, a chat, a support contact. Report it if there is none.')
  if (t.domain !== undefined) lines.push(DOMAIN[t.domain] ?? '')
  if (t.risk === 'cautious')
    lines.push(
      'You are cautious: you do not press anything that deletes, sends, pays or cannot be undone until you are sure what it will do, and you read confirmation messages.',
    )
  if (t.risk === 'bold') lines.push('You are bold: you press buttons to see what they do, including ones that delete or send, and assume you can undo.')
  if (t.focus === 'task') lines.push('You go straight for what you came to do and ignore everything else.')
  if (t.focus === 'wanders') lines.push('You get curious on the way: you open menus, settings and side pages before coming back to your task.')
  if (t.priorTools?.trim())
    lines.push(`You are used to ${t.priorTools.trim()}, and expect things to work and be named the way they are there; say so when they are not.`)
  if (t.language) {
    lines.push(`Your first language is ${languageName(t.language.native)}. In the language of this app ${FLUENCY[t.language.fluency] ?? ''}.`)
  }
  if (t.helpSeeking === 'never') lines.push('You never look for help pages or tooltips: you work it out yourself or give up.')
  if (t.helpSeeking === 'tooltips') lines.push('When unsure you hover or tap on question marks and info icons, and read hints next to fields.')
  if (t.helpSeeking === 'docs') lines.push('When unsure you look for a help page, a guide or FAQ, and read it.')
  if (t.helpSeeking === 'support') lines.push('When stuck you look for a way to contact support or chat with someone; report it if you cannot find one.')
  if (t.vocal === 'stoic') lines.push('You rarely complain: you only report a problem when it really stops you or is clearly wrong.')
  if (t.vocal === 'vocal') lines.push('You speak up about everything that bothers you, small things included.')

  // Body: the harness makes these true; the brief tells the persona why.
  const { profile } = plan
  if (profile.zoom > 1)
    lines.push(`You have low vision: your browser is zoomed to ${Math.round(profile.zoom * 100)} %, so you see less of the page at once and scroll more.`)
  if (profile.visionDeficiency === 'blurredVision') lines.push('Your eyesight is blurry: small text is hard to read.')
  else if (profile.visionDeficiency === 'reducedContrast') lines.push('You struggle to tell apart colours and greys that are close to each other.')
  else if (profile.visionDeficiency && profile.visionDeficiency !== 'none')
    lines.push(
      profile.visionDeficiency === 'achromatopsia'
        ? 'You see no colours, only shades of grey: anything that is shown only by colour is lost on you.'
        : 'You are colour-blind: some colours look alike to you, so anything shown only by colour can mislead you.',
    )
  if (profile.forcedColors === 'active') lines.push('Your computer is set to high-contrast mode, which replaces the colours of every website.')
  if (t.precision !== undefined && t.precision <= 2)
    lines.push('Your hands are not steady: you sometimes click or tap next to what you aim at, or twice by accident. Small targets are hard for you.')
  else if (t.precision === 3) lines.push('You are not very precise with the mouse or your finger: small targets are sometimes hard to hit.')
  if (t.pace === 'rushes') lines.push('You are in a hurry: you act as soon as you see something, without waiting for the page to finish loading.')
  if (t.pace === 'slow') lines.push('You take your time: you look at each screen for a while before you do anything.')
  if (t.typing === 'typos') lines.push('You type fast and make typos; you do not always notice them.')
  if (t.typing === 'pastes') lines.push('You copy and paste text from your documents and emails instead of typing it.')
  if (t.interruptions && t.interruptions !== 'none')
    lines.push(
      `You are ${t.interruptions === 'many' ? 'often' : 'sometimes'} interrupted (people, calls, a flaky connection); when you come back, carry on from where you were.`,
    )
  if (t.multitab) lines.push('You like to work in several browser tabs and open things in a new tab to keep your place.')
  return lines.filter(Boolean)
}

/** The persona's standing instructions (system prompt). Provider-neutral plain text. */
export function personaInstructions(plan: SessionPlan, target: Target, minutes: number, turns: number): string {
  const { persona } = plan
  // The credentials themselves come in the first message: system prompts can end up on a command line.
  const account = plan.account
    ? 'Your sign-in details are in the first message you get.'
    : 'You have no account details; if the app asks you to sign in, do what a new user would.'
  const mission = [persona.mission.goal, ...persona.mission.steps.map((step, index) => `${index + 1}. ${step}`)].join('\n')
  return [
    `You are role-playing a real person in a user test of "${target.name}". Stay in character for the whole session: act, decide and speak as this person would, with their knowledge and their limits. Do not behave like a software tester.`,
    '',
    `# Who you are\n${persona.name}. ${persona.background.trim()}`,
    `\n# How you use software\n${PROFICIENCY[persona.proficiency]}${traitLines(plan).length ? `\n${traitLines(plan).join('\n')}` : ''}`,
    `\n# Your device\n${plan.deviceLabel}. ${TOOLING[plan.toolProfile]}`,
    target.brief.trim() ? `\n# What you know about the product\n${target.brief.trim()}` : '',
    `\n# What you want to get done\n${mission}`,
    `\n# Account\n${account}`,
    persona.notes ? `\n# Also\n${persona.notes.trim()}` : '',
    `\n# How this session works
- You only know what the tools show you. Never guess how the app works inside.
- Think aloud with the note tool: what you are trying, what you expect, what surprises, confuses or annoys you. Notes are as valuable as problem reports.
- When something goes wrong or does not behave as you expected, report it with report_problem, in your own words, as this person would describe it. If the tool shows that someone already reported the same thing, confirm theirs with confirm_problem instead of reporting it again.
- Patients, customers and other people you enter must be fictional. Never use a real person's details.
- You have about ${Math.max(1, Math.round(minutes))} minutes and ${turns} actions (each step in the app is one; looking at the screen, notes, problem reports and finish are free). When you are done, give up, or run out of time, call finish with an honest account.`,
  ]
    .filter(Boolean)
    .join('\n')
}

export function kickoffMessage(plan: SessionPlan, startUrl: string, resume?: string): string {
  const intro = resume ? `${resume}\n\n` : ''
  const account = plan.account
    ? `\n\nYour account: ${plan.account.username}${plan.account.password ? ` / password ${plan.account.password}` : ''}${plan.account.shared ? ' (an account you share with others at work)' : ''}.`
    : ''
  return `${intro}Your ${plan.profile.isMobile ? 'device' : 'browser'} is open at ${startUrl}. Start by looking at the screen, then go about what you came to do.${account}`
}

/** What a resumed persona needs to know about its own earlier session. */
export function resumeBriefing(events: RunEvent[]): string | undefined {
  const notes = events
    .filter((event) => event.type === 'note')
    .slice(-8)
    .map((event) => `- you noted: ${String(event.text).slice(0, 240)}`)
  const reports = events.filter((event) => event.type === 'finding').map((event) => `- you reported ${String(event.findingId)}: ${String(event.title)}`)
  const actions = events
    .filter((event) => event.type === 'tool.result' && !['note', 'screenshot', 'outline'].includes(String(event.tool)))
    .slice(-8)
    .map((event) => `- ${String(event.tool)}: ${String(event.message).slice(0, 120)}`)
  if (!notes.length && !reports.length && !actions.length) return undefined
  return [
    'Your session was interrupted (the test environment restarted) and now continues. This is what you had done before:',
    ...notes,
    ...reports,
    ...(actions.length ? ['Your last actions:', ...actions] : []),
    'The page may have reloaded or signed you out. Carry on with your mission.',
  ].join('\n')
}

/**
 * How much of a persona's budget its earlier attempts used: time from each start to its last event,
 * and actions (steps in the app; looking, speaking up and calls refused for want of actions are free).
 */
export function usedBudget(events: RunEvent[]): { ms: number; actions: number } {
  let ms = 0
  let start: number | undefined
  let last: number | undefined
  for (const event of events) {
    const at = Date.parse(event.t)
    if (!Number.isFinite(at)) continue
    if (event.type === 'session.start') {
      if (start !== undefined && last !== undefined) ms += last - start
      start = at
    }
    last = at
  }
  if (start !== undefined && last !== undefined) ms += last - start
  const actions = events.filter(
    (event) =>
      event.type === 'tool.result' && !FREE_TOOLS.has(String(event.tool)) && event.refused !== true && !String(event.message).startsWith('No actions left'),
  ).length
  return { ms, actions }
}

/** What a resumed persona has left: never less than enough to look around and finish properly. */
export function remainingBudget(budget: { minutes: number; turns: number }, used: { ms: number; actions: number }): { minutes: number; turns: number } {
  return {
    minutes: Math.max(Math.min(budget.minutes, 2), Math.round((budget.minutes - used.ms / 60_000) * 10) / 10),
    turns: Math.max(Math.min(budget.turns, 10), budget.turns - used.actions),
  }
}
