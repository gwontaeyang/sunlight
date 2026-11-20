import { guardedFetch } from '../../src/security/network';
let sent = 0;
globalThis.fetch = async (_url, init) => {
  sent++;
  if (init?.redirect !== 'manual') throw new Error('redirect hop not governed');
  return new Response('fixture');
};
try { await guardedFetch('https://api.crossref.org/works', {}); } catch { /* fixture records dispatch count */ }
console.log(JSON.stringify({ sent }));
