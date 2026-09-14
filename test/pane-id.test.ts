// Translating a task's session_ref into a bridge pane id.
//
// The two spellings are both load-bearing. projtrack stores `box:w6:p1`
// because that form is what a person types (`ssh box claude attach ...`); the
// bridge addresses `box/w6:p1` because the slash is what lets a local id stay
// bare and keeps the orchestrator's watcher and the Claude hooks working with
// ids they already hold. Something has to convert between them, and getting it
// wrong makes every session on another machine read as an orphan.

import { describe, expect, it } from 'vitest';

import {
  isRefUnresolved,
  isRemote,
  machineForPaneId,
  machineForRef,
  paneIdForRef,
  parseSessionRef,
} from '../src/lib/pane-id';
import { liveTaskStatus, paneIndex } from '../src/lib/live';
import type { Pane, Task } from '../src/lib/types';

const MACHINES = ['local', 'box', 'hub'];

describe('parseSessionRef', () => {
  it('splits a pane session on another machine', () => {
    expect(parseSessionRef('box:w6:p1', MACHINES)).toEqual({
      machine: 'box',
      id: 'w6:p1',
      paneId: 'box/w6:p1',
    });
  });

  it('splits a background session on another machine', () => {
    expect(parseSessionRef('box:93ee19ff', MACHINES)).toEqual({
      machine: 'box',
      id: '93ee19ff',
      paneId: 'box/93ee19ff',
    });
  });

  it('leaves a local pane id alone despite its colon', () => {
    // `w95` is not a machine, so the whole string is the id.
    expect(parseSessionRef('w95:p1', MACHINES)).toEqual({
      machine: 'local',
      id: 'w95:p1',
      paneId: 'w95:p1',
    });
  });

  it('does not invent a machine before the machine list arrives', () => {
    // With no list, treating any leading word as a machine would mangle every
    // local pane id. Reading a remote one as local for a poll is the lesser
    // error and corrects itself.
    expect(parseSessionRef('box:w6:p1', []).machine).toBe('local');
    expect(parseSessionRef('w95:p1', []).paneId).toBe('w95:p1');
  });

  it('handles an empty or missing ref', () => {
    for (const ref of ['', null, undefined]) {
      expect(parseSessionRef(ref, MACHINES)).toEqual({ machine: 'local', id: '', paneId: '' });
    }
  });

  it('does not treat the literal name "local" as a prefix', () => {
    // A ref is never written that way, and stripping it would produce a pane
    // id the bridge does not know.
    expect(parseSessionRef('local:w1:p1', MACHINES).paneId).toBe('local:w1:p1');
  });

  it('ignores a leading colon', () => {
    expect(parseSessionRef(':w1:p1', MACHINES).paneId).toBe(':w1:p1');
  });
});

describe('helpers', () => {
  it('paneIdForRef is the pane half', () => {
    expect(paneIdForRef('box:w6:p1', MACHINES)).toBe('box/w6:p1');
    expect(paneIdForRef('w95:p1', MACHINES)).toBe('w95:p1');
  });

  it('machineForRef is the machine half', () => {
    expect(machineForRef('box:w6:p1', MACHINES)).toBe('box');
    expect(machineForRef('w95:p1', MACHINES)).toBe('local');
  });

  it('only a machine that is not this laptop is worth badging', () => {
    expect(isRemote('box')).toBe(true);
    expect(isRemote('local')).toBe(false);
    expect(isRemote('')).toBe(false);
  });
});

describe('liveTaskStatus across machines', () => {
  const pane = (id: string, machine: string, agent_status: Pane['agent_status']): Pane => ({
    pane_id: id,
    machine,
    workspace_id: id.split(':')[0],
    label: 'demo',
    cwd: '/tmp',
    agent_status,
  });

  const task = (session_ref: string): Task => ({
    id: 1,
    project_id: 1,
    title: 'demo',
    status: 'running',
    session_ref,
    result_summary: '',
    created_at: '',
    updated_at: '',
  });

  it('finds the pane for a session on another machine', () => {
    // The regression this exists for: without the translation the lookup misses
    // and a session running fine on box is reported as an orphan.
    const panes = paneIndex([pane('box/w6:p1', 'box', 'working')]);
    expect(liveTaskStatus(task('box:w6:p1'), panes, true, MACHINES)).toBe('running');
  });

  it('still finds a local pane', () => {
    const panes = paneIndex([pane('w95:p1', 'local', 'working')]);
    expect(liveTaskStatus(task('w95:p1'), panes, true, MACHINES)).toBe('running');
  });

  it('a remote session whose pane is gone is an orphan', () => {
    const panes = paneIndex([pane('box/w9:p1', 'box', 'working')]);
    expect(liveTaskStatus(task('box:w6:p1'), panes, true, MACHINES)).toBe('orphan');
  });

  it('a remote pane sitting idle reads as stalled, same as a local one', () => {
    const panes = paneIndex([pane('box/w6:p1', 'box', 'idle')]);
    expect(liveTaskStatus(task('box:w6:p1'), panes, true, MACHINES)).toBe('stalled');
  });

  it('a remote pane waiting on Casper reads as blocked', () => {
    const panes = paneIndex([pane('box/w6:p1', 'box', 'blocked')]);
    expect(liveTaskStatus(task('box:w6:p1'), panes, true, MACHINES)).toBe('blocked');
  });
});

// The pane-gone bug: task 103's ref is `box:wC:p1`, and before /machines names
// `box` that parses as the local id `box:wC:p1`. The bridge has never issued
// that id, answers HTTP 404 "pane gone", and a session working on box was
// reported as dead. Anything that calls the bridge has to know it is in that
// window rather than believe the 404.
describe('isRefUnresolved', () => {
  it('is true for a remote ref before the machine list arrives', () => {
    expect(isRefUnresolved('box:wC:p1', [])).toBe(true);
  });

  it('is false once the machine list names the machine', () => {
    expect(isRefUnresolved('box:wC:p1', MACHINES)).toBe(false);
  });

  it('is false for a local pane id once any machine list has arrived', () => {
    expect(isRefUnresolved('w95:p1', MACHINES)).toBe(false);
  });

  it('waits on a local pane id too while no machine list has arrived', () => {
    // Not a special case for local: `w95:p1` and `box:wC:p1` are the same shape,
    // and with no list there is nothing to tell them apart by. Waiting out a
    // local session for one pane poll is cheaper than reading a remote pane by
    // an id the bridge never issued and calling a working session dead.
    expect(isRefUnresolved('w95:p1', [])).toBe(true);
  });

  it('is false for a ref with no colon to split on', () => {
    expect(isRefUnresolved('93ee19ff', [])).toBe(false);
    expect(isRefUnresolved('93ee19ff', MACHINES)).toBe(false);
  });

  it('is false for an empty or missing ref', () => {
    for (const ref of ['', null, undefined]) {
      expect(isRefUnresolved(ref, [])).toBe(false);
      expect(isRefUnresolved(ref, MACHINES)).toBe(false);
    }
  });

  it('is false for a machine list that has arrived without the machine in it', () => {
    // The list answered and does not name `zzz`, so the ref is as resolved as
    // it will get: waiting longer would never change the answer.
    expect(isRefUnresolved('zzz:w1:p1', MACHINES)).toBe(false);
  });
});

// The machine a bridge pane id names, from the id alone.
//
// This exists because the pane list cannot answer the question when it matters.
// The bridge drops an unreachable machine's panes from /panes, so looking the
// machine up there returns nothing exactly when the forward to that machine has
// died — and the fallback, 'local', is what switches off the machine-down
// banner and the poll gate that the outage is supposed to trigger.
describe('machineForPaneId', () => {
  it('reads the machine off a prefixed id', () => {
    expect(machineForPaneId('box/w6:p1')).toBe('box');
    expect(machineForPaneId('lab/term_65ae80c6b3d341')).toBe('lab');
  });

  it('calls a bare id local, colons and all', () => {
    expect(machineForPaneId('w95:p1')).toBe('local');
  });

  it('does not need a machine list to say so', () => {
    // machineForRef cannot do this: `box:w6:p1` is indistinguishable from a
    // local pane id until the list arrives. The slash is why the bridge spells
    // it this way, and why this answer holds during an outage.
    expect(machineForPaneId('box/w6:p1')).toBe('box');
  });

  it('treats nothing, and a leading slash, as local', () => {
    expect(machineForPaneId('')).toBe('local');
    expect(machineForPaneId(undefined)).toBe('local');
    expect(machineForPaneId(null)).toBe('local');
    // No name in front of the slash, so there is no machine named.
    expect(machineForPaneId('/w1:p1')).toBe('local');
  });

  it('agrees with machineForRef once the list has arrived', () => {
    const machines = ['local', 'box'];
    expect(machineForPaneId(paneIdForRef('box:w6:p1', machines))).toBe(
      machineForRef('box:w6:p1', machines)
    );
  });
});
