// X-SW-32: FIDE's float criteria in the Swiss pairer. The text is FIDE C.04.3, the FIDE (Dutch) System as applied from
// 1 February 2026 (handbook.fide.com/chapter/C0403202602). Every expected pairing below is derived by hand from it, never read
// off the engine:
//   Art. 1.4.2  after two players with different scores have PLAYED each other in a round, the higher ranked one (Art. 1.2:
//               score first) receives a downfloat, the lower one an upfloat;
//   Art. 1.4.3  a pairing-allocated bye, and scoring more than a loss in a round without playing (a forfeit win), are downfloats;
//   Art. 1.4.4  nobody else floats: an equal-score board, a forfeit loss and a double forfeit give no float;
//   [C7]  (Art. 2.4.2)  minimise the scores of the downfloaters, highest first;
//   [C14] (Art. 2.4.9)  minimise the resident downfloaters who received a downfloat the previous round;
//   [C15] (Art. 2.4.10) minimise the MDP opponents who received an upfloat the previous round;
//   [C16], [C17]        the same two, two rounds before;
//   [C18]–[C21]         the score differences (highest first) of the MDPs who downfloated, and of the MDP opponents who
//                       upfloated, the previous round and two rounds before, in that order;
//   Art. 3.4 / 3.8.1    a candidate meeting every criterion is taken at once; otherwise the best one, the earlier one on a tie;
//   Art. 1.9.1  the pairing-allocated bye goes to the player who downfloats from the last bracket, so the criteria weigh it too;
//   Art. 3.2.4  an MDP left out of S1 is in the Limbo, "bound to double-float" (its Note). The 2026 text gives it no score
//               difference; by controller ruling 2026-11-23 (FIDE's intent) it counts for [C18]/[C20] with the pre-2026 C.04.3
//               A.8 PSD value: its score less an artificial score one point under the bracket's lowest.
// The bracket procedure is Art. 3.2–3.7: S1 holds the MDPs (or the top half), S2 the residents, S1[i] meets S2[i], and S2 is
// transposed before residents are exchanged.
//
// The facts name earlier opponents outside the field (x1, x2, x3: entrants who have since withdrawn), so no rematch touches a
// case and only the floats differ. A case that needs a meeting inside the field holds it as a played board of an older round
// between equal scores (`meetings`), which floats nobody: with `rounds`, every pair in `played` must be one. Each case runs with chess colours off and on (the pairer's one sport dimension; no colour
// history is given, so the colour limits bind nobody) and counts what it checked: zero checked is a failure.
import { describe, expect, it } from "vitest";
import { mulberry32 } from "../core/rng.ts";
import {
  pairKey,
  pairRound,
  swissRoundFloats,
  type Colour,
  type SwissConstraints,
  type SwissHistory,
  type SwissPairResult,
  type SwissRoundBoard,
  type SwissRoundFacts,
  type SwissStanding,
} from "./swiss.ts";

const row = (entrantId: string, score: number, rank: number): SwissStanding => ({ entrantId, score, rank });
// A board as it was played, each side's score the one that round was paired on.
const played = (home: string, away: string, homeScore: number, awayScore: number): SwissRoundBoard => ({ home, away, homeScore, awayScore });
// A board that was not played: `winner` names the side that scored more than a loss without playing, or "none".
const unplayed = (home: string, away: string, homeScore: number, awayScore: number, winner: "home" | "away" | "none"): SwissRoundBoard => ({
  ...played(home, away, homeScore, awayScore),
  forfeit: winner,
});
const round = (...boards: SwissRoundBoard[]): SwissRoundFacts => ({ boards });
const QUIET: SwissRoundFacts = round(); // a round whose facts touch nobody in the field
// The meetings in `met` as played boards between equal scores, packed into rounds (an entrant sits once per round), to go
// before a case's own facts: older than the window, or inside it floating nobody (Art. 1.4.4).
const meetings = (met: ReadonlySet<string>): SwissRoundFacts[] => {
  const out: { boards: SwissRoundBoard[]; seated: Set<string> }[] = [];
  for (const key of met) {
    const [home, away] = key.split("|") as [string, string];
    let r = out.find((o) => !o.seated.has(home) && !o.seated.has(away));
    if (r === undefined) {
      r = { boards: [], seated: new Set() };
      out.push(r);
    }
    r.boards.push(played(home, away, 0, 0));
    r.seated.add(home).add(away);
  }
  if (out.length === 0) throw new Error("premise: meetings() given no meeting");
  return out.map((o) => round(...o.boards));
};

const pairs = (...boards: [string, string][]): string[] => boards.map(([a, b]) => pairKey(a, b)).sort();
const boardsOf = (r: SwissPairResult): string[] => (r.ok ? r.pairings.map((p) => pairKey(p.home, p.away)).sort() : [`refused: ${r.reason}`]);

// Pairs one round with chess colours off and on; returns how many runs it checked.
const expectBoards = (field: SwissStanding[], history: SwissHistory, expected: string[], label: string): number => {
  let checked = 0;
  for (const chess of [false, true]) {
    expect(boardsOf(pairRound(field, history, { chess })), `${label}, chess ${chess}`).toEqual(expected);
    checked++;
  }
  return checked;
};

// F1. Score 1: p1 p2 p3 (odd: one downfloats); score 0: q1 q2 q3. FIDE: the homogeneous bracket {p1 p2 p3} has S1 [p1],
// S2 [p2 p3]; candidate (a) p1–p2 with p3 down, then the transposition (b) p1–p3 with p2 down, then the exchanges, among them
// (c) p2–p3 with p1 down. Below, the heterogeneous bracket {MDP | q1 q2 q3}: the MDP meets S2's first (q1), and q2–q3.
const F1 = [row("p1", 1, 1), row("p2", 1, 2), row("p3", 1, 3), row("q1", 0, 4), row("q2", 0, 5), row("q3", 0, 6)];
const P3_DOWN = pairs(["p1", "p2"], ["p3", "q1"], ["q2", "q3"]); // candidate (a)
const P2_DOWN = pairs(["p1", "p3"], ["p2", "q1"], ["q2", "q3"]); // candidate (b)
const P1_DOWN = pairs(["p2", "p3"], ["p1", "q1"], ["q2", "q3"]); // candidate (c)
const P3_DOWNFLOATED = round(played("p3", "x1", 1, 0)); // p3 the higher side of a played board (Art. 1.4.2)

describe("X-SW-32 the float criteria [C14] and [C16]: who downfloats out of a score group (C.04.3 Art. 1.4, 2.4.9, 2.4.11)", () => {
  it("X-SW-32 the empty case first: no round facts, and an empty list of them, pair as with no float history (the bottom resident floats)", () => {
    let checked = 0;
    checked += expectBoards(F1, { played: new Set() }, P3_DOWN, "no facts");
    checked += expectBoards(F1, { played: new Set(), rounds: [] }, P3_DOWN, "rounds: []");
    checked += expectBoards(F1, { played: new Set(), rounds: [QUIET, QUIET] }, P3_DOWN, "two rounds touching nobody");
    expect(checked).toBe(6);
  });

  it("X-SW-32 [C14]: a resident who downfloated the previous round does not float again, the next lowest does", () => {
    // (a) floats p3, who downfloated the previous round: [C14] 1. (b) floats p2: [C14] 0, perfect, taken (Art. 3.4.1).
    expect(expectBoards(F1, { played: new Set(), rounds: [P3_DOWNFLOATED] }, P2_DOWN, "p3 downfloated the previous round")).toBe(2);
  });

  it("X-SW-32 the window: the same downfloat counts the previous round ([C14]) and two rounds before ([C16]), and not three rounds before", () => {
    let checked = 0;
    checked += expectBoards(F1, { played: new Set(), rounds: [QUIET, QUIET, P3_DOWNFLOATED] }, P2_DOWN, "previous round");
    checked += expectBoards(F1, { played: new Set(), rounds: [QUIET, P3_DOWNFLOATED, QUIET] }, P2_DOWN, "two rounds before");
    checked += expectBoards(F1, { played: new Set(), rounds: [P3_DOWNFLOATED, QUIET, QUIET] }, P3_DOWN, "three rounds before: outside every criterion");
    expect(checked).toBe(6);
  });

  it("X-SW-32 up and down are separate: a resident who UPfloated the previous round floats down as before ([C14] counts downfloats only)", () => {
    const p3UpFloated = round(played("x1", "p3", 2, 1)); // p3 the lower side (Art. 1.4.2)
    expect(swissRoundFloats(p3UpFloated).get("p3")).toBe("up");
    expect(expectBoards(F1, { played: new Set(), rounds: [p3UpFloated] }, P3_DOWN, "p3 upfloated the previous round")).toBe(2);
  });

  it("X-SW-32 [C14] beats [C16]: the resident who downfloated the previous round stays, though two others downfloated two rounds before", () => {
    // p3 downfloated the previous round; p1 and p2 two rounds before. (a) p3 down: [C14] 1. (b) p2 down: [C14] 0, [C16] 1.
    // (c) p1 down: [C14] 0, [C16] 1. Nothing is perfect: the best is (b) or (c), and (b) comes first (Art. 3.8.1).
    // Read the other way round ([C16] first), (a) would win: p3 floats, as with no facts at all.
    const twoBefore = round(played("p1", "x2", 1, 0), played("p2", "x3", 1, 0));
    expect(expectBoards(F1, { played: new Set(), rounds: [twoBefore, P3_DOWNFLOATED] }, P2_DOWN, "C14 over C16")).toBe(2);
  });

  it("X-SW-32 every resident downfloated the previous round: [C14] cannot be met, so the bracket falls to its next criterion and the bottom floats", () => {
    // (a), (b), (c) all have [C14] 1 and nothing else: the earliest, (a).
    const all = round(played("p1", "x1", 1, 0), played("p2", "x2", 1, 0), played("p3", "x3", 1, 0));
    expect(expectBoards(F1, { played: new Set(), rounds: [all] }, P3_DOWN, "all three downfloated")).toBe(2);
  });

  it("X-SW-32 [C14] counts the resident floaters only: when p2 and p3 downfloated the previous round, the top seed p1 floats", () => {
    // (a) [C14] 1, (b) [C14] 1, (c) p1 down: [C14] 0, perfect.
    const two = round(played("p2", "x1", 1, 0), played("p3", "x2", 1, 0));
    expect(expectBoards(F1, { played: new Set(), rounds: [two] }, P1_DOWN, "p2 and p3 downfloated")).toBe(2);
  });
});

describe("X-SW-32 what counts as a float (C.04.3 Art. 1.4.2–1.4.4)", () => {
  it("X-SW-32 a pairing-allocated bye is a downfloat (Art. 1.4.3): the resident who had it the previous round does not float again", () => {
    let checked = 0;
    checked += expectBoards(F1, { played: new Set(), rounds: [{ boards: [], bye: "p3" }] }, P2_DOWN, "p3 had the bye");
    checked += expectBoards(F1, { played: new Set(), rounds: [{ boards: [], bye: "x1" }] }, P3_DOWN, "someone else had the bye");
    expect(checked).toBe(4);
  });

  it("X-SW-32 a forfeit win is a downfloat (Art. 1.4.3), even between equal scores, where the same board played gives none (Art. 1.4.2)", () => {
    let checked = 0;
    checked += expectBoards(F1, { played: new Set(), rounds: [round(unplayed("p3", "x1", 0, 0, "home"))] }, P2_DOWN, "p3 won by forfeit");
    checked += expectBoards(F1, { played: new Set(), rounds: [round(played("p3", "x1", 0, 0))] }, P3_DOWN, "p3 won it on the board");
    expect(checked).toBe(4);
  });

  it("X-SW-32 a walkover board is not a game played (Art. 1.4.2): the side that lost it by forfeit gets no float, though it had the higher score (Art. 1.4.4)", () => {
    let checked = 0;
    // p3 (1) lost to x1 (0) by forfeit: no float. Played, the same board downfloats p3.
    checked += expectBoards(F1, { played: new Set(), rounds: [round(unplayed("p3", "x1", 1, 0, "away"))] }, P3_DOWN, "p3 lost by forfeit");
    checked += expectBoards(F1, { played: new Set(), rounds: [round(played("p3", "x1", 1, 0))] }, P2_DOWN, "the same board played");
    // a double forfeit: neither side scored more than a loss, so neither floats
    checked += expectBoards(F1, { played: new Set(), rounds: [round(unplayed("p3", "x1", 1, 0, "none"))] }, P3_DOWN, "a double forfeit");
    // p2 (1) v p3 (0), p3 winning by forfeit: p3 downfloats (Art. 1.4.3), p2 gets nothing. Read as played, p2 would downfloat
    // and p3 upfloat, and p3 would float again.
    checked += expectBoards(F1, { played: new Set(), rounds: [round(unplayed("p2", "p3", 1, 0, "away"))] }, P2_DOWN, "p3 beat p2 by forfeit");
    expect(checked).toBe(8);
  });

  it("X-SW-32 swissRoundFloats reads one round's facts per Art. 1.4.2–1.4.4, every row counted", () => {
    // [facts, expected floats]: derived from the articles, one row per kind of board.
    const table: [SwissRoundFacts, Record<string, "down" | "up">][] = [
      [round(), {}], // the empty case first
      [round(played("a", "b", 2, 1)), { a: "down", b: "up" }], // 1.4.2, higher side home
      [round(played("a", "b", 1, 2)), { a: "up", b: "down" }], // 1.4.2, higher side away
      [round(played("a", "b", 1, 1)), {}], // 1.4.2: equal scores, no float
      [round(unplayed("a", "b", 1, 1, "home")), { a: "down" }], // 1.4.3 forfeit win; 1.4.4 the loser nothing
      [round(unplayed("a", "b", 2, 1, "away")), { b: "down" }], // 1.4.3 for the lower side; 1.4.4 nothing for the higher
      [round(unplayed("a", "b", 1, 2, "home")), { a: "down" }], // the lower side wins it: still only a downfloat
      [round(unplayed("a", "b", 2, 1, "none")), {}], // a double forfeit
      [{ boards: [], bye: "a" }, { a: "down" }], // 1.4.3 the pairing-allocated bye
      [{ boards: [played("a", "b", 3, 1), unplayed("c", "d", 1, 1, "away")], bye: "e" }, { a: "down", b: "up", d: "down", e: "down" }],
    ];
    let checked = 0;
    for (const [facts, expected] of table) {
      expect(Object.fromEntries(swissRoundFloats(facts)), JSON.stringify(facts)).toEqual(expected);
      checked++;
    }
    expect(checked).toBe(10);
  });
});

// F2. Score 2: m1 m2 m3 (odd: m3, the bottom, downfloats; none of them has a float). Score 1: q1 q2 q3. FIDE: bracket {m3 | q1
// q2 q3}: S1 [m3], S2 [q1 q2 q3]; (a) m3–q1 with q2–q3, then the transpositions (b) m3–q2 with q1–q3, (c) m3–q3 with q1–q2.
const F2 = [row("m1", 2, 1), row("m2", 2, 2), row("m3", 2, 3), row("q1", 1, 4), row("q2", 1, 5), row("q3", 1, 6)];
const M3_Q1 = pairs(["m1", "m2"], ["m3", "q1"], ["q2", "q3"]); // (a)
const M3_Q2 = pairs(["m1", "m2"], ["m3", "q2"], ["q1", "q3"]); // (b)
const Q1_UPFLOATED = round(played("x1", "q1", 2, 1)); // q1 the lower side of a played board (Art. 1.4.2)

describe("X-SW-32 the float criteria [C15] and [C17]: who meets a moved-down player (C.04.3 Art. 2.4.10, 2.4.12)", () => {
  it("X-SW-32 [C15]: the MDP's opponent is not the resident who upfloated the previous round", () => {
    // (a) [C15] 1; (b) [C15] 0, perfect.
    let checked = expectBoards(F2, { played: new Set() }, M3_Q1, "no facts: (a)");
    checked += expectBoards(F2, { played: new Set(), rounds: [Q1_UPFLOATED] }, M3_Q2, "q1 upfloated the previous round");
    expect(checked).toBe(4);
  });

  it("X-SW-32 the window for upfloats: the previous round ([C15]) and two rounds before ([C17]) count, three rounds before does not", () => {
    let checked = 0;
    checked += expectBoards(F2, { played: new Set(), rounds: [QUIET, Q1_UPFLOATED, QUIET] }, M3_Q2, "two rounds before");
    checked += expectBoards(F2, { played: new Set(), rounds: [Q1_UPFLOATED, QUIET, QUIET] }, M3_Q1, "three rounds before");
    expect(checked).toBe(4);
  });

  it("X-SW-32 up and down are separate: a resident who DOWNfloated the previous round may meet the MDP ([C15] counts upfloats only)", () => {
    expect(expectBoards(F2, { played: new Set(), rounds: [round(played("q1", "x1", 1, 0))] }, M3_Q1, "q1 downfloated")).toBe(2);
  });

  it("X-SW-32 [C15] beats [C17]: the MDP meets a resident who upfloated two rounds before rather than the one who upfloated the previous round", () => {
    // q1 upfloated the previous round; q2 and q3 two rounds before. (a) [C15] 1; (b) [C15] 0, [C17] 1; (c) [C15] 0, [C17] 1.
    // Best (b), the earlier. [C17] first would take (a), which is also what no facts give.
    const twoBefore = round(played("x2", "q2", 2, 1), played("x3", "q3", 2, 1));
    expect(expectBoards(F2, { played: new Set(), rounds: [twoBefore, Q1_UPFLOATED] }, M3_Q2, "C15 over C17")).toBe(2);
  });
});

describe("X-SW-32 the criteria are weighed together, in FIDE's order, over the whole candidate (C.04.3 Art. 3.8.1)", () => {
  it("X-SW-32 [C15] beats [C16]: Y, who downfloated two rounds before and upfloated the previous round, floats on rather than meet the MDP", () => {
    // M (2) is alone and downfloats. Bracket {M | Y X} (Y ranked above X), one floats on to z (0). S1 [M], S2 [Y X]:
    // (a) M–Y, X down: [C14] 0, [C15] 1 (Y upfloated the previous round), [C16] 0.
    // (b) M–X, Y down: [C14] 0, [C15] 0, [C16] 1 (Y downfloated two rounds before).
    // Nothing is perfect; [C15] outranks [C16]: (b), then Y–z. Choosing the floater first and the MDP's opponent after it would
    // take (a), as would no facts at all.
    const field = [row("M", 2, 1), row("Y", 1, 2), row("X", 1, 3), row("z", 0, 4)];
    const facts = [round(played("Y", "x1", 1, 0)), round(played("x2", "Y", 2, 1))];
    let checked = expectBoards(field, { played: new Set() }, pairs(["M", "Y"], ["X", "z"]), "no facts: (a)");
    checked += expectBoards(field, { played: new Set(), rounds: facts }, pairs(["M", "X"], ["Y", "z"]), "C15 over C16");
    expect(checked).toBe(4);
  });

  it("X-SW-32 [C14] counts residents only, so [C15] sends a moved-down player who downfloated the previous round into the Limbo to spare an upfloated resident", () => {
    // A and G (3) have met and both float into {A G | d e f} (on 2), which floats one on to b (1). A has met e and f, G has met
    // e, b has met e and f. A floating resident is cheaper by [C7] (2 against 3), but none can be one: d leaves A without a
    // partner, and e or f would meet b again. So one MDP is in the Limbo, and [C7] ties A and G. A downfloated the previous
    // round, d upfloated it. (i) G in the Limbo: A–d, e–f: [C15] 1. (ii) A in the Limbo: G–d, e–f: [C15] 1; (iii) G–f, d–e:
    // [C15] 0. [C14] counts no one in any of them (A and G are not residents), so [C15] decides: (iii), then A–b, though A
    // double-floats ([C18] after [C15]). Counting A under [C14] would take (i).
    const field = [row("A", 3, 1), row("G", 3, 2), row("d", 2, 3), row("e", 2, 4), row("f", 2, 5), row("b", 1, 6)];
    const met = new Set([pairKey("A", "G"), pairKey("A", "e"), pairKey("A", "f"), pairKey("G", "e"), pairKey("b", "e"), pairKey("b", "f")]);
    const facts = [round(played("A", "x1", 2, 1), played("x2", "d", 1, 0))];
    expect(expectBoards(field, { played: met, rounds: [...meetings(met), ...facts] }, pairs(["G", "f"], ["d", "e"], ["A", "b"]), "C15 over keeping A paired")).toBe(2);
  });

  it("X-SW-32 [C7] outranks the float criteria: a moved-down player never double-floats to spare a resident who downfloated the previous round", () => {
    // Bracket {M | Y X}, both residents downfloated the previous round. Floating M instead would meet [C14] but not [C7] (M's
    // 2 points over a resident's 1), which ranks higher: a resident floats, the bottom one, X.
    const field = [row("M", 2, 1), row("Y", 1, 2), row("X", 1, 3), row("z", 0, 4)];
    const facts = [round(played("Y", "x1", 1, 0), played("X", "x2", 1, 0))];
    expect(expectBoards(field, { played: new Set(), rounds: facts }, pairs(["M", "Y"], ["X", "z"]), "C7 over C14")).toBe(2);
  });
});

// F4. A (3) and B (2) have met; q1 q2 on 1. FIDE: {A} downfloats; {A | B} cannot pair (C1), so both float; bracket {A B | q1 q2}:
// S1 [A B], S2 [q1 q2]: (a) A–q1, B–q2, then the transposition (b) A–q2, B–q1. The score difference of a board with A is 2,
// with B 1.
const F4 = [row("A", 3, 1), row("B", 2, 2), row("q1", 1, 3), row("q2", 1, 4)];
const F4_PLAYED = new Set([pairKey("A", "B")]);
const F4_MET = meetings(F4_PLAYED);
const A_Q1 = pairs(["A", "q1"], ["B", "q2"]); // (a)
const A_Q2 = pairs(["A", "q2"], ["B", "q1"]); // (b)

describe("X-SW-32 the score-difference criteria [C18]–[C21] (C.04.3 Art. 2.4.13–2.4.16)", () => {
  it("X-SW-32 [C19]: the resident who upfloated the previous round meets the MDP nearer its score, whichever of q1 and q2 it is", () => {
    // q2 upfloated: (a) [C15] 1, [C19] [1]; (b) [C15] 1, [C19] [2] → (a). q1 upfloated: (a) [C19] [2]; (b) [C19] [1] → (b).
    let checked = 0;
    checked += expectBoards(F4, { played: F4_PLAYED, rounds: [...F4_MET, round(played("x1", "q2", 2, 1))] }, A_Q1, "q2 upfloated");
    checked += expectBoards(F4, { played: F4_PLAYED, rounds: [...F4_MET, round(played("x1", "q1", 2, 1))] }, A_Q2, "q1 upfloated");
    expect(checked).toBe(4);
  });

  it("X-SW-32 [C21]: the same, two rounds before, and nothing three rounds before", () => {
    const q2Up = round(played("x1", "q2", 2, 1));
    let checked = 0;
    checked += expectBoards(F4, { played: F4_PLAYED, rounds: [...F4_MET, q2Up, QUIET] }, A_Q1, "two rounds before");
    // three rounds before: no criterion reads it, so no criterion separates (a) from (b), and the order the pairer generates
    // its candidates in decides. FIDE's first is (a); the engine's (carried floaters arrive bottom first, so B chooses first)
    // is (b): the deviation X-SW-2 records, read here rather than assumed.
    checked += expectBoards(F4, { played: F4_PLAYED, rounds: [...F4_MET, q2Up, QUIET, QUIET] }, A_Q2, "three rounds before");
    expect(checked).toBe(4);
  });

  it("X-SW-32 [C17] beats [C19]: a count outranks every score difference, so the MDPs avoid a resident who upfloated two rounds before though a nearer opponent waits", () => {
    // A (3) and B (2) have met and float into {A B | u t n1 n2} (all on 1). u has met t, n1 and n2, so u meets an MDP whatever
    // happens; A has met n1 and n2. u upfloated the previous round, t two rounds before. FIDE's MDP-pairings (S1 [A B], S2
    // transposed): (1) A–u B–t, n1–n2: [C15] 1, [C17] 1. (2) A–u B–n1, t–n2: [C15] 1, [C17] 0, [C19] [2]. (3) A–u B–n2, t–n1:
    // as (2). (4) A–t B–u, n1–n2: [C15] 1, [C17] 1, [C19] [1]. A–t with B on n1 or n2 leaves u with a resident it has met.
    // Best by [C17]: (2), the earlier. Weighing the score differences first would take (4), u next to the nearer MDP.
    const field = [row("A", 3, 1), row("B", 2, 2), row("u", 1, 3), row("t", 1, 4), row("n1", 1, 5), row("n2", 1, 6)];
    const met = new Set([pairKey("A", "B"), pairKey("u", "t"), pairKey("u", "n1"), pairKey("u", "n2"), pairKey("A", "n1"), pairKey("A", "n2")]);
    const facts = [round(played("x1", "t", 2, 1)), round(played("x2", "u", 2, 1))];
    expect(expectBoards(field, { played: met, rounds: [...meetings(met), ...facts] }, pairs(["A", "u"], ["B", "n1"], ["t", "n2"]), "C17 over C19")).toBe(2);
  });

  it("X-SW-32 [C18] beats [C19] (Limbo read with the pre-2026 PSD value, controller ruling 2026-11-23): the MDP who downfloated the previous round is paired, though that sends an upfloated resident to the farther MDP", () => {
    // a (3), d and e (2) have all met, so all three float into {a d e | b c} (on 1); b has met e. Two pairs, one MDP in the
    // Limbo ([C6]); [C7] puts d or e there, not a. e downfloated the previous round, b upfloated it. A paired MDP's score
    // difference is its score less 1; one in the Limbo counts its score less 0 (one under the bracket's lowest). MDP sets by
    // smallest differing BSN (Art. 4.4.2): S1 [a d] (e in the Limbo): (i) a–b d–c: [C15] 1, [C18] [2], [C19] [2]; (ii) a–c d–b:
    // [C15] 1, [C18] [2], [C19] [1]. S1 [a e] (d in the Limbo): (iii) a–b e–c: [C15] 1, [C18] [1], [C19] [2]; a–c e–b is a
    // rematch. Best by [C18]: (iii), then d meets f (0) below. [C19] first would take (ii), and so would reading the Limbo
    // literally (e unpaired, [C18] empty), each sending e to f.
    const field = [row("a", 3, 1), row("d", 2, 2), row("e", 2, 3), row("b", 1, 4), row("c", 1, 5), row("f", 0, 6)];
    const met = new Set([pairKey("a", "d"), pairKey("a", "e"), pairKey("d", "e"), pairKey("b", "e")]);
    const facts = [round(played("e", "x1", 1, 0), played("x2", "b", 1, 0))];
    expect(expectBoards(field, { played: met, rounds: [...meetings(met), ...facts] }, pairs(["a", "b"], ["c", "e"], ["d", "f"]), "C18 over C19")).toBe(2);
  });

  // F5. X and Y (2) have met; q (1), z (0). FIDE: {X Y} cannot pair, both float; bracket {X Y | q}: one MDP meets q, the
  // other stays in the Limbo and floats on to z (Art. 3.2.4). The valid MDP sets, by their smallest differing BSN
  // (Art. 4.4.2): (a) X–q with Y in the Limbo, then (b) Y–q with X in the Limbo.
  const F5 = [row("X", 2, 1), row("Y", 2, 2), row("q", 1, 3), row("z", 0, 4)];
  const F5_PLAYED = new Set([pairKey("X", "Y")]);
  const F5_MET = meetings(F5_PLAYED);
  it("X-SW-32 [C18], [C20] (Limbo read with the pre-2026 PSD value, controller ruling 2026-11-23): the MDP who downfloated the previous round, or two rounds before, is the one paired; the other double-floats", () => {
    // A paired MDP's score difference is 2 − 1 = 1; one in the Limbo counts 2 − (1 − 1) = 2. X downfloated: (a) pairs X:
    // [C18] [1]; (b) leaves X in the Limbo: [C18] [2] → (a), X–q and Y–z. Y downfloated: (a) [2]; (b) [1] → (b). Two rounds
    // before, [C20] the same. Three rounds before nothing reads it, and the engine's own order decides: (b), where FIDE's
    // generation order (Art. 4.4.2) would take (a), the deviation X-SW-32 records. The X cases are the ones whose answer differs
    // from that order, so they are what witnesses the criterion.
    const X_Q = pairs(["X", "q"], ["Y", "z"]); // (a)
    const Y_Q = pairs(["Y", "q"], ["X", "z"]); // (b)
    let checked = 0;
    checked += expectBoards(F5, { played: F5_PLAYED, rounds: [...F5_MET, round(played("X", "x1", 2, 1))] }, X_Q, "X, previous round");
    checked += expectBoards(F5, { played: F5_PLAYED, rounds: [...F5_MET, round(played("Y", "x1", 2, 1))] }, Y_Q, "Y, previous round");
    checked += expectBoards(F5, { played: F5_PLAYED, rounds: [...F5_MET, round(played("X", "x1", 2, 1)), QUIET] }, X_Q, "X, two rounds before");
    checked += expectBoards(F5, { played: F5_PLAYED, rounds: [...F5_MET, round(played("X", "x1", 2, 1)), QUIET, QUIET] }, Y_Q, "X, three rounds before: the engine's own order");
    expect(checked).toBe(8);
  });
});

describe("X-SW-32 the pairing-allocated bye is the last bracket's downfloater (C.04.3 Art. 1.9.1)", () => {
  // F6. p1 p2 on 2; q1 q2 q3 on 1 (odd field). FIDE: {p1 p2} pairs; the last bracket {q1 q2 q3} has S1 [q1], S2 [q2 q3]:
  // (a) q1–q2, q3 downfloats, then (b) q1–q3, q2 downfloats, then the exchange (c) q2–q3, q1 downfloats. The downfloater
  // takes the bye.
  const F6 = [row("p1", 2, 1), row("p2", 2, 2), row("q1", 1, 3), row("q2", 1, 4), row("q3", 1, 5)];
  const bye = (r: SwissPairResult): string => (r.ok ? `${boardsOf(r).join(" ")} bye ${r.bye ?? "none"}` : `refused: ${r.reason}`);
  const expectBye = (history: SwissHistory, boards: string[], to: string, label: string): number => {
    let checked = 0;
    for (const chess of [false, true]) {
      expect(bye(pairRound(F6, history, { chess })), `${label}, chess ${chess}`).toBe(`${boards.join(" ")} bye ${to}`);
      checked++;
    }
    return checked;
  };
  const Q3_BYE = pairs(["p1", "p2"], ["q1", "q2"]); // (a)
  const Q2_BYE = pairs(["p1", "p2"], ["q1", "q3"]); // (b)

  it("X-SW-32 [C14] and [C16] steer the bye: one who downfloated the previous round, or two rounds before, does not take it", () => {
    // No float in the window: (a) is perfect, q3. q3 downfloated the previous round: (a) [C14] 1; (b) is perfect, q2. Two rounds
    // before: [C16], the same. Three rounds before: nothing reads it, q3.
    const q3Down = round(played("q3", "x1", 1, 0));
    let checked = expectBye({ played: new Set(), rounds: [QUIET] }, Q3_BYE, "q3", "no float");
    checked += expectBye({ played: new Set(), rounds: [q3Down] }, Q2_BYE, "q2", "q3, previous round");
    checked += expectBye({ played: new Set(), rounds: [q3Down, QUIET] }, Q2_BYE, "q2", "q3, two rounds before");
    checked += expectBye({ played: new Set(), rounds: [q3Down, QUIET, QUIET] }, Q3_BYE, "q3", "q3, three rounds before");
    // The deprecated path is unchanged: without facts the bye stays at the bottom.
    checked += expectBye({ played: new Set() }, Q3_BYE, "q3", "no facts");
    expect(checked).toBe(10);
  });

  it("X-SW-32 [C14] beats [C16] for the bye, and [C7] keeps it on the lowest score whatever floated", () => {
    // q1 had the bye three rounds ago (Art. 1.4.3 a downfloat, outside the window; the P-A4 bar takes it out of the running).
    // q2 downfloated two rounds before, q3 the previous round. (a) q3 down: [C14] 1. (b) q2 down: [C14] 0, [C16] 1 → (b), q2.
    const q1Bye: SwissRoundFacts = { boards: [], bye: "q1" };
    let checked = expectBye(
      { played: new Set(), byes: new Set(["q1"]), rounds: [q1Bye, round(played("q2", "x1", 1, 0)), round(played("q3", "x2", 1, 0))] },
      Q2_BYE,
      "q2",
      "C14 over C16",
    );
    // Every q downfloated the previous round: [C14] is 1 whoever floats, and [C7] still keeps the bye off p1 and p2 (2): (a).
    checked += expectBye(
      { played: new Set(), rounds: [round(played("q1", "x1", 1, 0), played("q2", "x2", 1, 0), played("q3", "x3", 1, 0))] },
      Q3_BYE,
      "q3",
      "every q downfloated",
    );
    expect(checked).toBe(4);
  });
});

describe("X-SW-32 the contract around the facts", () => {
  it("X-SW-32 with round facts the deprecated float count is ignored (one authority): the facts alone decide", () => {
    // The count says p2 and p3 floated before, which alone floats p1 ((c)). The facts say nobody floated in the window.
    const floats = new Map([["p2", 1], ["p3", 1]]);
    let checked = expectBoards(F1, { played: new Set(), floats }, P1_DOWN, "count alone");
    checked += expectBoards(F1, { played: new Set(), floats, rounds: [QUIET] }, P3_DOWN, "count and facts");
    expect(checked).toBe(4);
  });

  it("X-SW-32 a second call with the same facts pairs the same round and leaves the facts as they were", () => {
    const facts = [round(played("p1", "x2", 1, 0)), P3_DOWNFLOATED];
    const before = JSON.stringify(facts);
    const history: SwissHistory = { played: new Set(), rounds: facts };
    const first = pairRound(F1, history, { chess: true });
    expect(pairRound(F1, history, { chess: true })).toEqual(first);
    expect(JSON.stringify(facts)).toBe(before);
    expect(boardsOf(first)).toEqual(P2_DOWN);
  });

  it("X-SW-32 facts that miss a meeting in `played` are refused CONFIG_INVALID, naming the pair (wrong facts cannot pair quietly)", () => {
    const ab = new Set([pairKey("p1", "p2")]);
    const cases: [string, SwissRoundFacts[]][] = [
      ["no round holds it", [QUIET]],
      ["an empty list", []],
      ["only as a forfeit (not a game played, Art. 1.4.2)", [round(unplayed("p1", "p2", 0, 0, "home"))]],
      ["another pair played", [round(played("p1", "p3", 0, 0))]],
    ];
    let refused = 0;
    for (const [label, rounds] of cases) {
      expect(() => pairRound(F1, { played: ab, rounds }), label).toThrowError(
        expect.objectContaining({ code: "CONFIG_INVALID", message: expect.stringContaining("p1|p2") }),
      );
      refused++;
    }
    expect(refused).toBe(4);
    // The positive pair: held as a played board in any round, older than the window included, it pairs; and without facts
    // nothing is checked.
    let paired = 0;
    for (const rounds of [[round(played("p2", "p1", 0, 0))], [round(played("p1", "p2", 0, 0)), QUIET, QUIET]]) {
      expect(pairRound(F1, { played: ab, rounds }).ok).toBe(true);
      paired++;
    }
    expect(pairRound(F1, { played: ab }).ok).toBe(true);
    expect(paired + 1).toBe(3);
  });

  it("X-SW-32 an entrant seated twice in one round's facts is refused CONFIG_INVALID (assumption → guard)", () => {
    const cases: SwissRoundFacts[] = [
      round(played("p1", "x1", 1, 0), played("p1", "x2", 1, 0)), // two boards
      { boards: [played("p1", "x1", 1, 0)], bye: "p1" }, // a board and the bye
      round(played("p1", "p1", 1, 0)), // both sides
    ];
    let checked = 0;
    for (const facts of cases) {
      // anywhere in the list, not only in the two rounds the criteria read
      expect(() => pairRound(F1, { played: new Set(), rounds: [facts, QUIET, QUIET] }), JSON.stringify(facts))
        .toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("X-SW-32 a score that is not a finite number, or a forfeit marker FIDE does not name, is refused CONFIG_INVALID (assumption → guard)", () => {
    const cases: SwissRoundFacts[] = [
      round(played("p1", "x1", Number.NaN, 0)),
      round(played("p1", "x1", 1, Number.POSITIVE_INFINITY)),
      round({ ...played("p1", "x1", 1, 0), forfeit: "both" as unknown as "none" }),
    ];
    let checked = 0;
    for (const facts of cases) {
      expect(() => swissRoundFloats(facts)).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
      expect(() => pairRound(F1, { played: new Set(), rounds: [facts] })).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
      checked++;
    }
    expect(checked).toBe(3);
  });
});

// The deprecated path, pinned: with no round facts the pairer must answer exactly as engine 10.0.4 did. DIGEST and the counts
// were recorded by running this same corpus against src/scheduling/swiss.ts at origin/main b7462f6 (10.0.4), before X-SW-32 was
// written; the corpus generator is its own seeded PRNG, so the inputs never move.
describe("X-SW-32 without round facts the pairer is byte-identical to engine 10.0.4 (the float count path)", () => {
  // FNV-1a, 32 bits: the test hashes its own outputs (src tests import nothing from node:).
  const fnv1a = (text: string, seed: number): number => {
    let h = seed;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  };
  const CASES = 3000;
  const corpusCase = (seed: number): { standings: SwissStanding[]; history: SwissHistory; constraints: SwissConstraints } => {
    const rng = mulberry32(seed);
    const int = (lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
    const n = int(2, 12);
    const ids = Array.from({ length: n }, (_, i) => `e${i}`);
    const standings = ids.map((entrantId) => ({ entrantId, score: int(0, 3), rank: int(1, 2 * n) }));
    const playedPairs = new Set<string>();
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (rng() < 0.2) playedPairs.add(pairKey(ids[i] as string, ids[j] as string));
    const chess = rng() < 0.5;
    const colours = new Map(ids.map((id) => [id, Array.from({ length: int(0, 3) }, (): Colour => (rng() < 0.5 ? "W" : "B"))]));
    const byes = new Set(ids.filter(() => rng() < 0.15));
    const floats = new Map(ids.flatMap((id): [string, number][] => (rng() < 0.4 ? [[id, int(1, 2)]] : [])));
    const constraints: SwissConstraints = {
      chess,
      ...(rng() < 0.3 ? { pairing: "rank_adjacent" as const } : {}),
      ...(rng() < 0.3 ? { lookAhead: true } : {}),
      ...(rng() < 0.2 ? { finalRoundMaxScore: int(1, 4) } : {}),
    };
    return { standings, history: { played: playedPairs, colours, byes, floats }, constraints };
  };
  const answer = (c: ReturnType<typeof corpusCase>, history: SwissHistory): string => {
    try {
      return JSON.stringify(pairRound(c.standings, history, c.constraints));
    } catch (e) {
      return `threw ${(e as { code?: string }).code ?? String(e)}`;
    }
  };

  it("X-SW-32 the 10.0.4 corpus: same digest, same outcome counts, and the float count changed some answers (so the pin reads it)", () => {
    let digest = 0x811c9dc5;
    const t = { cases: 0, paired: 0, refused: 0, threw: 0, floatsMattered: 0, lookAhead: 0, chess: 0 };
    for (let seed = 1; seed <= CASES; seed++) {
      const c = corpusCase(seed);
      const out = answer(c, c.history);
      digest = fnv1a(`${seed}:${out}\n`, digest);
      t.cases++;
      if (out.startsWith('{"ok":true')) t.paired++;
      else if (out.startsWith('{"ok":false')) t.refused++;
      else t.threw++;
      if (out !== answer(c, { ...c.history, floats: new Map() })) t.floatsMattered++;
      if (c.constraints.lookAhead === true) t.lookAhead++;
      if (c.constraints.chess === true) t.chess++;
    }
    expect({ digest: digest.toString(16), ...t }).toEqual({
      digest: "4a0571c1",
      cases: CASES,
      paired: 2894,
      refused: 106,
      threw: 0,
      floatsMattered: 653,
      lookAhead: 849,
      chess: 1476,
    });
  });
});
