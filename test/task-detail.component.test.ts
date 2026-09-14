// Task detail against a bridge that behaves like the real one.
//
// The reported bug lived here rather than in the status logic: the pane read
// asked for a pane id the bridge had never issued, took the resulting 404 as
// proof the session was dead, and then stopped the only poll that could have
// corrected it.

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { app } from '../src/lib/store.svelte';
import { ApiError, PANE_LINES, PANE_LINES_MAX } from '../src/lib/api';
import type { Machine, Pane, TaskDetail as TaskDetailShape } from '../src/lib/types';

// The bridge the app talks to, standing in for the live one. `read` answers
// only for `box/wC:p1`, exactly as the real bridge does: the untranslated ref
// `box:wC:p1` gets HTTP 404 "pane gone".
const reads = vi.fn();
const panes = vi.fn();
const task = vi.fn();

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return {
    ...actual,
    projtrack: { task: (...a: unknown[]) => task(...a), addNote: vi.fn(), setTaskStatus: vi.fn() },
    bridge: {
      read: (...a: unknown[]) => reads(...a),
      pane: (...a: unknown[]) => panes(...a),
      send: vi.fn(),
      keys: vi.fn(),
      text: vi.fn(),
    },
  };
});

const { default: TaskDetail } = await import('../src/screens/TaskDetail.svelte');
const { app: store } = await import('../src/lib/store.svelte');

/** Task 103 as projtrack actually holds it. */
const TASK_103: TaskDetailShape = {
  id: 103,
  project_id: 5,
  title: 'traffic-harness fix round 1 on box',
  status: 'running',
  session_ref: 'box:wC:p1',
  result_summary: '',
  created_at: '2026-09-07T19:41:21Z',
  updated_at: '2026-09-07T19:46:16Z',
  events: [],
};

const BOX_PANE: Pane = {
  pane_id: 'box/wC:p1',
  machine: 'box',
  workspace_id: 'wC',
  label: 'traffic fix r1',
  cwd: '/home/casper/src/zecp2p-traffic',
  agent_status: 'working',
};

const MACHINES: Machine[] = [
  { name: 'local', reachable: true },
  { name: 'box', reachable: true },
];

/** The bridge answers for the id it issued and 404s on anything else. */
function bridgeAnsweringOnlyFor(paneId: string) {
  reads.mockImplementation(async (_s: unknown, id: string) => {
    if (id !== paneId) throw new ApiError('HTTP 404', 404);
    return {
      pane_id: paneId,
      machine: 'box',
      agent_status: 'working' as const,
      read_at: '2026-09-07T19:56:23Z',
      text: '● Now the sendrawtransaction handler:',
    };
  });
}

// Fake timers, so the pane poll can be advanced rather than waited on: several
// of these tests are about what the screen does on the ticks after the first,
// and the poll interval is seconds. `setTimeout` is left real so `flush` still
// yields to the microtask queue and to Svelte's own scheduling.
//
// `Date` is faked too, and the clock pinned to NOW below. The header prints
// `relativeTime(updated_at)`, which says "12 min ago" for a recent task and
// falls back to a bare date past 24 hours. Against the real clock these
// fixtures aged: the header quietly switched to "7 Sep" and the assertion that
// the task says when it was last touched failed on a screen that had not
// changed. The fixture timestamps are fixed, so the clock reading them has to
// be too.
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await new Promise((r) => realSetTimeout(r, 0));
};

const realSetTimeout = globalThis.setTimeout;

/** Twelve minutes after task 103 was last touched, two after its pane was read. */
const NOW = Date.parse('2026-09-07T19:58:16Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  task.mockResolvedValue(TASK_103);
  panes.mockResolvedValue(BOX_PANE);
  bridgeAnsweringOnlyFor('box/wC:p1');
  app.setPanes([]);
  app.setMachines([]);
  app.panesKnown = false;
  store.failures = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const draw = () => render(TaskDetail, { props: { taskId: 103, onBack: () => {} } });

describe('a session running on box', () => {
  it('reads the pane by the id the bridge issued, not the raw ref', async () => {
    app.setPanes([BOX_PANE]);
    app.setMachines(MACHINES);
    app.panesKnown = true;

    draw();
    await flush();

    expect(reads).toHaveBeenCalled();
    expect(reads.mock.calls.every((c) => c[1] === 'box/wC:p1')).toBe(true);
    // The untranslated ref is what produced the 404 in the live system.
    expect(reads.mock.calls.some((c) => c[1] === 'box:wC:p1')).toBe(false);
  });

  it('does not say "Pane gone" for a session the pane list shows working', async () => {
    app.setPanes([BOX_PANE]);
    app.setMachines(MACHINES);
    app.panesKnown = true;

    draw();
    await flush();

    expect(screen.queryByText('Pane gone')).toBeNull();
  });

  it('shows the transcript rather than an error', async () => {
    app.setPanes([BOX_PANE]);
    app.setMachines(MACHINES);
    app.panesKnown = true;

    draw();
    await flush();

    expect(screen.getByText(/sendrawtransaction/)).toBeTruthy();
  });

  it('asks the bridge nothing until the machine list can resolve the ref', async () => {
    // The window the bug lived in: the screen mounts before App's poll lands.
    draw();
    await flush();

    expect(reads).not.toHaveBeenCalled();
    expect(screen.queryByText('Pane gone')).toBeNull();
  });

  it('reads the pane on the tick the machine list arrives', async () => {
    draw();
    await flush();
    expect(reads).not.toHaveBeenCalled();

    app.setPanes([BOX_PANE]);
    app.setMachines(MACHINES);
    app.panesKnown = true;
    await flush();

    expect(reads).toHaveBeenCalledWith(expect.anything(), 'box/wC:p1', PANE_LINES);
    expect(screen.queryByText('Pane gone')).toBeNull();
  });
});

describe('a session whose pane really is gone', () => {
  it('says so once the pane list agrees', async () => {
    const dead = { ...TASK_103, session_ref: 'box:wZZ:p1' };
    task.mockResolvedValue(dead);
    app.setPanes([BOX_PANE]); // a different pane; wZZ:p1 is not there
    app.setMachines(MACHINES);
    app.panesKnown = true;

    draw();
    await flush();

    expect(screen.getByText('Pane gone')).toBeTruthy();
  });
});

describe('a session running on this laptop', () => {
  it('reads a local pane id unchanged', async () => {
    const local = { ...TASK_103, session_ref: 'w9K:p1' };
    task.mockResolvedValue(local);
    bridgeAnsweringOnlyFor('w9K:p1');
    app.setPanes([{ ...BOX_PANE, pane_id: 'w9K:p1', machine: 'local', workspace_id: 'w9K' }]);
    app.setMachines(MACHINES);
    app.panesKnown = true;

    draw();
    await flush();

    expect(reads).toHaveBeenCalledWith(expect.anything(), 'w9K:p1', PANE_LINES);
    expect(screen.queryByText('Pane gone')).toBeNull();
  });
});

// Should-fix 4. The latch: a 404 must not be able to switch off the only poll
// that could have corrected it. `shouldPollPane` cannot be tested for this from
// its arguments alone, because the flag the 404 sets is deliberately not one of
// them; it takes the screen, a bridge that 404s, and then answers.
describe('a read that 404s while the pane list says the session is working', () => {
  beforeEach(() => {
    app.setPanes([BOX_PANE]);
    app.setMachines(MACHINES);
    app.panesKnown = true;
  });

  it('does not say "Pane gone" on a 404 the list contradicts', async () => {
    // The bridge answers for nothing at all: every read 404s.
    reads.mockImplementation(async () => {
      throw new ApiError('HTTP 404', 404);
    });

    draw();
    await flush();

    expect(reads).toHaveBeenCalled();
    expect(screen.queryByText('Pane gone')).toBeNull();
  });

  it('keeps reading after the 404, and shows the transcript once one answers', async () => {
    // One 404, then the bridge starts answering. Nothing navigates away in
    // between; the screen has to correct itself where it stands.
    let first = true;
    reads.mockImplementation(async (_s: unknown, id: string) => {
      if (first) {
        first = false;
        throw new ApiError('HTTP 404', 404);
      }
      return {
        pane_id: id,
        machine: 'box',
        agent_status: 'working' as const,
        read_at: '2026-09-07T19:56:23Z',
        text: '● Now the sendrawtransaction handler:',
      };
    });

    draw();
    await flush();
    expect(screen.queryByText(/sendrawtransaction/)).toBeNull();

    // The poll fires again on its own; nothing about the screen changed.
    await vi.advanceTimersByTimeAsync(6000);
    await flush();

    expect(reads.mock.calls.length).toBeGreaterThan(1);
    expect(screen.getByText(/sendrawtransaction/)).toBeTruthy();
    expect(screen.queryByText('Pane gone')).toBeNull();
  });
});

// Round 2 should-fix. The gate was "the read 404d and the agent is not busy",
// so a single failed read against a pane the list was still holding latched
// "Pane gone" and switched the poll off. The bridge answers 404 for every read
// failure that is not a missing socket, its own 15 s exec timeout included, and
// most of the fleet's ledger-running tasks sit on a pane that is idle or done.
// Nothing then cleared it: idle and done never restarted the poll, and the poll
// was the only thing that could have.
describe('a read that 404s while the pane list still holds the pane', () => {
  /** The bridge 404s the first `n` reads, then answers with `status`. */
  function failsThenAnswers(n: number, status: 'working' | 'idle' = 'working') {
    let left = n;
    reads.mockImplementation(async (_s: unknown, id: string) => {
      if (left > 0) {
        left -= 1;
        throw new ApiError('HTTP 404', 404);
      }
      return {
        pane_id: id,
        machine: 'box',
        agent_status: status,
        read_at: '2026-09-07T19:56:23Z',
        text: '● Now the sendrawtransaction handler:',
      };
    });
  }

  for (const agent of ['idle', 'done'] as const) {
    it(`does not say "Pane gone" for a listed ${agent} pane whose read failed`, async () => {
      app.setPanes([{ ...BOX_PANE, agent_status: agent }]);
      app.setMachines(MACHINES);
      app.panesKnown = true;
      reads.mockImplementation(async () => {
        throw new ApiError('HTTP 404', 404);
      });

      draw();
      await flush();

      expect(reads).toHaveBeenCalled();
      expect(screen.queryByText('Pane gone')).toBeNull();
    });

    it(`keeps polling a listed ${agent} pane after a failed read`, async () => {
      app.setPanes([{ ...BOX_PANE, agent_status: agent }]);
      app.setMachines(MACHINES);
      app.panesKnown = true;
      reads.mockImplementation(async () => {
        throw new ApiError('HTTP 404', 404);
      });

      draw();
      await flush();
      const afterFirst = reads.mock.calls.length;

      await vi.advanceTimersByTimeAsync(30_000);
      await flush();

      expect(reads.mock.calls.length).toBeGreaterThan(afterFirst);
    });

    it(`recovers on the next successful read of a listed ${agent} pane`, async () => {
      // The live case: the pane sits idle in the list, one read times out and
      // the bridge maps it to 404, and the next one answers. The screen has to
      // correct itself where it stands, with nothing navigating away.
      app.setPanes([{ ...BOX_PANE, agent_status: agent }]);
      app.setMachines(MACHINES);
      app.panesKnown = true;
      failsThenAnswers(1, 'idle');

      draw();
      await flush();
      expect(screen.queryByText(/sendrawtransaction/)).toBeNull();
      expect(screen.queryByText('Pane gone')).toBeNull();

      await vi.advanceTimersByTimeAsync(6000);
      await flush();

      expect(screen.getByText(/sendrawtransaction/)).toBeTruthy();
      expect(screen.queryByText('Pane gone')).toBeNull();
    });
  }

  it('keeps the last transcript through a failed read', async () => {
    // Section 9: the transcript is never cleared. A read that 404s against a
    // listed pane must not take the text down with it.
    app.setPanes([{ ...BOX_PANE, agent_status: 'idle' }]);
    app.setMachines(MACHINES);
    app.panesKnown = true;

    let answered = false;
    reads.mockImplementation(async (_s: unknown, id: string) => {
      if (answered) throw new ApiError('HTTP 404', 404);
      answered = true;
      return {
        pane_id: id,
        machine: 'box',
        agent_status: 'idle' as const,
        read_at: '2026-09-07T19:56:23Z',
        text: '● Now the sendrawtransaction handler:',
      };
    });

    draw();
    await flush();
    expect(screen.getByText(/sendrawtransaction/)).toBeTruthy();

    await vi.advanceTimersByTimeAsync(12_000);
    await flush();

    expect(screen.getByText(/sendrawtransaction/)).toBeTruthy();
    expect(screen.queryByText('Pane gone')).toBeNull();
  });

  it('latches once the list itself drops the pane', async () => {
    // The list is what decides. While it holds the pane the 404s are retried;
    // the moment it stops holding it, the same 404 is believed.
    app.setPanes([{ ...BOX_PANE, agent_status: 'idle' }]);
    app.setMachines(MACHINES);
    app.panesKnown = true;
    reads.mockImplementation(async () => {
      throw new ApiError('HTTP 404', 404);
    });

    draw();
    await flush();
    expect(screen.queryByText('Pane gone')).toBeNull();

    app.setPanes([]);
    await flush();

    expect(screen.getByText('Pane gone')).toBeTruthy();
    const stopped = reads.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(reads.mock.calls.length).toBe(stopped);
  });
});

// Should-fix 2. The other side of the same coin. A 404 the pane list agrees with
// is an answer, and re-asking costs the bridge a `herdr pane read` exec every
// pane interval, over the ssh forward when the machine is remote.
describe('a read that 404s for a pane the list agrees is gone', () => {
  beforeEach(() => {
    task.mockResolvedValue({ ...TASK_103, session_ref: 'box:wZZ:p1' });
    app.setPanes([BOX_PANE]); // wZZ:p1 is not in it
    app.setMachines(MACHINES);
    app.panesKnown = true;
    reads.mockImplementation(async () => {
      throw new ApiError('HTTP 404', 404);
    });
  });

  it('stops reading rather than 404ing every pane interval', async () => {
    draw();
    await flush();

    expect(screen.getByText('Pane gone')).toBeTruthy();
    const after = reads.mock.calls.length;

    await vi.advanceTimersByTimeAsync(30_000);
    await flush();

    expect(reads.mock.calls.length).toBe(after);
  });

  it('reads again if the pane comes back into the list', async () => {
    draw();
    await flush();
    const stopped = reads.mock.calls.length;

    // The gate is the pane list, which keeps arriving from App's own poll. So
    // the screen can be told the pane is back without ever reading it.
    bridgeAnsweringOnlyFor('box/wZZ:p1');
    app.setPanes([BOX_PANE, { ...BOX_PANE, pane_id: 'box/wZZ:p1', workspace_id: 'wZZ' }]);
    await flush();
    await vi.advanceTimersByTimeAsync(6000);
    await flush();

    expect(reads.mock.calls.length).toBeGreaterThan(stopped);
    expect(screen.queryByText('Pane gone')).toBeNull();
  });
});

// Should-fix 5. The bridge answers 503 for a read against a machine it cannot
// reach. It answered, so it is up; treating that as a bridge failure put "Can't
// reach the pane bridge" on screen and tripped the OfflineStrip through
// app.failures while projtrack and the bridge were both fine.
describe('a session on a machine the bridge cannot reach', () => {
  beforeEach(() => {
    app.setPanes([BOX_PANE]);
    app.setMachines(MACHINES);
    app.panesKnown = true;
    store.failures = 0;
    reads.mockImplementation(async () => {
      throw new ApiError('HTTP 503', 503);
    });
  });

  it('names the machine rather than blaming the bridge', async () => {
    draw();
    await flush();

    expect(screen.queryByText(/Can't reach the pane bridge/)).toBeNull();
    expect(screen.getByText(/Can't reach box/)).toBeTruthy();
  });

  it('does not count toward the offline strip', async () => {
    // The task poll is stopped for the length of this test. It succeeds every 15
    // seconds and calls noteSuccess, which would reset the counter and let this
    // pass whether or not the 503 was ever excluded from it.
    let loaded = false;
    task.mockImplementation(async () => {
      if (loaded) await new Promise(() => {});
      loaded = true;
      return TASK_103;
    });

    draw();
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();

    // Several 503s have now been answered. The bridge is up; nothing is offline.
    expect(reads.mock.calls.length).toBeGreaterThan(1);
    expect(store.failures).toBe(0);
    expect(store.offline).toBe(false);
  });

  it('still raises the bridge banner for a failure that is not a 503', async () => {
    // The 503 path must not swallow the case it was carved out of: a read that
    // never landed is still a bridge that cannot be reached.
    reads.mockImplementation(async () => {
      throw new ApiError('Network error', 0);
    });

    draw();
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();

    expect(screen.getByText(/Can't reach the pane bridge/)).toBeTruthy();
    expect(screen.queryByText(/Can't reach box/)).toBeNull();
  });

  it('does not blame a machine for a session on this laptop', async () => {
    // `sessionMachine` is 'local' both for a genuinely local pane and for a
    // remote ref that has not resolved, so a 503 here must not name it.
    task.mockResolvedValue({ ...TASK_103, session_ref: 'w9K:p1' });
    app.setPanes([{ ...BOX_PANE, pane_id: 'w9K:p1', machine: 'local', workspace_id: 'w9K' }]);

    draw();
    await flush();

    expect(screen.queryByText(/Can't reach local/)).toBeNull();
  });

  it('names the machine when /machines is what reports it down', async () => {
    // No read has failed; the bridge's own machine list says box is unreachable.
    bridgeAnsweringOnlyFor('box/wC:p1');
    app.setMachines([{ name: 'local', reachable: true }, { name: 'box', reachable: false }]);

    draw();
    await flush();

    expect(screen.getByText(/Can't reach box/)).toBeTruthy();
  });
});

// Nit 7. Before the machine list lands there is no id to send to. The composer
// was live in that window and a send went out as the raw ref, which 404s.
describe('sending before the ref resolves', () => {
  it('disables the composer rather than sending to an id the bridge lacks', async () => {
    draw();
    await flush();

    // The window the pane read already waits out.
    expect(reads).not.toHaveBeenCalled();
    const box = screen.getByPlaceholderText('Message this session…') as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
  });

  it('enables it once the machine list arrives', async () => {
    draw();
    await flush();

    app.setPanes([BOX_PANE]);
    app.setMachines(MACHINES);
    app.panesKnown = true;
    await flush();

    const box = screen.getByPlaceholderText('Message this session…') as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
  });
});

// Nit 2. While the ref is pending nothing has read the pane and the pane list
// cannot be looked up either, so the header had only the ledger to go on and
// rendered "Working" above a body that said "Reading pane…".
describe('the header while the ref is pending', () => {
  it('does not claim the agent is working on the ledger word alone', async () => {
    draw();
    await flush();

    expect(screen.queryByText('Working')).toBeNull();
    expect(screen.getByText('Finding session')).toBeTruthy();
  });

  it('does not claim there is no agent either', async () => {
    draw();
    await flush();

    expect(screen.queryByText('No agent')).toBeNull();
  });

  it('says Working once the pane has actually been read', async () => {
    draw();
    await flush();

    app.setPanes([BOX_PANE]);
    app.setMachines(MACHINES);
    app.panesKnown = true;
    await flush();

    expect(screen.getByText('Working')).toBeTruthy();
  });
});

// Nit 2, round 2. With the pane gone the screen drops to history mode, which
// printed the ledger's own word. "Running · 14 min ago" sat directly above a
// banner reading "Pane gone": the header and the banner disagreed about the
// same task, on the same screen, at the same time.
describe('the header under "Pane gone"', () => {
  beforeEach(() => {
    task.mockResolvedValue({ ...TASK_103, session_ref: 'box:wZZ:p1' });
    app.setPanes([BOX_PANE]); // wZZ:p1 is not in it
    app.setMachines(MACHINES);
    app.panesKnown = true;
    reads.mockImplementation(async () => {
      throw new ApiError('HTTP 404', 404);
    });
  });

  it('does not call the task running above a banner saying the pane is gone', async () => {
    draw();
    await flush();

    expect(screen.getByText('Pane gone')).toBeTruthy();
    expect(screen.queryByText(/Running · /)).toBeNull();
  });

  it('says the session is gone, the one thing that is true of both', async () => {
    // Not "Abandoned": projtrack has written no such thing, and the header must
    // not invent a ledger state to avoid contradicting the banner.
    draw();
    await flush();

    expect(screen.getByText(/Session gone · /)).toBeTruthy();
    expect(screen.queryByText(/Abandoned · /)).toBeNull();
  });

  it('still says when the task was last touched', async () => {
    draw();
    await flush();

    expect(screen.getByText(/ago|just now/)).toBeTruthy();
  });

  it('leaves the header alone for a task the ledger really did close out', async () => {
    task.mockResolvedValue({ ...TASK_103, status: 'done', session_ref: 'box:wZZ:p1' });
    panes.mockRejectedValue(new ApiError('HTTP 404', 404));

    draw();
    await flush();

    expect(screen.getByText(/Done · /)).toBeTruthy();
  });
});

// Nit 4, round 2. /machines marks the machine unreachable, so every read
// against a pane on it can only come back 503. The gate is that list, which
// keeps arriving from App's poll, and not the 503 the read itself returns.
describe('a session on a machine /machines reports down', () => {
  beforeEach(() => {
    app.setPanes([BOX_PANE]);
    app.setMachines([
      { name: 'local', reachable: true },
      { name: 'box', reachable: false },
    ]);
    app.panesKnown = true;
    reads.mockImplementation(async () => {
      throw new ApiError('HTTP 503', 503);
    });
  });

  it('does not read a pane on it every pane interval', async () => {
    draw();
    await flush();
    const after = reads.mock.calls.length;

    await vi.advanceTimersByTimeAsync(30_000);
    await flush();

    expect(reads.mock.calls.length).toBe(after);
  });

  it('still names the machine rather than blaming the bridge', async () => {
    draw();
    await flush();

    expect(screen.getByText(/Can't reach box/)).toBeTruthy();
    expect(screen.queryByText(/Can't reach the pane bridge/)).toBeNull();
  });

  it('reads again once /machines says the machine is back', async () => {
    draw();
    await flush();
    const stopped = reads.mock.calls.length;

    // The screen is told by App's poll, without ever reading the pane itself.
    bridgeAnsweringOnlyFor('box/wC:p1');
    app.setMachines(MACHINES);
    await flush();
    await vi.advanceTimersByTimeAsync(6000);
    await flush();

    expect(reads.mock.calls.length).toBeGreaterThan(stopped);
    expect(screen.queryByText(/Can't reach box/)).toBeNull();
  });
});

// Scrolling further back than the 200-line poll window (section 5.3a). The
// window is small because it is fetched every 2 s over Tailscale; the whole
// window herdr will give is ~5x the bytes, so it is asked for by hand.
describe('reading further back than the live poll window', () => {
  /** A bridge whose reply grows with the window asked for, as the real one does. */
  function bridgeWithScrollback() {
    reads.mockImplementation(async (_s: unknown, id: string, lines: number) => ({
      pane_id: id,
      machine: 'box',
      agent_status: 'working' as const,
      read_at: '2026-09-07T19:56:23Z',
      text:
        lines >= PANE_LINES_MAX
          ? '● The part that scrolled off\n● Now the sendrawtransaction handler:'
          : '● Now the sendrawtransaction handler:',
    }));
  }

  beforeEach(() => {
    bridgeWithScrollback();
    app.setPanes([BOX_PANE]);
    app.setMachines(MACHINES);
    app.panesKnown = true;
  });

  it('polls the small window until asked for more', async () => {
    draw();
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();

    expect(reads.mock.calls.length).toBeGreaterThan(1);
    expect(reads.mock.calls.every((c) => c[2] === PANE_LINES)).toBe(true);
  });

  it('offers the earlier lines rather than silently truncating', async () => {
    draw();
    await flush();

    expect(screen.getByText(/Earlier/)).toBeTruthy();
    expect(screen.queryByText(/The part that scrolled off/)).toBeNull();
  });

  it('shows what scrolled off once Earlier is tapped', async () => {
    draw();
    await flush();

    await fireEvent.click(screen.getByText(/Earlier/));
    await flush();

    expect(reads.mock.calls.some((c) => c[2] === PANE_LINES_MAX)).toBe(true);
    expect(screen.getByText(/The part that scrolled off/)).toBeTruthy();
  });

  // The reason the wider window is sticky: a poll that reverted to 200 lines
  // would take the history away two seconds after it arrived.
  it('keeps polling the wide window afterwards', async () => {
    draw();
    await flush();
    await fireEvent.click(screen.getByText(/Earlier/));
    await flush();
    const afterTap = reads.mock.calls.length;

    await vi.advanceTimersByTimeAsync(10_000);
    await flush();

    expect(reads.mock.calls.length).toBeGreaterThan(afterTap);
    expect(reads.mock.calls.slice(afterTap).every((c) => c[2] === PANE_LINES_MAX)).toBe(true);
    expect(screen.getByText(/The part that scrolled off/)).toBeTruthy();
  });

  it('says where the scrollback ends rather than offering a wider read twice', async () => {
    draw();
    await flush();
    await fireEvent.click(screen.getByText(/Earlier/));
    await flush();

    expect(screen.queryByText(/Earlier/)).toBeNull();
    expect(screen.getByText('Start of available scrollback')).toBeTruthy();
  });

  // Nothing to go back from until the first read lands: offering it against an
  // empty screen would read as a second "Reading pane…".
  it('offers nothing until there is a transcript', async () => {
    reads.mockImplementation(() => new Promise(() => {}));

    draw();
    await flush();

    expect(screen.getByText('Reading pane…')).toBeTruthy();
    expect(screen.queryByText(/Earlier/)).toBeNull();
  });
});

// The screen used to have one thing to say while it had no transcript —
// "Reading pane…" — including in the case where nothing was being read at all.
// `readPane` returns before it starts when the machine list has not arrived, so
// a bridge that never answered left that line up for as long as the screen was
// open, under a header reading "Finding session", with nothing anywhere naming
// the bridge. That was reported as the app hanging.
describe('while the pane list has not arrived', () => {
  beforeEach(() => {
    app.setPanes([]);
    app.setMachines([]);
    app.panesKnown = false;
    store.bridgeError = null;
  });

  afterEach(() => {
    store.bridgeError = null;
  });

  it('says what it is waiting for rather than claiming to read', async () => {
    draw();
    await flush();

    expect(screen.getByText('Finding the session…')).toBeTruthy();
    expect(screen.queryByText('Reading pane…')).toBeNull();
    // Nothing was asked of the bridge: the ref does not resolve yet.
    expect(reads).not.toHaveBeenCalled();
  });

  it('names the bridge failure once there is one, instead of waiting silently', async () => {
    store.bridgeError = 'the pane bridge answered HTTP 501: this host serves the app only';

    draw();
    await flush();

    expect(screen.getByText(/answered HTTP 501/)).toBeTruthy();
    expect(screen.queryByText('Reading pane…')).toBeNull();
    expect(screen.queryByText('Finding the session…')).toBeNull();
  });

  it('goes back to reading once the list resolves the ref', async () => {
    const view = draw();
    await flush();
    expect(screen.getByText('Finding the session…')).toBeTruthy();

    app.setMachines(MACHINES);
    app.setPanes([BOX_PANE]);
    app.panesKnown = true;
    await flush();
    await vi.advanceTimersByTimeAsync(app.intervals.pane + 50);
    await flush();

    expect(reads).toHaveBeenCalled();
    expect(view.container.textContent).toContain('sendrawtransaction');
  });
});

// Opening a session directly on its pane (section 5.3c).
//
// The task route can only reach a session projtrack has a row for, and against
// the live daemon on 2026-09-14 that was 6 of 11 running panes: 5 had no task
// at all, and 16 of the 22 task refs named panes that no longer existed. These
// are the cases that route could not serve.
describe('a session opened on its pane', () => {
  /** A Codex pane with no projtrack task, as /panes reports it. */
  const CODEX_PANE: Pane = {
    pane_id: 'wH5:p1',
    machine: 'local',
    workspace_id: 'wH5',
    label: 'reserve yield design',
    cwd: '/home/casper/src/launchpad-integrated',
    agent_status: 'idle',
    provider: 'codex',
  };

  const drawSession = (paneId: string) =>
    render(TaskDetail, { props: { paneId, onBack: () => {} } });

  beforeEach(() => {
    app.setPanes([CODEX_PANE]);
    app.setMachines([{ name: 'local', reachable: true }]);
    app.panesKnown = true;
    reads.mockResolvedValue({
      pane_id: 'wH5:p1',
      agent_status: 'idle' as const,
      read_at: '2026-09-07T19:56:23Z',
      text: '• The buffer is raw USDC and earns nothing.',
    });
  });

  it('never asks projtrack for a task', async () => {
    drawSession('wH5:p1');
    await flush();
    expect(task).not.toHaveBeenCalled();
  });

  it('reads the pane straight away, without waiting for a ledger row', async () => {
    drawSession('wH5:p1');
    await flush();
    expect(reads).toHaveBeenCalled();
    expect(reads.mock.calls[0][1]).toBe('wH5:p1');
  });

  it('shows what the agent said', async () => {
    drawSession('wH5:p1');
    await flush();
    expect(await screen.findByText(/buffer is raw USDC/)).toBeTruthy();
  });

  it('is the live view even though the agent is idle', async () => {
    // The task route needs `status === 'running'`, so an idle pane fell through
    // to history mode and showed a note composer instead of the transcript.
    drawSession('wH5:p1');
    await flush();
    expect(screen.getByPlaceholderText('Message this session…')).toBeTruthy();
  });

  it('keeps polling, so a reply appears without leaving the screen', async () => {
    drawSession('wH5:p1');
    await flush();
    const first = reads.mock.calls.length;
    await vi.advanceTimersByTimeAsync(store.intervals.pane + 50);
    await flush();
    expect(reads.mock.calls.length).toBeGreaterThan(first);
  });

  it('titles the screen with the pane label rather than a blank task title', async () => {
    drawSession('wH5:p1');
    await flush();
    expect(screen.getByText('reserve yield design')).toBeTruthy();
  });

  it('says so plainly when the bridge has dropped the pane', async () => {
    // No ledger row behind this screen, so there is no history to fall back to.
    app.setPanes([]);
    reads.mockRejectedValue(new ApiError('HTTP 404', 404));
    drawSession('wH5:p1');
    await flush();
    expect(await screen.findByText(/session is gone/i)).toBeTruthy();
  });

  it('does not render a blank transcript when the pane is silent', async () => {
    // A read that succeeds with empty text used to draw nothing at all: the
    // placeholder only covered the window before the first answer.
    reads.mockResolvedValue({
      pane_id: 'wH5:p1',
      agent_status: 'idle' as const,
      read_at: '2026-09-07T19:56:23Z',
      text: '',
    });
    drawSession('wH5:p1');
    await flush();
    expect(await screen.findByText(/has not printed anything yet/i)).toBeTruthy();
  });
});

// A remote session whose machine goes down (audit finding 1).
//
// The bridge drops an unreachable machine's panes from /panes, so the pane
// leaves the index at exactly the moment the forward dies. Deriving the machine
// from the index therefore answered 'local' during the outage: no banner, a
// poll that kept collecting 503s while calling noteSuccess on each one, and a
// stale transcript under a header still reporting the last status read.
describe('a session on a machine that has gone down', () => {
  const BOX_SESSION: Pane = {
    pane_id: 'box/w6:p1',
    machine: 'box',
    workspace_id: 'w6',
    label: 'traffic fix r1',
    cwd: '/home/casper/src/zecp2p-traffic',
    agent_status: 'working',
  };

  const drawSession = (paneId: string) =>
    render(TaskDetail, { props: { paneId, onBack: () => {} } });

  /** The bridge is up and says it cannot reach box; its panes are gone. */
  function boxIsDown() {
    app.setPanes([]);
    app.setMachines([
      { name: 'local', reachable: true },
      { name: 'box', reachable: false },
    ]);
    app.panesKnown = true;
    reads.mockRejectedValue(new ApiError('HTTP 503: box is unreachable', 503));
  }

  it('still knows the session is on box once its pane has left the list', async () => {
    boxIsDown();
    drawSession('box/w6:p1');
    await flush();
    expect(await screen.findByText(/Can't reach box/)).toBeTruthy();
  });

  it('stops polling a machine the bridge has marked unreachable', async () => {
    boxIsDown();
    drawSession('box/w6:p1');
    await flush();
    const after = reads.mock.calls.length;
    await vi.advanceTimersByTimeAsync(store.intervals.pane * 3 + 50);
    await flush();
    // machineListedDown gates the poll: every read could only return 503, and
    // each one used to be counted as a success.
    expect(reads.mock.calls.length).toBe(after);
  });

  it('polls normally while box is reachable', async () => {
    app.setPanes([BOX_SESSION]);
    app.setMachines([
      { name: 'local', reachable: true },
      { name: 'box', reachable: true },
    ]);
    app.panesKnown = true;
    reads.mockResolvedValue({
      pane_id: 'box/w6:p1',
      machine: 'box',
      agent_status: 'working' as const,
      read_at: '2026-09-07T19:56:23Z',
      text: '● Now the sendrawtransaction handler:',
    });
    drawSession('box/w6:p1');
    await flush();
    const first = reads.mock.calls.length;
    await vi.advanceTimersByTimeAsync(store.intervals.pane + 50);
    await flush();
    expect(reads.mock.calls.length).toBeGreaterThan(first);
    expect(screen.queryByText(/Can't reach box/)).toBeNull();
  });

  it('leaves a local session alone', async () => {
    // `local` must not pick up a machine-down banner from a machine list that
    // happens to hold an unreachable box.
    app.setPanes([]);
    app.setMachines([
      { name: 'local', reachable: true },
      { name: 'box', reachable: false },
    ]);
    app.panesKnown = true;
    reads.mockResolvedValue({
      pane_id: 'w95:p1',
      agent_status: 'idle' as const,
      read_at: '2026-09-07T19:56:23Z',
      text: '● local output',
    });
    drawSession('w95:p1');
    await flush();
    expect(screen.queryByText(/Can't reach/)).toBeNull();
  });
});

// A first read that failed must not speak for the agent (audit finding 2).
describe('a session whose first read failed', () => {
  it('does not claim the agent printed nothing', async () => {
    app.setPanes([]);
    app.setMachines([{ name: 'local', reachable: true }]);
    app.panesKnown = true;
    reads.mockRejectedValue(new ApiError('Network error', 0));

    render(TaskDetail, { props: { paneId: 'w95:p1', onBack: () => {} } });
    await flush();

    // Nothing has been read, so nothing is known about what the agent printed.
    expect(screen.queryByText(/has not printed anything yet/i)).toBeNull();
    expect(screen.getByText(/Reading pane/)).toBeTruthy();
  });

  it('says the session is silent only once a read has answered', async () => {
    app.setPanes([]);
    app.setMachines([{ name: 'local', reachable: true }]);
    app.panesKnown = true;
    reads.mockResolvedValue({
      pane_id: 'w95:p1',
      agent_status: 'idle' as const,
      read_at: '2026-09-07T19:56:23Z',
      text: '',
    });

    render(TaskDetail, { props: { paneId: 'w95:p1', onBack: () => {} } });
    await flush();
    expect(await screen.findByText(/has not printed anything yet/i)).toBeTruthy();
  });
});
