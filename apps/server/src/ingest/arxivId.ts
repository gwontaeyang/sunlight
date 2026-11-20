// arXiv input → {id, version?} (PLAN 4.1 `resolve`, 3 "arXiv id는 정규식 통과분만 URL에 사용"). Owner A.
// Accepted:
//   new-style ids   2209.15397, 2209.15397v2, 0704.0001 (YYMM.NNNN for 0704–1412, YYMM.NNNNN from 1501)
//   old-style ids   cs/0112017, hep-th/9901001v3, math.GT/0309136 (the subject class is dropped: math/0309136)
//   prefixes        arXiv:2209.15397 (any case)
//   URLs            http(s)://(www.|export.)arxiv.org/(abs|pdf|html)/<id>[vN][.pdf][/][?…][#…]
// Everything else is rejected (null). Only ids produced here are ever put into a URL or a file path.

export interface ArxivRef {
  /** Canonical id without version: `2209.15397`, `cs/0112017`. */
  id: string;
  /** Requested version (>= 1) or undefined for "latest". */
  version?: number;
}

const NEW_ID = /^(\d{2})(0[1-9]|1[0-2])\.(\d{4,5})$/;
const OLD_ID = /^([a-z]+(?:-[a-z]+)?)(?:\.[A-Z]{2})?\/(\d{2})(0[1-9]|1[0-2])(\d{3})$/;
const ID_WITH_VERSION = /^(.+?)(?:v([1-9]\d{0,3}))?$/;
const URL_FORM = /^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf|html)\/(.+?)(?:\.pdf)?\/?(?:[?#].*)?$/i;
const PREFIX = /^arxiv:\s*/i;

/** Validates a bare id (no version). Returns the canonical id or null. */
export function canonicalArxivId(raw: string): string | null {
  const m = NEW_ID.exec(raw);
  if (m) {
    const yymm = Number(m[1]) * 100 + Number(m[2]);
    // 4-digit numbers only before 2015 (0704–1412), 5 digits from 1501; the scheme starts at 0704.
    if (yymm < 704) return null;
    if (m[3]!.length === 4 && yymm >= 1501) return null;
    if (m[3]!.length === 5 && yymm < 1501) return null;
    return raw;
  }
  const o = OLD_ID.exec(raw);
  if (o) {
    const yy = Number(o[2]);
    // Old-style ids exist from 1991 (91xx) to 2007 (07xx).
    if (!(yy >= 91 || yy <= 7)) return null;
    return `${o[1]}/${o[2]}${o[3]}${o[4]}`;
  }
  return null;
}

/** Parses user input (id, versioned id, arXiv: prefix or arxiv.org URL). Returns null when it is not one. */
export function parseArxivInput(input: string): ArxivRef | null {
  let s = input.trim();
  if (s.length === 0 || s.length > 300 || /\s/.test(s)) return null;
  const url = URL_FORM.exec(s);
  if (url) {
    try {
      s = decodeURIComponent(url[1]!);
    } catch {
      return null;
    }
  } else if (/^[a-z]+:\/\//i.test(s)) {
    return null; // some other URL
  } else {
    s = s.replace(PREFIX, '');
  }
  const v = ID_WITH_VERSION.exec(s);
  if (!v) return null;
  const id = canonicalArxivId(v[1]!);
  if (!id) return null;
  return v[2] === undefined ? { id } : { id, version: Number(v[2]) };
}

/** `2209.15397` + 2 → `2209.15397v2`. */
export function versionedId(id: string, version: number): string {
  if (canonicalArxivId(id) !== id || !Number.isInteger(version) || version < 1) throw new Error(`invalid arXiv id/version ${id} v${version}`);
  return `${id}v${version}`;
}

/** Splits the `<id>` element of an arXiv Atom entry (`http://arxiv.org/abs/2209.15397v2`) into id + version. */
export function parseAbsUrl(absUrl: string): { id: string; version: number } | null {
  const m = /arxiv\.org\/abs\/(.+?)v([1-9]\d{0,3})$/i.exec(absUrl.trim());
  if (!m) return null;
  const id = canonicalArxivId(m[1]!);
  return id ? { id, version: Number(m[2]) } : null;
}
