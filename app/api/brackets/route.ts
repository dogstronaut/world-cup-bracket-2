import { NextResponse } from 'next/server';
import { getAllBrackets, getResults } from '@/lib/storage';
import { calculateScore } from '@/lib/scoring';

export async function GET() {
  try {
    const [brackets, results] = await Promise.all([getAllBrackets(), getResults()]);
    const scored = brackets.map(b => ({
      ...b,
      score: calculateScore(b.picks, results),
    }));
    // Sort by points desc
    scored.sort((a, b) => b.score.points - a.score.points || a.name.localeCompare(b.name));
    return NextResponse.json(scored);
  } catch (error) {
    console.error('GET /api/brackets error:', error);
    return NextResponse.json({ error: 'Failed to fetch brackets' }, { status: 500 });
  }
}

export async function POST() {
  return NextResponse.json({ error: 'Submissions are closed' }, { status: 403 });
}
