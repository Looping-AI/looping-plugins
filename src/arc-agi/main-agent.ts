import type { DelegationNames } from "@loopingai/core";

/**
 * Everything the **main agent** is told about ARC-AGI-3 — the counterpart to
 * {@link file://./soul.ts}, which is what the *subagent* playing a game is told.
 *
 * Both blocks used to be hand-written inside `agent/` (`prompt.ts`'s
 * `ARC_CAPABILITY` and a `## Playing an ARC-AGI-3 game` section of
 * `turn.ts`'s round contract). The main agent's system prompt is soul +
 * round contract concatenated, so it read ARC advice twice per round from two
 * files with no reason to agree — and they had stopped agreeing: one said to
 * delegate a subtask per game, the other said to delegate exactly one subtask and
 * nothing else. They are one file now, and the guidance below follows the
 * capability block.
 */

/**
 * The capability block: what the agent can do, and what to do with a result that
 * comes back. Deliberately names no scorecard tool and no `card_id` — the card is
 * leased by the recipe per chunk and is not this model's to manage, so naming one
 * would only invite a call to a tool that does not exist.
 */
export const ARC_CAPABILITY = [
  "You can run ARC-AGI-3 games, played for you by subagents:",
  "- `arc_list_games` shows the available games with their exact ids and tags describing how each is played.",
  "- To have a game played, delegate a subtask of type `arc-game` with param `game_id` (an exact id from `arc_list_games`). That is the whole contract — there is no scorecard for you to open, choose, or close.",
  "- To have several games played, delegate one `arc-game` subtask per game; they run concurrently.",
  "- Each play's report ends with that game's score, read from the scorecard once the play finishes. Report that score rather than inventing one — and if a report carries no score line, say the score was unavailable.",
  "- A play's report also carries what it learned: the mechanics it confirmed, what it never got to test, and where the level's pieces are. That is the only record of it — the subagent keeps nothing between plays. Record what generalizes (mechanics, geography, what failed and why) so the next play starts from it, and keep it separate from what is merely suspected. Spent scorecard ids and other one-off residue are not worth keeping."
].join("\n");

/**
 * The delegation guidance: how to build the `delegate` payload for a play. What
 * the capability block already says is not repeated here, and neither is the
 * params schema — the `delegate` tool description renders that from the type.
 */
export function arcDelegationGuidance(names: DelegationNames): string {
  return `## Playing an ARC-AGI-3 game

When the user asks for a game to be played (e.g. "play game ls20"), you can
delegate in parallel subtasks of "type": "arc-game" per game they named.

Each of those subtasks carries "params": { "game_id": "<id>" }, an exact id from
\`arc_list_games\`. The param is what starts the play, and the "prompt" is never a
substitute for it. Restate the request in the "prompt" as well (e.g. "Play the
ARC-AGI-3 game ls20."), so the subagent knows what it was asked for.

If the request does not name a game, or names it loosely — call \`arc_list_games\`
first and delegate the id associated with "ls20". Never invent an id or pass through
the user's wording as one. If nothing in the list matches well enough to choose,
ask the user which game they mean with \`${names.finalReplyTool}\` rather than guessing.

### What to put in the prompt

Give it the goal, and give it what earlier plays actually established — labeled as
what it is. Write "an earlier play observed …" for something a play reported seeing,
and "we suspect …" for a hypothesis, so it can tell what to verify from what to use.
A route or a map you pass down is a guess about a level nobody has finished; stated
as fact, it gets followed off a cliff.

Do **not** state mechanics of the tools or the budget: how many actions it has, how
many moves fit in one call, how many turns it may spend. It is told all of that
directly, it is told correctly, and a number you supply that disagrees will be
believed over the truth — a play once stopped early because its prompt said it had
"20 actions total" when 20 was its turn budget.

These subtasks take several minutes — acknowledge in your "reply" that you have started playing
and will report back, without promising a time.`;
}
