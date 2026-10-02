import { notFound } from 'next/navigation';
import { RESULT_CARD_FIXTURES } from '@/components/result-card/fixtures';
import FixtureGallery from './FixtureGallery';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Result card fixtures - QIT', robots: { index: false } };

// Development-only gallery of every result card state. Production serves it only with QIT_FIXTURES=1.
export default async function ResultCardFixturesPage({ searchParams }: { searchParams: Promise<{ only?: string }> }) {
  if (process.env.NODE_ENV === 'production' && process.env.QIT_FIXTURES !== '1') notFound();
  const { only } = await searchParams;
  const fixtures = only ? RESULT_CARD_FIXTURES.filter(fixture => fixture.id === only) : RESULT_CARD_FIXTURES;
  if (!fixtures.length) notFound();
  return <div className="container mx-auto max-w-4xl px-4 py-8 text-black">
    <h1 className="text-3xl font-bold">Result card fixtures</h1>
    <p className="my-4">Every state of the roulette result card, rendered from fixture data. Actions log here instead of acting.</p>
    <FixtureGallery ids={fixtures.map(fixture => fixture.id)} />
  </div>;
}
