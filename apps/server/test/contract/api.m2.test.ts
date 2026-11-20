// Contract: M2 additions to contracts/api.ts · routes.ts · errors.ts · sse.ts (BRIEF_S S3). Owner: supervisor.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  API_SCHEMAS,
  Base64Png,
  CreateGlossaryRequest,
  CreateThreadRequest,
  EquationDto,
  LastPositionDto,
  LIMITS,
  PatchGlossaryRequest,
  PostMessageRequest,
  PutPositionRequest,
} from '@study-paper/shared/contracts/api';
import { EQUATION_LATEX_MAX } from '@study-paper/shared/contracts/domain';
import { parseConflictDetails } from '@study-paper/shared/contracts/errors';
import { ROUTE_MANIFEST } from '@study-paper/shared/contracts/routeManifest';
import { ROUTE_BY_ID, ROUTES } from '@study-paper/shared/contracts/routes';
import { parseSseEvent } from '@study-paper/shared/contracts/sse';
import { maxBodyBytes } from '../../src/security/limits';
import { makeTestPngBase64 } from '../helpers/png';
import { REPO_ROOT } from '../helpers/proc';

const ID = '00000000-0000-4000-8000-000000000001';
const CRID = '11111111-1111-4111-8111-111111111111';
const AREA = { kind: 'area' as const, rects: [{ page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] };

describe('contracts M2: routes', () => {
  it('papers.upgradeStructure and papers.capture (A, milestone 2); png is a response kind', () => {
    expect(ROUTE_BY_ID['papers.upgradeStructure']).toMatchObject({ method: 'POST', path: '/papers/:id/upgrade-structure', response: 'json' });
    expect(ROUTE_BY_ID['papers.capture']).toMatchObject({ method: 'GET', path: '/papers/:id/captures/:fileId', response: 'png' });
    for (const r of ['papers.upgradeStructure', 'papers.capture'] as const) expect(ROUTE_MANIFEST.find((m) => m.route === r)).toMatchObject({ owner: 'A', milestone: 2 });
    expect(API_SCHEMAS['papers.upgradeStructure'].response.parse({ jobId: ID })).toEqual({ jobId: ID });
    expect(API_SCHEMAS['papers.capture'].params.safeParse({ id: ID, fileId: ID }).success).toBe(true);
    expect(ROUTES.filter((r) => r.response === 'png').map((r) => r.id)).toEqual(['papers.capture']);
  });

  it('security/limits.ts is unchanged: the 6 MiB capture limit applies to threads.create and highlights.create only', () => {
    for (const r of ROUTES) {
      const want = r.id === 'papers.upload' ? LIMITS.uploadBytes : r.id === 'threads.create' || r.id === 'highlights.create' ? LIMITS.captureRequestBytes : LIMITS.jsonBodyBytes;
      expect(maxBodyBytes(r.id), r.id).toBe(want);
    }
    expect(LIMITS.captureRequestBytes).toBe(6_291_456);
    expect(LIMITS.capturesPerPaper).toBe(500);
    expect(LIMITS.captureBytesPerPaper).toBe(500 * 1024 * 1024);
  });
});

describe('contracts M2: request schemas', () => {
  it('Base64Png: canonical only (pad bits), size cap unchanged (4 MiB + 3 bytes → too long)', () => {
    const png = makeTestPngBase64({ width: 16, height: 16, padToBytes: 1000 });
    expect(png.endsWith('==')).toBe(true);
    expect(Base64Png.safeParse(png).success).toBe(true);
    const variant = png.slice(0, -3) + String.fromCharCode(png.charCodeAt(png.length - 3) + 1) + '==';
    expect(Buffer.from(variant, 'base64').equals(Buffer.from(png, 'base64'))).toBe(true);
    expect(Base64Png.safeParse(variant).success).toBe(false);
    expect(Base64Png.safeParse(`${png}\n`).success).toBe(false);
    expect(Base64Png.safeParse('').success).toBe(false);
    // Length cap: base64 of 4 MiB + 2 bytes = 5,592,408 chars passes the schema; 4 MiB + 3 bytes = 5,592,412 does not.
    expect(Base64Png.safeParse('A'.repeat(5_592_408)).success).toBe(true);
    expect(Base64Png.safeParse('A'.repeat(5_592_412)).success).toBe(false);
  });

  it('CreateThreadRequest: deep optional, imagePng needs an area anchor (shape only)', () => {
    const png = makeTestPngBase64({ width: 16, height: 16 });
    expect(CreateThreadRequest.safeParse({ kind: 'chat', question: 'q', deep: true, clientRequestId: CRID }).success).toBe(true);
    expect(CreateThreadRequest.safeParse({ kind: 'figure', anchor: AREA, imagePng: png, clientRequestId: CRID }).success).toBe(true);
    expect(CreateThreadRequest.safeParse({ kind: 'figure', imagePng: png, clientRequestId: CRID }).success).toBe(false);
    expect(CreateThreadRequest.safeParse({ kind: 'figure', anchor: { kind: 'text', quote: { exact: 'x' }, rects: [] }, imagePng: png, clientRequestId: CRID }).success).toBe(false);
    expect(PostMessageRequest.safeParse({ text: 't', deep: false, clientRequestId: CRID }).success).toBe(true);
  });

  it('glossary create/patch are strict: unknown fields (citations, origin) are rejected', () => {
    expect(CreateGlossaryRequest.safeParse({ term: 'ICP' }).success).toBe(true);
    expect(CreateGlossaryRequest.safeParse({ term: 'ICP', citations: [] }).success).toBe(false);
    expect(CreateGlossaryRequest.safeParse({ term: 'ICP', origin: 'llm' }).success).toBe(false);
    expect(PatchGlossaryRequest.safeParse({ definitionKo: null }).success).toBe(true);
    expect(PatchGlossaryRequest.safeParse({ definitionKo: 'x', citations: [] }).success).toBe(false);
  });

  it('LastPositionDto: M1 values parse with mode custom / top 0; M2 values keep theirs; top is 0..1', () => {
    expect(LastPositionDto.parse({ page: 3, zoom: 1.25 })).toEqual({ page: 3, zoom: 1.25, mode: 'custom', top: 0 });
    expect(PutPositionRequest.parse({ page: 3, zoom: 1, mode: 'page-width', top: 0.4 })).toEqual({ page: 3, zoom: 1, mode: 'page-width', top: 0.4 });
    expect(LastPositionDto.safeParse({ page: 3, zoom: 1, top: 1.5 }).success).toBe(false);
    expect(LastPositionDto.safeParse({ page: 3, zoom: 1, mode: 'fit' }).success).toBe(false);
  });
});

describe('contracts M2: ConflictDetails and run.retrying', () => {
  it('parseConflictDetails accepts the two forms and nothing else', () => {
    expect(parseConflictDetails({ reason: 'payload_version', runId: 'r' })).toEqual({ reason: 'payload_version', runId: 'r' });
    expect(parseConflictDetails({ reason: 'card_generating', runId: 'r', cardId: 'c' })).toEqual({ reason: 'card_generating', runId: 'r', cardId: 'c' });
    for (const bad of [null, undefined, 'x', {}, { reason: 'other', runId: 'r' }, { reason: 'card_generating', runId: 'r' }, { reason: 'payload_version' }]) expect(parseConflictDetails(bad)).toBeNull();
  });

  it('run.retrying: reason validation, ≤ 10 errors of ≤ 200 chars', () => {
    expect(parseSseEvent('run.retrying', { reason: 'validation', errors: ['a'] }).event).toBe('run.retrying');
    expect(() => parseSseEvent('run.retrying', { reason: 'other', errors: [] })).toThrow();
    expect(() => parseSseEvent('run.retrying', { reason: 'validation', errors: Array.from({ length: 11 }, () => 'a') })).toThrow();
    expect(() => parseSseEvent('run.retrying', { reason: 'validation', errors: ['a'.repeat(201)] })).toThrow();
  });
});

describe('EquationDto.latex: the one constant EQUATION_LATEX_MAX (X-I10-03)', () => {
  it('the schema takes its limit from contracts/domain EQUATION_LATEX_MAX, not a number of its own', () => {
    const src = readFileSync(join(REPO_ROOT, 'packages', 'shared', 'src', 'contracts', 'api.ts'), 'utf8');
    const body = src.slice(src.indexOf('export const EquationDto'), src.indexOf('});', src.indexOf('export const EquationDto')));
    expect(body).toMatch(/\blatex: z\.string\(\)\.max\(EQUATION_LATEX_MAX\)/);
    expect(body).not.toMatch(/\blatex: z\.string\(\)\.max\(\d/);
    expect(EquationDto.shape.latex.safeParse('x'.repeat(EQUATION_LATEX_MAX)).success).toBe(true);
    expect(EquationDto.shape.latex.safeParse('x'.repeat(EQUATION_LATEX_MAX + 1)).success).toBe(false);
  });
});
