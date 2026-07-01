import Anthropic from '@anthropic-ai/sdk';
import { ROUND_OF_32, TEAM_FLAGS } from './bracket';
import { getAllBrackets, getResults } from './storage';
import { calculateScore } from './scoring';
import { Bracket, Results } from './types';

const ROUND_KEYS = ['r0', 'r1', 'r2', 'r3', 'r4'] as const;

function formatMatchDate(isoDate: string): string {
  // Convert "2026-06-29" → "Jun 29" to match ROUND_OF_32 date format
  const d = new Date(isoDate + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function offsetDate(isoDate: string, days: number): string {
  const d = new Date(isoDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function buildMatchStats(brackets: Bracket[], results: Results, matchIndices: number[]) {
  return matchIndices.map(i => {
    const winner = results.r0[i]!;
    const correctNames = brackets.filter(b => b.picks.r0[i] === winner).map(b => b.name);
    const wrongNames = brackets.filter(b => b.picks.r0[i] && b.picks.r0[i] !== winner).map(b => b.name);
    return {
      match: `${ROUND_OF_32[i].home} vs ${ROUND_OF_32[i].away}`,
      winner,
      correctNames,
      wrongNames,
      total: correctNames.length + wrongNames.length,
    };
  });
}

function buildRecapContext(brackets: Bracket[], results: Results, targetDate: string): string {
  const yesterdayDate = formatMatchDate(offsetDate(targetDate, -1));
  const todayDate = formatMatchDate(targetDate);

  // Bucket completed R32 matches by date
  const yesterdayIndices: number[] = [];
  const todayIndices: number[] = [];
  const earlierIndices: number[] = [];

  for (let i = 0; i < 16; i++) {
    if (!results.r0[i]) continue;
    const matchDate = ROUND_OF_32[i].date;
    if (matchDate === todayDate) todayIndices.push(i);
    else if (matchDate === yesterdayDate) yesterdayIndices.push(i);
    else earlierIndices.push(i);
  }

  const yesterdayStats = buildMatchStats(brackets, results, yesterdayIndices);
  const todayStats = buildMatchStats(brackets, results, todayIndices);
  const earlierStats = buildMatchStats(brackets, results, earlierIndices);

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

  // Bold / unusual picks
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

  // TODAY'S upcoming matches only (not yet played, scheduled for today)
  const todayUpcoming = ROUND_OF_32
    .map((m, i) => ({ ...m, i }))
    .filter(m => !results.r0[m.i] && m.date === todayDate);

  function renderStats(stats: ReturnType<typeof buildMatchStats>) {
    return stats.map(s => `
Match: ${s.match}
Winner: ${s.winner} ${TEAM_FLAGS[s.winner] || ''}
Bracket accuracy: ${s.correctNames.length}/${s.total} got it right (${s.total > 0 ? Math.round((s.correctNames.length / s.total) * 100) : 0}%)
✅ Correct: ${s.correctNames.join(', ') || 'nobody'}
❌ Wrong: ${s.wrongNames.join(', ') || 'nobody'}
`).join('\n');
  }

  return `
TODAY'S DATE: ${targetDate}
TOTAL BRACKETS: ${brackets.length}

=== YESTERDAY'S COMPLETED MATCHES (${yesterdayDate}) ===
${yesterdayStats.length === 0 ? 'None.' : renderStats(yesterdayStats)}

=== TODAY'S COMPLETED MATCHES (${todayDate}) ===
${todayStats.length === 0 ? 'No matches completed today yet.' : renderStats(todayStats)}

=== EARLIER COMPLETED MATCHES (2+ days ago) ===
${earlierStats.length === 0 ? 'None.' : renderStats(earlierStats)}

=== TODAY'S REMAINING MATCHES (still to play today) ===
${todayUpcoming.length === 0 ? 'All of today\'s matches are done (or none scheduled today).' : todayUpcoming.map(m => `${m.home} vs ${m.away}`).join('\n')}

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
