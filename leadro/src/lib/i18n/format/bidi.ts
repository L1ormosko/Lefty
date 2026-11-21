/** Unicode bidi isolates (UAX #9): contain the wrapped text so it cannot reorder its neighbours. */
const LEFT_TO_RIGHT_ISOLATE = "⁦";
const RIGHT_TO_LEFT_ISOLATE = "⁧";
const POP_DIRECTIONAL_ISOLATE = "⁩";

/**
 * Wraps always-left-to-right content (phone numbers, emails, IDs, URLs) so it renders correctly
 * inside right-to-left text such as Hebrew (§16.4 mixed-direction content). Use for plain-text
 * output; in JSX prefer `<bdi dir="ltr">`. Harmless in LTR contexts.
 */
export function isolateLtr(text: string): string {
  return `${LEFT_TO_RIGHT_ISOLATE}${text}${POP_DIRECTIONAL_ISOLATE}`;
}

/** Wraps user-entered text of unknown direction (names, notes) embedded in a sentence. */
export function isolateRtl(text: string): string {
  return `${RIGHT_TO_LEFT_ISOLATE}${text}${POP_DIRECTIONAL_ISOLATE}`;
}
