// W4 test driver (plan 2026-11-05-w4-knockout-engine.md, Task 6): plays a generated bracket out into the `BracketFixture`
// rows the app's `bracketWinnerLoser` writes (apps/web/src/server/engine-db/competition.ts), so a ranking test folds the
// GENERATOR's own output rather than a hand-typed fixture list. Not exported from the testkit index: a test imports it
// by path. It reads only the generator's shape (types) and writes only stage-shaped rows (types).
//
// Feeds resolve round by round, in the generator's order (every feed names an earlier fixture):
//   - a bye `award` is a walkover with a winner and no loser (the app's row for a bye);
//   - `withdraw`: the named entrant is out of the stage there (withdrawn or disqualified) — a walkover the other side
//     wins, `walkedOver: "loser"`; its onward LOSER feeds (a third-place play-off, a page playoff's Qualifier 2, a
//     losers'-bracket seat) are dead (X-DE-1, RB6-F4; controller ruling B3-10). In a knockout a forfeit is this row too;
//   - `oneLossForfeit`: the named entrant forfeits ONE match (a no-show, an award against them, a retirement) — a
//     walkover the other side wins, with a winner and a loser and NO `walkedOver`, as the app writes a double
//     elimination's forfeit (RB6-F1, F3, F9, F11): the forfeiter drops to the losers'-bracket seat like any loser;
//   - `doubleWalkover`: both sides walked over — `walkedOver: "both"`, no winner and no loser, every onward seat dead;
//   - `voided`: the fixture is void, nobody advances from it;
//   - `jointFinal`: the final, both sides seated, is decided with no winner — `jointWinners: true` (Q4, X-CH-1) — so a
//     double-elimination bracket reset after it has no one to seat and is void;
//   - a fixture with one seat dead is a walkover to the side present (no loser); with both dead it is void;
//   - a double-elim bracket reset (`conditional`) is played only when it is owed (`resetOwed`, the one reading: the
//     losers'-bracket champion won the grand final, X-DE-11), and voided otherwise (spec 05 §2.4, RB6-G6);
//   - otherwise it is decided by `winner(home, away)`, by default the better seed (the lower seed number; home on a tie).
import type { EntrantId } from "../core/types.ts";
import { resetOwed, type BracketFixture } from "../competition/stage.ts";
import type { BracketSlotRef, GeneratedBracket } from "../scheduling/bracket.ts";

export interface PlayOutOptions {
  /** Who wins a fixture played between two seated sides. Default: the better seed (lower number), home on a tie. */
  winner?: (home: EntrantId, away: EntrantId) => EntrantId;
  /** The seeds the default winner reads. Absent = every side unseeded (home wins). */
  seeds?: ReadonlyMap<EntrantId, number>;
  /** Fixture id → the entrant who is out of the stage there, withdrawn or disqualified (the loser, `walkedOver: "loser"`). */
  withdraw?: ReadonlyMap<string, EntrantId>;
  /** Fixture id → the entrant who forfeits that one match (the loser of a walkover, no `walkedOver`): one loss, not out. */
  oneLossForfeit?: ReadonlyMap<string, EntrantId>;
  /** Fixture ids both sides walked over (`walkedOver: "both"`). */
  doubleWalkover?: ReadonlySet<string>;
  /** Fixture ids voided. */
  voided?: ReadonlySet<string>;
  /** The final (both sides seated) ends in joint winners: `status: "decided"`, `jointWinners: true`, no winner or loser. */
  jointFinal?: boolean;
}

/** The rows carry neither the generator's feeds (`homeFrom` / `awayFrom`) nor `conditional`. A double elimination ranks a
 *  winners'-bracket exit by the losers'-bracket fixture its loser feed names (W6, RB6-R7), so a caller that ranks one
 *  with a winners'-bracket withdrawal or double walkover attaches the feeds first; without them that entrant shares the
 *  last place (the fallback). */
export function playOutBracket(gen: GeneratedBracket, opts: PlayOutOptions = {}): BracketFixture[] {
  const seedOf = (id: EntrantId): number => opts.seeds?.get(id) ?? Number.MAX_SAFE_INTEGER;
  const winnerOf = opts.winner ?? ((home: EntrantId, away: EntrantId): EntrantId => (seedOf(away) < seedOf(home) ? away : home));
  const byId = new Map<string, BracketFixture>();
  const rows: BracketFixture[] = [];
  const feedsOf = (g: GeneratedBracket["fixtures"][number]): Pick<BracketFixture, "homeFrom" | "awayFrom"> => ({
    ...(g.homeFrom === undefined ? {} : { homeFrom: g.homeFrom }),
    ...(g.awayFrom === undefined ? {} : { awayFrom: g.awayFrom }),
  });

  const feed = (ref: BracketSlotRef | undefined): EntrantId | undefined => {
    if (ref === undefined) return undefined;
    const source = byId.get(ref.fixtureId);
    if (source === undefined) throw new Error(`playOutBracket: "${ref.fixtureId}" is fed before it is played`);
    if (ref.side === "winner") return source.winner;
    // A withdrawn entrant is out at the fixture it walked over: it never takes a loser's seat onward (B3-10). A
    // one-loss forfeiter carries no `walkedOver` and drops like any loser.
    return source.walkedOver === "loser" ? undefined : source.loser;
  };

  for (const g of gen.fixtures) {
    const home = g.home ?? feed(g.homeFrom);
    const away = g.away ?? feed(g.awayFrom);
    const base: BracketFixture = {
      id: g.id,
      round: g.round,
      ...(g.bracket === undefined ? {} : { bracket: g.bracket }),
      ...(g.isFinal === undefined ? {} : { isFinal: g.isFinal }),
      ...(g.thirdPlace === undefined ? {} : { thirdPlace: g.thirdPlace }),
      ...(home === undefined ? {} : { home }),
      ...(away === undefined ? {} : { away }),
      status: "scheduled",
    };
    let row: BracketFixture;
    // `resetOwed` reads the rows played so far with the generator's feeds attached (the returned rows carry none); row
    // i is gen.fixtures[i], one row per generated fixture.
    const resetNotNeeded =
      g.conditional === true &&
      !resetOwed([...rows.map((played, i) => ({ ...played, ...feedsOf(gen.fixtures[i] as typeof g) })), { ...base, ...feedsOf(g), conditional: true }]);
    const withdrawn = opts.withdraw?.get(g.id);
    const forfeiter = opts.oneLossForfeit?.get(g.id);
    const present = home ?? away; // the one side seated, when only one is
    const walkoverAgainst = (loser: EntrantId): BracketFixture => {
      if (loser !== home && loser !== away) throw new Error(`playOutBracket: "${loser}" is not seated in ${g.id}`);
      return { ...base, status: "walkover", winner: loser === home ? away : home, loser };
    };
    if (g.award !== undefined) {
      row = { ...base, status: "walkover", winner: g.award };
    } else if (opts.voided?.has(g.id) === true || resetNotNeeded) {
      row = { ...base, status: "void" };
    } else if (home !== undefined && away !== undefined && opts.doubleWalkover?.has(g.id) === true) {
      row = { ...base, status: "walkover", walkedOver: "both" };
    } else if (home !== undefined && away !== undefined && withdrawn !== undefined) {
      row = { ...walkoverAgainst(withdrawn), walkedOver: "loser" };
    } else if (home !== undefined && away !== undefined && forfeiter !== undefined) {
      row = walkoverAgainst(forfeiter);
    } else if (home !== undefined && away !== undefined && opts.jointFinal === true && g.isFinal === true) {
      row = { ...base, status: "decided", jointWinners: true };
    } else if (home !== undefined && away !== undefined) {
      const winner = winnerOf(home, away);
      row = { ...base, status: "decided", winner, loser: winner === home ? away : home };
    } else if (present !== undefined) {
      row = { ...base, status: "walkover", winner: present };
    } else {
      row = { ...base, status: "void" };
    }
    byId.set(g.id, row);
    rows.push(row);
  }
  return rows;
}
