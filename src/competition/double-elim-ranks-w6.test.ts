// W6 double elimination: final places by losers'-bracket EXIT ROUND (rows X-FR-6, X-FR-7, X-FR-8; X-FR-3 for the
// one-loss forfeit). Every expected value comes from the W6 rulebook (seazn.club rulebook-W6-double-elim.md §4 RB6-X1,
// X2 and the n = 8 worked table; §7 RB6-F1 to F11; §9 the deciding match; §10 RB6-R1 to R10 and both place tables),
// never from `bracketRanks`' own output.
//
// Numbering: rulebook rounds and games count from 1, engine ids from 0. `WB r.i` is `wb-r{r−1}-i{i−1}` and `LB t.p` is
// `lb-r{t−1}-i{p−1}`. GF1 is `gf`, the reset `gf-reset`. The generator numbers rounds WB 0 … k−1, LB k + L, gf k + 2(k−1),
// gf-reset one after; the app numbers each lane from 0 (LB round = L, gf 0, gf-reset 1; app bracket-rounds.ts:21-24).
//
// The rig: `generateDoubleElim` played out by the testkit's `playOutBracket` under a result script, each row then given
// its generated fixture's feeds and `conditional` — the app's rows. Expected places for a fully played bracket come from
// RB6-R3 applied to the SCRIPT'S OWN RECORD (`placesByR3`: the deciding match's winner 1st and loser 2nd, then each
// entrant 1 + the entrants placed above, by the LB round of the one LB match they lost). The rulebook's place tables
// appear as literal cross-checks of that formula. Hand-derived places for walkovers carry their derivation.
//
// Withdrawal vs forfeit (RB6-F1, F4): `withdraw` writes `walkedOver: "loser"` (out of the stage there); `oneLossForfeit`
// writes a walkover with a winner and a loser and no `walkedOver` (one loss: the forfeiter drops).
import { describe, expect, it } from "vitest";
import { generateDoubleElim, type GeneratedBracket } from "../scheduling/bracket.ts";
import { playOutBracket, type PlayOutOptions } from "../testkit/bracket-play.ts";
import {
  bracketRanks,
  bracketTitle,
  completeBracketStage,
  resetOwed,
  type BracketFixture,
  type BracketStage,
  type FinalPlace,
} from "./stage.ts";

type Winner = (home: string, away: string) => string;
const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `E${i + 1}`);
const seedsOf = (list: readonly string[]): Map<string, number> => new Map(list.map((id, i) => [id, i + 1]));
const seedNo = (id: string): number => Number(id.slice(1));
const favourite: Winner = (home, away) => (seedNo(away) < seedNo(home) ? away : home);
const underdog: Winner = (home, away) => (seedNo(away) > seedNo(home) ? away : home);
/** A seeded coin: the same salt plays the same results, in the generator's order. */
function coins(salt: number): Winner {
  let state = (salt * 2654435761) >>> 0;
  return (home, away) => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return (state >>> 16) & 1 ? home : away;
  };
}
/** E1 and E2 meet in the WB final, GF1 and the reset: `script[i]` wins their (i + 1)-th meeting; favourite elsewhere. */
function meetings(...script: string[]): Winner {
  let met = 0;
  return (home, away) => ([home, away].sort().join() === "E1,E2" ? (script[met++] ?? "E1") : favourite(home, away));
}

/** Each row with its generated fixture's feeds and `conditional`, as the app's rows carry them. */
function asAppRows(gen: GeneratedBracket, rows: readonly BracketFixture[]): BracketFixture[] {
  const byId = new Map(gen.fixtures.map((f) => [f.id, f]));
  return rows.map((row) => {
    const g = byId.get(row.id);
    return {
      ...row,
      ...(g?.homeFrom === undefined ? {} : { homeFrom: g.homeFrom }),
      ...(g?.awayFrom === undefined ? {} : { awayFrom: g.awayFrom }),
      ...(g?.conditional === true ? { conditional: true } : {}),
    };
  });
}

interface Played {
  stage: BracketStage;
  rows: BracketFixture[];
}
function play(n: number, opts: PlayOutOptions & { reset?: boolean; extra?: readonly string[] } = {}): Played {
  const { reset = false, extra = [], ...script } = opts;
  const entrants = ids(n);
  const declared = [...entrants, ...extra];
  const gen = generateDoubleElim({ entrants, seeds: seedsOf(entrants), bracketReset: reset });
  const rows = asAppRows(gen, playOutBracket(gen, { winner: favourite, ...script }));
  return { stage: { id: "de", kind: "double_elim", entrants: declared, seeds: seedsOf(declared) }, rows };
}

const rowIn = (rows: readonly BracketFixture[], id: string): BracketFixture => {
  const row = rows.find((r) => r.id === id);
  if (row === undefined) throw new Error(`no row ${id}`);
  return row;
};
const replacing = (rows: readonly BracketFixture[], id: string, swap: (row: BracketFixture) => BracketFixture): BracketFixture[] =>
  rows.map((row) => (row.id === id ? swap(row) : row));
const rankOf = (set: readonly FinalPlace[]): Record<string, number> => Object.fromEntries(set.map((p) => [p.entrantId, p.rank]));
const ranked = (...pairs: readonly (readonly [string, number])[]): FinalPlace[] => pairs.map(([entrantId, rank]) => ({ entrantId, rank }));
/** Places by seed: the i-th rank belongs to E(i+1). */
const bySeed = (...ranks: number[]): FinalPlace[] => ranks.map((rank, i) => ({ entrantId: `E${i + 1}`, rank }));

/** RB6-R2, R3, R4 over a FULLY PLAYED bracket's own record: the deciding match (the reset once played, else GF1) gives
 *  1st and 2nd; every other entrant lost exactly one LB match, and ranks 1 + 2 + (entrants whose LB loss is in a later
 *  LB round). Throws when the record is not that shape: the oracle refuses rather than guessing. */
function placesByR3(rows: readonly BracketFixture[], n: number): Record<string, number> {
  const reset = rows.find((r) => r.id === "gf-reset");
  const deciding = reset?.status === "decided" ? reset : rowIn(rows, "gf");
  if (deciding.status !== "decided" || deciding.winner === undefined || deciding.loser === undefined) throw new Error("placesByR3: no decided deciding match");
  const lbExit = new Map<string, number>();
  for (const row of rows) {
    if (row.bracket !== "LB" || row.loser === undefined) continue;
    if (lbExit.has(row.loser)) throw new Error(`placesByR3: ${row.loser} lost two LB matches`);
    lbExit.set(row.loser, row.round);
  }
  const want: Record<string, number> = { [deciding.winner]: 1, [deciding.loser]: 2 };
  for (const [id, round] of lbExit) want[id] = 3 + [...lbExit.values()].filter((other) => other > round).length;
  if (Object.keys(want).length !== n) throw new Error(`placesByR3: ${Object.keys(want).length} of ${n} entrants placed`);
  return want;
}

describe("double elimination places by losers'-bracket exit round (W6 X-FR-6, X-FR-7)", () => {
  // single-sport: double-elimination structure and ranks are sport-agnostic (reads no SportModule)
  it("X-FR-7 a field of 2: 1st and 2nd, nobody shares", () => {
    // RB6-E3, RB6-R2: no LB match; the deciding match's winner and loser. With the reset played (E2, the LB champion,
    // wins GF1 and the reset; RB6-R4) the reset decides.
    let checked = 0;
    for (const reset of [false, true]) {
      const { stage, rows } = play(2, { reset });
      expect(bracketRanks(stage, rows), `reset ${reset}`).toEqual(bySeed(1, 2));
      checked++;
    }
    const { stage, rows } = play(2, { reset: true, winner: meetings("E1", "E2", "E2") });
    expect(rowIn(rows, "gf-reset").winner, "premise: the reset was played and E2 won it").toBe("E2");
    expect(bracketRanks(stage, rows)).toEqual(ranked(["E2", 1], ["E1", 2]));
    checked++;
    expect(checked).toBe(3);
  });

  it("X-FR-6 a field of 3: 1st, 2nd, 3rd, nobody 4th", () => {
    // RB6-E4: E1 has the WB round-1 bye, the loser of E2 v E3 advances from LB 1.1 by bye and loses the LB final to the
    // WB final's loser. Places 1st, 2nd, 3rd; nobody is 4th.
    const { stage, rows } = play(3);
    expect(bracketRanks(stage, rows)).toEqual(bySeed(1, 2, 3));
    expect(bracketRanks(stage, rows).some((p) => p.rank === 4), "nobody 4th").toBe(false);
  });

  it("X-FR-7 n = 8, every match played: the two LB round-2 losers are 5= and the two LB round-1 losers 7=", () => {
    // RB6 place table n=8: 3rd the loser of LB 4.1, 4th of LB 3.1, 5= the 2 losers of LB round 2, 7= the 2 of LB round 1.
    // On the chalk draw (RB6-X2 worked table, n=8): LB 1 puts out E8 and E7, LB 2 E5 and E6, LB 3 E4, the LB final E3.
    // differential: today 1 … 8, strict by seed (stage.ts rankRest / placeNext).
    const { stage, rows } = play(8);
    const want = bySeed(1, 2, 3, 4, 5, 5, 7, 7);
    expect(rankOf(want)).toEqual(placesByR3(rows, 8));
    expect(bracketRanks(stage, rows)).toEqual(want);
    // A second call gives the same places; the completed stage carries them.
    expect(bracketRanks(stage, rows)).toEqual(want);
    expect(completeBracketStage(stage, rows).finalRanks).toEqual(want);
  });

  it("X-FR-7 n = 16: 1, 2, 3, 4, 5, 5, 7, 7, 9 ×4, 13 ×4", () => {
    // RB6 place table n=16: 3rd LB 6.1, 4th LB 5.1, 5= LB round 4, 7= LB round 3, 9= the 4 losers of LB round 2, 13= the
    // 4 of LB round 1. Chalk (RB6-X2 worked table, n=16): LB 1 out 16, 13, 14, 15; LB 2 out 9, 12, 11, 10; LB 3 out 7, 8;
    // LB 4 out 6, 5.
    const { stage, rows } = play(16);
    const want = bySeed(1, 2, 3, 4, 5, 5, 7, 7, 9, 9, 9, 9, 13, 13, 13, 13);
    expect(rankOf(want)).toEqual(placesByR3(rows, 16));
    expect(bracketRanks(stage, rows)).toEqual(want);
  });

  it("X-FR-7 odd fields: n = 7 one 7th, n = 6 nobody 7th, n = 5 one 5th", () => {
    // Odd-fields table, RB6-R5 (frame of 8, byes to the top seeds): a round with one real loser gives an unshared place;
    // a round with no match gives no place. n = 4 cannot tell right from wrong: every LB round has one loser.
    const cases: [number, number[]][] = [
      [7, [1, 2, 3, 4, 5, 5, 7]],
      [6, [1, 2, 3, 4, 5, 5]],
      [5, [1, 2, 3, 4, 5]],
    ];
    let checked = 0;
    for (const [n, ranks] of cases) {
      const { stage, rows } = play(n);
      expect(rankOf(bySeed(...ranks)), `n=${n} table = formula`).toEqual(placesByR3(rows, n));
      expect(bracketRanks(stage, rows), `n=${n}`).toEqual(bySeed(...ranks));
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("X-FR-7 seed does not order a shared place: seeds 1 and 7, both out in LB round 1, both rank 7", () => {
    // E1 loses every match: wb-r0-i0 to E8, then lb-r0-i0 to E5 (RB6-X1: LB 1.1 takes the losers of WB 1.1 and 1.2).
    // E7 loses wb-r0-i3 to E2, then lb-r0-i1 to E6 (LB 1.2: the losers of WB 1.3 and 1.4). RB6-R3: both share 7th.
    // E1 and E8 cannot both be there: they meet in WB 1.1. LB 2 puts out E5 (to E3) and E8 (to E6): not seed-adjacent,
    // both 5th.
    // differential: today seed 1 ranks 7th and seed 7 8th.
    const e1Loses: Winner = (home, away) => (home === "E1" ? away : away === "E1" ? home : favourite(home, away));
    const { stage, rows } = play(8, { winner: e1Loses });
    expect([rowIn(rows, "lb-r0-i0").loser, rowIn(rows, "lb-r0-i1").loser], "premise: LB round 1's losers").toEqual(["E1", "E7"]);
    const want = ranked(["E2", 1], ["E3", 2], ["E4", 3], ["E6", 4], ["E5", 5], ["E8", 5], ["E1", 7], ["E7", 7]);
    expect(rankOf(want)).toEqual(placesByR3(rows, 8));
    expect(bracketRanks(stage, rows)).toEqual(want);
  });

  it("X-FR-6 the top four are single and the reset changes only 1st and 2nd", () => {
    // RB6-R2: 3rd the loser of lb-r3-i0 (LB 4.1, the LB final), 4th the loser of lb-r2-i0 (LB 3.1). RB6-R4: reset off,
    // or on and not earned → GF1's winner and loser; reset played → the reset's. Every other place is the same.
    const variants: [string, Played, [string, string]][] = [
      ["reset off, E2 (the LB champion) wins GF1", play(8, { winner: meetings("E1", "E2") }), ["E2", "E1"]],
      ["reset on, not earned (E1 wins GF1)", play(8, { reset: true }), ["E1", "E2"]],
      ["reset on and played, E2 wins both", play(8, { reset: true, winner: meetings("E1", "E2", "E2") }), ["E2", "E1"]],
    ];
    const below = ranked(["E3", 3], ["E4", 4], ["E5", 5], ["E6", 5], ["E7", 7], ["E8", 7]);
    let checked = 0;
    for (const [what, { stage, rows }, [first, second]] of variants) {
      expect([rowIn(rows, "lb-r3-i0").loser, rowIn(rows, "lb-r2-i0").loser], `${what}: premise`).toEqual(["E3", "E4"]);
      const got = bracketRanks(stage, rows);
      expect(got, what).toEqual([...ranked([first, 1], [second, 2]), ...below]);
      expect(rankOf(got), what).toEqual(placesByR3(rows, 8));
      checked++;
    }
    expect(checked, "variants").toBe(3);
  });

  it("X-FR-7 the sweep: n = 2 … 32 × {favourite, underdog, 4 seeded coins} × reset {off, on}, each rank by RB6-R3", () => {
    // RB6-R9: a full-order oracle on every field size, odd fields included, reset off and on; it counts what it ranked.
    let runs = 0;
    let entrantsRanked = 0;
    let sharedSeen = 0;
    for (let n = 2; n <= 32; n++) {
      const scripts: [string, () => Winner][] = [
        ["favourite", () => favourite],
        ["underdog", () => underdog],
        ...[1, 2, 3, 4].map((salt): [string, () => Winner] => [`coins ${salt}`, () => coins(salt * 100 + n)]),
      ];
      for (const [name, winner] of scripts) {
        for (const reset of [false, true]) {
          const what = `n=${n} ${name} reset ${reset}`;
          const { stage, rows } = play(n, { reset, winner: winner() });
          const got = bracketRanks(stage, rows);
          expect(got.map((p) => p.entrantId).sort(), `${what}: every entrant once`).toEqual(ids(n).sort());
          expect(got.filter((p) => p.rank === 1), `${what}: one 1st`).toHaveLength(1);
          expect(rankOf(got), what).toEqual(placesByR3(rows, n));
          if (new Set(got.map((p) => p.rank)).size < n) sharedSeen++;
          entrantsRanked += got.length;
          runs++;
        }
      }
    }
    expect(runs, "runs: 31 sizes × 6 scripts × 2").toBe(372);
    expect(entrantsRanked, "Σ n (2 … 32) × 12 = 527 × 12").toBe(6324);
    // Anti-vacuity: the sweep reaches shared places (every n ≥ 6 shares at least 5th).
    expect(sharedSeen).toBeGreaterThan(0);
  });
});

describe("double elimination places after a forfeit, a withdrawal or a walkover (W6 X-FR-3, X-FR-8)", () => {
  // single-sport: double-elimination structure and ranks are sport-agnostic (reads no SportModule)
  // E8 beats E5 in LB 1.1, otherwise to seed: the forfeiter then plays on in the LB.
  const e8OverE5: Winner = (home, away) => ([home, away].sort().join() === "E5,E8" ? "E8" : favourite(home, away));

  it("X-FR-3 a one-loss forfeit is a plain loss: ranked by the second loss; a withdrawal in the same slot is out there", () => {
    // RB6-F1, R6: E8 forfeits wb-r0-i0 (a walkover, a winner and a loser, no walkedOver), drops to lb-r0-i0, beats E5
    // there and loses lb-r1-i0 (LB 2.1, to E3, the loser of WB 2.2): out in LB round 2 with E6 (lost LB 2.2 to E4) → 5=.
    // RB6-F4, R7: the same slot as a withdrawal (walkedOver "loser") puts E8 out there, at the LB round of the seat it
    // vacates (LB 1.1, RB6-X1): 7= with E7 (lost LB 1.2); E5 walks over LB 1.1, loses LB 2.1 → 5= with E6.
    const forfeit = play(8, { winner: e8OverE5, oneLossForfeit: new Map([["wb-r0-i0", "E8"]]) });
    expect(rowIn(forfeit.rows, "wb-r0-i0")).toMatchObject({ status: "walkover", winner: "E1", loser: "E8" });
    expect(rowIn(forfeit.rows, "wb-r0-i0").walkedOver).toBeUndefined();
    expect(rowIn(forfeit.rows, "lb-r1-i0").loser, "premise: E8 played on and lost LB 2.1").toBe("E8");
    expect(bracketRanks(forfeit.stage, forfeit.rows)).toEqual(ranked(["E1", 1], ["E2", 2], ["E3", 3], ["E4", 4], ["E6", 5], ["E8", 5], ["E5", 7], ["E7", 7]));

    const withdrawn = play(8, { winner: e8OverE5, withdraw: new Map([["wb-r0-i0", "E8"]]) });
    expect(rowIn(withdrawn.rows, "wb-r0-i0")).toMatchObject({ status: "walkover", winner: "E1", loser: "E8", walkedOver: "loser" });
    expect(bracketRanks(withdrawn.stage, withdrawn.rows)).toEqual(bySeed(1, 2, 3, 4, 5, 5, 7, 7));
    // They differ: E8 5th by forfeit, 7th by withdrawal.
    expect([rankOf(bracketRanks(forfeit.stage, forfeit.rows)).E8, rankOf(bracketRanks(withdrawn.stage, withdrawn.rows)).E8]).toEqual([5, 7]);
  });

  /** X-FR-8 (b): E3 withdraws at wb-r1-i1 (WB 2.2, v E2); its loser feeds lb-r1-i0 (LB 2.1, RB6-X2 c=0 reversed). */
  const wbWithdrawal = (): Played => play(8, { withdraw: new Map([["wb-r1-i1", "E3"]]) });
  /** X-FR-8 (c): the same entrant, gone before the WB 2.2 opponent arrived: their seat empty, the row an awarded walkover. */
  const wbDeadSeat = (): Played => {
    const { stage, rows } = wbWithdrawal();
    const done = replacing(rows, "wb-r1-i1", (row) => {
      const { home, away, loser: _l, walkedOver: _o, ...rest } = row;
      return { ...rest, ...(home === "E3" ? {} : { home }), ...(away === "E3" ? {} : { away }) };
    });
    return { stage, rows: done };
  };
  // X-FR-8 (b) and (c): E3 at LB round 2 with E6 (lost LB 2.2 to E4) → 5=; E5 walks over LB 2.1, loses LB 3.1 → 4th; E4
  // loses the LB final to E2 → 3rd.
  const WB_WITHDRAWAL = ranked(["E1", 1], ["E2", 2], ["E4", 3], ["E5", 4], ["E3", 5], ["E6", 5], ["E7", 7], ["E8", 7]);
  /** X-FR-8 (d): E1 withdraws at GF1: E2 walks over it and is champion; E1 is its loser. */
  const gfWithdrawal = (): Played => play(8, { withdraw: new Map([["gf", "E1"]]) });
  const GF_WITHDRAWAL = ranked(["E2", 1], ["E1", 2], ["E3", 3], ["E4", 4], ["E5", 5], ["E6", 5], ["E7", 7], ["E8", 7]);

  it("X-FR-8 a withdrawn entrant takes the place of the LB round of the seat they vacate", () => {
    // RB6-R7, all n = 8 to seed otherwise.
    // (a) E5 withdraws in lb-r0-i0 (LB 1.1, v E8): out in LB round 1 with E7 (lost LB 1.2) → 7=. E8 walks over, loses
    // LB 2.1 to E3 → 5= with E6.
    const a = play(8, { withdraw: new Map([["lb-r0-i0", "E5"]]) });
    expect(bracketRanks(a.stage, a.rows)).toEqual(ranked(["E1", 1], ["E2", 2], ["E3", 3], ["E4", 4], ["E6", 5], ["E8", 5], ["E5", 7], ["E7", 7]));
    // (b) differential: today E3 is out at the WB round-1 fixture's own round, below every LB loser: 8th.
    const b = wbWithdrawal();
    expect(rowIn(b.rows, "lb-r1-i0"), "premise: LB 2.1 is a walkover nobody loses").toMatchObject({ status: "walkover", winner: "E5" });
    expect(rowIn(b.rows, "lb-r1-i0").loser).toBeUndefined();
    expect(rowIn(b.rows, "lb-r1-i0").awayFrom).toEqual({ fixtureId: "wb-r1-i1", side: "loser" });
    expect(bracketRanks(b.stage, b.rows)).toEqual(WB_WITHDRAWAL);
    // (c) through the dead seat: the walkover names no loser on the raw row; the seat's feed names E3.
    const c = wbDeadSeat();
    expect(rowIn(c.rows, "wb-r1-i1").loser, "premise: no loser on the raw row").toBeUndefined();
    expect([rowIn(c.rows, "wb-r1-i1").home, rowIn(c.rows, "wb-r1-i1").away]).not.toContain("E3");
    expect(bracketRanks(c.stage, c.rows)).toEqual(WB_WITHDRAWAL);
    // (d) a finalist out at the deciding match is its loser: 2nd (RB6-C2).
    const d = gfWithdrawal();
    expect(bracketRanks(d.stage, d.rows)).toEqual(GF_WITHDRAWAL);
  });

  it("X-FR-7 the app's per-lane rounds rank the same as the generator's", () => {
    // Review Focus 1. The app numbers each lane from 0 (LB round = L, gf 0, gf-reset 1), so a raw round never compares
    // across lanes. A fully played bracket cannot see this (every exit is an LB loss): each case has a WB-side exit
    // competing with LB exits.
    const perLane = (rows: readonly BracketFixture[]): BracketFixture[] => {
      const k = 1 + Math.max(...rows.filter((r) => r.bracket === "WB").map((r) => r.round));
      const gf0 = Math.min(...rows.filter((r) => r.bracket === "GF").map((r) => r.round));
      return rows.map((r) => (r.bracket === "LB" ? { ...r, round: r.round - k } : r.bracket === "GF" ? { ...r, round: r.round - gf0 } : r));
    };
    const cases: [string, () => Played, FinalPlace[]][] = [
      // RB6-R7: E2 withdraws at the WB final; it vacates the LB final's seat, the latest LB round: 1 + champion + runner-up
      // = 3rd, alone. E3 walks over the LB final and loses GF1.
      ["a WB-final withdrawal", () => play(8, { withdraw: new Map([["wb-r2-i0", "E2"]]) }),
        ranked(["E1", 1], ["E3", 2], ["E2", 3], ["E4", 4], ["E5", 5], ["E6", 5], ["E7", 7], ["E8", 7])],
      // RB6-R10 (n=8, a double walkover in the WB final): both out, both vacate the LB final's seat; the LB final and GF1
      // are walkovers nobody loses: E3 (the LB champion) 1st, E1 and E2 2=, nobody 3rd, E4 (lost LB 3.1) 4th.
      ["a WB-final double walkover", () => play(8, { doubleWalkover: new Set(["wb-r2-i0"]) }),
        ranked(["E3", 1], ["E1", 2], ["E2", 2], ["E4", 4], ["E5", 5], ["E6", 5], ["E7", 7], ["E8", 7])],
      ["X-FR-8 (c), the dead seat", wbDeadSeat, WB_WITHDRAWAL],
      ["X-FR-8 (d), the GF1 withdrawal", gfWithdrawal, GF_WITHDRAWAL],
    ];
    let checked = 0;
    for (const [what, build, want] of cases) {
      const { stage, rows } = build();
      const lanes = perLane(rows);
      // Premise: in the app's numbering the LB opens at round 0, below the WB final's round 2.
      expect(rowIn(lanes, "lb-r0-i0").round, what).toBeLessThan(rowIn(lanes, "wb-r2-i0").round);
      for (const [numbering, fixtures] of [["generator", rows], ["per-lane", lanes]] as const) {
        expect(bracketRanks(stage, fixtures), `${what}, ${numbering} rounds`).toEqual(want);
        checked++;
      }
    }
    expect(checked, "4 cases × 2 numberings").toBe(8);
  });

  it("X-FR-7 a double walkover: everyone out in that round shares its place by the same formula", () => {
    // RB6-F5, F7, R10 (ruling 306(c)), n = 8 to seed otherwise. Each place is 1 + the entrants placed above.
    const cases: [string, Played, FinalPlace[]][] = [
      // LB final (lb-r3-i0, E3 v E2) both walked over: nobody is LB champion, E1 walks over GF1; E2 and E3 went out last
      // → 2=, nobody 3rd; E4 (LB 3.1) 4th.
      ["the LB final", play(8, { doubleWalkover: new Set(["lb-r3-i0"]) }),
        ranked(["E1", 1], ["E2", 2], ["E3", 2], ["E4", 4], ["E5", 5], ["E6", 5], ["E7", 7], ["E8", 7])],
      ["the LB final, reset on", play(8, { reset: true, doubleWalkover: new Set(["lb-r3-i0"]) }),
        ranked(["E1", 1], ["E2", 2], ["E3", 2], ["E4", 4], ["E5", 5], ["E6", 5], ["E7", 7], ["E8", 7])],
      // LB 2.1 (lb-r1-i0, E5 v E3) both walked over: out in LB round 2 with E6 (lost LB 2.2); LB 3.1 is a walkover
      // nobody loses → three at 4=, nobody 5th or 6th; E4 loses the LB final → 3rd.
      ["LB 2.1", play(8, { doubleWalkover: new Set(["lb-r1-i0"]) }),
        ranked(["E1", 1], ["E2", 2], ["E4", 3], ["E3", 4], ["E5", 4], ["E6", 4], ["E7", 7], ["E8", 7])],
      // WB 2.1 (wb-r1-i0, E1 v E4) both walked over: both vacate LB 2.2's seat (RB6-X2 c=0), out in LB round 2 with E5
      // (lost LB 2.1); the WB final and the LB final are walkovers nobody loses; E6 (lost LB 3.1) 3rd; the three 4=.
      ["WB 2.1", play(8, { doubleWalkover: new Set(["wb-r1-i0"]) }),
        ranked(["E2", 1], ["E3", 2], ["E6", 3], ["E1", 4], ["E4", 4], ["E5", 4], ["E7", 7], ["E8", 7])],
    ];
    let checked = 0;
    for (const [what, { stage, rows }, want] of cases) {
      expect(bracketRanks(stage, rows), what).toEqual(want);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("X-FR-8 an entrant in no fixture, or whose line was voided, shares the last place", () => {
    // Plan's call: neither lost a match nor was walked over, so neither has an exit round — below every LB round, shared.
    // wb-r0-i0 (E1 v E8) is voided: E4 walks over WB 2.1, E5 over LB 1.1. Then LB 1.2 puts out E7 (6th alone), LB 2.1 E5
    // (5th alone), LB 3.1 E6 (4th), the LB final E4 (3rd); GF1 E2 over E3. E9 is declared and in no fixture.
    // differential: today E1 7th, E8 8th, E9 9th, by seed.
    const { stage, rows } = play(8, { voided: new Set(["wb-r0-i0"]), extra: ["E9"] });
    expect(bracketRanks(stage, rows)).toEqual(ranked(["E2", 1], ["E3", 2], ["E4", 3], ["E6", 4], ["E5", 5], ["E7", 6], ["E1", 7], ["E8", 7], ["E9", 7]));
  });
});

describe("double elimination places while the reset is owed (W6 X-FR-6; RB6-G7, §9)", () => {
  // single-sport: double-elimination structure and ranks are sport-agnostic (reads no SportModule)
  // §9: "the deciding match is GF1 while no reset is owed, and the reset once the LB champion has won GF1". E2 (the LB
  // champion) wins GF1 over E1, so the reset is owed (`resetOwed`, the one reading) and nobody is champion until it is
  // decided: both finalists are still in the stage with one loss each, ranked as entrants in play (B3-3: fewest losses,
  // then seed) above everyone out. 3rd … 8th are already final (RB6-R4).
  const owedRows = (): Played => play(8, { reset: true, winner: meetings("E1", "E2"), voided: new Set(["gf-reset"]) });
  const BELOW = ranked(["E3", 3], ["E4", 4], ["E5", 5], ["E6", 5], ["E7", 7], ["E8", 7]);

  it("X-FR-6 owed and void, owed and scheduled: no title and GF1's winner is not ranked as champion", () => {
    // differential: today the owed-and-void read ranks GF1's winner E2 1st while bracketTitle answers undefined.
    const { stage, rows } = owedRows();
    expect(resetOwed(rows), "premise: owed").toBe(true);
    expect([rowIn(rows, "gf-reset").status, rowIn(rows, "gf").winner]).toEqual(["void", "E2"]);
    expect(bracketTitle(rows)).toBeUndefined();
    const inPlay = [...ranked(["E1", 1], ["E2", 2]), ...BELOW];
    expect(bracketRanks(stage, rows)).toEqual(inPlay);
    // The same with the void reset row unseated: the answer is read from GF1 through `resetOwed`, not from the seats.
    const unseated = replacing(rows, "gf-reset", ({ home: _h, away: _a, ...rest }) => rest);
    expect(resetOwed(unseated)).toBe(true);
    expect(bracketRanks(stage, unseated)).toEqual(inPlay);
    // Owed and still to play: the same provisional places.
    const scheduled = replacing(rows, "gf-reset", (row) => ({ ...row, status: "scheduled" }));
    expect(bracketTitle(scheduled)).toBeUndefined();
    expect(bracketRanks(stage, scheduled)).toEqual(inPlay);
    expect(bracketRanks(stage, scheduled), "a second call").toEqual(inPlay);
  });

  it("X-FR-6 reset played, and reset not owed: the deciding match's winner 1st", () => {
    // Played: E2 wins the reset too (RB6-G4) → champion. Not owed: E1 wins GF1, the reset does not exist (RB6-G6).
    const played = play(8, { reset: true, winner: meetings("E1", "E2", "E2") });
    expect(bracketTitle(played.rows)).toEqual({ kind: "champion", champion: "E2" });
    expect(bracketRanks(played.stage, played.rows)).toEqual([...ranked(["E2", 1], ["E1", 2]), ...BELOW]);
    const notOwed = play(8, { reset: true });
    expect(resetOwed(notOwed.rows)).toBe(false);
    expect(bracketTitle(notOwed.rows)).toEqual({ kind: "champion", champion: "E1" });
    expect(bracketRanks(notOwed.stage, notOwed.rows)).toEqual([...ranked(["E1", 1], ["E2", 2]), ...BELOW]);
  });
});
