// Swiss pairing — spec 05 §2.2. Chess-correct, sport-generic, behind the
// `pairRound(standings, history, constraints, budget)` interface so the algorithm
// can be swapped without touching callers (full FIDE Dutch via weighted matching
// is a later refinement — the spec explicitly defers it; W3 X-SW-2 records the
// deviation, rulebook-W3 RB3-1).
//
// Implementation, a simplified Dutch: order by score group then pairing rank and
// pair each score group by fold (or rank-adjacent), floating the fewest down to
// the next group, the lowest-ranked among the least-floated (P-Q1; FIDE C.04.3
// ranks avoiding a repeat float above rank). With `history.rounds` (X-SW-32) the
// floats are derived per round from the earlier rounds' facts (FIDE C.04.3
// Art. 1.4.2-1.4.4) and each score group weighs [C7] then [C14]-[C21] over the
// last two rounds, taking a candidate with nothing to minimise at once (Art.
// 3.4.1) and otherwise the best, the earlier on a tie (Art. 3.8.1); the
// deprecated `history.floats` count is then ignored. An odd field's bye goes to the
// lowest eligible entrant whose removal leaves a pairable remainder, trying the
// candidates from the bottom up (P-Q2). When the score groups cannot pair a
// remainder within their share of the search budget, a COMPLETE backtracking
// matching over the whole remainder (fold preferred, every transposition
// explored) decides it. Completeness is what makes
// "a round is paired whenever a legal one exists" hold (P-A6): the search fails
// only when no bye candidate leaves a rematch-free (and, for chess, colour-legal)
// perfect matching, or the node budget runs out first. Determinism: candidate
// order is fixed (fold distance, then global rank order), so the same inputs
// always yield the same pairing.
//
// With `lookAhead` (W3 X-SW-10; the app sets it on every round but the last of
// a stage that plays more rounds than the safe maximum ⌊n/2⌋: the last has no
// next round to protect), each complete pairing the search reaches, in the
// same order, is kept only if the next round could still be paired; the search
// goes on past one that dead-ends, but only among the completions of the bye
// candidate it already chose (bye minimality outranks it). With chess colours on,
// a board seated the other way up is a different legal pairing too (final review
// I1): when no pairing keeps the next round pairable with the colours the rule
// gives it, the same pairings are walked again, each with its boards turned where
// both sides stay within the colour limits, the fewest colour preferences given
// up first. When none keeps the next round pairable, the first is seated anyway: the round reports
// `nextRound: "unpairable"` (or "unknown" when the shared budget ran out first)
// so the organiser can be told, never a refusal (rulebook-W3 §3.3, RB3-4).
//
// With `finalRoundMaxScore` (W3 X-SW-11; the app sets it on a stage's last round only) and chess colours on, a board with a
// topscorer is exempt from the colour limits; two non-topscorers with the same absolute preference still never meet
// (FIDE C.04.3 [C3]). The look-ahead's next-round check never applies it.
//
// When it fails, pairRound returns a named refusal (SWISS_NO_LEGAL_PAIRING with
// its reason) that writes nothing, not even the bye — never an empty or partial
// round reported as success (W3 X-SW-3; rulebook-W3 §3.3, P-A6; FIDE C.04.3 [C4]).
import { EngineError } from "../core/errors.ts";
import type { EntrantId } from "../core/types.ts";

export type Colour = "W" | "B";

// One entrant's row as the pairer sees it: current Swiss score and pairing rank
// (rating/seed; lower = stronger). Everything else (metrics, tiebreaks) is
// irrelevant to pairing and stays out.
export interface SwissStanding {
  entrantId: EntrantId;
  score: number;
  rank: number;
}

export interface SwissHistory {
  played: ReadonlySet<string>; // pairKey(a,b) of every fixture already contested — no rematch (hard)
  colours?: ReadonlyMap<EntrantId, readonly Colour[]>; // colour sequence per entrant; outside chess its home/away record (home = "W"), read softly (X-SW-4)
  byes?: ReadonlySet<EntrantId>; // entrants NOT eligible for the bye: already had one, or (FIDE C.04.1(d)) won a walkover. Read only by the bye pick.
  /** @deprecated Pass `rounds` instead. A running downfloat count per entrant: the least-floated float first (soft). Read only
   *  when `rounds` is absent; with `rounds` it is ignored. */
  floats?: ReadonlyMap<EntrantId, number>;
  /** X-SW-32: the facts of every earlier round of this stage, oldest first, the round just played last. When present, the
   *  pairer derives who floated which way in each round itself (`swissRoundFloats`, FIDE C.04.3 Art. 1.4.2–1.4.4) and, in each
   *  score group, weighs [C7] and then the float criteria [C14]–[C21], reading the previous round and the one before it.
   *  `floats` is then ignored. Only the last two rounds are read, but every round given is checked. */
  rounds?: readonly SwissRoundFacts[];
}

/** Which way an entrant floated in one round (FIDE C.04.3 Art. 1.4.2–1.4.3). */
export type SwissFloat = "down" | "up";

/** One board of an earlier round, as the float criteria read it (X-SW-32). */
export interface SwissRoundBoard {
  home: EntrantId;
  away: EntrantId;
  /** Each side's pairing score BEFORE that round: the score the round was paired on (C.04.3 Art. 1.2, 1.4.2). */
  homeScore: number;
  awayScore: number;
  /** Absent: the board was played. Present: it was not (a forfeit recorded before play), so the two have not "played each
   *  other" (Art. 1.4.2); it names the side that scored more than a loss without playing, which downfloats (Art. 1.4.3):
   *  "home", "away", or "none" (a double forfeit: nobody floats, Art. 1.4.4). */
  forfeit?: "home" | "away" | "none";
}

/** What one earlier round seated, for the float criteria (X-SW-32). */
export interface SwissRoundFacts {
  boards: readonly SwissRoundBoard[];
  bye?: EntrantId; // the pairing-allocated bye (Art. 1.5), when the round had one: a downfloat (Art. 1.4.3)
}

export interface SwissConstraints {
  chess?: boolean; // enforce colour rules and read home/away as White/Black
  /** Hammes preset (Jul3/08 §7, 20 Jan): pair ADJACENT ranks (1v2, 3v4, …)
   *  instead of folding top-vs-bottom; the no-rematch backtracking is shared. */
  pairing?: "fold" | "rank_adjacent";
  /** One-round look-ahead (W3 X-SW-10; rulebook-W3 §3.3 prevention, RB3-4; not a FIDE criterion). The app sets it on every
   *  round but the last of a stage that plays more rounds than the safe maximum ⌊n/2⌋; never on the last, which has no next
   *  round to protect (set there, it would move boards and warn for a round that never comes). The search then prefers,
   *  among the legal pairings of the bye it would choose anyway, one after which the next round can still be paired, and
   *  reports its verdict as `nextRound`. With chess colours on, the colour preferences give way only after the boards do:
   *  every pairing is first judged with the colours the rule gives it, and only when none of them keeps the next round
   *  pairable is a board seated the other way up (both sides within the colour limits, the fewest preferences given up
   *  first; final review I1). It judges the next round under the full colour limits, the final round included:
   *  who is a topscorer there (X-SW-11) depends on results not yet played, so before the final round it may move a board or
   *  warn where the topscorer exception would have let that round pair (controller ruling, T4c). `finalRoundMaxScore`, if
   *  also set, describes THIS round and never enters the next round's check. */
  lookAhead?: boolean;
  /** The final round's topscorer exception (W3 X-SW-11; rulebook RB3-10; FIDE C.04.3 (1 Feb 2026) Art. 1.8, [C3] Art. 2.1.3).
   *  The app sets it only when pairing a stage's last round: the most an entrant could have scored before it,
   *  (rounds − 1) × the win, in the pairing score's units. With chess colours on, an entrant with OVER half of it is a
   *  topscorer, and a board with a topscorer is exempt from the colour limits: two non-topscorers with the same absolute
   *  preference still never meet. The exception relaxes the limits and never asks to break them: an assignment that keeps
   *  both sides within their limits is used where there is one, else one that keeps the non-topscorer within its own.
   *  Absent: no exception. Not finite, or ≤ 0: CONFIG_INVALID. Outside chess there is no limit to lift, so it changes
   *  nothing. */
  finalRoundMaxScore?: number;
}

/** Whether the round after this one can be paired legally (X-SW-10): `unknown` when the search budget ran out first. */
export type SwissNextRound = "pairable" | "unpairable" | "unknown";

export interface SwissPairing {
  home: EntrantId; // chess: White
  away: EntrantId; // chess: Black
}

// W3 X-SW-3 (rulebook-W3 §3.3, P-A6): the code of every refusal, and why the round cannot be paired.
export const SWISS_NO_LEGAL_PAIRING = "SWISS_NO_LEGAL_PAIRING" as const;
export type SwissRefusalReason =
  | "field_too_small" // fewer than 2 entrants
  | "no_bye_candidate" // odd field and every entrant is bye-ineligible (P-A4)
  | "rematch" // no rematch-free perfect matching exists (P-A1/A6)
  | "colour" // a rematch-free matching exists, but none meets the chess colour limits (P-A5)
  | "search_limit"; // the search budget ran out before it proved either

// A round that cannot be paired. It carries no pairing and no bye: the caller seats nothing from it.
export interface SwissRefusal {
  readonly ok: false;
  readonly code: typeof SWISS_NO_LEGAL_PAIRING;
  readonly reason: SwissRefusalReason;
  readonly field: number; // standings.length, for the message ("Round N can't be paired")
}

export interface SwissRound {
  readonly ok: true;
  pairings: SwissPairing[]; // always ⌊n/2⌋ ≥ 1 boards
  bye?: EntrantId; // present iff n is odd: the entrant sitting out
  floated: EntrantId[]; // the stronger side of each board between different scores (the deprecated history.floats count). With `rounds`, record the round's boards instead.
  // Present iff constraints.lookAhead: can the next round (this field, with this round's boards, bye and colours added) be
  // paired? "unpairable" seats this round anyway (a soft preference, never a refusal); the app warns the organiser.
  nextRound?: SwissNextRound;
}

export type SwissPairResult = SwissRound | SwissRefusal;

// The search nodes one pairRound call may visit (the pairing search and the reason probe together). A call that runs out
// before it either pairs the round or proves it unpairable is refused `search_limit`, never reported as having no pairing.
export const SWISS_SEARCH_BUDGET: number = 1_000_000;

// The share of the budget still unspent that one remainder's score-group pass may use. Its whole-group floater choices
// grow combinatorially, and in a dead subtree (a lower group that no carry can complete) it would spend the whole budget
// before the complete search below ever ran: a round that search pairs in a few nodes would be refused `search_limit`.
// The rest stays for the complete search, which decides the round either way.
const GROUP_PASS_SHARE = 1 / 8;

// The score-group pass floats at most this many entrants out of a group beyond the one an odd group must.
const EXTRA_FLOATS = 4;

// Stable, order-independent key for an unordered pair.
export function pairKey(a: EntrantId, b: EntrantId): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Who floated which way in one round (X-SW-32; FIDE C.04.3 (1 Feb 2026) Art. 1.4.2–1.4.4): on a PLAYED board between different
 * scores, the higher side downfloats and the lower upfloats (1.4.2, the scores the round was paired on, so score decides the
 * rank); a pairing-allocated bye and a forfeit win downfloat (1.4.3); nobody else floats (1.4.4: an equal-score board, a
 * forfeit loss, a double forfeit). An entrant seated twice in the round, a score that is not a finite number and a forfeit
 * marker other than "home", "away" or "none" are caller defects: CONFIG_INVALID.
 */
export function swissRoundFloats(round: SwissRoundFacts): Map<EntrantId, SwissFloat> {
  const floats = new Map<EntrantId, SwissFloat>();
  const seated = new Set<EntrantId>();
  const seat = (id: EntrantId): void => {
    if (seated.has(id)) {
      throw new EngineError("CONFIG_INVALID", `pairRound: "${id}" is seated twice in one round's facts`, { entrantId: id });
    }
    seated.add(id);
  };
  for (const board of round.boards) {
    seat(board.home);
    seat(board.away);
    for (const score of [board.homeScore, board.awayScore]) {
      if (!Number.isFinite(score)) {
        throw new EngineError("CONFIG_INVALID", `pairRound: a round's facts give ${board.home} v ${board.away} the score ${score}`, {
          home: board.home,
          away: board.away,
        });
      }
    }
    const forfeit: unknown = board.forfeit;
    if (forfeit === undefined) {
      if (board.homeScore !== board.awayScore) {
        const homeHigher = board.homeScore > board.awayScore;
        floats.set(board.home, homeHigher ? "down" : "up");
        floats.set(board.away, homeHigher ? "up" : "down");
      }
    } else if (forfeit === "home" || forfeit === "away") {
      floats.set(forfeit === "home" ? board.home : board.away, "down");
    } else if (forfeit !== "none") {
      throw new EngineError("CONFIG_INVALID", `pairRound: a round's facts mark ${board.home} v ${board.away} forfeit ${JSON.stringify(forfeit)}`, {
        home: board.home,
        away: board.away,
      });
    }
  }
  if (round.bye !== undefined) {
    seat(round.bye);
    floats.set(round.bye, "down");
  }
  return floats;
}

// X-SW-32: how one candidate of a score group (its downfloaters, and the boards of the entrants it carried in) stands on [C7]
// and the float criteria [C14]–[C21], in FIDE's order. Counts and score-difference lists, each list highest first.
interface FloatCost {
  c7: number[]; // [C7] the downfloaters' scores
  counts: [number, number, number, number]; // [C14] [C15] [C16] [C17]
  differences: [number[], number[], number[], number[]]; // [C18] [C19] [C20] [C21]
}

// Lower is better: score lists compare element by element, highest first, a shorter one lower on a shared prefix (one score
// difference fewer); the criteria compare in the order FIDE ranks them. 0 is a tie (Art. 3.8.1: then the earlier candidate).
function compareLists(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  }
  return a.length - b.length;
}
function compareFloatCost(a: FloatCost, b: FloatCost): number {
  const c7 = compareLists(a.c7, b.c7);
  if (c7 !== 0) return c7;
  for (let i = 0; i < 4; i++) {
    if (a.counts[i] !== b.counts[i]) return (a.counts[i] as number) - (b.counts[i] as number);
  }
  for (let i = 0; i < 4; i++) {
    const d = compareLists(a.differences[i] as number[], b.differences[i] as number[]);
    if (d !== 0) return d;
  }
  return 0;
}

const opposite = (c: Colour): Colour => (c === "W" ? "B" : "W");

interface ColourState {
  diff: number; // white − black
  streakColour: Colour | null;
  streakLen: number;
}

function colourState(seq: readonly Colour[] | undefined): ColourState {
  if (seq === undefined || seq.length === 0) return { diff: 0, streakColour: null, streakLen: 0 };
  let w = 0;
  let b = 0;
  for (const c of seq) {
    if (c === "W") w++;
    else b++;
  }
  const streakColour = seq[seq.length - 1] as Colour;
  let streakLen = 1;
  for (let i = seq.length - 2; i >= 0; i--) {
    if (seq[i] === streakColour) streakLen++;
    else break;
  }
  return { diff: w - b, streakColour, streakLen };
}

// The two hard colour rules (spec 05 §2.2): |W−B| ≤ 2 after the round, and never
// three consecutive same colours.
function canTake(state: ColourState, c: Colour): boolean {
  if (c === "W" ? state.diff + 1 > 2 : state.diff - 1 < -2) return false;
  if (state.streakColour === c && state.streakLen >= 2) return false;
  return true;
}

// Which colours an entrant may take this round under the two hard rules.
type ColourClass = "white" | "black" | "either" | "neither";
function classOf(state: ColourState): ColourClass {
  const white = canTake(state, "W");
  const black = canTake(state, "B");
  return white && black ? "either" : white ? "white" : black ? "black" : "neither";
}

// How far entrants with these colour classes are from sitting on boards of one White and one Black side each (CI red,
// X-SW-1 chess at n = 62), with `free` seats whose board the colour limits do not bind (a topscorer's, X-SW-11; the next
// round's bye seat), each taking one entrant of any class. A board of two bound entrants holds at most one who may take
// only White, one who may take only Black, and nobody who may take neither, so the free seats must take each who may take
// neither and the excess of either one-colour class over the other and the flexible: what they cannot take is the slack.
// Above 0 the entrants cannot pair among themselves; at or below it they may (parity and rematches are not read). One
// entrant more or fewer moves the slack by one at most.
function colourSlack(count: { white: number; black: number; either: number; neither: number }, free: number): number {
  const excess = Math.max(0, count.white - count.black - count.either, count.black - count.white - count.either);
  return count.neither + excess - free;
}

// Preferred colour to keep the balance level: the minority colour, or the
// alternation of the last one when balanced. `null` = no preference (round 1).
function preferredColour(state: ColourState): Colour | null {
  if (state.diff > 0) return "B";
  if (state.diff < 0) return "W";
  if (state.streakColour !== null) return opposite(state.streakColour);
  return null;
}

// Order (score desc, rank asc, id asc) — the pairing order all groups derive from.
function pairingOrder(standings: readonly SwissStanding[]): SwissStanding[] {
  return [...standings].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.entrantId < b.entrantId ? -1 : a.entrantId > b.entrantId ? 1 : 0;
  });
}

// Split an already-ordered pool into score groups (runs of equal score, desc).
function groupByScore(pool: readonly SwissStanding[]): SwissStanding[][] {
  const groups: SwissStanding[][] = [];
  for (const s of pool) {
    const last = groups[groups.length - 1];
    if (last === undefined || (last[0] as SwissStanding).score !== s.score) groups.push([s]);
    else last.push(s);
  }
  return groups;
}

// Combinations of `k` items from `items`, yielded in `items` order (so the
// caller's preference ordering carries through).
function* combinations<T>(items: readonly T[], k: number): Generator<T[]> {
  if (k === 0) {
    yield [];
    return;
  }
  for (let i = 0; i <= items.length - k; i++) {
    const head = items[i] as T;
    for (const tail of combinations(items.slice(i + 1), k - 1)) yield [head, tail].flat() as T[];
  }
}

// Which `fc` entrants of `current` to float down, over the WHOLE group: the
// least-floated first, then the lowest-ranked (bottom of the group) — "avoid
// repeat floats" (spec 05 §2.2), "floats are few and low" (P-Q1; SW-L4: a blocked
// top-of-group entrant may be the one that must float). Lazy, because a whole
// group's choices grow combinatorially: the caller pays a search node for each.
function* floaterChoices(
  current: readonly SwissStanding[],
  fc: number,
  floatCountOf: (id: EntrantId) => number,
): Generator<SwissStanding[]> {
  const ordered = [...current].sort((a, b) => {
    const fa = floatCountOf(a.entrantId);
    const fb = floatCountOf(b.entrantId);
    if (fa !== fb) return fa - fb; // least-floated first
    return current.indexOf(b) - current.indexOf(a); // bottom (lowest-ranked) first
  });
  yield* combinations(ordered, fc);
}

/**
 * Pairs one Swiss round: a `SwissRound` (`ok: true`) or a `SwissRefusal` (`ok: false`), as the file header describes.
 *
 * Cost (final review m4): the call runs synchronously, and `budget` bounds it in search nodes: the pairing search, the
 * reason probe and the look-ahead (`constraints.lookAhead`) all count against it. A round that spends the whole budget,
 * a `search_limit` refusal or a look-ahead that ends `"unknown"`, is the worst case. At the default 1,000,000 nodes that
 * took 1.9 to 2.8 s for chess at n = 42 on a development laptop, with the look-ahead on as the app sets it there (up to
 * 3.5 s on a loaded laptop). The final review measured about 2 to 2.5 s, and the look-ahead at about twice the cost of
 * a round without it: its nodes cost more each, so the time is not a fixed multiple of the nodes. The caller holds
 * whatever lock it holds for that long. A server caller inside a request may pass a smaller budget: the cost scales
 * with it, and running out is still a `search_limit` refusal or `nextRound: "unknown"`, never a wrong pairing.
 */
export function pairRound(
  standings: readonly SwissStanding[],
  history: SwissHistory,
  constraints: SwissConstraints = {},
  budget: number = SWISS_SEARCH_BUDGET,
): SwissPairResult {
  // NaN would switch the cap off (no node count exceeds it) and a negative budget refuses every round unsearched:
  // both are caller defects, never a search to run.
  if (Number.isNaN(budget) || budget < 0) {
    throw new EngineError("CONFIG_INVALID", `pairRound: the search budget must be a number ≥ 0, got ${budget}`, { budget });
  }
  // A maximum that is not a positive number makes "over half of it" meaningless: NaN and +∞ exempt nobody, and ≤ 0 nearly
  // everyone. Each is a caller defect, never a final round to pair.
  const finalMax = constraints.finalRoundMaxScore;
  if (finalMax !== undefined && !(Number.isFinite(finalMax) && finalMax > 0)) {
    throw new EngineError("CONFIG_INVALID", `pairRound: finalRoundMaxScore must be a finite number > 0, got ${finalMax}`, {
      finalRoundMaxScore: finalMax,
    });
  }
  // An entrant listed twice would be seated twice (or paired with itself): a caller defect, never a round to pair.
  const seen = new Set<EntrantId>();
  for (const s of standings) {
    if (seen.has(s.entrantId)) {
      throw new EngineError("CONFIG_INVALID", `pairRound: entrant "${s.entrantId}" appears twice in the standings`, {
        entrantId: s.entrantId,
      });
    }
    seen.add(s.entrantId);
  }
  // X-SW-32: with the earlier rounds' facts, who floated which way the previous round and two rounds before ([C14]–[C21] read
  // no further back). Every round is read, so a defect in any of them is refused, not only one inside the window.
  let floatWindow: { previous: Map<EntrantId, SwissFloat>; twoBefore: Map<EntrantId, SwissFloat> } | undefined;
  if (history.rounds !== undefined) {
    const perRound = history.rounds.map(swissRoundFloats);
    const none = new Map<EntrantId, SwissFloat>();
    floatWindow = { previous: perRound[perRound.length - 1] ?? none, twoBefore: perRound[perRound.length - 2] ?? none };
  }
  const refuse = (reason: SwissRefusalReason): SwissRefusal => ({
    ok: false,
    code: SWISS_NO_LEGAL_PAIRING,
    reason,
    field: standings.length,
  });
  // A round needs a board: 0 entrants pair nothing and 1 would sit out alone.
  if (standings.length < 2) return refuse("field_too_small");

  const chess = constraints.chess === true;
  const stateOf = (id: EntrantId): ColourState => colourState(history.colours?.get(id));

  const ordered = pairingOrder(standings);

  // The bye candidates (P-Q2): on an odd field, the eligible entrants (P-A4: not in history.byes) from the bottom of the
  // pairing order up — lowest score first, then lowest rank. None eligible is a refusal, never a second bye. An even
  // field has one "candidate", no bye.
  let candidates: (SwissStanding | undefined)[] = [undefined];
  if (ordered.length % 2 === 1) {
    const byed = history.byes ?? new Set<EntrantId>();
    candidates = [...ordered].reverse().filter((s) => !byed.has(s.entrantId));
    if (candidates.length === 0) return refuse("no_bye_candidate");
  }
  const remainderOf = (bye: SwissStanding | undefined): SwissStanding[] =>
    bye === undefined ? ordered : ordered.filter((s) => s !== bye);

  const played = history.played;
  // X-SW-11 (C.04.3 Art. 1.8): in the final round, an entrant with over half the most it could have scored is a topscorer, and
  // its own colour limits do not bind. Read only where the colour limits are (chess).
  const topscorer = (s: SwissStanding): boolean => finalMax !== undefined && s.score > finalMax / 2;
  // The reason probe (below) re-runs the search with the colour limits lifted, to tell "colour" from "rematch".
  let liftColourLimits = false;
  const colourLegal = (a: SwissStanding, b: SwissStanding): boolean => {
    if (!chess || liftColourLimits) return true;
    // [C3] keeps apart only two non-topscorers: a board with a topscorer is legal whatever the history (X-SW-11)
    if (topscorer(a) || topscorer(b)) return true;
    const sa = stateOf(a.entrantId);
    const sb = stateOf(b.entrantId);
    return (canTake(sa, "W") && canTake(sb, "B")) || (canTake(sa, "B") && canTake(sb, "W"));
  };
  const hardLegal = (a: SwissStanding, b: SwissStanding): boolean =>
    !played.has(pairKey(a.entrantId, b.entrantId)) && colourLegal(a, b);
  // Which colours each entrant may take this round, for `coloursCanPair`: a topscorer's board is legal whatever the colours
  // (X-SW-11), so it is read apart from the rest.
  const colourClassOf = new Map<EntrantId, ColourClass | "topscorer">();
  const colourClass = (s: SwissStanding): ColourClass | "topscorer" => {
    let known = colourClassOf.get(s.entrantId);
    if (known === undefined) {
      known = topscorer(s) ? "topscorer" : classOf(stateOf(s.entrantId));
      colourClassOf.set(s.entrantId, known);
    }
    return known;
  };
  // Whether `list` can still pair among itself as far as the colour counts go (CI red, X-SW-1 chess at n = 62). Without it
  // the complete search, pairing top-down, could spend the flexible entrants above and reach a remainder holding more
  // entrants who may take only White (or only Black) than it has boards, then refute that dead end one transposition at a
  // time: exponential, so a round a pairing exists for ran out of budget. Necessary, never sufficient: it cuts only
  // subtrees with no legal matching, so the search reaches the same leaves in the same order, in fewer nodes.
  const slackOf = (list: readonly SwissStanding[]): number => {
    if (!chess || liftColourLimits) return 0;
    const count = { white: 0, black: 0, either: 0, neither: 0, topscorer: 0 };
    for (const s of list) count[colourClass(s)]++;
    return colourSlack(count, count.topscorer);
  };
  const coloursCanPair = (list: readonly SwissStanding[]): boolean => slackOf(list) <= 0;

  // Fold-preference candidate order for the strongest unpaired player `a`: its
  // own score group first (fold partner = top of that group's bottom half),
  // then nearest groups (minimal float), then rank order.
  const orderCandidates = (a: SwissStanding, others: SwissStanding[]): SwissStanding[] => {
    const sameScore = others.filter((o) => o.score === a.score);
    const adjacent = constraints.pairing === "rank_adjacent";
    const foldIdx = adjacent ? 0 : Math.floor(sameScore.length / 2);
    const globalIdx = new Map(others.map((o, i) => [o.entrantId, i]));
    return [...others].sort((x, y) => {
      const sx = x.score === a.score;
      const sy = y.score === a.score;
      if (sx !== sy) return sx ? -1 : 1;
      if (sx && sy) {
        const dx = Math.abs(sameScore.indexOf(x) - foldIdx);
        const dy = Math.abs(sameScore.indexOf(y) - foldIdx);
        if (dx !== dy) return dx - dy;
      } else {
        const gx = Math.abs(a.score - x.score);
        const gy = Math.abs(a.score - y.score);
        if (gx !== gy) return gx - gy;
      }
      return (globalIdx.get(x.entrantId) as number) - (globalIdx.get(y.entrantId) as number);
    });
  };

  // Complete backtracking matching of one list, fold-preferred. Every candidate
  // is tried before giving up, so it finds a matching iff one exists. The score
  // group pass runs it per group (spec 05 §2.2: "backtracking over transpositions
  // within score groups"); when the groups cannot pair a remainder within their
  // share of the search budget it runs once over the whole remainder, which is
  // what makes a refusal a proof (P-A6).
  // `memoFail` prunes dead subsets within one run.
  // Shared search budget across the whole call (`budget`, default
  // SWISS_SEARCH_BUDGET): every bye candidate, group pass, floater choice, whole-
  // remainder search and the reason probe draw on it. Hard colour limits can make
  // a pathological field's infeasibility proof exponential, so we cap total work.
  // Once it runs out every further node fails, so the round cannot be paired AND
  // nothing was proved: `exhausted` makes that a `search_limit` refusal, never a
  // claimed rematch.
  let nodes = 0;
  let exhausted = false;
  let cap = budget; // lowered to the group pass's share while it runs; running out of a share is not running out
  const spend = (): boolean => {
    if (++nodes > cap) {
      if (cap >= budget) exhausted = true;
      return false;
    }
    return true;
  };
  // The search reaches complete pairings ("leaves") one at a time, in preference order, and hands each to a continuation,
  // which answers whether the search may stop there. Without the look-ahead the first leaf is taken, so the search visits
  // exactly the nodes it always did. What one search found: no leaf at all ("none"), leaves that were all turned down
  // ("rejected"), or one that was taken ("accepted").
  type Found = "none" | "rejected" | "accepted";
  type Boards = [SwissStanding, SwissStanding][];

  // `k` gets each complete matching of `list` (with the boards chosen before it in the caller's own continuation). When
  // `k` answers "none", what follows `list` cannot complete whatever `list`'s matching is (the groups below a score
  // group read only its floaters), so this list's other matchings are not tried. A subset that reached no leaf is
  // remembered as dead within this run; one whose leaves were turned down is not, since another prefix may be taken.
  const matchWithin = (list: SwissStanding[], k: (boards: Boards) => Found): Found => {
    const memoFail = new Set<string>();
    const chosen: Boards = [];
    let deadBelow = false;
    const rec = (remaining: SwissStanding[]): Found => {
      if (remaining.length === 0) {
        const answer = k([...chosen]);
        if (answer === "none") deadBelow = true;
        return answer;
      }
      if (!spend()) return "none";
      const key = remaining.map((s) => s.entrantId).join(",");
      if (memoFail.has(key)) return "none";
      if (!coloursCanPair(remaining)) {
        memoFail.add(key);
        return "none";
      }
      const a = remaining[0] as SwissStanding;
      const others = remaining.slice(1);
      let found: Found = "none";
      for (const b of orderCandidates(a, others)) {
        if (!hardLegal(a, b)) continue;
        chosen.push([a, b]);
        const sub = rec(others.filter((o) => o.entrantId !== b.entrantId));
        chosen.pop();
        if (sub === "accepted") return "accepted";
        if (sub === "rejected") found = "rejected";
        if (deadBelow) return found;
      }
      if (found === "none") memoFail.add(key);
      return found;
    };
    return rec(list);
  };

  // Score-group pairing top-down. Each group is paired internally (with the
  // carried downfloaters from stronger groups sitting on top); whoever can't be
  // paired here floats to the next group. Fewest floaters first, and among equal
  // counts the least-floated go down, the lowest-ranked among them (spec 05 §2.2
  // float tracking; FIDE C.04.3 ranks avoiding a repeat float above rank). Bounded: at most parity + 4 floaters per group; who floats
  // ranges over the whole group, each choice read costs a node, and the pass as a
  // whole may spend only GROUP_PASS_SHARE of the budget left when it starts.
  // With the round facts (X-SW-32) the count is not read: the floaters go bottom first, and the float criteria order the candidates.
  const floatCountOf = (id: EntrantId): number => (floatWindow !== undefined ? 0 : (history.floats?.get(id) ?? 0));

  // X-SW-32: one score group's candidates with `fc` downfloaters, weighed by FIDE C.04.3's float criteria. A candidate is a set
  // of floaters and the boards of the entrants the group carried in (its MDPs; the residents left all hold the group's score,
  // so their boards float nobody): those two decide [C7] and [C14]–[C21] (`costOf`). They are generated in the order the
  // search below has always reached them (floaters bottom first, each carried entrant's partner by fold), the residents'
  // boards found for each by the same complete search. One that matches the best a candidate could possibly do is tried at
  // once (Art. 3.4.1); the rest are kept, and when none of those completes they are tried best first, the earlier on a tie
  // (Art. 3.8.1). Trying one runs the groups below (C.04.3 [C4]: the round must still complete): when they cannot complete
  // with those floaters, no other candidate with the same floaters is tried. "out": the node budget ran out.
  const pairGroupByFloats = (
    current: readonly SwissStanding[],
    carry: readonly SwissStanding[],
    fc: number,
    fw: NonNullable<typeof floatWindow>,
    below: (floaters: SwissStanding[], boards: Boards) => Found,
  ): Found | "out" => {
    const carried = new Set(carry.map((s) => s.entrantId));
    // [C14]/[C16] count the RESIDENT floaters (an MDP floating on is not one); [C15]/[C17] the MDP opponents, the lower side of
    // a carried entrant's board; [C18]/[C20] the MDPs paired here, the higher side. The 2026 text gives a score difference only
    // to a board, so an MDP left unpaired adds none. The engine may seat two MDPs together, which FIDE never does: there the
    // lower one takes the upfloat (Art. 1.4.2) and is read as the MDP opponent.
    const costOf = (floaters: readonly SwissStanding[], boards: Boards): FloatCost => {
      const cost: FloatCost = { c7: floaters.map((f) => f.score).sort((x, y) => y - x), counts: [0, 0, 0, 0], differences: [[], [], [], []] };
      for (const f of floaters) {
        if (carried.has(f.entrantId)) continue;
        if (fw.previous.get(f.entrantId) === "down") cost.counts[0]++;
        if (fw.twoBefore.get(f.entrantId) === "down") cost.counts[2]++;
      }
      for (const [x, y] of boards) {
        if (x.score === y.score) continue;
        const [hi, lo] = x.score > y.score ? [x, y] : [y, x];
        const difference = hi.score - lo.score;
        if (fw.previous.get(lo.entrantId) === "up") {
          cost.counts[1]++;
          cost.differences[1].push(difference);
        }
        if (fw.twoBefore.get(lo.entrantId) === "up") {
          cost.counts[3]++;
          cost.differences[3].push(difference);
        }
        if (fw.previous.get(hi.entrantId) === "down") cost.differences[0].push(difference);
        if (fw.twoBefore.get(hi.entrantId) === "down") cost.differences[2].push(difference);
      }
      for (const list of cost.differences) list.sort((x, y) => y - x);
      return cost;
    };
    // The best any candidate could do: the fc lowest scores floating, and nothing else counted.
    const best: FloatCost = {
      c7: current.map((s) => s.score).sort((x, y) => x - y).slice(0, fc).sort((x, y) => y - x),
      counts: [0, 0, 0, 0],
      differences: [[], [], [], []],
    };
    // Every way to seat the carried entrants of `rest` (a prefix of it, in carry order), as the complete search reaches them:
    // the first unpaired carried entrant takes each legal partner in fold order. The residents left come back unpaired.
    function* carriedBoards(rest: readonly SwissStanding[]): Generator<{ boards: Boards; residents: SwissStanding[] }> {
      const chosen: Boards = [];
      function* rec(remaining: SwissStanding[]): Generator<{ boards: Boards; residents: SwissStanding[] }> {
        const a = remaining[0];
        if (a === undefined || !carried.has(a.entrantId)) {
          yield { boards: [...chosen], residents: remaining };
          return;
        }
        const others = remaining.slice(1);
        for (const b of orderCandidates(a, others)) {
          if (!hardLegal(a, b)) continue;
          chosen.push([a, b]);
          yield* rec(others.filter((o) => o.entrantId !== b.entrantId));
          chosen.pop();
        }
      }
      yield* rec([...rest]);
    }
    interface Candidate {
      floaters: SwissStanding[];
      boards: Boards;
      residents: SwissStanding[];
      cost: FloatCost;
      order: number;
    }
    const deadFloaters = new Set<string>();
    let found: Found = "none";
    const attempt = (c: Candidate): Found => {
      const key = c.floaters.map((f) => f.entrantId).join(",");
      if (deadFloaters.has(key)) return "none";
      let belowNone = false;
      const here = matchWithin(c.residents, (boards) => {
        const answer = below(c.floaters, [...c.boards, ...boards]);
        if (answer === "none") belowNone = true;
        return answer;
      });
      if (belowNone) deadFloaters.add(key);
      return here;
    };
    const kept: Candidate[] = [];
    for (const floaters of floaterChoices(current, fc, floatCountOf)) {
      if (!spend()) return "out";
      const set = new Set(floaters.map((f) => f.entrantId));
      const rest = current.filter((c) => !set.has(c.entrantId));
      if (!coloursCanPair(rest)) continue;
      for (const { boards, residents } of carriedBoards(rest)) {
        if (!spend()) return "out";
        const candidate: Candidate = { floaters, boards, residents, cost: costOf(floaters, boards), order: kept.length };
        if (compareFloatCost(candidate.cost, best) !== 0) {
          kept.push(candidate);
          continue;
        }
        const here = attempt(candidate);
        if (here === "accepted") return "accepted";
        if (here === "rejected") found = "rejected";
      }
    }
    kept.sort((a, b) => compareFloatCost(a.cost, b.cost) || a.order - b.order);
    for (const candidate of kept) {
      if (!spend()) return "out";
      const here = attempt(candidate);
      if (here === "accepted") return "accepted";
      if (here === "rejected") found = "rejected";
    }
    return found;
  };

  const pairFrom = (
    groups: readonly SwissStanding[][],
    gi: number,
    carry: SwissStanding[],
    k: (boards: Boards) => Found,
  ): Found => {
    if (gi >= groups.length) return carry.length === 0 ? k([]) : "none";
    const current = [...carry, ...(groups[gi] as SwissStanding[])];
    const isLast = gi === groups.length - 1;
    const parity = current.length % 2;
    const maxFloat = isLast ? 0 : parity + EXTRA_FLOATS; // cap extra floats per group (the pass's cost is held by GROUP_PASS_SHARE)
    // The colour counts (CI red): a floater moves a group's slack by one at most, so a group must float out, or be carried
    // in, at least its slack. This group floats at most maxFloat; a group below is carried at most 1 + EXTRA_FLOATS and
    // floats as many (none from the last). Past either cap no choice of floaters can pair the groups, and the pass would
    // otherwise walk every choice above before its share of the budget ran out.
    if (slackOf(current) > maxFloat) return "none";
    for (let g = gi + 1; g < groups.length; g++) {
      const floatsOut = g === groups.length - 1 ? 0 : 1 + EXTRA_FLOATS;
      if (slackOf(groups[g] as SwissStanding[]) > 1 + EXTRA_FLOATS + floatsOut) return "none";
    }

    let found: Found = "none";
    for (let fc = parity; fc <= maxFloat; fc += 2) {
      if (isLast && fc !== 0) break;
      if (floatWindow !== undefined) {
        const here = pairGroupByFloats(current, carry, fc, floatWindow, (floaters, boards) =>
          pairFrom(groups, gi + 1, floaters, (below) => k([...boards, ...below])),
        );
        if (here === "out") return found;
        if (here === "accepted") return "accepted";
        if (here === "rejected") found = "rejected";
        continue;
      }
      for (const floaters of floaterChoices(current, fc, floatCountOf)) {
        if (!spend()) return found;
        const set = new Set(floaters.map((f) => f.entrantId));
        const rest = current.filter((c) => !set.has(c.entrantId));
        const here = matchWithin(rest, (boards) => pairFrom(groups, gi + 1, floaters, (below) => k([...boards, ...below])));
        if (here === "accepted") return "accepted";
        if (here === "rejected") found = "rejected";
      }
    }
    return found;
  };

  // One bye candidate's remainder: the score-group pass first (P-Q1), and only when the groups cannot pair it within
  // their share of the search budget (or, with the look-ahead, every pairing they reached was turned down), the complete
  // search over the whole remainder (P-A6). Floats are read off the boards either way (below).
  const pairRemainder = (remainder: SwissStanding[], leaf: (boards: Boards) => Found): Found => {
    cap = Math.min(budget, nodes + Math.floor((budget - nodes) * GROUP_PASS_SHARE));
    const viaGroups = pairFrom(groupByScore(remainder), 0, [], leaf);
    cap = budget;
    if (viaGroups === "accepted" || exhausted) return viaGroups;
    const whole = matchWithin(remainder, leaf);
    return whole === "none" ? viaGroups : whole;
  };

  // Seat the boards: colours (chess) or home and away, and the downfloats. Each board is turned upper board first (its
  // place in the pairing order) before either is read. The search does not promise that order: carried floaters arrive
  // bottom first, and the look-ahead reaches pairings in which two of them meet. Read as reached, such a board would name
  // the lower side as the one that floated, and give the upper board's colour claim to the lower one.
  // Keyed by id: every seated entrant comes from `ordered` (the candidate lists below are all taken from it, and a duplicated
  // id is refused above), so a missing one is a defect in this file, refused loudly rather than read as "upside down".
  const position = new Map(ordered.map((s, i) => [s.entrantId, i]));
  const positionOf = (s: SwissStanding): number => {
    const at = position.get(s.entrantId);
    if (at === undefined) throw new Error(`pairRound: "${s.entrantId}" was seated but is not in the pairing order`);
    return at;
  };
  const seat = (boards: Boards): { pairings: SwissPairing[]; floated: EntrantId[] } => {
    const pairings: SwissPairing[] = [];
    const floated: EntrantId[] = [];
    for (const [x, y] of boards) {
      const [a, b] = positionOf(x) < positionOf(y) ? [x, y] : [y, x];
      if (a.score !== b.score) floated.push(a.entrantId); // a is the stronger side ⇒ it floated down
      pairings.push(assignColours(a, b, chess, stateOf, topscorer));
    }
    return { pairings, floated };
  };

  // The look-ahead's leaf check (X-SW-10): with these boards and this bye seated, can the next round be paired at all? The
  // same field, with this round's boards played (P-A1), its bye no longer eligible (P-A4), and for chess the colours as
  // seated (P-A5). Existence only, over the whole field: an odd field adds one bye seat that only a bye-eligible entrant may
  // take, so a perfect matching that seats it IS a bye choice with a pairable remainder. It draws on the same node budget,
  // and answers "cut" when that ran out before it proved either answer. `sides` is this round's boards as seated (White
  // home), read for the colours; null lifts the colour limits.
  const lookAhead = constraints.lookAhead === true;
  const nextRoundCheck = (boards: Boards, bye: SwissStanding | undefined, sides: readonly SwissPairing[] | null): "yes" | "no" | "cut" => {
    const withColours = sides !== null;
    const metNow = new Set(boards.map(([a, b]) => pairKey(a.entrantId, b.entrantId)));
    const nextState = new Map<EntrantId, ColourState>();
    if (sides !== null) {
      const take = (id: EntrantId, c: Colour): void => {
        nextState.set(id, colourState([...(history.colours?.get(id) ?? []), c]));
      };
      for (const p of sides) {
        take(p.home, "W");
        take(p.away, "B");
      }
    }
    const stateNext = (id: EntrantId): ColourState => nextState.get(id) ?? stateOf(id);
    const field = ordered;
    const byeSeat = field.length % 2 === 1 ? field.length : -1; // index of the extra seat, odd fields only
    const legal = (i: number, j: number): boolean => {
      if (j === byeSeat) {
        const s = field[i] as SwissStanding;
        return s.entrantId !== bye?.entrantId && history.byes?.has(s.entrantId) !== true;
      }
      const x = (field[i] as SwissStanding).entrantId;
      const y = (field[j] as SwissStanding).entrantId;
      const key = pairKey(x, y);
      if (played.has(key) || metNow.has(key)) return false;
      if (!withColours) return true;
      const sx = stateNext(x);
      const sy = stateNext(y);
      return (canTake(sx, "W") && canTake(sy, "B")) || (canTake(sx, "B") && canTake(sy, "W"));
    };
    // The colour counts, as in the round's own search (CI red): the bye seat is the one seat the colours do not bind.
    const seatClass = new Map<number, ColourClass>();
    const slackOfSeats = (remaining: readonly number[]): number => {
      if (!withColours) return 0;
      const count = { white: 0, black: 0, either: 0, neither: 0 };
      let free = 0;
      for (const i of remaining) {
        if (i === byeSeat) {
          free++;
          continue;
        }
        let known = seatClass.get(i);
        if (known === undefined) {
          known = classOf(stateNext((field[i] as SwissStanding).entrantId));
          seatClass.set(i, known);
        }
        count[known]++;
      }
      return colourSlack(count, free);
    };
    const memoFail = new Set<string>();
    let cut = false;
    const rec = (remaining: number[]): boolean => {
      if (remaining.length === 0) return true;
      if (!spend()) {
        cut = true;
        return false;
      }
      const key = remaining.join(",");
      if (memoFail.has(key)) return false;
      if (slackOfSeats(remaining) > 0) {
        memoFail.add(key);
        return false;
      }
      const i = remaining[0] as number;
      const others = remaining.slice(1);
      for (const j of others) {
        if (legal(i, j) && rec(others.filter((o) => o !== j))) return true;
      }
      memoFail.add(key);
      return false;
    };
    const seats = Array.from({ length: field.length + (byeSeat >= 0 ? 1 : 0) }, (_, i) => i);
    return rec(seats) ? "yes" : cut ? "cut" : "no";
  };

  for (const bye of candidates) {
    // The first leaf this bye reaches is the pairing the search has always returned. With the look-ahead, the search goes on
    // past a leaf after which the next round cannot pair, but only among this bye's own completions: the bye is the
    // P-Q2-minimal one, and bye minimality outranks every other criterion (controller ruling R1; rulebook §2.3 item 4).
    // "accepted" stops the search: the leaf took the boards, or proved that no completion of this bye can be taken.
    let first: Boards | undefined;
    let taken: Boards | undefined;
    let takenSides: SwissPairing[] | undefined; // set when the second pass seats `taken` with a board turned
    // A pairing the score-group pass reaches by several floater choices, and again in the whole-remainder search, is judged
    // once. The memo is keyed on the boards AS REACHED (each pair in the order the search holds it), not on the set: the
    // same set reached with a board the other way up is judged again, so its verdict rests on `seat` turning every board
    // upper side first, and never on the memo standing in for that.
    const keyOf = (boards: Boards): string => boards.map(([a, b]) => JSON.stringify([a.entrantId, b.entrantId])).sort().join("\n");
    const verdicts = new Map<string, boolean>();
    let baseChecked = false;
    let hopeless = false; // the next round cannot pair whatever this round seats: no second pass either
    const leaf = (boards: Boards): Found => {
      first ??= boards;
      if (!lookAhead) {
        taken = boards;
        return "accepted";
      }
      const key = keyOf(boards);
      let pairs = verdicts.get(key);
      if (pairs === undefined) {
        const answer = nextRoundCheck(boards, bye, chess ? seat(boards).pairings : null);
        if (answer === "cut") return "rejected"; // not proved either way: a later reach judges it again
        pairs = answer === "yes";
        verdicts.set(key, pairs);
      }
      if (pairs) {
        taken = boards;
        return "accepted";
      }
      // Turned down. If the next round cannot pair even before this round adds its boards and colours (this bye spent, the
      // colour limits lifted), no completion of this bye can make it pair: stop here rather than walk them all.
      if (!baseChecked) {
        const base = nextRoundCheck([], bye, null);
        if (base !== "cut") baseChecked = true;
        if (base === "no") {
          hopeless = true;
          return "accepted";
        }
      }
      return "rejected";
    };
    pairRemainder(remainderOf(bye), leaf);

    // The second pass (chess, final review I1): no pairing kept the next round pairable with the colours the rule gives it.
    // A board seated the other way up is another legal pairing (rulebook §3.3: "among legal pairings"), so the same pairings
    // are walked again, in the same order, and each is judged with its boards turned: only boards whose two sides both stay
    // within the colour limits either way up (a topscorer's exception never turns one), the fewest colour preferences given
    // up first (`turnings`). The first that keeps the next round pairable is seated. Colour preferences give way only here:
    // a pairing the rule's colours keep pairable, on any boards, was taken in the first pass. It draws on the same budget,
    // each turning tried a node of its own, so a round it cannot finish comes back "unknown", never refused.
    const turnedDown = new Set<string>();
    const turnLeaf = (boards: Boards): Found => {
      const key = keyOf(boards);
      if (turnedDown.has(key)) return "rejected";
      // the colours cannot help when the next round has no pairing even with their limits lifted: a rematch dead end
      const lifted = nextRoundCheck(boards, bye, null);
      if (lifted === "cut") return "rejected";
      if (lifted === "no") {
        turnedDown.add(key);
        return "rejected";
      }
      const { pairings } = seat(boards);
      const byCost: [number[], number[], number[]] = [[], [], []];
      pairings.forEach((p, i) => {
        const cost = turnCost(p, stateOf);
        if (cost !== null) byCost[cost].push(i);
      });
      for (const turned of turnings(byCost)) {
        if (!spend()) return "rejected"; // out of nodes (the whole budget, or the score-group pass's share): judged again later, or "unknown"
        const sides = pairings.map((p, i) => (turned.includes(i) ? { home: p.away, away: p.home } : p));
        const answer = nextRoundCheck(boards, bye, sides);
        if (answer === "cut") return "rejected";
        if (answer === "yes") {
          taken = boards;
          takenSides = sides;
          return "accepted";
        }
      }
      turnedDown.add(key);
      return "rejected";
    };
    if (lookAhead && chess && first !== undefined && taken === undefined && !hopeless && !exhausted) {
      pairRemainder(remainderOf(bye), turnLeaf);
    }

    if (first !== undefined) {
      // No leaf kept the next round pairable: seat the first anyway (a soft preference, never a refusal), and say why.
      const nextRound: SwissNextRound = taken !== undefined ? "pairable" : exhausted ? "unknown" : "unpairable";
      const { pairings: ruleSides, floated } = seat(taken ?? first);
      const pairings = takenSides ?? ruleSides;
      return {
        ok: true,
        pairings,
        floated,
        ...(bye === undefined ? {} : { bye: bye.entrantId }),
        ...(lookAhead ? { nextRound } : {}),
      };
    }
    if (exhausted) return refuse("search_limit");
  }

  // No bye candidate leaves a rematch-free (colour-legal) perfect matching: refuse, and write nothing, not even the bye
  // (§3.3). The reason (controller ruling R2): run out of budget anywhere ⇒ "search_limit"; chess, and ANY candidate's
  // remainder pairs once the colour limits are lifted ⇒ "colour"; else "rematch". The probe needs only existence, so it
  // runs the complete search alone.
  if (!chess) return refuse("rematch");
  liftColourLimits = true;
  for (const bye of candidates) {
    if (matchWithin(remainderOf(bye), () => "accepted") === "accepted") return refuse("colour");
    if (exhausted) return refuse("search_limit");
  }
  return refuse("rematch");
}

// The look-ahead's second pass (X-SW-10, final review I1): what turning one seated chess board costs, in colour preferences
// (preferredColour) the other way up leaves unmet beyond those the seated way leaves. null when the other way up would take
// either side outside its colour limits: only a board both sides could play either way up may be turned, so a topscorer's
// exception (X-SW-11) never turns one. The seated way already meets every preference it can (assignColours: both asks met
// when they differ, the lone ask met, one of two equal asks met), so the cost is 0, 1 or 2; anything else is a defect in
// this file, refused loudly rather than ordered wrongly.
function turnCost(p: SwissPairing, stateOf: (id: EntrantId) => ColourState): 0 | 1 | 2 | null {
  const white = stateOf(p.home);
  const black = stateOf(p.away);
  if (!(canTake(white, "W") && canTake(black, "B") && canTake(white, "B") && canTake(black, "W"))) return null;
  const unmet = (s: ColourState, c: Colour): number => {
    const ask = preferredColour(s);
    return ask !== null && ask !== c ? 1 : 0;
  };
  const cost = unmet(white, "B") + unmet(black, "W") - (unmet(white, "W") + unmet(black, "B"));
  if (cost !== 0 && cost !== 1 && cost !== 2) {
    throw new Error(`pairRound: ${p.home} v ${p.away} was seated against ${-cost} more colour preferences than the other way up`);
  }
  return cost;
}

// The sets of boards the second pass tries turned, cheapest first: fewest colour preferences given up (the boards' summed
// turnCost), then fewest boards turned, then a fixed order (the costlier boards' combinations outermost, each in board
// order). `byCost[c]` lists the boards (their places in the seated round) whose turn costs c. Lazy: the caller pays a node
// for each set it takes. Never the empty set: the boards as seated were judged in the first pass.
function* turnings(byCost: readonly [number[], number[], number[]]): Generator<number[]> {
  const [free, one, two] = byCost;
  const boards = free.length + one.length + two.length;
  for (let cost = 0; cost <= one.length + 2 * two.length; cost++) {
    for (let size = 1; size <= boards; size++) {
      for (let twos = 0; 2 * twos <= cost && twos <= two.length; twos++) {
        const ones = cost - 2 * twos;
        const frees = size - ones - twos;
        if (ones > one.length || frees < 0 || frees > free.length) continue;
        for (const t of combinations(two, twos)) {
          for (const o of combinations(one, ones)) {
            for (const f of combinations(free, frees)) yield [...f, ...o, ...t];
          }
        }
      }
    }
  }
}

// Decide who is home (White in chess; a is the upper board). Chess: satisfy the
// hard rules first, then colour preferences. Outside chess the same preferences
// alternate home and away, softly (W3 X-SW-4; rulebook RB3-11, P-Q6): the side
// that was home more often (or last) plays away, and there is no hard limit to
// satisfy. Either way, neutral ⇒ the upper board is home (round-1 S1 = White). In the final round the topscorer exception
// (`exempt`, X-SW-11) RELAXES the limits and never asks to break them (controller ruling, T4c fix round 1): an assignment
// that alone keeps BOTH sides within the limits is used first; only when neither does, one that alone keeps the
// non-topscorer within its own; otherwise the preferences decide.
function assignColours(
  a: SwissStanding,
  b: SwissStanding,
  chess: boolean,
  stateOf: (id: EntrantId) => ColourState,
  exempt: (s: SwissStanding) => boolean,
): SwissPairing {
  const sa = stateOf(a.entrantId);
  const sb = stateOf(b.entrantId);
  // Outside chess both assignments are open: home/away is never a reason to refuse or to override a preference.
  let aW = !chess || (canTake(sa, "W") && canTake(sb, "B"));
  let aB = !chess || (canTake(sa, "B") && canTake(sb, "W"));
  if (!aW && !aB) {
    // No assignment keeps both within the limits: a board only a topscorer makes legal (colourLegal seats two
    // non-topscorers only with one). Drop the topscorers' own limits, so the non-topscorer's alone decide.
    const may = (s: SwissStanding, state: ColourState, c: Colour): boolean => exempt(s) || canTake(state, c);
    aW = may(a, sa, "W") && may(b, sb, "B");
    aB = may(a, sa, "B") && may(b, sb, "W");
    // Still neither: the non-topscorer may take neither colour. That needs a colour difference of ±2 one way and the two
    // latest games of the other colour, so ±4 two games earlier: a history no legal event produces. Refused by name, never
    // seated outside its limits unannounced.
    if (!aW && !aB) {
      const side = exempt(a) ? b : a;
      throw new EngineError(
        "CONFIG_INVALID",
        `pairRound: "${side.entrantId}"'s colour history allows neither colour (no legal event produces it)`,
        { entrantId: side.entrantId },
      );
    }
  }

  let aColour: Colour;
  if (aW && !aB) aColour = "W";
  else if (aB && !aW) aColour = "B";
  else {
    const pa = preferredColour(sa);
    const pb = preferredColour(sb);
    if (pa !== null && pb !== null && pa !== pb) aColour = pa; // both satisfied
    else if (pa !== null && pb !== null) {
      // Both want the same colour — the stronger claim (larger imbalance, then
      // the upper board) gets it.
      aColour = Math.abs(sa.diff) >= Math.abs(sb.diff) ? pa : opposite(pa);
    } else if (pa !== null) aColour = pa;
    else if (pb !== null) aColour = opposite(pb);
    else aColour = "W"; // both neutral ⇒ upper board White
  }

  return aColour === "W"
    ? { home: a.entrantId, away: b.entrantId }
    : { home: b.entrantId, away: a.entrantId };
}
