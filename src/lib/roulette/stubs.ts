import { SCOPE_KINDS, type Filter, type Mode } from './types';

// Placeholders registered for every mode and filter id so each owning package only edits its own file.

export class StubNotImplementedError extends Error {
  constructor(kind: 'mode' | 'filter', id: string) {
    super(`Roulette ${kind} "${id}" is a stub`);
    this.name = 'StubNotImplementedError';
  }
}

export function stubMode(meta: Pick<Mode, 'id' | 'label' | 'description' | 'requires'> & Partial<Pick<Mode, 'scopes'>>): Mode {
  return {
    scopes: [...SCOPE_KINDS],
    ...meta,
    emits: [],
    stub: true,
    score() { throw new StubNotImplementedError('mode', meta.id); },
  };
}

export function stubFilter(meta: Pick<Filter, 'id' | 'label' | 'description' | 'requires'>): Filter {
  return {
    ...meta,
    stub: true,
    // Nothing validates until the filter exists, so requests naming a stub are rejected.
    parse: () => null,
    test() { throw new StubNotImplementedError('filter', meta.id); },
  };
}
