// parseAnswer compatibility (PLAN_M2 R10, BRIEF_B B3). Owner B. The default options (and explicit markup + badge) must
// give the M1 output byte for byte, or the chip numbering of stored M1 answers would shift. The table holds the sha256
// of JSON.stringify(parseAnswer(raw)) / parseAnswer(raw, { final: false }) computed with the parser at tag
// m2-contracts (the M1 parser) for every M1 mock output and adversarial fixture. A failure here means: revert the
// parser change, not this table.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseAnswer } from '../src/markup/parseAnswer';
import { readMockFile, readMockManifest } from '../src/mockOutputs';

const M1_OUTPUT_SHA256: Record<string, { final: string; streaming: string }> = {
  // New learning fixture, also evaluated with the unmodified parser and grammar at tag m2-contracts.
  'study_path.md': { final: '98e8a245d83f4036b2da383fd3e117b4f71fa02d13c5416f9baef61768dd5ec7', streaming: '98e8a245d83f4036b2da383fd3e117b4f71fa02d13c5416f9baef61768dd5ec7' },
  'explain_selection.md': { final: '82ec90dbc5dcc6a6acbf14725dfdbd4979c1bd0d6bb0f77c0db8f21bc933a193', streaming: '82ec90dbc5dcc6a6acbf14725dfdbd4979c1bd0d6bb0f77c0db8f21bc933a193' },
  'chat.md': { final: '5736ce97b4bed9f34f04076bc77481bfe43abb4c2df9e1e22229ebaef6577d82', streaming: '5736ce97b4bed9f34f04076bc77481bfe43abb4c2df9e1e22229ebaef6577d82' },
  'translate_selection.md': { final: '2acb76e003eb19a76b374db8963a89515112c4cc947cf91b677ee4672b875028', streaming: '2acb76e003eb19a76b374db8963a89515112c4cc947cf91b677ee4672b875028' },
  'figure_area.md': { final: 'ad9a4aeda2d125864b6f1d664737fb4894f08a612254670a5c85e32bc4812ed1', streaming: 'ad9a4aeda2d125864b6f1d664737fb4894f08a612254670a5c85e32bc4812ed1' },
  'summary.md': { final: 'a55bc061fdf5ee33661f4662af2ded18ad61f1aa10f6db3551c2f5e843dbed18', streaming: 'a55bc061fdf5ee33661f4662af2ded18ad61f1aa10f6db3551c2f5e843dbed18' },
  'equation_deep.md': { final: '12485dde971629f7942215c9ed01a12dab05f78fbb0da99b8c0e53d4cb710883', streaming: '12485dde971629f7942215c9ed01a12dab05f78fbb0da99b8c0e53d4cb710883' },
  'notation_card.md': { final: '955276c02a94415bc1ea62e4e33555c4b035ace3e5a7b4d0394daadd0ba04e25', streaming: '955276c02a94415bc1ea62e4e33555c4b035ace3e5a7b4d0394daadd0ba04e25' },
  'assumptions_card.md': { final: 'c177feb4e82e5b97a05b2b2cc7f3a3fc506185e9e3ab333453b5d45d94deac48', streaming: 'c177feb4e82e5b97a05b2b2cc7f3a3fc506185e9e3ab333453b5d45d94deac48' },
  'glossary_define.md': { final: '50734d9e60176d4cf0cc6a164dc11d71b781ac8340f639173e2d3d6a351c46a3', streaming: '50734d9e60176d4cf0cc6a164dc11d71b781ac8340f639173e2d3d6a351c46a3' },
  'cards_from_highlights.md': { final: 'fde536ed8ed8ef5d0044308d1471537b8f274d92dc7ca58d274aa8bf255a63c3', streaming: 'fde536ed8ed8ef5d0044308d1471537b8f274d92dc7ca58d274aa8bf255a63c3' },
  'explain_back_grade.md': { final: '525c78bac88ab566ae7bae75f42111783d8081b941ece80105be60a20ce045a1', streaming: '525c78bac88ab566ae7bae75f42111783d8081b941ece80105be60a20ce045a1' },
  'adversarial/injection.md': { final: 'b93cac1afdc27a002bd683095f74adab97e5467e7345c7ec92411fcb16c64bdd', streaming: 'b93cac1afdc27a002bd683095f74adab97e5467e7345c7ec92411fcb16c64bdd' },
  'adversarial/fence_and_code.md': { final: 'd333b32329a1b9f62963334419b19f2545f4934612b91d95ea096071df1ac56f', streaming: 'd333b32329a1b9f62963334419b19f2545f4934612b91d95ea096071df1ac56f' },
  'adversarial/unclosed_nested.md': { final: 'd2b6ea8c5dc3d3e16271211d32a7889226dfcfb822e68b5f8a00cf7b68042007', streaming: '55270eb5d3f1b29fc963f9773b22265cdc1229f594e8f8d472e2134367a08011' },
  'adversarial/forged_links.md': { final: 'a8ec1c05ab5335b8374e36f393da766b1ba8eff916d5fd54f274131966503da2', streaming: 'a8ec1c05ab5335b8374e36f393da766b1ba8eff916d5fd54f274131966503da2' },
  'adversarial/forged_chip_forms.md': { final: '3914327550c8d29ef93696e9a70f279ff18c7f487ec5809f7e2d78fa12aafc80', streaming: '3914327550c8d29ef93696e9a70f279ff18c7f487ec5809f7e2d78fa12aafc80' },
  'adversarial/forged_badge_comment.md': { final: 'efe6fdcba0852d17e7ed50a7b069e478ce0c40773cbeefde6951423497ddb37c', streaming: 'efe6fdcba0852d17e7ed50a7b069e478ce0c40773cbeefde6951423497ddb37c' },
  'adversarial/label_mid_table.md': { final: 'af7c29d949b44f225b77d77a74a6aa2af3afc1b18b1c3315c86c2d7ca704e595', streaming: 'af7c29d949b44f225b77d77a74a6aa2af3afc1b18b1c3315c86c2d7ca704e595' },
  'adversarial/too_many_quotes.md': { final: 'a024d4a62d0a057ac11eb79e0a61414fd2810fb77e6921c72fab43cd5e6b016d', streaming: 'a024d4a62d0a057ac11eb79e0a61414fd2810fb77e6921c72fab43cd5e6b016d' },
};

const sha = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');

describe('parseAnswer default options = the M1 output', () => {
  const manifest = readMockManifest();
  const files = [...Object.values(manifest.tasks).filter((t) => t.format !== 'json-schema').map((t) => t.file), ...Object.values(manifest.adversarial).map((a) => a.file)];

  it('the table covers every M1 mock and adversarial output (and nothing else)', () => {
    expect(Object.keys(M1_OUTPUT_SHA256).sort()).toEqual([...files].sort());
  });

  for (const file of files) {
    it(file, () => {
      const raw = readMockFile(file);
      const want = M1_OUTPUT_SHA256[file]!;
      expect(sha(parseAnswer(raw))).toBe(want.final);
      expect(sha(parseAnswer(raw, { final: true }))).toBe(want.final);
      expect(sha(parseAnswer(raw, { final: true, mode: 'markup', labels: 'badge' }))).toBe(want.final);
      expect(sha(parseAnswer(raw, { final: false }))).toBe(want.streaming);
      expect(sha(parseAnswer(raw, { final: false, mode: 'markup', labels: 'badge' }))).toBe(want.streaming);
    });
  }
});
