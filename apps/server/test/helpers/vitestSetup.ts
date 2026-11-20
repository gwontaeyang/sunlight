// vitest setup for the server project (BRIEF_S S5b). Owner: supervisor.
// Removes process-wide switches a shell may still carry, so unit tests that inject a mock fetch or start the fake
// CLI behave the same everywhere: the network guard (SP_NETWORK, SP_ARXIV_OFFLINE_DIR) would refuse injected fetches,
// and a live ledger (SP_LIVE_LEDGER, SP_LIVE) would spend the real M2 budget or refuse with budget_exhausted.
// Tests that need one of them set it on the process they start, or set it inside the test and remove it after.
// A real fetch inside vitest is still blocked by defaultFetch's VITEST check.
for (const k of ['SP_NETWORK', 'SP_ARXIV_OFFLINE_DIR', 'SP_LIVE_LEDGER', 'SP_LIVE']) delete process.env[k];
// The same for an M3 campaign selected in the shell (SP_M3_CAMPAIGN, SP_M3_PHASE and any later SP_M3_* switch): with
// it, every guarded request of a test would reserve from the campaign's sealed HTTP or CLI budget (S-a fix round).
for (const k of Object.keys(process.env)) if (k.startsWith('SP_M3_')) delete process.env[k];
