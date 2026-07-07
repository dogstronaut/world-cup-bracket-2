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

  // Today's remaining matches (slots with no winner yet in the active round)
  let todayUpcoming: string[] = [];
  if (todayRound >= 0) {
    const rk = ROUND_KEYS[todayRound];
    const size = ROUND_SIZES[todayRound];
    for (let i = 0; i < size; i++) {
      if (!results[rk][i]) {
        // For R32, only include if scheduled today
        if (todayRound === 0 && ROUND_OF_32[i].date !== todayFormatted) continue;
        todayUpcoming.push(getMatchLabel(results, todayRound, i));
      }
    }
  }

  return `
TODAY'S DATE: ${targetDate}
TOTAL BRACKETS: ${brackets.length}

=== YESTERDAY'S COMPLETED MATCHES (${yesterdayFormatted}) ===
${yesterdayMatches.length === 0 ? 'None.' : yesterdayMatches.join('\n\n')}

=== TODAY'S COMPLETED MATCHES (${todayFormatted}) ===
${todayMatches.length === 0 ? 'No matches completed today yet.' : todayMatches.join('\n\n')}

=== EARLIER COMPLETED MATCHES ===
${earlierMatches.length === 0 ? 'None.' : earlierMatches.join('\n\n')}

=== TODAY'S REMAINING MATCHES (still to play today) ===
${todayUpcoming.length === 0 ? 'All of today\'s matches are done (or none scheduled today).' : todayUpcoming.join('\n')}

=== CURRENT LEADERBOARD (top 10) ===
${scored.map((s, i) => `${i + 1}. ${s.name} — ${s.score.points} pts`).join('\n')}

=== CHAMPION PICK DISTRIBUTION ===
${champSorted.map(([team, names]) => `${team} ${TEAM_FLAGS[team] || ''}: ${names.length} picks (${names.join(', ')})`).join('\n')}

=== BOLD / UNIQUE PICKS ===
${unusualPicks.length > 0 ? unusualPicks.join('\n') : 'No unique solo picks yet.'}
`.trim();
}

const RECAP_SYSTEM_PROMPT = `You are a passionate, witty sideline sports reporter covering the 2026 FIFA World Cup bracket challenge for a friends group.
Your style: vivid, energetic, like you just ran in from pitchside with a hot mic. You know every player in this bracket by name and love calling them out.

Write a FULL recap in this exact order (use emojis as section headers, NOT markdown ## headers):

1. ⚽ YESTERDAY'S RESULTS: Lead with yesterday's completed matches — name exactly who got each pick right and who got burned. Be specific and dramatic.
2. 🏟️ TODAY'S ACTION: Recap any matches already completed today. If matches are still to play today, hype what's at stake for bracket players — but DO NOT mention or tease matches scheduled for future days beyond today.
3. 📊 BRACKET WATCH: Overall bracket accuracy, standout correct/wrong picks, call out bold or unique picks by name.
4. 🏆 LEADERBOARD: Current standings with narrative — who's climbing, who's fading, who's in danger.
5. 🔥 TRENDS: Patterns in the bracket — who's been consistently right, any picks on the bubble, champion picks still alive.
6. 🌍 WORLD CUP FUN FACT: One genuinely interesting historical or football fact relevant to today's teams or matches.

IMPORTANT: DO NOT tease or preview matches scheduled for future days beyond today. Only reference today's remaining matches if they exist.
Be specific with names and numbers. Keep energy high throughout.
Use line breaks generously for readability.
Write the recap body only (no title — that is provided separately).`;

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

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      system: RECAP_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Write the daily bracket recap for ${formattedDate}. Here is all the data:\n\n${context}${emphasisSection}\n\nCover all required sections in order. Be vivid, specific, and entertaining.`,
        },
      ],
    });

    const body = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
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
