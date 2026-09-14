// The Sessions row on the Fleet root, and what it says while the bridge is
// not answering.
//
// The pane polls deliberately keep the last list they had rather than emptying
// it on a failure, so `panesKnown` stays false when the bridge has never
// answered at all. That is what `app.bridgeError` is for: without it this row
// read "Asking the pane bridge…" for as long as the app was open, which is the
// silent forever-wait the store comment was written to end.

import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Pane } from '../src/lib/types';

const summary = vi.fn();

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return {
    ...actual,
    projtrack: {
      summary: (...a: unknown[]) => summary(...a),
      setProjectStatus: vi.fn(),
    },
  };
});

const { default: Projects } = await import('../src/screens/Projects.svelte');
const { app } = await import('../src/lib/store.svelte');

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

function pane(pane_id: string, agent_status: Pane['agent_status']): Pane {
  return {
    pane_id,
    machine: 'local',
    workspace_id: pane_id.split(':')[0],
    label: pane_id,
    cwd: '/home/casper/src/x',
    agent_status,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  summary.mockResolvedValue({ projects: [], queued_tasks: 0 });
  app.setPanes([]);
  app.panesKnown = false;
  app.bridgeError = null;
});
afterEach(cleanup);

const draw = () =>
  render(Projects, { props: { onOpenProject: () => {}, onOpenSessions: () => {} } });

describe('the Sessions row', () => {
  it('says it is waiting while the first pane poll is still out', async () => {
    draw();
    await flush();
    expect(screen.getByText(/Asking the pane bridge/)).toBeTruthy();
  });

  it('says why instead, once the bridge has failed', async () => {
    app.bridgeError = "Can't reach the pane bridge at http://127.0.0.1:17988 — Network error";
    draw();
    await flush();
    expect(screen.getByText(/Can't reach the pane bridge/)).toBeTruthy();
    // The stale "still waiting" line is the thing being replaced; showing both
    // would describe one state two ways.
    expect(screen.queryByText(/Asking the pane bridge/)).toBeNull();
  });

  it('names the token as the problem when that is the problem', async () => {
    // apiFailureText already distinguishes these; the row must not flatten a
    // rejected token into a reachability failure.
    app.bridgeError = 'the pane bridge at http://x rejected the bearer token — check it in Settings (HTTP 403)';
    draw();
    await flush();
    expect(screen.getByText(/rejected the bearer token/)).toBeTruthy();
  });

  it('shows the counts once the list arrives, not the stale error', async () => {
    app.bridgeError = "Can't reach the pane bridge at http://127.0.0.1:17988 — Network error";
    app.setPanes([pane('w1:p1', 'working'), pane('w2:p1', 'idle')]);
    draw();
    await flush();
    expect(screen.getByText(/1 working · 2 open/)).toBeTruthy();
    expect(screen.queryByText(/Can't reach the pane bridge/)).toBeNull();
  });

  it('counts the sessions waiting on Casper first', async () => {
    app.setPanes([pane('w1:p1', 'blocked'), pane('w2:p1', 'working'), pane('w3:p1', 'idle')]);
    draw();
    await flush();
    expect(screen.getByText(/1 waiting on you · 1 working · 3 open/)).toBeTruthy();
  });
});
