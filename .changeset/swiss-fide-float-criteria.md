---
"@seazn-club/seazn-engine": minor
---

Swiss pairing applies FIDE's float criteria (C.04.3 Dutch, 1 February 2026; rule X-SW-32).

**New optional field.** `SwissHistory` gains `rounds: SwissRoundFacts[]`. It lists every earlier round of the stage, oldest first. Each round carries:
- its boards: `home`, `away`, and both sides' scores before that round;
- `forfeit: "home" | "away" | "none"` on a board that was not played;
- its pairing-allocated `bye`.

**What the pairer does with it.** When `rounds` is present, `pairRound` derives who floated which way in each round itself (Art. 1.4.2–1.4.4):
- On a played board between different scores, the higher side downfloats and the lower side upfloats.
- A bye and a forfeit win are downfloats.
- A forfeit loss, a double forfeit and an equal-score board are not floats.

In each score group, after the fewest floaters, it weighs [C7] (the floaters' scores) and then [C14]–[C21] in FIDE's order, over the previous round and the one before it. Two details:
- **A moved-down player left unpaired (the Limbo, Art. 3.2.4).** It counts for [C18]/[C20] with the pre-2026 A.8 PSD value: its score less one point under the bracket's lowest. This follows a controller ruling on FIDE's intent; the 2026 text gives it none.
- **The bye.** It is the last bracket's downfloater (Art. 1.9.1), so among equal-score candidates it goes first to one who did not downfloat the previous round, then to one who did not two rounds before.

**New export.** `swissRoundFloats(round)` returns one round's floats.

**Facts that are refused `CONFIG_INVALID`.** Facts are refused when they:
- seat an entrant twice;
- give a score that is not a finite number;
- mark a forfeit other than those three;
- miss a meeting: a pair in `played` that no round holds as a played board.

**Deviations kept (recorded in X-SW-32).**
- The colour criteria [C8]–[C13] are not applied.
- Candidates that tie on every criterion resolve in the engine's order, not FIDE's S1/S2 transpositions and exchanges.
- Two moved-down players may be seated together.
- The bye is chosen before the brackets.
- The whole-remainder fallback ignores the float criteria.
- A requested half-point bye has no fact shape.

**Deprecation.** `SwissHistory.floats` is deprecated. It is read only when `rounds` is absent, and then exactly as in 10.0.4; a pinned corpus proves the output byte-identical.

**Other.** The testkit simulation now builds `rounds`. Pairing is not part of the fold, so no golden or `FOLD_EPOCH` moves. To adopt the change, the app sends `rounds` instead of `floats`, with every meeting in `played` held as a played board.
