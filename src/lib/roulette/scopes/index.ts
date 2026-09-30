import type { ScopeResolvers } from '../pipeline';
import { libraryScope } from './library';

// Scope resolvers the spin pipeline can use. Each group scope's package adds its own resolver file here and one line
// below (friends: qit-friend-night, pair: qit-library-compare, lobby: qit-lobby-roulette). A scope with no resolver
// is rejected as "not available yet".
export const SCOPE_RESOLVERS: ScopeResolvers = {
  library: libraryScope,
};
