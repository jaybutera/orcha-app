// Parses a herdr pane capture into transcript blocks (DESIGN.md 5.3a).
//
// The rules are the orchestrator's own (`extractLastAgentMessage` and
// PANE_CHROME in index.mjs), generalised to keep every block rather than only
// the last prose one. The Terminal view is the fallback whenever a Claude Code
// release moves the rendering out from under this, so this parser is allowed to
// be wrong without the screen becoming useless.

export type Block =
  | { kind: 'message'; text: string }
  | { kind: 'tool'; head: string; result: string[] }
  | { kind: 'user'; text: string }
  | { kind: 'dialog'; lines: string[] }
  | { kind: 'spinner'; word: string; elapsed: string }
  /** The whole screen, when no glyph in it was recognised. */
  | { kind: 'raw'; text: string };

/**
 * The glyph an agent puts in front of its own turn.
 *
 * Claude Code draws `●`/`⏺`; Codex draws `•`. Both are in one class because the
 * rest of the grammar below is the same shape for either TUI, and because a
 * pane's provider is not always known: `/panes` reports `unknown` for an agent
 * herdr cannot identify, and the parser still has to do something useful.
 * Matching both glyphs everywhere is what makes that possible.
 *
 * Before `•` was here a live Codex pane parsed to zero blocks from 199 lines of
 * real output (measured against pane wH5:p1 on 2026-09-14), and the Messages
 * view rendered nothing at all.
 */
const MSG_BULLET = /^[●⏺•]\s?/;
const TOOL_HEAD = /^[A-Za-z][\w-]*\(/;
/** `❯` is Claude Code's input line, `›` is Codex's. */
const USER_PROMPT = /^\s*[❯›]\s?(.*)$/;
/** Only a corner glyph opens a dialog. A bare `│` also starts every row of a
 *  markdown table the agent printed inside its own prose (observed in a live
 *  pane on 2026-09-06), so matching it would turn tables into DialogCards. */
const BOX_OPEN = /^\s*[╭┌]/;
const BOX_BODY = /^\s*[╭╰│├└┌┐┘]/;
/** `✻ Sautéed for 38m 2s · done 12:34 PM` and `✢ Skedaddling… (24s · ↓ 1.4k tokens)`
 *  are both live spinner lines; the parenthesised form is the one section 5.3a
 *  quotes, the `for …` form is what a finished turn leaves on screen. */
const SPINNER_LINE = /^\s*([✢✻✽✶✳])\s+(.*)$/;
const RESULT_LINE = /^\s*⎿\s?/;
const RULE_LINE = /^\s*[─━]{3,}\s*$/;

// Lines that end the transcript area: input box, status bar, spinner, recap.
// `›` is Codex's input line, the counterpart of Claude Code's `❯`; without it a
// Codex message block ran on through the composer and the model/cwd status bar.
const PANE_FOOTER = /^\s*(?:[─━]{3,}\s*$|[❯›]|⏵|[✻✽✶✳✢]\s|※)/;

const PANE_CHROME: RegExp[] = [
  /^\s*[─━]{3,}\s*$/,
  /^\s*⧉/,
  /\/clear to save \S+ tokens/,
  /\(disable recaps in \/config\)/,
  /^\s*\? for shortcuts/,
  /^\s*esc to interrupt/,
  /^\s*(Ran|Read|Made|Wrote|Edited|Searched|Recalled|Listed|Fetched)\b.{0,80}\b(shell commands?|files?|edits?|memor(?:y|ies)|scratchpad|searches)\s*$/,
];

function isChrome(line: string): boolean {
  return PANE_CHROME.some((re) => re.test(line));
}

/** Collapses runs of blank lines and trims, the orchestrator's toExcerpt. */
function toExcerpt(bodyLines: string[]): string {
  const kept: string[] = [];
  for (const raw of bodyLines) {
    const line = raw.trim();
    if (!line) {
      if (kept.length && kept[kept.length - 1] !== '') kept.push('');
      continue;
    }
    kept.push(line);
  }
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  return kept.join('\n');
}

export function parsePane(paneText: string): Block[] {
  const lines = paneText.split('\n').map((l) => l.replace(/\s+$/, ''));
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // A box opened by a corner glyph is a permission or trust dialog: keep it
    // whole, borders included, so the numbered options stay readable.
    if (BOX_OPEN.test(line)) {
      const box: string[] = [];
      while (i < lines.length && BOX_BODY.test(lines[i])) {
        box.push(lines[i]);
        i++;
      }
      if (box.length) blocks.push({ kind: 'dialog', lines: box });
      continue;
    }

    // Spinner: the live "thinking" line, always last when present.
    const spin = SPINNER_LINE.exec(line);
    if (spin) {
      const rest = spin[2].trim();
      // Word is the first token; elapsed is the first duration anywhere after it.
      const word = rest.split(/[\s…(·]/)[0].replace(/…$/, '');
      const elapsed = /(\d+\s*h\s*)?(\d+\s*m\s*)?(\d+\s*s)|(\d+\s*[smh])/.exec(rest)?.[0]?.trim() ?? '';
      blocks.push({ kind: 'spinner', word, elapsed });
      i++;
      continue;
    }

    // Casper's own prompt, echoed in the pane.
    const user = USER_PROMPT.exec(line);
    if (user) {
      const text = user[1].trim();
      // A bare "❯" is the empty input box, not a message.
      if (text) blocks.push({ kind: 'user', text });
      i++;
      continue;
    }

    if (MSG_BULLET.test(line)) {
      const head = line.replace(MSG_BULLET, '').trim();

      if (TOOL_HEAD.test(head)) {
        // "● Bash(…)" — a tool call. The ⎿ lines under it are its result.
        const result: string[] = [];
        i++;
        while (i < lines.length) {
          const next = lines[i];
          if (MSG_BULLET.test(next) || BOX_OPEN.test(next) || PANE_FOOTER.test(next)) break;
          if (RESULT_LINE.test(next)) {
            result.push(next.replace(RESULT_LINE, '').trim());
          } else if (next.trim() && result.length) {
            // Continuation of the previous result line, indented under it.
            result.push(next.trim());
          } else if (!next.trim()) {
            break;
          }
          i++;
        }
        blocks.push({ kind: 'tool', head, result });
        continue;
      }

      // Assistant prose: runs until the next bullet or a footer line.
      const body = [head];
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (MSG_BULLET.test(next) || BOX_OPEN.test(next) || PANE_FOOTER.test(next)) break;
        body.push(next.replace(/^ {2}/, ''));
        i++;
      }
      const text = toExcerpt(body.filter((l) => !isChrome(l)));
      if (text) blocks.push({ kind: 'message', text });
      continue;
    }

    i++;
  }

  // Nothing matched, but the pane is not empty: a TUI this grammar has never
  // seen, or one that moved out from under it in a release. The screen's own
  // text is worth more than an empty Messages view, which is what a pane with
  // no recognised glyph used to render (a live Codex pane, every time). The
  // Terminal tab shows the same text; this is the Messages tab refusing to
  // claim there is nothing to read.
  // The footer goes too, not just the chrome: an idle pane is often nothing but
  // its own empty input box and status bar, and echoing that back as a message
  // would turn "this agent has said nothing yet" into a wall of furniture.
  if (!blocks.length) {
    const text = toExcerpt(lines.filter((l) => !isChrome(l) && !PANE_FOOTER.test(l)));
    if (text) blocks.push({ kind: 'raw', text });
  }

  return blocks;
}

/** Spinner glyphs, cycled at 8 fps by SpinnerLine (section 5.3a). */
export const SPINNER_GLYPHS = ['✢', '✻', '✽', '✶', '✳'];

export { RULE_LINE, isChrome };
