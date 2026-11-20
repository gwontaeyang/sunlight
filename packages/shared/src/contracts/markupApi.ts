// Options of shared/markup parseAnswer (PLAN_M2 3.4). Owner: supervisor (the type); B implements it in
// markup/parseAnswer.ts, D uses it (a temporary adapter for these options only until B is merged).
// Defaults = the M1 behaviour (markup + badge).
export interface ParseOptions {
  /** The answer is complete (no streaming hold-back). */
  final?: boolean;
  /** plain: <q>, <eq>, [[P]] and <glossary> are NOT interpreted (left as text); citations and blocks are always empty.
   *  Used for translations, notes and user memos. HTML/link neutralisation is the same as markup. */
  mode?: 'markup' | 'plain';
  /** strip: [[P]]-style label tokens are removed from the display and no block labels are made (an issue is recorded);
   *  citation chips stay. Used for notation/assumption card item bodies, whose label is the item attribute. */
  labels?: 'badge' | 'strip';
}
