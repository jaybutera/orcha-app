import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parsePane } from '../src/lib/pane-parse';

const real = readFileSync(new URL('./fixtures-pane-real.txt', import.meta.url), 'utf8');
/** A live Codex pane, captured from wH5:p1 through the bridge on 2026-09-14. */
const codex = readFileSync(new URL('./fixtures-pane-codex.txt', import.meta.url), 'utf8');

describe('parsePane', () => {
  it('keeps every prose block, not only the last', () => {
    const blocks = parsePane(real);
    const messages = blocks.filter((b) => b.kind === 'message');
    expect(messages.length).toBeGreaterThan(2);
  });

  it('reads the user prompt echoed after ❯', () => {
    const blocks = parsePane(real);
    const user = blocks.find((b) => b.kind === 'user');
    expect(user).toBeDefined();
    expect(user && user.kind === 'user' && user.text).toContain('connection dropped mid-response');
  });

  it('ignores the empty input box', () => {
    const blocks = parsePane('❯ \n');
    expect(blocks).toHaveLength(0);
  });

  it('renders a tool call as a tool block with its ⎿ result', () => {
    const text = ['● Write(src/lib/pane-parse.ts)', '  ⎿  Wrote 147 lines to src/lib/pane-parse.ts'].join(
      '\n'
    );
    const blocks = parsePane(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: 'tool',
      head: 'Write(src/lib/pane-parse.ts)',
      result: ['Wrote 147 lines to src/lib/pane-parse.ts'],
    });
  });

  it('treats prose starting with a bullet as a message, not a tool', () => {
    const blocks = parsePane('● Now the pane-text parser, the trickiest piece.');
    expect(blocks[0].kind).toBe('message');
  });

  it('parses the parenthesised spinner from the spec', () => {
    const blocks = parsePane('✢ Skedaddling… (24s · ↓ 1.4k tokens)');
    expect(blocks[0]).toMatchObject({ kind: 'spinner', word: 'Skedaddling', elapsed: '24s' });
  });

  it('parses the "for" spinner form a finished turn leaves on screen', () => {
    const blocks = parsePane('✻ Sautéed for 38m 2s · done 12:34 PM');
    expect(blocks[0]).toMatchObject({ kind: 'spinner', word: 'Sautéed' });
  });

  it('collects a corner-opened box as one dialog', () => {
    const text = [
      '╭─────────────────────────╮',
      '│ Do you trust this folder?',
      '│  1. Yes                 │',
      '│  2. No                  │',
      '╰─────────────────────────╯',
    ].join('\n');
    const blocks = parsePane(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('dialog');
    expect(blocks[0].kind === 'dialog' && blocks[0].lines).toHaveLength(5);
  });

  it('does not turn a markdown table inside prose into a dialog', () => {
    // Observed in a live pane on 2026-09-06: an agent printing a table emits
    // rows starting with │, which must stay part of the prose block.
    const text = [
      '● Here is the ledger:',
      '  │ Project    │ Running │',
      '  │ zpay v2    │ 0       │',
    ].join('\n');
    const blocks = parsePane(text);
    expect(blocks.every((b) => b.kind !== 'dialog')).toBe(true);
  });

  it('drops the chrome lines the orchestrator drops', () => {
    const text = ['● Wrote the file.', '  Ran 1 shell command', '  ? for shortcuts'].join('\n');
    const blocks = parsePane(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind === 'message' && blocks[0].text).toBe('Wrote the file.');
  });

  it('stops a prose block at the footer rule', () => {
    const text = [
      '● The answer is 4.',
      '───────────────────────────',
      '❯ next question',
    ].join('\n');
    const blocks = parsePane(text);
    const msg = blocks.find((b) => b.kind === 'message');
    expect(msg && msg.kind === 'message' && msg.text).toBe('The answer is 4.');
  });

  it('returns nothing for an empty pane', () => {
    expect(parsePane('')).toEqual([]);
    expect(parsePane('\n\n  \n')).toEqual([]);
  });

  // Codex draws its turns with `•` and its input line with `›`, where Claude
  // Code uses `●` and `❯`. Against this fixture the Claude-only grammar
  // produced zero blocks from 198 lines, so the Messages view of every Codex
  // session was blank while the pane read had succeeded.
  describe('a Codex pane', () => {
    const blocks = parsePane(codex);

    it('is not empty', () => {
      expect(blocks.length).toBeGreaterThan(0);
      expect(blocks.some((b) => b.kind === 'message')).toBe(true);
    });

    it('reads the agent prose off the screen', () => {
      const first = blocks.find((b) => b.kind === 'message');
      expect(first && first.kind === 'message' && first.text).toContain(
        'This shares the core of our latest design'
      );
    });

    it('keeps the operator’s own lines apart from the agent’s', () => {
      expect(blocks.some((b) => b.kind === 'user')).toBe(true);
    });

    it('does not fall back to the raw screen when the grammar matched', () => {
      // `raw` is the last resort for an unrecognised TUI. Seeing it here would
      // mean the Codex glyphs stopped matching and the fixture was carrying
      // the test on the fallback alone.
      expect(blocks.some((b) => b.kind === 'raw')).toBe(false);
    });

    it('does not swallow the composer into the last message', () => {
      const texts = blocks.filter((b) => b.kind === 'message').map((b) => (b as { text: string }).text);
      expect(texts.some((t) => t.includes('Ask Codex to do anything'))).toBe(false);
    });
  });

  // The parser is allowed to be wrong about a TUI it has never seen; it is not
  // allowed to render that pane as nothing. The Terminal tab shows the same
  // text, and this is the Messages tab declining to claim the pane is silent.
  describe('a pane whose grammar is unrecognised', () => {
    it('falls back to the screen text rather than an empty view', () => {
      const text = ['agent> thinking about it', 'the answer is 4', 'done in 3s'].join('\n');
      const blocks = parsePane(text);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind === 'raw' && blocks[0].text).toContain('the answer is 4');
    });

    it('still returns nothing when the screen really is blank', () => {
      expect(parsePane('   \n\n  ')).toEqual([]);
    });
  });
});

// A prompt longer than the pane is wide wraps, and the continuation lines carry
// no glyph. They used to match nothing and be discarded, so a reader saw the
// first line of their own message and nothing after it. Rare on Claude Code,
// the common case on Codex, whose composer takes multi-line input.
describe('a prompt that wrapped across lines', () => {
  it('keeps the continuation, not just the first line', () => {
    const text = [
      '› what do you mean eliminate migration machinery? When it comes to defi,',
      '  every line we change must be audited',
      '',
      '• I think that is a credible concern.',
    ].join('\n');
    const user = parsePane(text).find((b) => b.kind === 'user');
    expect(user && user.kind === 'user' && user.text).toContain('every line we change must be audited');
  });

  it('ends the prompt at the blank line, not at the next glyph', () => {
    // The empty composer's own prompt line sits two lines above the model and
    // cwd status bar. Running past the blank line would absorb it.
    const text = ['› ', '', '  gpt-6-astra medium · ~/src/launchpad-integrated'].join('\n');
    const user = parsePane(text).find((b) => b.kind === 'user');
    expect(user).toBeUndefined();
  });

  it('does not take an indented agent bullet as a continuation', () => {
    const text = ['❯ run the tests', '  ● Running them now.'].join('\n');
    const blocks = parsePane(text);
    const user = blocks.find((b) => b.kind === 'user');
    expect(user && user.kind === 'user' && user.text).toBe('run the tests');
  });

  it('reads the wrapped prompts out of the live Codex capture', () => {
    const users = parsePane(codex).filter((b) => b.kind === 'user') as { text: string }[];
    expect(users.some((u) => u.text.includes('\n'))).toBe(true);
    // The status bar is not part of anything Casper typed.
    expect(users.some((u) => u.text.includes('gpt-6-astra'))).toBe(false);
  });

  it('does not read the empty composer placeholder as a message', () => {
    // "Ask Codex to do anything" is drawn inside the input box, on the prompt
    // line, so it read as the last thing Casper said in every idle Codex pane.
    const users = parsePane(codex).filter((b) => b.kind === 'user') as { text: string }[];
    expect(users.some((u) => u.text.includes('Ask Codex to do anything'))).toBe(false);
  });
});
