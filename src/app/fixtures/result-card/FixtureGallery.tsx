'use client';

import { useState } from 'react';
import { ResultCard, type ResultCardProps } from '@/components/result-card/ResultCard';
import { FIXTURE_NOW, RESULT_CARD_FIXTURES, type FixtureActions } from '@/components/result-card/fixtures';
import type { Card } from '@/lib/roulette/types';

type Handlers = Pick<ResultCardProps, 'onPlay' | 'onReroll' | 'onNotTonight' | 'onViewOnSteam' | 'onExclude'>;

function handlersFor(actions: FixtureActions, log: (action: string) => (card: Card) => void): Handlers {
  if (actions === 'none') return {};
  const linkHandlers = { onPlay: log('Play this'), onViewOnSteam: log('View on Steam') };
  if (actions === 'play-and-steam') return linkHandlers;
  return { ...linkHandlers, onReroll: log('Reroll'), onNotTonight: log('Not tonight'), onExclude: log('Add to exclusions') };
}

export default function FixtureGallery({ ids }: { ids: string[] }) {
  const [lastAction, setLastAction] = useState('');
  const log = (action: string) => (card: Card) => setLastAction(`${action}: ${card.name}`);
  const fixtures = RESULT_CARD_FIXTURES.filter(fixture => ids.includes(fixture.id));
  return <>
    <p role="status" className="mb-6 min-h-6 font-bold">{lastAction}</p>
    <div className="space-y-12">
      {fixtures.map(fixture => (
        <section key={fixture.id} id={fixture.id} aria-label={fixture.title}>
          <p className="mb-3 text-sm font-bold"><code className="border-2 border-black bg-white px-1">{fixture.id}</code> {fixture.title}</p>
          <ResultCard card={fixture.card} now={FIXTURE_NOW} busyAction={fixture.busyAction} {...handlersFor(fixture.actions, log)} />
        </section>
      ))}
    </div>
  </>;
}
