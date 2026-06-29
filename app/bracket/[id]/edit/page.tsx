'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ROUND_OF_32, ROUND_NAMES, ROUND_SIZES, TEAM_FLAGS, ROUND_KEYS,
  getEligibleTeamsForSlot, applyPick,
} from '@/lib/bracket';
import { Picks } from '@/lib/types';

const EMPTY_PICKS: Picks = { r0: Array(16).fill(null), r1: Array(8).fill(null), r2: Array(4).fill(null), r3: Array(2).fill(null), r4: Array(1).fill(null), champion: null };

export default function EditBracketPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [authed, setAuthed] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  const [bracketName, setBracketName] = useState('');
  const [picks, setPicks] = useState<Picks>(EMPTY_PICKS);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setAuthError('');
    setAuthLoading(true);
    // Verify password by fetching the bracket
    const res = await fetch(`/api/admin?bracketId=${params.id}`, {
      headers: { Authorization: `Bearer ${password}` },
    });
    setAuthLoading(false);
    if (!res.ok) {
      setAuthError('Incorrect password');
      return;
    }
    const data = await res.json();
    if (data.bracket) {
      setBracketName(data.bracket.name);
      setPicks(data.bracket.picks);
      setAuthed(true);
    } else {
      setAuthError('Bracket not found');
    }
  }

  function handlePickChange(round: number, index: number, team: string | null) {
    setPicks(prev => applyPick(prev, round, index, team));
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    const res = await fetch('/api/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${password}` },
      body: JSON.stringify({ action: 'update_picks', id: params.id, picks }),
    });
    setSaving(false);
    if (res.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } else {
      setError('Failed to save. Check your connection and try again.');
    }
  }

  if (!authed) {
    return (
      <div className="max-w-sm mx-auto mt-16">
        <div className="bg-[#0f2040] border border-[#1a3a60] rounded-xl p-6 space-y-4">
          <h1 className="text-xl font-black text-white text-center">🔐 Admin — Edit Bracket</h1>
          <p className="text-[#8899aa] text-sm text-center">Enter admin password to edit picks for this bracket.</p>
          <form onSubmit={handleLogin} className="space-y-4">
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Admin password"
              className="w-full bg-[#050d1a] border border-[#1a3a60] rounded-lg px-4 py-3 text-white placeholder-[#4a5568] focus:outline-none focus:border-[#FFD700]"
            />
            {authError && <p className="text-red-400 text-sm">{authError}</p>}
            <button
              type="submit"
              disabled={authLoading || !password}
              className="w-full bg-[#FFD700] text-[#050d1a] font-black py-3 rounded-lg hover:bg-[#FFE57F] disabled:opacity-50"
            >
              {authLoading ? 'Verifying...' : 'Unlock'}
            </button>
          </form>
          <Link href={`/bracket/${params.id}`} className="block text-center text-[#8899aa] text-sm hover:text-white">
            ← Back to bracket
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-12">
      <div className="flex items-center justify-between">
        <div>
          <Link href={`/bracket/${params.id}`} className="text-[#8899aa] text-sm hover:text-white">
            ← Back to bracket
          </Link>
          <h1 className="text-2xl font-black text-white mt-1">Editing {bracketName}'s Picks</h1>
        </div>
        <div className="flex items-center gap-3">
          {saved && (
            <span className="text-green-400 text-sm font-bold">✓ Saved!</span>
          )}
          {error && (
            <span className="text-red-400 text-sm">{error}</span>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="bg-[#FFD700] text-[#050d1a] font-black px-5 py-2 rounded-lg hover:bg-[#FFE57F] disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Picks'}
          </button>
        </div>
      </div>

      {ROUND_KEYS.map((roundKey, roundIdx) => (
        <div key={roundKey} className="bg-[#0f2040] border border-[#1a3a60] rounded-xl overflow-hidden">
          <div className="px-4 py-3 bg-[#050d1a] border-b border-[#1a3a60]">
            <h2 className="font-bold text-white">{ROUND_NAMES[roundIdx]}</h2>
          </div>
          <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
            {Array.from({ length: ROUND_SIZES[roundIdx] }).map((_, i) => {
              const eligible = getEligibleTeamsForSlot(roundIdx, i);
              const matchLabel = roundIdx === 0
                ? `${ROUND_OF_32[i].home} vs ${ROUND_OF_32[i].away}`
                : `Match ${i + 1}`;
              const current = picks[roundKey][i];

              return (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-xs text-[#8899aa] w-28 shrink-0 truncate">{matchLabel}</span>
                  <select
                    value={current || ''}
                    onChange={e => handlePickChange(roundIdx, i, e.target.value || null)}
                    className="flex-1 bg-[#050d1a] border border-[#1a3a60] rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:border-[#FFD700]"
                  >
                    <option value="">No pick</option>
                    {eligible.map(team => (
                      <option key={team} value={team}>{TEAM_FLAGS[team] || ''} {team}</option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* Champion */}
      <div className="bg-[#0f2040] border border-[#1a3a60] rounded-xl p-4 space-y-2">
        <h2 className="font-bold text-white">🏆 Champion</h2>
        <select
          value={picks.champion || ''}
          onChange={e => handlePickChange(4, 0, e.target.value || null)}
          className="bg-[#050d1a] border border-[#1a3a60] rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-[#FFD700]"
        >
          <option value="">No pick</option>
          {Array.from(new Set(ROUND_OF_32.flatMap(m => [m.home, m.away]))).map(team => (
            <option key={team} value={team}>{TEAM_FLAGS[team] || ''} {team}</option>
          ))}
        </select>
      </div>

      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="bg-[#FFD700] text-[#050d1a] font-black px-6 py-3 rounded-lg hover:bg-[#FFE57F] disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Picks'}
        </button>
      </div>
    </div>
  );
}
