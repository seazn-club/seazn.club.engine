// S5 (perf/swiss-tiebreak-index): rankStandings re-indexed the whole Swiss ledger on EVERY comparison of its cascade sort
// (`buchholz`, `buchholzCut1`, `sonnebornBerger` and `opponentsDiff` each called `indexTable`), 42-57% of a 500-entrant Swiss
// refold's CPU in the app (W5 perf measure, 2026-11-22). The change reads each of those values once per entrant per rank
// call. It is a pure refactor, so the output must not move by one byte. Two oracles, neither derived from the code under
// test:
//   1. PRE_CHANGE: the four metric functions exactly as engine 10.0.3 (bf70530) wrote them, each indexing the ledger on
//      every call. Every row's materialised Swiss column is re-read through them, and the ranked order must be
//      non-increasing on the cascade's leading points-and-Swiss keys read through them (spec 05 §4: a plain key orders
//      each class the keys before it left level).
//   2. RECORDED: a sha-256 of completeTableStage's whole output (events, tables, new lots draws), one per sport and cfg over
//      all of that cfg's cases, recorded by engine 10.0.3 BEFORE the change, over this same seeded sweep.
// The sweep: every sport in the registry (forEachSport); every declared cfg at 8, 9 and 33 entrants, and each sport's
// first declared cfg at 100, 257 and 500 (the S5 sizes; the cfg moves only the points rule and the chain, which the small
// sizes already sweep); ranked before any result (the empty table), after rounds 1, 4 and 7 of 7, and in the middle of
// round 5 (some boards in play or voided, as a per-result refold sees them); under the sport's own Swiss chain and under
// ALL_SWISS (every Swiss key, so SB and opp_diff run for every sport). Each field has late entrants (absent rounds before
// entry, C.07 16.2.3), withdrawals (absent rounds after, 16.2.5), byes (odd fields, 16.2.1), forfeits and double
// walkovers (16.2.2, 16.2.4), draws where the sport's Swiss stage reaches one, and the level classes a Swiss table is
// full of. Results come through the producers the app runs: the stage rule's `payout` over the result, the module's own
// standingsDelta for a bye or a walkover, and `unplayedSidesOf` for the unplayed side(s).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { MatchOutcome, type EntrantId, type StandingsDelta } from "../core/types.ts";
import type { AnySportModule, TiebreakerKey } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { tableRulesOf } from "../testkit/helpers.ts";
import { decidedInFor } from "./decided-in.ts";
import { payout, setsToWinOf, swissDrawFactsOf, swissDrawPoints, unplayedSidesOf, type PointsRule } from "./points.ts";
import { completeTableStage, type TableFixture, type TableStage } from "./stage.ts";
import type { FixtureResult, StandingsRow } from "./standings.ts";
import { resolveTableRules } from "./table-rules.ts";
import {
  DIFF_KEYS,
  buchholz,
  buchholzCut1,
  buildSwissLedger,
  metricOf,
  opponentsDiff,
  sonnebornBerger,
  type GameResult,
  type SwissGame,
  type SwissRow,
  type SwissTable,
} from "./tiebreakers.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Oracle 1: the pre-change reads, verbatim from engine 10.0.3 (src/competition/tiebreakers.ts at bf70530), renamed, with
// one liberty: each ledger and table THIS TEST builds is indexed once (`indexOnce`, `rowsOnce`), where 10.0.3 re-indexed on
// every read. The test never writes a ledger or a table after building it, and each case builds its own (ledgerOf), so the
// index is the very map each read would have built, and it can never be another case's. Without it the oracle alone is
// O(n^2) per table, most of this file's time at 500 entrants.
// ---------------------------------------------------------------------------------------------------------------------
function indexTable(table: SwissTable): Map<EntrantId, SwissRow> {
  const map = new Map<EntrantId, SwissRow>();
  for (const row of table) map.set(row.entrant, row);
  return map;
}
const INDEXED = new WeakMap<SwissTable, Map<EntrantId, SwissRow>>();
function indexOnce(table: SwissTable): Map<EntrantId, SwissRow> {
  const kept = INDEXED.get(table);
  if (kept !== undefined) return kept;
  const map = indexTable(table);
  INDEXED.set(table, map);
  return map;
}
const ROWS = new WeakMap<readonly StandingsRow[], Map<EntrantId, StandingsRow>>();
function rowsOnce(rows: readonly StandingsRow[]): Map<EntrantId, StandingsRow> {
  const kept = ROWS.get(rows);
  if (kept !== undefined) return kept;
  const map = new Map(rows.map((r) => [r.entrantId, r]));
  ROWS.set(rows, map);
  return map;
}
const isVur = (game: SwissGame): boolean =>
  game.unplayed === "absent" || game.unplayed === "absent_last" || game.unplayed === "forfeit_loss";
function opponentScore(byEntrant: Map<EntrantId, SwissRow>, row: SwissRow, game: SwissGame): number {
  if (game.unplayed !== undefined) {
    if (game.cap === undefined) {
      throw new EngineError("CONFIG_INVALID", `"${row.entrant}"'s round ${game.round} is unplayed (${game.unplayed}) but carries no 16.4 cap`, { entrantId: row.entrant, round: game.round });
    }
    return Math.min(row.score, game.cap);
  }
  if (game.opponent === null) {
    throw new EngineError("CONFIG_INVALID", `"${row.entrant}"'s round ${game.round} names no opponent and no unplayed category`, { entrantId: row.entrant, round: game.round });
  }
  const opp = byEntrant.get(game.opponent);
  if (opp === undefined) {
    throw new EngineError("CONFIG_INVALID", `Swiss ledger references unknown opponent "${game.opponent}"`, { entrantId: row.entrant, opponent: game.opponent });
  }
  return opp.adjusted ?? opp.score;
}
function requireRow(byEntrant: Map<EntrantId, SwissRow>, entrant: EntrantId): SwissRow {
  const row = byEntrant.get(entrant);
  if (row === undefined) throw new Error(`entrant "${entrant}" is not in the Swiss table`);
  return row;
}
function preBuchholz(table: SwissTable, entrant: EntrantId, opts: { cut?: number } = {}): number {
  const byEntrant = indexOnce(table);
  const row = requireRow(byEntrant, entrant);
  const cards = row.games.map((game) => ({ score: opponentScore(byEntrant, row, game), vur: isVur(game) }));
  const scores = cards.map((card) => card.score);
  const cut = opts.cut ?? 0;
  if (cut < 0) throw new EngineError("CONFIG_INVALID", `a Buchholz cut drops opponents' scores, so it is never negative: ${cut}`, { cut });
  if (cut <= 0) return scores.reduce((sum, s) => sum + s, 0);
  const left = [...cards].sort((a, b) => a.score - b.score);
  for (let k = 0; k < cut; k++) {
    const vur = left.findIndex((card) => card.vur);
    left.splice(vur === -1 ? 0 : vur, 1);
  }
  return left.reduce((sum, card) => sum + card.score, 0);
}
function preBuchholzCut1(table: SwissTable, entrant: EntrantId): number {
  return preBuchholz(table, entrant, { cut: 1 });
}
function preSonnebornBerger(table: SwissTable, entrant: EntrantId): number {
  const byEntrant = indexOnce(table);
  const row = requireRow(byEntrant, entrant);
  let total = 0;
  row.games.forEach((game) => {
    const oppScore = opponentScore(byEntrant, row, game);
    const weight = game.result === "win" ? 2 : game.result === "draw" ? 1 : 0;
    total += weight * oppScore;
  });
  return total;
}
function preOpponentsDiff(table: SwissTable, rows: readonly StandingsRow[], entrant: EntrantId): number {
  const row = requireRow(indexOnce(table), entrant);
  const byEntrant = rowsOnce(rows);
  let total = 0;
  for (const game of row.games) {
    if (game.unplayed !== undefined) continue;
    if (game.opponent === null) {
      throw new EngineError("CONFIG_INVALID", `"${entrant}"'s round ${game.round} names no opponent and no unplayed category`, { entrantId: entrant, round: game.round });
    }
    const opponent = byEntrant.get(game.opponent);
    if (opponent === undefined) {
      throw new EngineError("CONFIG_INVALID", `opp_diff reads "${entrant}"'s opponent "${game.opponent}", which has no row in the table`, { entrantId: entrant, opponent: game.opponent });
    }
    const diff = metricOf(opponent, DIFF_KEYS);
    if (diff === undefined) {
      const need = DIFF_KEYS.join(" or ");
      throw new EngineError("CONFIG_INVALID", `opp_diff reads "${entrant}"'s opponent "${game.opponent}", whose row records no goal difference (${need})`, { entrantId: entrant, opponent: game.opponent, need });
    }
    total += diff;
  }
  return total;
}

// ---------------------------------------------------------------------------------------------------------------------
// The seeded sweep.
// ---------------------------------------------------------------------------------------------------------------------
/** Every Swiss key behind points, then the head-to-head step and lots: SB and opp_diff run for every sport. */
const ALL_SWISS: readonly TiebreakerKey[] = ["points", "buchholz_cut1", "buchholz", "sberger", "opp_diff", "direct", "lots"];
/** The keys whose value the pre-change oracle (or the row) gives: an ordered prefix of these is checked pair by pair. */
const SWISS_KEYS = ["buchholz_cut1", "buchholz", "sberger", "opp_diff"] as const;
type SwissKey = (typeof SWISS_KEYS)[number];
const ROUNDS = 7;
const SMALL = [8, 9, 33] as const;
const LARGE = [100, 257, 500] as const;
/** Where each case is ranked: 0 = before any result (the empty table), "5-mid" = rounds 1-4 and half of round 5. */
const AT = [0, 1, 4, "5-mid", 7] as const;
type At = (typeof AT)[number];

/** mulberry32: a seeded generator owned by this test, so an engine RNG change cannot move the recorded sweep. */
function rngOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Sport {
  readonly m: AnySportModule;
  readonly cfgName: string;
  readonly cfg: unknown;
  readonly rule: PointsRule;
  /** The sport's own Swiss chain, as an unpinned stage resolves it. */
  readonly chain: readonly TiebreakerKey[];
  readonly drawStands: boolean;
  readonly setsToWin: number | undefined;
}

function sportOf(m: AnySportModule, cfgName: string, cfg: unknown): Sport {
  const pin = resolveTableRules({ module: m, stageKind: "swiss", mergedCfg: cfg, stageOwn: { points: null, tiebreakers: null, crossGroup: null }, divisionTiebreakers: null, pinned: null });
  const parsed = m.configSchema.parse(cfg);
  const drawStands = m.reachableResultKinds(parsed, "swiss").has("draw") || m.supportsDraws(parsed, "swiss");
  return { m, cfgName, cfg, rule: pin.points, chain: pin.tiebreakers, drawStands, setsToWin: setsToWinOf(m, cfg) };
}

/** A played board, paid by the stage rule through the real payout. The ledger is the union of every sport's (sets, rally
 *  points, games, boards, goals, runs), so each key of each chain has something to read; the winner takes the sets a match
 *  is won on, so a set-score rule prices a final score the sport declares. */
function played(s: Sport, rng: () => number, round: number, home: EntrantId, away: EntrantId, r: "h" | "a" | "d"): TableFixture {
  const toWin = s.setsToWin ?? 2;
  const lostSets = Math.floor(rng() * toWin);
  const g1 = 1 + Math.floor(rng() * 5);
  const g2 = r === "d" ? g1 : Math.floor(rng() * g1);
  const side = (id: EntrantId, won: boolean): StandingsDelta => {
    const drawn = r === "d";
    const sw = drawn ? lostSets : won ? toWin : lostSets;
    const sl = drawn ? lostSets : won ? lostSets : toWin;
    const gf = drawn || won ? g1 : g2;
    const ga = drawn ? g1 : won ? g2 : g1;
    return {
      entrantId: id, played: 1, won: won ? 1 : 0, drawn: drawn ? 1 : 0, lost: !won && !drawn ? 1 : 0, points: 0,
      metrics: {
        sets_won: sw, sets_lost: sl, points_won: 21 * sw + 15 * sl, points_lost: 21 * sl + 15 * sw, games_won: 6 * sw + 3 * sl, games_lost: 6 * sl + 3 * sw,
        boards_won: 2 * sw + sl, boards_lost: 2 * sl + sw, gf, ga, gd: gf - ga, for: gf, against: ga, diff: gf - ga,
        runs_for: 120 + 10 * gf, runs_against: 120 + 10 * ga, balls_faced_eff: 120, balls_bowled_eff: 120,
      },
    };
  };
  const raw: FixtureResult = [side(home, r === "h"), side(away, r === "a")];
  const outcome = r === "d" ? MatchOutcome.parse({ kind: "draw" }) : MatchOutcome.parse({ kind: "win", winner: r === "h" ? home : away, loser: r === "h" ? away : home });
  const result = payout(outcome, decidedInFor(s.m, outcome), raw, true, s.rule, s.m.awardScoreKeys, s.setsToWin);
  return { id: `r${round}-${home}-${away}`, roundNo: round, status: "decided", result, unplayed: null };
}
/** A forfeit or a double walkover, as the app writes a walked-over table fixture (swiss-unplayed.test.ts `walkedOver`). */
function walkedOver(s: Sport, round: number, home: EntrantId, away: EntrantId, outcome: MatchOutcome): TableFixture {
  const cfg = s.m.configSchema.parse(s.cfg);
  const state = s.m.init(cfg, { home: { entrantId: home, slots: [] }, away: { entrantId: away, slots: [] } });
  const raw = s.m.standingsDelta(outcome, cfg, { kind: "swiss" }, state) as FixtureResult;
  const result = payout(outcome, decidedInFor(s.m, outcome), raw, false, s.rule, s.m.awardScoreKeys, s.setsToWin);
  return { id: `r${round}-${home}-${away}`, roundNo: round, status: "walkover", result, unplayed: unplayedSidesOf(outcome, false, result) };
}
/** A pairing-allocated bye, as the app's `awardByeDelta` builds it (swiss-unplayed.test.ts `paidBye`). */
function bye(s: Sport, round: number, winner: EntrantId): TableFixture {
  const cfg = s.m.configSchema.parse(s.cfg);
  const outcome = MatchOutcome.parse({ kind: "award", winner, loser: null, reason: "bye" });
  const state = s.m.init(cfg, { home: { entrantId: winner, slots: [] }, away: { entrantId: "__bye__", slots: [] } });
  const raw = s.m.standingsDelta(outcome, cfg, { kind: "swiss" }, state) as FixtureResult;
  const paid = payout(outcome, decidedInFor(s.m, outcome), raw, false, s.rule, s.m.awardScoreKeys, s.setsToWin).find((d) => d.entrantId === winner);
  if (paid === undefined) throw new Error(`${s.m.key}: the paid bye names no winner`);
  return { id: `r${round}-bye-${winner}`, roundNo: round, status: "walkover", awardDelta: paid };
}

interface Field {
  readonly entrants: readonly EntrantId[];
  /** All seven rounds' boards, in round order. */
  readonly fixtures: readonly TableFixture[];
  /** Each entrant's unpaired rounds over all seven (late entry before, withdrawal after). */
  readonly absent: ReadonlyMap<EntrantId, readonly number[]>;
}

/** Seven Swiss rounds: each round pairs the active field by score (a random order within a score), the lowest without a
 *  bye sits out an odd round, and each board is a forfeit (3%), a double walkover (1%), a draw (12% where one stands) or a
 *  win for either side. About 4% enter late (round 2 or 3) and 4% withdraw (after round 1 to 4). */
function fieldOf(s: Sport, size: number, seed: number): Field {
  const rng = rngOf(seed);
  const entrants = Array.from({ length: size }, (_, i) => `p${String(i + 1).padStart(3, "0")}`);
  const enters = new Map<EntrantId, number>();
  const leaves = new Map<EntrantId, number>();
  for (const id of entrants) {
    const u = rng();
    if (u < 0.04) enters.set(id, 2 + Math.floor(rng() * 2));
    else if (u < 0.08) leaves.set(id, 2 + Math.floor(rng() * 4));
  }
  const score = new Map(entrants.map((id) => [id, 0]));
  const add = (id: EntrantId, points: number) => score.set(id, (score.get(id) ?? 0) + points);
  const hadBye = new Set<EntrantId>();
  const fixtures: TableFixture[] = [];
  const absent = new Map<EntrantId, number[]>();
  for (let round = 1; round <= ROUNDS; round++) {
    const active: EntrantId[] = [];
    for (const id of entrants) {
      if ((enters.get(id) ?? 1) > round || (leaves.get(id) ?? Infinity) <= round) absent.set(id, [...(absent.get(id) ?? []), round]);
      else active.push(id);
    }
    const order = new Map(active.map((id) => [id, rng()]));
    active.sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0) || (order.get(a) ?? 0) - (order.get(b) ?? 0));
    if (active.length % 2 === 1) {
      let i = active.length - 1;
      while (i > 0 && hadBye.has(active[i] as EntrantId)) i--;
      const sitter = active.splice(i, 1)[0] as EntrantId;
      hadBye.add(sitter);
      const f = bye(s, round, sitter);
      fixtures.push(f);
      add(sitter, f.awardDelta?.points ?? 0);
    }
    for (let i = 0; i + 1 < active.length; i += 2) {
      const [home, away] = [active[i] as EntrantId, active[i + 1] as EntrantId];
      const u = rng();
      let f: TableFixture;
      if (u < 0.03) {
        const homeWins = rng() < 0.5;
        f = walkedOver(s, round, home, away, MatchOutcome.parse({ kind: "award", winner: homeWins ? home : away, loser: homeWins ? away : home, reason: "walkover" }));
      } else if (u < 0.04) f = walkedOver(s, round, home, away, MatchOutcome.parse({ kind: "double_walkover" }));
      else if (u < 0.04 + (s.drawStands ? 0.12 : 0)) f = played(s, rng, round, home, away, "d");
      else f = played(s, rng, round, home, away, rng() < 0.5 ? "h" : "a");
      fixtures.push(f);
      for (const d of f.result ?? []) add(d.entrantId, d.points);
    }
  }
  return { entrants, fixtures, absent };
}

/** The stage and its boards as a refold sees them at `at`: the absences up to that round, the boards up to it, and in the
 *  middle of round 5 every second board of the round still in play and every fourth voided (pending: they count nothing). */
function stageAt(s: Sport, chain: readonly TiebreakerKey[], field: Field, at: At): { stage: TableStage; fixtures: TableFixture[]; through: number } {
  const through = at === "5-mid" ? 5 : at;
  const absent = new Map<EntrantId, number[]>();
  for (const [id, rounds] of field.absent) {
    const upTo = rounds.filter((r) => r <= through);
    if (upTo.length > 0) absent.set(id, upTo);
  }
  let board = 0;
  const fixtures = field.fixtures
    .filter((f) => (f.roundNo ?? 0) <= through)
    .map((f): TableFixture => {
      if (at !== "5-mid" || f.roundNo !== 5 || f.result === undefined) return f;
      board++;
      if (board % 4 === 0) return { id: f.id, roundNo: 5, status: "void" };
      return board % 2 === 0 ? { id: f.id, roundNo: 5, status: "in_play" } : f;
    });
  const stage: TableStage = {
    id: "sw", kind: "swiss", swiss: true, entrants: [...field.entrants], rules: tableRulesOf(chain, s.rule), rngSeed: 7, rounds: ROUNDS,
    swissAbsentRounds: absent, swissDraw: swissDrawFactsOf(s.m, s.cfg),
  };
  return { stage, fixtures, through };
}

/** The ledger completeTableStage ranks by, rebuilt from the same inputs by the same builder (stage.ts `swissLedgerOf`). */
function ledgerOf(s: Sport, stage: TableStage, fixtures: readonly TableFixture[]): SwissTable {
  const counted = fixtures
    .filter((f) => (f.status === "decided" || f.status === "walkover") && (f.result !== undefined || f.awardDelta !== undefined))
    .map((f) => ({
      round: f.roundNo as number,
      ...(f.result === undefined ? {} : { result: f.result }),
      ...(f.awardDelta === undefined ? {} : { award: f.awardDelta }),
      ...(f.unplayed == null ? {} : { unplayed: f.unplayed }),
    }));
  return buildSwissLedger(stage.entrants, counted, {
    rounds: stage.rounds,
    drawPoints: swissDrawPoints(s.rule, swissDrawFactsOf(s.m, s.cfg)),
    absent: stage.swissAbsentRounds,
  });
}

/** The value a key reads for a row: the table points, or a Swiss key through the pre-change oracle (in ledger units). */
function oracleOf(ledger: SwissTable, rows: readonly StandingsRow[]): (key: "points" | SwissKey, row: StandingsRow) => number {
  const memo = new Map<string, number>();
  return (key, row) => {
    if (key === "points") return row.points;
    const k = `${key}:${row.entrantId}`;
    let v = memo.get(k);
    if (v === undefined) {
      v = key === "buchholz_cut1" ? preBuchholzCut1(ledger, row.entrantId)
        : key === "buchholz" ? preBuchholz(ledger, row.entrantId)
          : key === "sberger" ? preSonnebornBerger(ledger, row.entrantId)
            : preOpponentsDiff(ledger, rows, row.entrantId);
      memo.set(k, v);
    }
    return v;
  };
}

/** The leading keys of a chain the oracle can read: points and Swiss keys, up to the first other key. */
function orderedPrefix(chain: readonly TiebreakerKey[]): ("points" | SwissKey)[] {
  const prefix: ("points" | SwissKey)[] = [];
  for (const key of chain) {
    if (key !== "points" && !(SWISS_KEYS as readonly string[]).includes(key)) break;
    prefix.push(key as "points" | SwissKey);
  }
  return prefix;
}

const GAME_RESULTS: readonly GameResult[] = ["win", "draw", "loss"];

/** Recorded by engine 10.0.3 (bf70530, the pre-change tiebreakers.ts) over exactly this sweep: per sport and cfg, the
 *  sha-256 of every case's `${id}\n${JSON.stringify(completeTableStage(...))}\n`, in sweep order. */
const RECORDED: Readonly<Record<string, string>> = {
  "football/(schema default)": "37f10d46ac5da754f04c3024afc33ede986d22f36d02a61a75fa014629274ddf",
  "football/11-a-side": "d5bc75ed3c6b51ea77c42fca3e41ee52ad38a5bc9a773b4e1aada991d1b2cf78",
  "football/youth": "98dae159e89524f717381023b2bbcc14761e0a327939a382304d0129800630ea",
  "football/small-sided": "9be3eb694ff24d82eb6084f100fd9d47be6f84bb42c5a24b2440fca338c55762",
  "football/mini-soccer": "f1e7da2664e2bba5433fedd97cd6b4b1ebe8635d07ee1eeb113856c213c3263e",
  "cricket/(schema default)": "3a52e15cf5788d4c5dae258a3cb475b03cf3eea40bb8fb08346f65655d8ff09b",
  "cricket/t20": "4ef94bdeed5f24f49400369ccd262779b10f09e20772b824d9686db342d3b106",
  "cricket/odi": "2334f1ce9e8f47ee24a25b39a08af2e758cadeb879bfbd19c91719818dd7086b",
  "cricket/hundred": "83643f7fc9dac41a7cf745b348a209afe613f45d0ca94bfddf297bb9a573edd6",
  "cricket/test": "bcee4884462ea49eafd32c899c85b5fb419e360e6767859834e5ab9563ff0861",
  "boardgame/(schema default)": "4ae198ec80436ef6257d4c5d883f6354bc7d9e333ea3c10010838bea1c2ea7d8",
  "boardgame/classical": "1d1e031ac2a2b002c08c5874480becba3c92741811306bf1af5dc56137a91df3",
  "boardgame/rapid": "10ef4e96682e70b760272d0ffd255e1153a401a9328eabba5910ecab22e0ff77",
  "boardgame/blitz": "fdc218e23a559c43921d66fa65c605fa0e07e335e4cb460f1c2c973646fbc669",
  "carrom/(schema default)": "c3cfe5abd242b8bbadc5ed8285a9c589a8d77629cb67bb407e0f9283d2f91f3b",
  "carrom/icf": "99456b658befd8321e12a78653ce876351bd5b2ae316a904ff1c577e3b61a816",
  "carrom/club-29": "362f1351b0de05a693fc373b01feb3abd7a1fd0181240bbcb21ec399858e9230",
  "generic/win_loss": "436468e9a8a58ee29b53d06735d5a7510a43300877bd39d3e33acc76e106eac0",
  "generic/score": "45fda6484c38ddf1071b0c754ddbce3018ae4979a47c401a97de891ffc8d237d",
  "volleyball/(schema default)": "caf709f317995a097d214f71ad4cd54f5ff794ca8154434343cf2240c432d143",
  "volleyball/indoor": "7826893357d595850b27869a5d4d0fe3e9e772d61e83d1ba6734ae4820f92a31",
  "volleyball/beach": "9df87e39e2dfffa5d6b5a3e5fd8e6c3c611a358ab168f4dffd2d4a5b1d02ed80",
  "badminton/(schema default)": "c7ffffa7b588a0697c9ab53c45b1038a2428fde2dc3c501a6a93dbd9f638f1cd",
  "badminton/bwf": "a6fb2f2f2f2af36f771038f8f6ef7546be56b3765fec8a9eb2be5d3f7f496ef0",
  "badminton/bwf-3x15": "61ae7ac3d45aeca5f02f8520c68983948c7fb96208f2eda070a2015ebe4631c2",
  "badminton/short": "159504c9ee072638da9c439034c831ea8584512f92c83bf82e45a1960cd20c3f",
  "tabletennis/(schema default)": "0298f843a0c0f753dd576da96771a9181ed27ae2aabb52591b005ae18fce6b28",
  "tabletennis/bo5": "624d2f3667899737b4c557fbd6151efc06c79b13f9b4643cbb7d1c7ba04480fc",
  "tabletennis/bo7": "cde6222510e98d1b0f46fac7daab284866e7464616ea16f0909c1504c9b22732",
  "tabletennis/hardbat-21": "c82c2383a2936d50f742deb980be8d7f51a77a274159e67640756c567f86d884",
  "tennis/(schema default)": "e1cd4e63588796c6afca95078cc9971d6f81d789176efd1264912b786274a0a0",
  "tennis/tour": "f2ea826e38c2c0ed8f77c175a105f245c85156aeb4a824493f80805ccb063ff7",
  "tennis/grand-slam": "25b9bd8f8d103d9949446ae8c1819033b06b07f8cbe4b657337c7ca1c3e89826",
  "tennis/fast4": "44ee3e24e936f041e35cae6851d2e777d7323f87a39714afd5153df14a3926cf",
  "tennis/doubles-noad-mtb10": "c3f067a77327c9b91a5de662a121e7a78e4cf29df939d80d0438c35474204278",
  "tennis/short-sets": "7f66923fd1b42bfb48cdd64b1d34e899b730df9dbe035b80f320824092ff0674",
  "icehockey/(schema default)": "636ccf98661ae210c9abe9bf370c58da306e666a3531279a75848ffadda3c536",
  "icehockey/iihf": "8857655041e9ed79ab4fc4504b1c3da16b1043fe080b23f22e679cfd2d81e565",
  "icehockey/recreational": "dfe3f670b7f4c20aee248f9e51f7eb46b6d1e71f5c46a6657ff7fe280209f158",
  "hockey/(schema default)": "d5acba1edc2715ecb84eae4c5605e6843220a9760f8c9f02b3632b9b4f04ab7f",
  "hockey/fih-outdoor": "e3d9cbde400f0eb536d8de044271230389fa3b3019c833dd5ab4f56f97b95443",
  "hockey/fih-shootout": "d5c2d11347b664801b7fc988b95e63d841261927ec7465ef23895984f4eae7f9",
  "hockey/youth": "b3f2cfbfd74cf1d6c1884871f802182a36ba5ae5c9604997e6410227d119b0f5",
};

describe("S5: the Swiss tiebreak reads are byte-identical to engine 10.0.3 (every sport, seeded sweep up to 500 entrants; counted)", () => {
  it("every row's Swiss column equals the pre-change read, the order is non-increasing on the chain's points-and-Swiss prefix read the pre-change way, and each sport-cfg's whole output hashes to its 10.0.3 recording", () => {
    const digests = new Map<string, ReturnType<typeof createHash>>();
    let cases = 0;
    let declared = 0; // the sweep's size, read off the registry: per declared cfg its sizes x both chains x every AT
    let emptyCases = 0;
    let midRoundCases = 0;
    let columns = 0; // materialised Swiss cells checked against oracle 1
    let pairs = 0; // adjacent ranked pairs checked against the ordered prefix
    let publicReads = 0; // calls of the exported reads (buchholz, buchholzCut1, sonnebornBerger, opponentsDiff) checked against oracle 1
    // Each disagreement with oracle 1, collected (and asserted empty once, below): 450k cells and pairs, one expect apiece,
    // would cost more than the sweep.
    const disagreements: string[] = [];
    const decidedBy = new Map<string, number>(); // the Swiss key that first separated an adjacent pair, by key
    const categories = new Map<string, number>(); // ledger cards seen, by 16.2 category ("played" for a game)
    const results = new Map<GameResult, number>();
    const sizes = new Set<number>();
    const perSport = new Map<string, number>();
    let lotsDrawn = 0;

    const n = forEachSport(({ module: m }) => {
      declaredCfgs(m as never).forEach(({ name, cfg }, cfgIndex) => {
        const s = sportOf(m, name, cfg);
        const key = `${m.key}/${name}`;
        const hash = createHash("sha256");
        digests.set(key, hash);
        const fieldSizes: readonly number[] = cfgIndex === 0 ? [...SMALL, ...LARGE] : SMALL;
        declared += fieldSizes.length * 2 * AT.length;
        for (const size of fieldSizes) {
          const field = fieldOf(s, size, 20261122 + size);
          for (const [chainName, chain] of [["own", s.chain], ["all-swiss", ALL_SWISS]] as const) {
            for (const at of AT) {
              const id = `${key}/${chainName}/n${size}/at${at}`;
              const { stage, fixtures } = stageAt(s, chain, field, at);
              const done = completeTableStage(stage, fixtures);
              hash.update(`${id}\n${JSON.stringify(done)}\n`);
              const rows = done.tables.overall ?? [];
              expect(rows, `${id}: one row per entrant`).toHaveLength(size);

              const ledger = ledgerOf(s, stage, fixtures);
              for (const row of ledger) {
                for (const game of row.games) {
                  const cat = game.unplayed ?? "played";
                  categories.set(cat, (categories.get(cat) ?? 0) + 1);
                  results.set(game.result, (results.get(game.result) ?? 0) + 1);
                }
              }
              const read = oracleOf(ledger, rows);
              const unit = s.rule.unit === "half" ? 2 : 1;
              const scale: Record<SwissKey, number> = { buchholz_cut1: unit, buchholz: unit, sberger: 2 * unit, opp_diff: 1 };
              for (const row of rows) {
                for (const k of SWISS_KEYS) {
                  const want = chain.includes(k) ? read(k, row) / scale[k] : undefined;
                  if (!Object.is(row.metrics[k], want)) disagreements.push(`${id} ${row.entrantId} ${k}: ${row.metrics[k]}, pre-change ${want}`);
                  if (want !== undefined) columns++;
                }
              }
              // The exported reads keep their 10.0.3 results (they still index per call, so the small fields only, once per ledger).
              if (chainName === "own" && size <= Math.max(...SMALL)) {
                for (const row of rows) {
                  const e = row.entrantId;
                  const got = [buchholz(ledger, e), buchholz(ledger, e, { cut: 1 }), buchholzCut1(ledger, e), sonnebornBerger(ledger, e), opponentsDiff(ledger, rows, e)];
                  const want = [read("buchholz", row), read("buchholz_cut1", row), read("buchholz_cut1", row), read("sberger", row), read("opp_diff", row)];
                  got.forEach((v, i) => {
                    if (!Object.is(v, want[i])) disagreements.push(`${id} ${e}: exported read #${i} ${v}, pre-change ${want[i]}`);
                    publicReads++;
                  });
                }
              }
              const prefix = orderedPrefix(chain);
              for (let i = 0; i + 1 < rows.length; i++) {
                const [hi, lo] = [rows[i] as StandingsRow, rows[i + 1] as StandingsRow];
                for (const k of prefix) {
                  const [a, b] = [read(k, hi), read(k, lo)];
                  if (a === b) continue;
                  if (!(a > b)) disagreements.push(`${id}: ${hi.entrantId} (${k} ${a}) above ${lo.entrantId} (${k} ${b}) on ${prefix.join(" > ")}`);
                  if (k !== "points") decidedBy.set(k, (decidedBy.get(k) ?? 0) + 1);
                  break;
                }
                pairs++;
              }
              lotsDrawn += done.newLotsDraws.length;
              if (at === 0) emptyCases++;
              if (at === "5-mid") midRoundCases++;
              sizes.add(size);
              perSport.set(m.key, (perSport.get(m.key) ?? 0) + 1);
              cases++;
            }
          }
        }
      });
    });

    const actual = Object.fromEntries([...digests].map(([k, h]) => [k, h.digest("hex")]));
    expect(disagreements.slice(0, 20), `${disagreements.length} disagreements with the pre-change reads`).toEqual([]);
    // Anti-vacuity: every sport, every size, the empty table and the mid-round refold, every Swiss key deciding real pairs,
    // and every 16.2 category and game result on some card.
    expect(n).toBe(builtinModules.length);
    expect(publicReads, "the exported reads, checked").toBeGreaterThan(0);
    expect(perSport.size, "every sport checked").toBe(n);
    expect([...sizes].sort((a, b) => a - b), "every field size").toEqual([...SMALL, ...LARGE]);
    expect(emptyCases, "the empty table, ranked").toBeGreaterThan(0);
    expect(midRoundCases, "a mid-round refold, ranked").toBeGreaterThan(0);
    for (const k of SWISS_KEYS) expect(decidedBy.get(k) ?? 0, `adjacent pairs ${k} decided`).toBeGreaterThan(0);
    for (const cat of ["played", "bye", "forfeit_win", "forfeit_loss", "absent", "absent_last"]) {
      expect(categories.get(cat) ?? 0, `ledger cards of category ${cat}`).toBeGreaterThan(0);
    }
    for (const r of GAME_RESULTS) expect(results.get(r) ?? 0, `cards that are a ${r}`).toBeGreaterThan(0);
    expect(lotsDrawn, "lots drawn for residual ties").toBeGreaterThan(0);
    expect(cases, "every declared case ranked").toBe(declared);
    expect(columns, "Swiss columns checked").toBeGreaterThan(0);
    expect(pairs, "ranked pairs checked").toBeGreaterThan(0);
    expect(Object.keys(actual), "one recording per sport and cfg").toEqual(Object.keys(RECORDED));
    expect(actual).toEqual(RECORDED);
  }, 300_000);
});
