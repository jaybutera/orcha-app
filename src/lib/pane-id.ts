// Turning a task's session_ref into a pane id the bridge understands.
//
// The two backends spell the same session differently, and both spellings are
// load-bearing where they are:
//
//   projtrack stores `session_ref` as `<machine>:<session id>`. That form is
//   what a person is told to type: `ssh box claude attach 93ee19ff`.
//
//   The pane bridge addresses a pane as `<machine>/<pane id>`. The slash is
//   what keeps a local id bare — `w95:p1` means this laptop — so the
//   orchestrator's watcher and the Claude hooks keep working with ids they
//   already hold.
//
// Without a translation between them every task on another machine looks like
// an orphan: the ledger says `box:w6:p1`, the pane list says `box/w6:p1`, the
// lookup misses, and the UI reports a session that is running fine as having no
// pane at all.

/** Machine name plus the pane or session id, from a stored session_ref. */
export interface SessionRef {
  machine: string;
  /** The id as the machine's own herdr knows it, with no prefix. */
  id: string;
  /** The pane id the bridge takes, prefixed unless it is local. */
  paneId: string;
}

export const LOCAL = 'local';

/**
 * Parse `session_ref`, given the machines the bridge knows about.
 *
 * The machine list is needed because a colon does not by itself mean a prefix:
 * a local pane id is `w95:p1`, and `w95` is not a machine. Splitting on the
 * last colon instead would break the other way, turning `box:w6:p1` into `p1`.
 *
 * With no machine list yet — the first poll has not landed — nothing is treated
 * as prefixed. That reads a box task as local for a moment, which shows it as
 * an orphan until the list arrives; the alternative is guessing that any
 * leading word is a machine, which would mangle every local pane id instead.
 */
export function parseSessionRef(ref: string | null | undefined, machines: readonly string[]): SessionRef {
  const text = String(ref ?? '');
  const colon = text.indexOf(':');
  if (colon > 0) {
    const head = text.slice(0, colon);
    if (head !== LOCAL && machines.includes(head)) {
      const id = text.slice(colon + 1);
      return { machine: head, id, paneId: `${head}/${id}` };
    }
  }
  return { machine: LOCAL, id: text, paneId: text };
}

/** The bridge pane id for a task's session_ref. */
export function paneIdForRef(ref: string | null | undefined, machines: readonly string[]): string {
  return parseSessionRef(ref, machines).paneId;
}

/** The machine a session_ref names, for showing on a session row. */
export function machineForRef(ref: string | null | undefined, machines: readonly string[]): string {
  return parseSessionRef(ref, machines).machine;
}

/**
 * The machine a bridge pane id names, from the id alone.
 *
 * The counterpart of the orchestrator's `joinPaneId`: `box/w6:p1` is on box,
 * `w95:p1` is local. Unlike `machineForRef` this needs no machine list, because
 * the slash is unambiguous where a colon is not — which is the whole reason the
 * bridge spells it this way.
 *
 * It must not be replaced by a lookup in the pane list. The bridge drops an
 * unreachable machine's panes from /panes entirely, so exactly when a remote
 * forward dies the pane leaves the index and a lookup answers `local` — the one
 * answer that switches off the machine-down banner and the poll gate that exist
 * for that case.
 */
export function machineForPaneId(paneId: string | null | undefined): string {
  const text = String(paneId ?? '');
  const slash = text.indexOf('/');
  return slash > 0 ? text.slice(0, slash) : LOCAL;
}

/** True when a machine name is worth showing; the laptop is the unmarked case. */
export function isRemote(machine: string): boolean {
  return !!machine && machine !== LOCAL;
}

/**
 * True when `ref` cannot be turned into a bridge pane id yet.
 *
 * A ref like `box:wC:p1` only resolves once the machine list names `box`;
 * until then it parses as the local id `box:wC:p1`, which no bridge knows.
 * Asking the bridge about that id gets HTTP 404 "pane gone" for a session that
 * is running fine, so a caller that reaches a pane has to wait rather than
 * treat the miss as an answer.
 *
 * The one thing this cannot do is tell a local pane id from a remote one whose
 * machine has not been listed: `w95:p1` and `box:wC:p1` are the same shape, and
 * the machine list is the only thing that separates them. So with no list at
 * all, both are reported unresolved. That waits out a local session for as long
 * as the first pane poll takes, which is the cheaper error: the other way round
 * reads a remote pane by an id the bridge never issued and calls a working
 * session dead.
 *
 * Once any list has arrived the wait is over either way, including for a head
 * the list does not name. Waiting longer there would never change the answer.
 */
export function isRefUnresolved(
  ref: string | null | undefined,
  machines: readonly string[]
): boolean {
  const text = String(ref ?? '');
  if (!text) return false;
  // The head is a machine the list names, so the ref is resolved.
  if (parseSessionRef(text, machines).machine !== LOCAL) return false;
  // A colon-headed ref whose head is not a known machine is either a local pane
  // id (`w95:p1`) or a remote one whose machine has not been listed yet. Nothing
  // in the string separates them; the only usable signal is whether any machine
  // list has arrived at all, so with none, wait.
  const colon = text.indexOf(':');
  if (colon <= 0) return false;
  return machines.length === 0;
}
