import Link from 'next/link';

export default function NewBracketPage() {
  return (
    <div className="max-w-sm mx-auto mt-16 text-center space-y-4">
      <p className="text-5xl">🔒</p>
      <h1 className="text-xl font-black text-white">Submissions Closed</h1>
      <p className="text-[#8899aa] text-sm">The bracket challenge is no longer accepting new entries.</p>
      <Link href="/" className="inline-block text-[#FFD700] hover:underline text-sm">
        ← View the leaderboard
      </Link>
    </div>
  );
}
