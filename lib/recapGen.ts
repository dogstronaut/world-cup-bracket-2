import Anthropic from '@anthropic-ai/sdk';
import { ROUND_OF_32, ROUND_NAMES, ROUND_SIZES, TEAM_FLAGS } from './bracket';
import { getAllBrackets, getResults } from './storage';
import { calculateScore } from './scoring';
import { Bracket, Results } from './types';

type RoundKey = 'r0' | 'r1' | 'r2' | 'r3' | 'r4';
const ROUND_KEYS: RoundKey[] = ['r0', 'r1', 'r2', 'r3', 'r4'];

// Date ranges for each round (used for yesterday/today bucketing in later rounds)
// We treat a round as "active" during its date window; individual match dates aren't stored for r1+
const ROUND_DATE_RANGES: { start: string; end: string }[] = [
  { start: 'Jun 28', end: 'Jul 3' },  // R32
  { start: 'Jul 5',  end: 'Jul 8' },  // R16
  { start: 'Jul 11', end: 'Jul 12' }, // QF
  { start: 'Jul 15', end: 'Jul 16' }, // SF
  { start: 'Jul 19', end: 'Jul 19' }, // Final
];

function formatMatchDate(isoDate: string): string {
  const d = new Date(isoDate + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function offsetDate(isoDate: string, days: number): string {
  const d = new Date(isoDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Determine which round index is active on a given formatted date (e.g. "Jul 6")
function getActiveRoundForDate(formattedDate: string): number {
  // Parse "Jul 6" into a comparable month+day number
  function parseMonthDay(s: string): number {
    const months: Record<string, number> = {
      Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
      Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
    };
    const [mon, day] = s.split(' ');
    return (months[mon] ?? 0) * 100 + parseInt(day);
  }
  const target = parseMonthDay(formattedDate);
  for (let r = ROUND_DATE_RANGES.length - 1; r >= 0; r--) {
    const start = parseMonthDay(ROUND_DATE_RANGES[r].start);
    const end = parseMonthDay(ROUND_DATE_RANGES[r].end);
    if (target >= start && target <= end) return r;
  }
  return -1;
}

// Get a human-readable match label for any round/index by looking up actual winners from r0
function getMatchLabel(results: Results, round: number, index: number): string {
  if (round === 0) {
    return `${ROUND_OF_32[index].home} vs ${ROUND_OF_32[index].away}`;
  }
  const prevKey = ROUND_KEYS[round - 1];
  const teamA = results[prevKey][index * 2] ?? `Match ${index * 2 + 1} winner`;
  const teamB = results[prevKey][index * 2 + 1] ?? `Match ${index * 2 + 2} winner`;
  return `${teamA} vs ${teamB}`;
}

// Build bracket pick stats for a given round/index result
function getPickStats(brackets: Bracket[], roundKey: RoundKey, index: number, winner: string) {
  const correctNames = brackets.filter(b => b.picks[roundKey][index] === winner).map(b => b.name);
  const wrongNames = brackets.filter(b => b.picks[roundKey][index] && b.picks[roundKey][index] !== winner).map(b => b.name);
  return { correctNames, wrongNames, total: correctNames.length + wrongNames.length };
}

function renderMatchBlock(
  label: string,
  winner: string,
  correctNames: string[],
  wrongNames: string[],
  total: number
): string {
  const pct = total > 0 ? Math.round((correctNames.length / total) * 100) : 0;
  return `Match: ${label}
Winner: ${winner} ${TEAM_FLAGS[winner] || ''}
Bracket accuracy: ${correctNames.length}/${total} got it right (${pct}%)
✅ Correct: ${correctNames.join(', ') || 'nobody'}
❌ Wrong: ${wrongNames.join(', ') || 'nobody'}`;
}

function buildRecapContext(brackets: Bracket[], results: Results, targetDate: string): string {
  const todayFormatted = formatMatchDate(targetDate);
  const yesterdayFormatted = formatMatchDate(offsetDate(targetDate, -1));

  const todayRound = getActiveRoundForDate(todayFormatted);
  const yesterdayRound = getActiveRoundForDate(yesterdayFormatted);

  // Collect completed matches bucketed into: yesterday, today, earlier
  const yesterdayMatches: string[] = [];
  const todayMatches: string[] = [];
  const earlierMatches: string[] = [];

  for (let r = 0; r <= 4; r++) {
    const rk = ROUND_KEYS[r];
    const size = ROUND_SIZES[r];
    for (let i = 0; i < size; i++) {
      const winner = results[rk][i];
      if (!winner) continue;

      const label = getMatchLabel(results, r, i);
      const { correctNames, wrongNames, total } = getPickStats(brackets, rk, i, winner);
      const block = renderMatchBlock(label, winner, correctNames, wrongNames, total);
      const roundName = ROUND_NAMES[r];

      const entry = `[${roundName}]\n${block}`;

      // For R32 we have exact match dates; for later rounds use round date range
      if (r === 0) {
        const matchDate = ROUND_OF_32[i].date;
        if (matchDate === todayFormatted) todayMatches.push(entry);
        else if (matchDate === yesterdayFormatted) yesterdayMatches.push(entry);
        else earlierMatches.push(entry);
      } else {
        // For r1+, bucket by which round is active on yesterday/today
        if (r === todayRound) todayMatches.push(entry);
        else if (r === yesterdayRound) yesterdayMatches.push(entry);
        else earlierMatches.push(entry);
      }
    }
  }

  // Champion pick distribution
  const champCounts: Record<string, string[]> = {};
  for (const b of brackets) {
    if (b.picks.champion) {
      if (!champCounts[b.picks.champion]) champCounts[b.picks.champion] = [];
      champCounts[b.picks.champion].push(b.name);
    }
  }
  const champSorted = Object.entries(champCounts).sort((a, b) => b[1].length - a[1].length);

  // Current leaderboard (top 10)
  const scored = brackets
    .map(b => ({ name: b.name, score: calculateScore(b.picks, results) }))
    .sort((a, b) => b.score.points - a.score.points || a.name.localeCompare(b.name))
    .slice(0, 10);

  // Unique/bold picks across all rounds still alive
  const unusualPicks: string[] = [];
  for (const b of brackets) {
    for (let i = 0; i < 16; i++) {
      const pick = b.picks.r0[i];
      if (!pick) continue;
      const match = ROUND_OF_32[i];
      const isUnderdog = pick === match.away;
      const onlyOne = brackets.filter(br => br.picks.r0[i] === pick).length === 1;
      if (onlyOne && isUnderdog) {
        unusualPicks.push(`${b.name} is the ONLY person who picked ${pick} (vs ${pick === match.home ? match.away : match.home})`);
      }
    }
    if (b.picks.champion && champCounts[b.picks.champion]?.length === 1) {
      unusualPicks.push(`${b.name} is the ONLY person picking ${b.picks.champion} 🏆 to win it all`);
    }
  }

  // Build upcoming matches preview for the next unfinished round
  // Find the first round that has any unfilled slots
  let upcomingRound = -1;
  for (let r = 0; r <= 4; r++) {
    const rk = ROUND_KEYS[r];
    if (results[rk].some(v => v === null)) { upcomingRound = r; break; }
  }

  const upcomingMatchPreviews: string[] = [];
  if (upcomingRound >= 0) {
    const rk = ROUND_KEYS[upcomingRound];
    const size = ROUND_SIZES[upcomingRound];
    for (let i = 0; i < size; i++) {
      if (results[rk][i]) continue; // already played
      const label = getMatchLabel(results, upcomingRound, i);
      const teamA = upcomingRound > 0 ? results[ROUND_KEYS[upcomingRound - 1]][i * 2] : ROUND_OF_32[i].home;
      const teamB = upcomingRound > 0 ? results[ROUND_KEYS[upcomingRound - 1]][i * 2 + 1] : ROUND_OF_32[i].away;

      // Picks alive: picked the actual team in this slot
      const pickersA = teamA ? brackets.filter(b => b.picks[rk][i] === teamA).map(b => b.name) : [];
      const pickersB = teamB ? brackets.filter(b => b.picks[rk][i] === teamB).map(b => b.name) : [];

      // Eliminated: had a pick for this slot but their team didn't make it here
      const eliminated = brackets.filter(b => {
        const pick = b.picks[rk][i];
        return pick && pick !== teamA && pick !== teamB;
      }).map(b => b.name);

      // No pick at all
      const noPick = brackets.filter(b => !b.picks[rk][i]).map(b => b.name);

      upcomingMatchPreviews.push(
        `MATCH: ${label}\n` +
        (teamA ? `  ${teamA} ${TEAM_FLAGS[teamA] || ''} — picks alive (${pickersA.length}): ${pickersA.join(', ') || 'nobody'}\n` : '') +
        (teamB ? `  ${teamB} ${TEAM_FLAGS[teamB] || ''} — picks alive (${pickersB.length}): ${pickersB.join(', ') || 'nobody'}\n` : '') +
        (eliminated.length ? `  Already eliminated from this slot (${eliminated.length}): ${eliminated.join(', ')}\n` : '') +
        (noPick.length ? `  No pick made for this slot: ${noPick.join(', ')}` : '')
      );
    }
  }

  const upcomingRoundName = upcomingRound >= 0 ? ROUND_NAMES[upcomingRound] : 'None';

  // Between-rounds day: no matches yesterday or today — pure preview mode
  const betweenRounds = yesterdayMatches.length === 0 && todayMatches.length === 0;

  return `
TODAY'S DATE: ${targetDate}
TOTAL BRACKETS: ${brackets.length}
${betweenRounds ? '\nMODE: NO MATCHES YESTERDAY OR TODAY — THIS IS A PREVIEW-ONLY RECAP. Do not recap earlier rounds. Go straight to the upcoming match previews.\n' : ''}
${!betweenRounds ? `=== YESTERDAY'S COMPLETED MATCHES (${yesterdayFormatted}) ===
${yesterdayMatches.length === 0 ? 'None.' : yesterdayMatches.join('\n\n')}

=== TODAY'S COMPLETED MATCHES (${todayFormatted}) ===
${todayMatches.length === 0 ? 'No matches completed today yet.' : todayMatches.join('\n\n')}` : ''}

=== UPCOMING: ${upcomingRoundName.toUpperCase()} — WHO HAS PICKS ALIVE ===
${upcomingMatchPreviews.length === 0 ? 'Tournament complete.' : upcomingMatchPreviews.join('\n\n')}

=== CURRENT LEADERBOARD (top 10) ===
${scored.map((s, i) => `${i + 1}. ${s.name} — ${s.score.points} pts`).join('\n')}

=== CHAMPION PICK DISTRIBUTION ===
${champSorted.map(([team, names]) => `${team} ${TEAM_FLAGS[team] || ''}: ${names.length} picks (${names.join(', ')})`).join('\n')}

=== BOLD / UNIQUE PICKS ===
${unusualPicks.length > 0 ? unusualPicks.join('\n') : 'No unique solo picks yet.'}
`.trim();
}

const RECAP_SYSTEM_PROMPT = `You are a hype sideline reporter hosting a pre-game show for a World Cup bracket challenge with friends. Your voice: electric, punchy, personal, a little trash talk. You know every person in the bracket by name and you are NOT afraid to call them out.

Before writing, use web_search to look up each upcoming match individually — get the real venue, kickoff time ET, key storylines, head-to-head history, star players, and what's at stake on the pitch.

=== PREVIEW-ONLY MODE (when data says "NO MATCHES YESTERDAY OR TODAY") ===

STRUCTURE:

1. Open with a 2-3 line hype intro. "IT'S QUARTERFINAL TIME!!" energy. Make it feel like the camera just cut to you on the sideline.

2. For EACH upcoming match, write its own mini-segment separated by ---:

🏟️ QUARTERFINAL #[N] — [DAY DATE]
[FLAG] [TEAM A] vs [FLAG] [TEAM B]
📍 [Venue, City] | [Kickoff Time] ET

[3-5 sentences previewing this specific matchup. Use real details from web search: key players, recent form, history between these sides, what makes this match electric. Be vivid and specific — no generic "this should be a great game" filler.]

Then immediately: who's alive, who's dead, and what it means:

- Name EVERY person from the "picks alive" list for Team A, with their pick count: "X people are riding with [TEAM A] [FLAG]: [Name1], [Name2], [Name3]..."
- Name EVERY person from the "picks alive" list for Team B the same way. If nobody picked them, say "LITERALLY NOBODY picked [TEAM B] 😂 — they said 'pick me coward' and the whole group chat said NOPE 💀"
- Name EVERY person from the "already eliminated from this slot" list: "Sorry [Name1], [Name2] — your pick of [team] is already on a plane home ✈️😬" Make it funny, not mean.
- Call out the stakes: who on the alive lists is currently leading the leaderboard and could pull away? Who is in the middle of the pack and NEEDS this pick to come through? Build suspense. Name names.

3. After all matches:

🏆 LEADERBOARD — Who's Running the Table?
Numbered list with points. Add narrative: who's running away with it, who's one bad day from falling out of contention, any interesting rivalries.

4. End with one 🌍 World Cup fun fact about one of the teams playing today.

=== WHEN THERE ARE MATCHES YESTERDAY OR TODAY ===

1. ⚽ YESTERDAY'S RESULTS (1-2 sentences per match ONLY — "Belgium knocked out USA 2-0, Spain eliminated Portugal in Ronaldo's final game"): Use web search for real scorelines. DO NOT go deep on R16 or R32 — it's ancient history.
2. Name who got each yesterday pick right and wrong, one line each.
3. 🏟️ TODAY'S ACTION if any matches are completed today.
4. 🏆 LEADERBOARD with narrative.
5. 🔥 UPCOMING PREVIEW using the same per-match format above.
6. 🌍 FUN FACT.

ABSOLUTE RULES:
- The data gives you "picks alive", "already eliminated from this slot", and "no pick made" for each match — USE ALL THREE. Name every single person in each list. Never say "some players" or leave anyone out.
- DO NOT recap R32 results — ancient history, skip entirely.
- DO NOT spend more than 1-2 sentences on any previous round result.
- NEVER say generic things like "this should be a great match" without naming specific people and stakes.
- Always follow admin emphasis notes — they override everything.
- Use --- separators between match segments.
- Write the recap body only (no title).`;

export async function generateAndPostRecap(date: string, notes?: string): Promise<{ success: boolean; message: string; title: string; body: string }> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    const [brackets, results] = await Promise.all([getAllBrackets(), getResults()]);
    const context = buildRecapContext(brackets, results, date);

    const formattedDate = new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    });

    const emphasisSection = notes?.trim()
      ? `\n\n=== EMPHASIS NOTES FROM ADMIN ===\nMake sure to highlight/lead with the following angles:\n${notes.trim()}`
      : '';

    const response: any = await (client.messages.create as any)({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      system: RECAP_SYSTEM_PROMPT,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [
        {
          role: 'user',
          content: `Write the bracket recap for ${formattedDate}. Bracket data:\n\n${context}${emphasisSection}\n\nFor each upcoming match listed in the data, use web_search to find: the venue, kickoff time, real preview storylines, head-to-head history, key players, and what's at stake. Search for each match individually to get specific details. Then write the recap following the format in your instructions exactly.`,
        },
      ],
    });

    const body = (response.content as { type: string; text?: string }[])
      .filter(b => b.type === 'text')
      .map(b => b.text ?? '')
      .join('');

    if (!body.trim()) throw new Error('Claude returned empty recap');

    // Auto-generate a punchy title
    const titleRes = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 60,
      messages: [
        {
          role: 'user',
          content: `Write a short punchy title (max 10 words, include an emoji) for this World Cup bracket recap:\n${body.slice(0, 300)}\n\nRespond with ONLY the title, nothing else.`,
        },
      ],
    });

    const title = (titleRes.content[0] as { type: 'text'; text: string }).text.trim();

    return { success: true, message: 'Recap generated — review and save when ready', title, body };
  } catch (error) {
    return {
      success: false,
      message: `Recap generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      title: '',
      body: '',
    };
  }
}
