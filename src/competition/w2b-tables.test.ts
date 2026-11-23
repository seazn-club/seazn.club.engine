// W2b Task 6 (spec §5.3, engine half; Appendix A X-DW-4, X-DW-2, X-DE-1, TN-WO-1, CK-WO-1; plan D14). What the
// competition layer does with W2b's two new results: a double walkover in a table and in a bracket, and a withdrawn
// loser in double elimination (W6: a forfeit there is one loss, RB6-F1). Every expectation is the rulebook row written
// out here — the table rows are folded from each sport's OWN `standingsDelta` (real producer) and read back through the
// engine's own readers (`RATIO_LEDGERS`, `derivedMetricText`, `rankStandings`), never through the function under test.
import { describe, expect, it } from "vitest";
import { foldMatchWithStoppage, outcomeOf, playRecorded } from "../core/events.ts";
import type { EntrantId, LineupPair, MatchOutcome } from "../core/types.ts";
import type { AnySportModule } from "../sport/module.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { buildStream, lineupFromCatalog, makeEnvelope } from "../testkit/helpers.ts";
import { builtinModules } from "../sports/index.ts";
import { derivedMetricText, RATIO_LEDGERS } from "./display.ts";
import { decidedInFor } from "./decided-in.ts";
import { legacyPointsRule, payout } from "./points.ts";
import type { BracketSlotRef } from "../scheduling/bracket.ts";
import { bracketRanks, type BracketFixture, type BracketStage, type FinalPlace } from "./stage.ts";
import { foldResults, resultsAmong, type FixtureResult, type StandingsRow } from "./standings.ts";
import { ledgerOf, rankStandings } from "./tiebreakers.ts";

const X = "X";
const Y = "Y";
const Z = "Z";

const mod = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no module ${key}`);
  return m;
};
const firstCfg = (m: AnySportModule): unknown => {
  const first = declaredCfgs(m as never)[0];
  if (first === undefined) throw new Error(`${m.key}: no declared cfg`);
  return first.cfg;
};
const lineups = (m: AnySportModule, home: EntrantId, away: EntrantId): LineupPair => ({
  home: lineupFromCatalog(m.positions, home),
  away: lineupFromCatalog(m.positions, away),
});

/** `played`: W2b's `playRecorded` of the ledger the fold read (W2c Task 9: `payout` takes it). */
interface Folded { outcome: MatchOutcome; pair: FixtureResult; played: boolean }

/** Fold `events` (a list of {type, payload}) for home v away and return the real outcome + the module's delta pair. */
function fold(m: AnySportModule, cfg: unknown, home: EntrantId, away: EntrantId, events: { type: string; payload: unknown }[]): Folded {
  const l = lineups(m, home, away);
  const envelopes = events.map((e, i) => makeEnvelope(i + 1, e as never));
  const f = foldMatchWithStoppage(m as never, cfg as never, l, envelopes);
  const outcome = outcomeOf(m as never, f as never);
  if (outcome === null) throw new Error(`${m.key}: the stream decided nothing`);
  return { outcome, pair: m.standingsDelta(outcome, cfg, { kind: "league" }, f.state), played: playRecorded(envelopes, m) };
}

/** A PLAYED, decided match from the module's own generator: no forfeit or abandon recorded, a win/draw/tie result.
 *  `wantWinner` narrows to a win by that side. Scans seeds; refuses rather than returning nothing. */
function played(m: AnySportModule, cfg: unknown, home: EntrantId, away: EntrantId, salt: number, wantWinner?: EntrantId): Folded {
  const l = lineups(m, home, away);
  for (let seed = 1 + salt * 1000; seed <= 400 + salt * 1000; seed++) {
    const events = buildStream(m as never, cfg as never, l, seed, 800);
    if (events.some((e) => e.type === "core.forfeit" || e.type === "core.abandon")) continue;
    const f = foldMatchWithStoppage(m as never, cfg as never, l, events);
    const outcome = outcomeOf(m as never, f as never);
    if (outcome === null || !(outcome.kind === "win" || outcome.kind === "draw" || outcome.kind === "tie")) continue;
    if (wantWinner !== undefined && !(outcome.kind === "win" && outcome.winner === wantWinner)) continue;
    return { outcome, pair: m.standingsDelta(outcome, cfg, { kind: "league" }, f.state), played: playRecorded(events, m) };
  }
  throw new Error(`${m.key}: no played ${wantWinner ? `win for ${wantWinner}` : "result"} in 400 seeds`);
}

const DOUBLE_WALKOVER = [{ type: "core.forfeit", payload: { by: "both", reason: "walkover" } }];
const walkoverBy = (offender: EntrantId) => [{ type: "core.forfeit", payload: { by: offender, reason: "walkover" } }];

const rowOf = (rows: readonly StandingsRow[], id: EntrantId): StandingsRow => {
  const row = rows.find((r) => r.entrantId === id);
  if (row === undefined) throw new Error(`no row ${id}`);
  return row;
};
/** Every ratio a table reads: the four RATIO_LEDGERS pairs and NRR (display.ts DERIVED_METRICS / tiebreakers.ts). */
const RATIOS = [...(Object.keys(RATIO_LEDGERS) as (keyof typeof RATIO_LEDGERS)[]), "nrr"] as const;
const NRR_LEDGERS = ["runs_for", "balls_faced_eff", "runs_against", "balls_bowled_eff"] as const;
const ledgersOf = (key: (typeof RATIOS)[number]): readonly string[] => (key === "nrr" ? NRR_LEDGERS : RATIO_LEDGERS[key]);

/** One ratio of one row compared across two tables, through the engine's own readers: the printed text
 *  (`derivedMetricText`) and every integer ledger the cascade's comparator cross-multiplies (`ledgerOf`). */
function ratioMoved(before: StandingsRow, after: StandingsRow, key: (typeof RATIOS)[number]): string | null {
  const text = [derivedMetricText(before, key), derivedMetricText(after, key)];
  if (text[0] !== text[1]) return `${key} text ${text[0]} -> ${text[1]}`;
  for (const ledger of ledgersOf(key)) {
    const pair = [ledgerOf(before, [ledger]), ledgerOf(after, [ledger])];
    if (pair[0] !== pair[1]) return `${key} ledger ${ledger} ${pair[0]} -> ${pair[1]}`;
  }
  return null;
}
/** Whether the row records data for that ratio at all (else equality is 0/0 = 0/0 and witnesses nothing). */
const hasData = (row: StandingsRow, key: (typeof RATIOS)[number]): boolean => ledgersOf(key).some((l) => ledgerOf(row, [l]) !== 0);

describe("X-DW-4: a double walkover in a table (spec §5.3; plan D14)", () => {
  it("X-DW-4: in a league of 3 a double walkover is P+1, L+1, 0 points for both sides and moves nothing else — every sport", () => {
    let sports = 0;
    let keysCompared = 0;
    // A stage rule where a loss PAYS — the wrong answer (a double walkover scored as a loss) differs from 0.
    const RULE = legacyPointsRule({ base: { win: 3, draw: 2, loss: 1 }, forfeit: { winnerPoints: 3, loserPoints: 1 } });
    forEachSport(({ module: m }) => {
      const cfg = firstCfg(m);
      const xz = played(m, cfg, X, Z, 1);
      const yz = played(m, cfg, Y, Z, 2);
      const dw = fold(m, cfg, X, Y, DOUBLE_WALKOVER);
      expect(dw.outcome, `${m.key}: the fold of core.forfeit{by:"both"}`).toEqual({ kind: "double_walkover" });
      for (const rule of [undefined, RULE]) {
        const scored = (f: Folded): FixtureResult => (rule === undefined ? f.pair : payout(f.outcome, decidedInFor(m, f.outcome), f.pair, f.played, rule, m.awardScoreKeys, undefined));
        const without = foldResults([X, Y, Z], [scored(xz), scored(yz)]);
        const withDw = foldResults([X, Y, Z], [scored(xz), scored(yz), scored(dw)]);
        const tag = `${m.key} ${rule === undefined ? "sport points" : "stage rule"}`;
        for (const id of [X, Y]) {
          const [a, b] = [rowOf(without, id), rowOf(withDw, id)];
          expect({ p: b.played, w: b.won, d: b.drawn, l: b.lost, pts: b.points }, `${tag} ${id}`).toEqual({
            p: a.played + 1, w: a.won, d: a.drawn, l: a.lost + 1, pts: a.points,
          });
          for (const key of new Set([...Object.keys(a.metrics), ...Object.keys(b.metrics)])) {
            expect(b.metrics[key] ?? 0, `${tag} ${id} metric ${key}: a double walkover credits no score`).toBe(a.metrics[key] ?? 0);
            keysCompared++;
          }
        }
        expect(rowOf(withDw, Z), `${tag} Z`).toEqual(rowOf(without, Z));
      }
      // The rule's own reading of the result itself: 0 each, never `base.loss` / `forfeit.loserPoints` (both 1 here).
      expect(payout(dw.outcome, decidedInFor(m, dw.outcome), dw.pair, dw.played, RULE, m.awardScoreKeys, undefined).map((d) => d.points), `${m.key}: D14`).toEqual([0, 0]);
      sports++;
    });
    expect(sports).toBe(builtinModules.length);
    expect(keysCompared).toBeGreaterThan(0);
  });

  it("D14: a double walkover earns no bonus, forfeit_loss included, and no configured award score; a bye pays the win and no bonus (ruling 251, X-SW-5) — every sport", () => {
    // Every bonus kind pays, and every one of them is a different amount, so a leak names itself.
    const RULE = legacyPointsRule({
      base: { win: 3, draw: 2, loss: 0 },
      bonuses: [
        { when: "loss_margin_lte", param: 1000, points: 1 },
        { when: "score_ratio_gte", param: 0, points: 2 },
        { when: "win_margin_gte", param: -1000, points: 4 },
        { when: "forfeit_loss", points: 8 },
        { when: "forfeit_win", points: 16 },
        { when: "draw", points: 32 },
        { when: "no_result", points: 64 },
      ],
      forfeit: { winnerPoints: 5, loserPoints: 0, awardScore: [3, 0] },
    });
    let dws = 0;
    let byes = 0;
    forEachSport(({ module: m }) => {
      for (const { name, cfg } of declaredCfgs(m as never)) {
        const dw = fold(m, cfg, X, Y, DOUBLE_WALKOVER);
        const scored = payout(dw.outcome, decidedInFor(m, dw.outcome), dw.pair, dw.played, RULE, m.awardScoreKeys, undefined);
        expect(scored.map((d) => d.points), `${m.key}/${name}: double walkover`).toEqual([0, 0]);
        expect(scored.map((d) => d.metrics), `${m.key}/${name}: no award score on a double walkover`).toEqual(dw.pair.map((d) => d.metrics));
        dws++;
        // A bye, exactly as the server folds it (bye-credit.test.ts / awardByeDelta): an init state, a phantom seat.
        const bye: MatchOutcome = { kind: "award", winner: X, loser: null, reason: "bye" };
        const state = m.init(cfg, { home: { entrantId: X, slots: [] }, away: { entrantId: "__bye__", slots: [] } });
        const pair = m.standingsDelta(bye, cfg, { kind: "swiss" }, state) as FixtureResult;
        // A bye is written with no event (stages.ts), so no ledger: nothing played.
        const winner = payout(bye, decidedInFor(m, bye), pair, false, RULE, m.awardScoreKeys, undefined).find((d) => d.entrantId === X);
        // differential: before ruling 251 the row's 5 + forfeit_win 16 = 21; a bonus let in names itself (4 = win_margin_gte)
        expect(winner?.points, `${m.key}/${name}: a bye pays the win (3), never the forfeit row or a bonus`).toBe(RULE.win.regulation);
        byes++;
      }
    });
    expect(dws).toBeGreaterThanOrEqual(builtinModules.length);
    expect(byes).toBe(dws);
  });

  it("X-DW-4: a double walkover gives neither side a head-to-head point — the mini-table is level and the cascade falls through", () => {
    // single-sport: sport-agnostic by construction (the mini-table reads only the delta pair), so one sport per kind of ledger.
    let checked = 0;
    for (const key of ["football", "volleyball", "cricket", "boardgame"]) {
      const m = mod(key);
      const cfg = firstCfg(m);
      const dw = fold(m, cfg, X, Y, DOUBLE_WALKOVER);
      const among = resultsAmong(new Set([X, Y]), [dw.pair]);
      expect(among, key).toHaveLength(1);
      const mini = foldResults([X, Y], among);
      expect(mini.map((r) => [r.won, r.points]), `${key}: no winner, no point`).toEqual([[0, 0], [0, 0]]);
      const ranked = rankStandings(foldResults([X, Y], [dw.pair]), {
        cascade: ["points", "h2h_points", "seed"],
        results: [dw.pair],
        seeds: new Map([[X, 2], [Y, 1]]),
      });
      expect(ranked.rows.map((r) => [r.entrantId, r.tieBreak?.key]), `${key}: seed decides, not h2h`).toEqual([[Y, "seed"], [X, "seed"]]);
      checked++;
    }
    expect(checked).toBe(4);
  });
});

describe("X-DW-4 / TN-WO-1 / CK-WO-1: excluded keys move no ratio (spec §5.3: tie-break readers honour `excluded`)", () => {
  it("TN-WO-1: a tennis walkover leaves both sides' game % where the played matches put it, and does move set %", () => {
    // single-sport: TN-WO-1 is tennis's own row.
    const m = mod("tennis");
    const cfg = firstCfg(m);
    const base = [played(m, cfg, X, Y, 1).pair, played(m, cfg, Y, X, 2).pair];
    const wo = fold(m, cfg, X, Y, walkoverBy(Y));
    const [before, after] = [foldResults([X, Y], base), foldResults([X, Y], [...base, wo.pair])];
    let compared = 0;
    for (const id of [X, Y]) {
      expect(hasData(rowOf(before, id), "game_ratio"), `${id} played games`).toBe(true);
      expect(ratioMoved(rowOf(before, id), rowOf(after, id), "game_ratio"), `${id} game %`).toBeNull();
      compared++;
    }
    // The positive pair: the walkover IS in the second table — X's set ledger gained the straight sets.
    expect(ratioMoved(rowOf(before, X), rowOf(after, X), "set_ratio"), "X set % moved").not.toBeNull();
    expect(compared).toBe(2);
  });

  it("CK-WO-1: a cricket walkover leaves the winner's NRR untouched and charges the defaulter its full quota", () => {
    // single-sport: CK-WO-1 is cricket's own row; limited overs (PF-6: an unlimited match has no NRR to keep).
    const m = mod("cricket");
    const limited = declaredCfgs(m as never).filter(({ cfg }) => (cfg as { ballsPerInnings: number | null }).ballsPerInnings !== null);
    let compared = 0;
    for (const { name, cfg } of limited) {
      const c = cfg as { ballsPerInnings: number; inningsPerSide: number };
      const base = [played(m, cfg, X, Y, 1).pair, played(m, cfg, Y, X, 2).pair];
      const wo = fold(m, cfg, X, Y, walkoverBy(Y));
      const [before, after] = [foldResults([X, Y], base), foldResults([X, Y], [...base, wo.pair])];
      expect(hasData(rowOf(before, X), "nrr"), `${name}: X has an NRR`).toBe(true);
      expect(ratioMoved(rowOf(before, X), rowOf(after, X), "nrr"), `${name}: the winner's NRR`).toBeNull();
      compared++;
      // The positive pair: the defaulter IS charged (ICC PC 16.10.7) — its balls faced grow by the full quota.
      expect(ledgerOf(rowOf(after, Y), ["balls_faced_eff"]) - ledgerOf(rowOf(before, Y), ["balls_faced_eff"]), `${name}: Y charged`).toBe(
        c.ballsPerInnings * c.inningsPerSide,
      );
    }
    expect(compared).toBeGreaterThan(0);
  });

  it("X-DW-4: every ratio of both sides of a double walkover is unchanged — every sport", () => {
    let compared = 0;
    let witnessed = 0;
    forEachSport(({ module: m }) => {
      const cfg = firstCfg(m);
      const base = [played(m, cfg, X, Y, 1).pair, played(m, cfg, Y, X, 2).pair];
      const dw = fold(m, cfg, X, Y, DOUBLE_WALKOVER);
      const [before, after] = [foldResults([X, Y], base), foldResults([X, Y], [...base, dw.pair])];
      for (const id of [X, Y]) {
        for (const key of RATIOS) {
          expect(ratioMoved(rowOf(before, id), rowOf(after, id), key), `${m.key} ${id} ${key}`).toBeNull();
          compared++;
          if (hasData(rowOf(before, id), key)) witnessed++;
        }
      }
    });
    expect(compared).toBe(builtinModules.length * 2 * RATIOS.length);
    // At least the ratio sports (set, game, board, point ratios and NRR) put real data in front of the comparison.
    expect(witnessed).toBeGreaterThan(builtinModules.length);
  });
});

// Bracket rows are structural (bracketRanks reads no sport), so these are hand-built `BracketFixture` lists whose
// rounds follow the generator's own numbering (scheduling/bracket.ts): an 8-field double elimination has WB rounds
// 0-2, LB rounds 3-6 and the grand final at 7.
const seeds = (n: number) => new Map(Array.from({ length: n }, (_, i) => [`E${i + 1}`, i + 1] as const));
/** Places written out, for a shape with a shared rank. */
const ranked = (...pairs: readonly (readonly [string, number])[]): FinalPlace[] => pairs.map(([entrantId, rank]) => ({ entrantId, rank }));
const fx = (id: string, round: number, home: string | undefined, away: string | undefined, winner: string | undefined, extra: Partial<BracketFixture> = {}): BracketFixture => {
  const loser = winner === undefined ? undefined : winner === home ? away : home;
  return {
    id, round, status: "decided",
    ...(home === undefined ? {} : { home }), ...(away === undefined ? {} : { away }),
    ...(winner === undefined ? {} : { winner }), ...(loser === undefined ? {} : { loser }),
    ...extra,
  };
};

describe("X-DE-1 a withdrawn entrant is out and is never read as dropped (spec §5.3, W2b-R11; W6 RB6-F4, R7)", () => {
  const stage: BracketStage = { id: "de", kind: "double_elim", entrants: [...seeds(8).keys()], seeds: seeds(8) };
  // A STORED pre-11 bracket: straight drops, the loser of WB game i (0-based round r ≥ 1) seated in LB game i, so E3,
  // the loser of wb-r1-1, sits in lb-r1-1. The feeds below follow these rows' own ids — a stored bracket ranks by its
  // stored edges, never by the W6 drop table (RB6-X2 applies to a new or rebuilt bracket only, ruling 295).
  const W = (fixtureId: string): BracketSlotRef => ({ fixtureId, side: "winner" });
  const L = (fixtureId: string): BracketSlotRef => ({ fixtureId, side: "loser" });
  const FEEDS: Record<string, [BracketSlotRef, BracketSlotRef]> = {
    "wb-r1-0": [W("wb-r0-0"), W("wb-r0-1")], "wb-r1-1": [W("wb-r0-2"), W("wb-r0-3")], "wb-r2-0": [W("wb-r1-0"), W("wb-r1-1")],
    "lb-r0-0": [L("wb-r0-0"), L("wb-r0-1")], "lb-r0-1": [L("wb-r0-2"), L("wb-r0-3")],
    "lb-r1-0": [W("lb-r0-0"), L("wb-r1-0")], "lb-r1-1": [W("lb-r0-1"), L("wb-r1-1")],
    "lb-r2-0": [W("lb-r1-0"), W("lb-r1-1")], "lb-r3-0": [W("lb-r2-0"), L("wb-r2-0")], gf: [W("wb-r2-0"), W("lb-r3-0")],
  };
  // E3 meets E2 in wb-r1-1 (WB round 2). Everything else is the same in every variant.
  const around = (wbR1g1: BracketFixture, lbR1g1: BracketFixture, lbR2g0 = fx("lb-r2-0", 5, "E4", "E6", "E4", { bracket: "LB" })): BracketFixture[] =>
    [
      fx("wb-r0-0", 0, "E1", "E8", "E1", { bracket: "WB" }),
      fx("wb-r0-1", 0, "E4", "E5", "E4", { bracket: "WB" }),
      fx("wb-r0-2", 0, "E2", "E7", "E2", { bracket: "WB" }),
      fx("wb-r0-3", 0, "E3", "E6", "E3", { bracket: "WB" }),
      fx("wb-r1-0", 1, "E1", "E4", "E1", { bracket: "WB" }),
      wbR1g1,
      fx("wb-r2-0", 2, "E1", "E2", "E1", { bracket: "WB" }),
      fx("lb-r0-0", 3, "E8", "E5", "E5", { bracket: "LB" }),
      fx("lb-r0-1", 3, "E7", "E6", "E6", { bracket: "LB" }),
      fx("lb-r1-0", 4, "E5", "E4", "E4", { bracket: "LB" }),
      lbR1g1,
      lbR2g0,
      fx("lb-r3-0", 6, "E4", "E2", "E2", { bracket: "LB" }),
      fx("gf", 7, "E1", "E2", "E1", { bracket: "GF", isFinal: true }),
    ].map((row) => {
      const feeds = FEEDS[row.id];
      return feeds === undefined ? row : { ...row, homeFrom: feeds[0], awayFrom: feeds[1] };
    });
  const withdrawn = fx("wb-r1-1", 1, "E2", "E3", "E2", { bracket: "WB", status: "walkover", walkedOver: "loser" });

  it("X-DE-1: E3 withdrawn at wb-r1-1 takes LB round 2's place (the seat it vacates) with E5 — 5th, shared — its LB seat dead", () => {
    // RB6-R7: E3 ranks at the LB round of the seat it vacates, lb-r1-1 (LB round 2), with that round's other loser E5
    // (lb-r1-0); RB6-R3: 1 + four ranked better. E6 4th (lb-r2-0), E4 3rd (the LB final), E7 and E8 7= (LB round 1).
    // differential: today E3 is last, 8th (out at the WB round's own round, below every LB loser).
    const deadSeat = fx("lb-r1-1", 4, "E6", undefined, "E6", { bracket: "LB", status: "walkover" });
    const want = ranked(["E1", 1], ["E2", 2], ["E4", 3], ["E6", 4], ["E3", 5], ["E5", 5], ["E7", 7], ["E8", 7]);
    expect(bracketRanks(stage, around(withdrawn, deadSeat))).toEqual(want);
  });

  it("X-DE-1: a stale LB row that still seats E3 never moves it — the earliest walkover, by the LB round of the seat it vacates", () => {
    // Pre-W2b rows that seated E3 and recorded it on: lb-r1-1 E6 v E3 won by E3, then lb-r2-0 E4 v E3 won by E4 —
    // played, or walked over a second time. The earliest walkover wins, earliest by the resolved LB round of the seat
    // vacated (raw rounds do not compare across lanes), so E3 still takes LB round 2's place, now with E5 and E6.
    // RB6-R7, RB6-R3 (three ranked better; ruling 306(c)): E1, E2, E4, then E3, E5, E6 at 4th, then E7, E8 at 7th.
    // E3 alone is 4th under a "latest loss" reading too: E5 and E6 at 4th, not 5th, are what tell the two apart.
    const lbR1 = fx("lb-r1-1", 4, "E6", "E3", "E3", { bracket: "LB" });
    const stale = [
      fx("lb-r2-0", 5, "E4", "E3", "E4", { bracket: "LB" }),
      fx("lb-r2-0", 5, "E4", "E3", "E4", { bracket: "LB", status: "walkover", walkedOver: "loser" }),
    ];
    const want = ranked(["E1", 1], ["E2", 2], ["E4", 3], ["E3", 4], ["E5", 4], ["E6", 4], ["E7", 7], ["E8", 7]);
    let checked = 0;
    for (const row of stale) {
      // Either order of the rows: the elimination round is the EARLIEST walkover, not the first one listed.
      for (const fixtures of [around(withdrawn, lbR1, row), around(withdrawn, lbR1, row).reverse()]) {
        expect(bracketRanks(stage, fixtures), JSON.stringify(row)).toEqual(want);
        checked++;
      }
    }
    expect(checked).toBe(4);
  });

  it("X-DE-1 positive pair: the same wb-r1-1 as a played loss drops E3, who wins lb-r1-1 and loses lb-r2-0 — 4th, alone", () => {
    // RB6-R2: 4th is the loser of LB 3.1 (lb-r2-0). E5 and E6 (LB round 2) 5=, against 5th shared for the withdrawal.
    const win = fx("wb-r1-1", 1, "E2", "E3", "E2", { bracket: "WB" });
    const rows = around(win, fx("lb-r1-1", 4, "E6", "E3", "E3", { bracket: "LB" }), fx("lb-r2-0", 5, "E4", "E3", "E4", { bracket: "LB" }));
    expect(bracketRanks(stage, rows)).toEqual(ranked(["E1", 1], ["E2", 2], ["E4", 3], ["E3", 4], ["E5", 5], ["E6", 5], ["E7", 7], ["E8", 7]));
  });
});

describe("X-DW-2: a double walkover in a bracket puts both sides out in its round (spec §5.3)", () => {
  // 8-field knockout, seeded upset in the quarter-final so the rulebook order is not the seed order.
  const stage: BracketStage = { id: "ko", kind: "knockout", entrants: [...seeds(8).keys()], seeds: seeds(8) };
  const field = (semi: BracketFixture): BracketFixture[] => [
    fx("qf-0", 0, "E1", "E8", "E8"),
    fx("qf-1", 0, "E4", "E5", "E4"),
    fx("qf-2", 0, "E2", "E7", "E2"),
    fx("qf-3", 0, "E3", "E6", "E3"),
    fx("sf-0", 1, "E8", "E4", "E8"),
    semi,
    // The final's other seat is dead: E8 advances by walkover, nobody loses it.
    fx("f", 2, "E8", undefined, "E8", { isFinal: true, status: "walkover" }),
  ];

  it("X-DW-2: E2 and E3 double-walk-over in the semi-final and both go out in round 1, ranked below E4, the semi-final's one loser", () => {
    const dw = fx("sf-1", 1, "E2", "E3", undefined, { status: "walkover", walkedOver: "both" });
    // Champion E8 by walkover over the dead seat, so nobody is 2nd (B3-6, controller call). E4, the one semi-final loser,
    // ranks 3rd (SH-3: a knockout with no play-off); E2 and E3, out in round 1 with no loser's place, then E1, E5, E6,
    // E7 (round 0, seed order), each max(previous rank + 1, placed + 1) (C4: standard competition ranking).
    // ruling 270: was 3/4 by seed (E2 2, E3 3, E4 4: round 1 by seed, then round 0)
    expect(bracketRanks(stage, field(dw))).toEqual([
      { entrantId: "E8", rank: 1 },
      { entrantId: "E4", rank: 3 },
      { entrantId: "E2", rank: 4 },
      { entrantId: "E3", rank: 5 },
      { entrantId: "E1", rank: 6 },
      { entrantId: "E5", rank: 7 },
      { entrantId: "E6", rank: 8 },
      { entrantId: "E7", rank: 9 },
    ]);
  });

  it("empty case: an entrant neither beaten nor walked over (its line voided) ranks last, below every elimination round", () => {
    const voided = fx("sf-1", 1, "E2", "E3", undefined, { status: "void" });
    // E2 and E3 lost nothing settled: below round-0 losers E1, E5, E6, E7; seed order between them. Nobody is 2nd (the
    // final's other seat is dead, B3-6) and E4 is the semi-final's one loser, 3rd (SH-3); C4: standard competition ranking.
    // ruling 270: was 3/4 by seed (E4 2, E1 3 … E3 8)
    expect(bracketRanks(stage, field(voided))).toEqual([
      { entrantId: "E8", rank: 1 },
      { entrantId: "E4", rank: 3 },
      { entrantId: "E1", rank: 4 },
      { entrantId: "E5", rank: 5 },
      { entrantId: "E6", rank: 6 },
      { entrantId: "E7", rank: 7 },
      { entrantId: "E2", rank: 8 },
      { entrantId: "E3", rank: 9 },
    ]);
  });

  it("X-DW-2: a double walkover row that names a winner or a loser, or a forfeit row that names no loser, is refused", () => {
    const named = [
      fx("sf-1", 1, "E2", "E3", "E2", { status: "walkover", walkedOver: "both" }),
      fx("sf-1", 1, "E2", "E3", "E2", { status: "walkover", walkedOver: "both", loser: undefined }),
      fx("sf-1", 1, "E2", "E3", undefined, { status: "walkover", walkedOver: "both", loser: "E3" }),
    ];
    for (const row of named) expect(() => bracketRanks(stage, field(row)), JSON.stringify(row)).toThrow(/double walkover .*names a winner or a loser/);
    const oneSided = [
      fx("sf-1", 1, undefined, "E3", undefined, { status: "walkover", walkedOver: "both" }),
      fx("sf-1", 1, "E2", undefined, undefined, { status: "walkover", walkedOver: "both" }),
    ];
    for (const row of oneSided) expect(() => bracketRanks(stage, field(row)), JSON.stringify(row)).toThrow(/double walkover .*is missing a side/);
    const noLoser = fx("sf-1", 1, "E2", undefined, "E2", { status: "walkover", walkedOver: "loser" });
    expect(() => bracketRanks(stage, field(noLoser))).toThrow(/walkover out of the stage .*names no loser/);
  });
});
