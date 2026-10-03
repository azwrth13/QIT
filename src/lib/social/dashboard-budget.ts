import { db } from '../firestore';
import { paths } from '../store/paths';
import { createDailyBudget, firestoreBudgetStore } from '../steam/budget';
import { createSteamClient } from '../steam/client';

// Existing endpoint wrappers accept an injected client. Attach the global guard for dashboard calls;
// all instances reserve from the same daily document rather than keeping independent daily quotas.
const budget = createDailyBudget({ store: firestoreBudgetStore(day => db.doc(paths.steamBudget(day))) });
export const dashboardSteamClient = createSteamClient({ budget });
