// The orchestrator: one entry point for the owner's spoken requests about all of his projects. It matches a project
// by name or alias (the PROJECT# registry), routes "tell X to ..." to that project's worker (agents.mjs), and builds
// spoken reports from the workers' status files (status.mjs) and their live state (AGENT#): status on all or some
// projects, what needs the owner, details on one, and the morning and evening briefings.
// It's plain code, not a model: the same words always route the same way, answers take no time, and it costs
// nothing between requests. The Claude work happens in the workers.
// Dependencies are passed in, so tests run with fakes and no AWS.
import { OWNER } from './owner.mjs';
import { resolveProject, STALE_MS, norm } from './agents.mjs';

const ARTICLE = /^(?:the|my|our)\s+/i;
const PROGRAMS = '(?:programs?|projects?|repos?|agents?|workers?)';
const ALL = new RegExp(`^(?:give me (?:a |the )?|what'?s the |what is the )?status(?: report)? (?:on|of|for) (?:all|every|everything)(?: (?:my |the |of my |of the )?${PROGRAMS})?$`, 'i');
const ALL2 = new RegExp(`^(?:status (?:on|of|for) )?(?:all|every) (?:my |the )?${PROGRAMS}(?: status)?$`, 'i');
const SOME = /^(?:what'?s the |what is the )?status (?:on|of|for) (.+)$/i;
const NEEDS = /^(?:what|anything|does anything|is anything|who)(?:'s| is)? (?:needs?|(?:is )?waiting (?:on|for)) (?:me|my (?:attention|input|decision))$/i;
const DETAILS = /^(?:give me |tell me )?(?:the )?(?:details?|full status|everything) (?:on|of|for|about) (.+)$/i;
const TELL = /^(?:tell|ask|have|get) (.+?) to (.+)$/i;
const MORNING = /^(?:(?:give me |start |read me )?(?:the |my )?)?(?:morning|daily) (?:briefing|brief|report)$/i;
const EVENING = /^(?:(?:give me |start |read me )?(?:the |my )?)?(?:evening|end of day|end of the day|nightly|overnight|night) (?:briefing|brief|report)$/i;

const RANK = { blocked: 0, 'needs attention': 1, 'on track': 2, unknown: 3 };
const LIST_MAX = 8;   // projects read out one by one before "and N more"

/** What was said -> a command for the orchestrator, or null when it's something else (a task, a reply). */
export function parseCommand(said) {
  const t = String(said ?? '').replace(/[\s.!?]+$/, '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (ALL.test(t) || ALL2.test(t)) return { kind: 'all' };
  if (NEEDS.test(t)) return { kind: 'needs' };
  if (MORNING.test(t)) return { kind: 'morning' };
  if (EVENING.test(t)) return { kind: 'evening' };
  let m = DETAILS.exec(t);
  if (m) return { kind: 'details', name: m[1].replace(ARTICLE, '') };
  m = SOME.exec(t);
  if (m) return { kind: 'some', names: splitNames(m[1]) };
  m = TELL.exec(t);
  if (m) return { kind: 'tell', name: m[1].replace(ARTICLE, ''), task: m[2] };
  return null;
}

// "the trader, CVR and bridge relay" -> ['trader', 'CVR', 'bridge relay']
export function splitNames(s) {
  return String(s).split(/\s*(?:,|\band\b|&|\bplus\b)\s*/i).map((x) => x.replace(ARTICLE, '').trim()).filter(Boolean);
}

/** A link said aloud: "pull request 45" for a GitHub PR, never the address itself. */
export function spokenWhere(where) {
  const w = String(where ?? '').trim();
  if (!w) return '';
  let m = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/i.exec(w);
  if (m) return `pull request ${m[2]} in ${m[1].replace(/[-_.]+/g, ' ')}`;
  m = /github\.com\/[^/]+\/([^/]+)\/issues\/(\d+)/i.exec(w);
  if (m) return `issue ${m[2]} in ${m[1].replace(/[-_.]+/g, ' ')}`;
  m = /github\.com\/[^/]+\/([^/]+)\/tree\/([^?#]+)/i.exec(w);
  if (m) return `branch ${decodeURIComponent(m[2])} in ${m[1].replace(/[-_.]+/g, ' ')}`;
  if (/^https?:\/\//i.test(w)) return 'a link in the status file';
  return w.replace(/^PR[- ]?(\d+)$/i, 'pull request $1');
}

export function ago(ms) {
  const min = Math.round(ms / 60_000);
  if (min < 2) return 'just now';
  if (min < 60) return `${min} minutes ago`;
  const h = Math.round(min / 60);
  if (h < 36) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} days ago`;
}

const sentence = (s) => { const t = String(s ?? '').trim(); return !t ? '' : /[.!?…]$/.test(t) ? t : `${t}.`; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function nameList(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * deps.store: {
 *   projects(user) -> [{ name, repo, branch, aliases?, tag? }]   (PROJECT#: the registry)
 *   agents(user) -> [agent]   (AGENT#: busy, startedAt, awaiting, question)
 *   statuses(user) -> [{ key, health, done, inProgress, id, next, needs, owner, where, overnight, note, updated }]
 * }
 * deps.now() -> ms
 * Returns:
 *   handle(user, said) -> { say } (a report), { task: { project, task } } ("tell X to ..."), or null (not a command)
 *   board(user) -> each project's combined view, most urgent first (for the connector)
 *   report(user, command) -> spoken text for a parsed command (also the connector's get_status)
 */
export function makeOrchestrator(deps) {
  const now = deps.now ?? Date.now;

  // One project's status file and live agent, as one view. The live state outranks a stale file: an agent waiting
  // on a question needs the owner whatever its last report said, and one whose run went quiet needs attention.
  function view(p, statusByKey, agentByKey) {
    const key = norm(p.name);
    const s = statusByKey.get(key) ?? null;
    const a = agentByKey.get(key) ?? null;
    const t = now();
    const working = !!a?.busy && t - (a.startedAt ?? 0) < STALE_MS;
    const stale = !!a?.busy && !working;
    const waiting = !!a?.awaiting && !a.busy;
    let health = s?.health && RANK[s.health] !== undefined ? s.health : 'unknown';
    if ((stale || waiting || s?.note) && RANK[health] > RANK['needs attention']) health = 'needs attention';
    const needs = [waiting ? `It asked: ${a.question || 'a yes or no question'}` : '', s?.needs ?? ''].filter(Boolean);
    return {
      key, name: p.name, tag: p.tag ?? '', repo: p.repo, health, working, stale, waiting,
      needs, status: s, problem: stale ? 'Its run went quiet without reporting.' : (s?.note || ''),
      updatedAgo: s?.updated ? ago(t - s.updated) : '',
    };
  }

  async function load(user) {
    const [projects, agents, statuses] = await Promise.all([deps.store.projects(user), deps.store.agents(user), deps.store.statuses(user)]);
    const statusByKey = new Map(statuses.map((s) => [s.key, s]));
    const agentByKey = new Map(agents.map((a) => [a.key, a]));
    const views = projects.map((p) => view(p, statusByKey, agentByKey))
      .sort((x, y) => RANK[x.health] - RANK[y.health] || (y.needs.length - x.needs.length)
        || (y.status?.updated ?? 0) - (x.status?.updated ?? 0) || x.name.localeCompare(y.name));
    return { projects, views };
  }
  const board = async (user) => (await load(user)).views;

  // One line per project: how it is, and the one thing most worth hearing.
  function line(v) {
    const what = v.needs[0] ? `Needs you: ${v.needs[0]}` : v.problem || (v.working ? 'Working on it now.' : '')
      || v.status?.inProgress || v.status?.done || '';
    return `${v.name}, ${healthWords(v)}.${what ? ` ${sentence(what)}` : ''}`;
  }
  const healthWords = (v) => (v.health !== 'unknown' ? v.health : v.working ? 'working, no report yet' : 'no report yet');

  // "Status on X and Y": a little more than a line each.
  function more(v) {
    const s = v.status ?? {};
    return [`${v.name}, ${healthWords(v)}.`, v.needs.length && `Needs you: ${v.needs.map(sentence).join(' ')}`, v.problem && sentence(v.problem),
      v.working && 'Working on it now.', s.done && `Done: ${sentence(s.done)}`, s.inProgress && `In progress: ${sentence(s.inProgress)}`,
      s.next && `Next: ${sentence(s.next)}`].filter(Boolean).join(' ');
  }

  function headline(views) {
    const reported = views.filter((v) => v.health !== 'unknown');
    if (!reported.length) return views.length ? `None of your ${plural(views.length, 'project')} has reported yet.` : '';
    const counts = ['blocked', 'needs attention', 'on track'].map((h) => [h, reported.filter((v) => v.health === h).length])
      .filter(([, n]) => n).map(([h, n]) => `${n} ${h}`);
    return `${plural(reported.length, 'project')} reporting: ${nameList(counts)}.`;
  }

  // Projects with nothing to say are only counted, so a long registry doesn't make a long answer.
  function lines(views) {
    const told = views.filter((v) => v.health !== 'unknown' || v.working || v.needs.length || v.problem);
    const quiet = views.length - told.length;
    const shown = told.slice(0, LIST_MAX).map(line);
    if (told.length > LIST_MAX) shown.push(`And ${plural(told.length - LIST_MAX, 'more project')}.`);
    if (quiet) shown.push(`${plural(quiet, 'other project')} with no report.`);
    return shown;
  }

  function details(v) {
    const s = v.status ?? {};
    const parts = [`${v.name}.`];
    parts.push(v.status ? `Updated ${v.updatedAgo}. Health: ${v.health}.` : `No status report yet. Health: ${v.health === 'unknown' ? 'unknown' : v.health}.`);
    if (v.working) parts.push('It is working right now.');
    if (v.problem) parts.push(sentence(v.problem));
    if (s.done) parts.push(`Done: ${sentence(s.done)}`);
    if (s.inProgress) parts.push(`In progress: ${sentence(s.inProgress)}${s.id ? ` I D ${s.id}.` : ''}`);
    if (s.next) parts.push(`Next: ${sentence(s.next)}`);
    parts.push(v.needs.length ? `Needs you: ${v.needs.map(sentence).join(' ')}` : 'Nothing needs you.');
    if (s.owner) parts.push(`Assigned to ${sentence(s.owner)}`);
    if (s.where) parts.push(`Where: ${sentence(spokenWhere(s.where))}`);
    if (s.overnight) parts.push(`To keep going overnight: ${sentence(s.overnight)}`);
    return parts.join(' ');
  }

  function needsReport(views) {
    const items = views.filter((v) => v.needs.length || v.health === 'blocked');
    if (!items.length) return 'Nothing needs you right now.';
    return [`${plural(items.length, 'project needs', 'projects need')} you.`,
      ...items.map((v) => `${v.name}: ${sentence(v.needs.join('. ') || v.status?.note || 'It is blocked.')}`)].join(' ');
  }

  function morning(views) {
    if (!views.length) return "Good morning. You don't have any projects set up yet.";
    const needy = views.filter((v) => v.needs.length || v.health === 'blocked');
    const rest = views.filter((v) => !needy.includes(v));
    const parts = [`Good morning. ${headline(views)}`];
    parts.push(needy.length ? `Needs your decision: ${needy.map((v) => `${v.name}: ${sentence(v.needs.join('. ') || v.status?.note || 'blocked')}`).join(' ')}`
      : 'Nothing needs your decision.');
    parts.push(...lines(rest));
    return parts.join(' ');
  }

  function evening(views) {
    if (!views.length) return "Good evening. You don't have any projects set up yet.";
    const parts = ['Good evening. Here is the overnight brief.'];
    const plans = views.filter((v) => v.working || v.status?.next).slice(0, LIST_MAX)
      .map((v) => `${v.name}: ${sentence(v.working ? 'working now' : v.status.next)}`);
    parts.push(plans.length ? `Overnight plan. ${plans.join(' ')}` : 'No worker has a plan for tonight.');
    const asks = views.filter((v) => v.status?.overnight || v.needs.length)
      .map((v) => `${v.name}: ${sentence(v.status?.overnight || v.needs.join('. '))}`);
    parts.push(asks.length ? `Needs from you tonight. ${asks.join(' ')}` : 'Nothing is needed from you tonight.');
    const risk = views.filter((v) => v.health === 'blocked' || v.status?.overnight || v.waiting || v.stale).map((v) => v.name);
    parts.push(risk.length ? `At risk of stopping overnight: ${nameList(risk)}.` : 'Nothing is at risk of stopping.');
    return parts.join(' ');
  }

  // Each name said -> its view, or the name nobody matched.
  function pick({ views, projects }, names) {
    const found = [], missing = [];
    for (const n of names) {
      const p = resolveProject(n, projects);
      const v = p && views.find((x) => x.key === norm(p.name));
      if (v && !found.includes(v)) found.push(v);
      else if (!v) missing.push(n);
    }
    return { found, missing };
  }

  async function report(user, cmd) {
    const loaded = await load(user);
    const { views } = loaded;
    if (!views.length) return "You don't have any projects yet. Run the owner setup script on your PC.";
    const unknown = (missing) => (missing.length ? ` I don't know ${nameList(missing.map((m) => `"${m}"`))}.` : '');
    switch (cmd.kind) {
      case 'all': return [headline(views), ...lines(views)].filter(Boolean).join(' ');
      case 'needs': return needsReport(views);
      case 'morning': return morning(views);
      case 'evening': return evening(views);
      case 'details': {
        const { found, missing } = pick(loaded, [cmd.name]);
        return found[0] ? details(found[0]) : `I don't know a project called ${missing[0]}.`;
      }
      case 'some': {
        const { found, missing } = pick(loaded, cmd.names);
        if (!found.length) return `I don't know ${nameList(missing.map((m) => `"${m}"`))}. Say status on all programs to hear every project.`;
        return found.map(more).join(' ') + unknown(missing);
      }
      default: return null;
    }
  }

  async function handle(user, said) {
    if (user !== OWNER) return null;
    const cmd = parseCommand(said);
    if (!cmd) return null;
    if (cmd.kind === 'tell') {
      const p = resolveProject(cmd.name, await deps.store.projects(user));
      // "tell me a joke" isn't for a project: only a name in the registry routes.
      if (!p) return null;
      return { task: { project: p.name, task: cmd.task.trim() } };
    }
    return { say: await report(user, cmd) };
  }

  return { handle, board, report };
}
