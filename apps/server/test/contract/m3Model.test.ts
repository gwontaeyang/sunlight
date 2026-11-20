import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkManagedModelSettings, initCampaign, readCampaign } from '../../src/security/m3Campaign';
import { childEnv } from '../../src/llm/claudeCli';
import { collect, makeRequest, writeScript } from '../llm/fakeCli';
import { tempDir } from '../helpers/tmp';
import { REPO_ROOT, runProbe } from '../helpers/proc';

const pins = { haiku:'claude-haiku-4-5', opus:'claude-opus-4-6', sonnet:'claude-sonnet-4-5' };
afterEach(() => vi.unstubAllEnvs());
describe('campaign CLI model verification', () => {
  it('removes inherited model overrides; rejects unreadable policy and managed overrides before spawn', () => {
    expect(childEnv({ KEEP:'yes', ANTHROPIC_MODEL:'x', ANTHROPIC_DEFAULT_OPUS_MODEL:'y', ANTHROPIC_DEFAULT_FUTURE_MODEL:'z' })).toEqual({ KEEP:'yes' });
    const d=tempDir(); mkdirSync(join(d, 'managed-settings.d'));
    checkManagedModelSettings(d);
    const file=join(d, 'managed-settings.d/10-test.json');
    for (const value of ['{', '{"model":"fable"}','{"env":{"ANTHROPIC_DEFAULT_SONNET_MODEL":"x"}}']) {
      writeFileSync(file,value); expect(() => checkManagedModelSettings(d)).toThrow();
    }
  });
  it('stops a requested Fable before reservation or spawn', async () => {
    const d = tempDir(), campaign = join(d,'campaign');
    initCampaign(campaign, pins);
    vi.stubEnv('SP_M3_CAMPAIGN',campaign); vi.stubEnv('SP_M3_PHASE','final'); vi.stubEnv('SP_LIVE_LEDGER',join(campaign,'final'));
    const rejected = await collect({ claudeBin:join(d,'never-run'), cwd:d }, makeRequest({model:'fable'}));
    expect(rejected.pids).toEqual([]);
    expect(readCampaign(campaign)).toMatchObject({ stopped:'unapproved_model', final:{used:{total:0}} });
  });
  it.each(['silent child', 'result before init', 'duplicate init'])('keeps the reservation and blocks resume after %s', async (kind) => {
    const root = tempDir();
    const campaign = join(root, 'campaign');
    initCampaign(campaign, pins);
    vi.stubEnv('SP_M3_CAMPAIGN', campaign);
    vi.stubEnv('SP_M3_PHASE', 'final');
    vi.stubEnv('SP_LIVE_LEDGER', join(campaign, 'final'));
    const init = { type: 'system', subtype: 'init', model: pins.opus, apiKeySource: 'none', tools: [], mcp_servers: [] };
    const result = { type: 'result', subtype: 'success', result: 'text' };
    const events = kind === 'silent child' ? [] : kind === 'result before init' ? [result] : [init, init];
    const bin = writeScript(root, 'fixture-cli', ['cat >/dev/null', ...events.map(e => "printf '%s\\n' '" + JSON.stringify(e) + "'")].join('\n'));
    const opts = { claudeBin: bin, cwd: root };
    const first = await collect(opts, makeRequest({ model: 'opus' }));
    expect(first.terminal.type).toBe('error');
    expect(first.pids).toHaveLength(1);
    expect(readCampaign(campaign)).toMatchObject({ stopped: 'model_mismatch', final: { used: { total: 1 } } });
    expect((await collect(opts, makeRequest({ model: 'opus' }))).pids).toEqual([]);
  });

  it.each(['ok','dated','wrong-init','missing-init-model','wrong-result','wrong-usage'] as const)('%s: real adapter, synthetic child and durable judgement', async (scenario) => {
    const d = tempDir(), campaign = join(d,'campaign'), ledger = join(campaign,'final');
    initCampaign(campaign, pins);
    vi.stubEnv('SP_M3_CAMPAIGN', campaign); vi.stubEnv('SP_M3_PHASE','final'); vi.stubEnv('SP_LIVE_LEDGER',ledger);
    const init = { type:'system', subtype:'init', tools:[], mcp_servers:[], apiKeySource:'none', model:scenario === 'wrong-init' ? 'claude-fable-5' : scenario === 'missing-init-model' ? undefined : scenario === 'dated' ? pins.opus + '-20260101' : pins.opus };
    const result = { type:'result', subtype:'success', result:'fixture', model:scenario==='wrong-result'?pins.sonnet:pins.opus, modelUsage:{ [scenario==='wrong-usage'?'unknown':pins.opus]:{} } };
    const bin = writeScript(d, 'fake-model', [
      'test "$2" = "--model" && test "$3" = "' + pins.opus + '" || exit 42',
      'test -z "${ANTHROPIC_MODEL:-}" && test -z "${ANTHROPIC_DEFAULT_OPUS_MODEL:-}" || exit 43',
      'cat >/dev/null', "printf '%s\\n' '" + JSON.stringify(init) + "' '" + JSON.stringify(result) + "'",
    ].join('\n'));
    const opts = { claudeBin:bin, cwd:d, env:{ ...process.env, ANTHROPIC_MODEL:'fable', ANTHROPIC_DEFAULT_OPUS_MODEL:'fable' } };
    const r = await collect(opts, makeRequest({model:'opus'}));
    expect(r.pids).toHaveLength(1);
    expect(readCampaign(campaign).final.used.perModel).toEqual({opus:1});
    if (scenario === 'ok' || scenario === 'dated') {
      expect(r.terminal.type).toBe('result');
      expect(readCampaign(campaign).stopped).toBeNull();
    } else {
      expect(r.terminal).toMatchObject({type:'error',code:'unsafe_cli_state'});
      expect(readCampaign(campaign).stopped).toMatch(/model_mismatch/);
      expect((await collect(opts, makeRequest({model:'opus'}))).pids).toEqual([]);
      for (const command of ['resume','evaluate']) {
        const replay = await runProbe(join(REPO_ROOT,'scripts/m3-campaign.ts'), {}, [command,campaign,'final']);
        expect(replay.status).toBe(3);
        expect(JSON.parse(replay.stdout).stopped).toMatch(/model_mismatch/);
      }
    }
  });
});

describe('child environment (S-a fix round)', () => {
  it('also removes the background-model and subagent-model switches', () => {
    expect(childEnv({ KEEP: 'yes', ANTHROPIC_SMALL_FAST_MODEL: 'x', CLAUDE_CODE_SUBAGENT_MODEL: 'y', ANTHROPIC_MODEL: 'z' })).toEqual({ KEEP: 'yes' });
  });
});
