// A retained finished run holds no image (review B-R1-10): the capture PNG (imagePngBase64) and a re-attached stored
// capture (storedImagePngBase64) are dropped when the run ends; a replay and a payload comparison still work. Owner B.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/deps';
import { makeTestPngBase64 } from '../helpers/png';
import { ControlledAdapter } from '../helpers/server';
import { events, makeRunEnv, request } from './runEnv';

describe('retained runs drop their image', () => {
  it('imagePngBase64 and storedImagePngBase64 are gone after the terminal; the same id still replays and another image is still a 409', async () => {
    const llm = new ControlledAdapter();
    const env = await makeRunEnv({ adapter: llm });
    const png = makeTestPngBase64({ width: 40, height: 30 });
    const crid = randomUUID();
    const withImage = request({ clientRequestId: crid, imagePngBase64: png, inputs: { question: 'what is this?' } }, 'figure_area');
    const h = env.manager.runTask(withImage);
    expect(env.manager.inspect.heldInput(h.runId)?.imagePngBase64).toBe(png); // live: still needed for the call
    const first = await events(h);
    expect(first.at(-1)!.event).toBe('run.done');
    expect(llm.calls[0]!.tail[0]).toMatchObject({ type: 'image' });
    const held = env.manager.inspect.heldInput(h.runId)!;
    expect(held).toBeDefined();
    expect('imagePngBase64' in held).toBe(false);
    expect(held.task).toBe('figure_area');
    // the same request id + the same image → the same run (from memory, no new call)
    const again = env.manager.runTask({ ...withImage, startRows: request().startRows });
    expect(again.runId).toBe(h.runId);
    expect((await events(again)).at(-1)).toEqual(first.at(-1));
    // another image under the same id → 409 (the comparison uses the stored payload hash, not the dropped PNG)
    expect(() => env.manager.runTask({ ...withImage, imagePngBase64: makeTestPngBase64({ width: 41, height: 30 }), startRows: request().startRows })).toThrow(HttpError);

    // a follow-up that re-attaches a stored capture
    const stored = env.manager.runTask(request({ storedImagePngBase64: png, inputs: { question: 'and this?' } }, 'chat'));
    await events(stored);
    expect(llm.calls.at(-1)!.tail[0]).toMatchObject({ type: 'image' });
    expect('storedImagePngBase64' in env.manager.inspect.heldInput(stored.runId)!).toBe(false);
    expect(llm.calls).toHaveLength(2);
    env.close();
  });
});
