// Application state. Svelte 5 runes in a .svelte.ts module, so screens read
// plain properties and the reactivity is handled here.

import { DEFAULTS, loadSettings, saveSettings, POLL_INTERVALS, type Settings } from './settings';
import { paneIndex, type PaneIndex } from './live';
import type { Machine, Pane } from './types';

export type Tab = 'fleet' | 'chat' | 'usage';

export type FleetRoute =
  | { screen: 'projects' }
  | { screen: 'project'; projectId: number }
  | { screen: 'task'; taskId: number; projectId: number }
  /**
   * A session addressed by its pane, with no projtrack task in the way.
   *
   * The task route can only reach a session projtrack has a row for, and the
   * ledger is not a reliable index of what is running: measured against the
   * live daemon on 2026-09-14, 5 of 11 running panes had no task at all (the
   * Codex pane among them) and 16 of 22 task session_refs named panes that no
   * longer existed. Those five had no route into the app, and the sixteen
   * opened onto a dead pane. This route addresses the pane the bridge is
   * actually serving, so every live session can be opened and answered.
   */
  | { screen: 'session'; paneId: string }
  /** The list of those sessions, straight from the bridge's /panes. */
  | { screen: 'sessions' };

class AppStore {
  settings = $state<Settings>({ ...DEFAULTS });
  settingsLoaded = $state(false);

  tab = $state<Tab>('fleet');
  /** The Fleet stack. Index 0 is always the Projects root. */
  stack = $state<FleetRoute[]>([{ screen: 'projects' }]);
  settingsOpen = $state(false);

  /** Scroll offsets kept per tab so switching tabs restores position. */
  scroll = $state<Record<string, number>>({});

  toast = $state<{ text: string; tone: 'normal' | 'alert'; id: number } | null>(null);
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  /** Consecutive failures across all sources; two in a row raise OfflineStrip. */
  failures = $state(0);
  /** Panes cached from the bridge. The live half of every task status. */
  panes = $state<Pane[]>([]);
  /** False until the first pane poll lands; nothing is judged live before then. */
  panesKnown = $state(false);
  /** Machines the bridge can reach. Empty until /machines has answered. */
  machines = $state<Machine[]>([]);
  /**
   * Why the pane bridge is not answering, while it is not.
   *
   * The pane polls deliberately keep the last list they had rather than
   * emptying it on a failure, which is right — but it also meant a bridge that
   * had never answered at all was indistinguishable from one that was merely
   * quiet, and every screen that waits on the pane list waited forever without
   * saying what for. This is that missing sentence.
   */
  bridgeError = $state<string | null>(null);
  /**
   * The newest chat message that has been in front of Casper. 0 until the chat
   * has been read or the watcher has looked once; the watcher seeds it rather
   * than announcing the whole history the first time it runs.
   */
  chatSeenId = $state(0);
  /** Orchestrator and event messages that have arrived since (section 3.2). */
  chatUnreadCount = $state(0);

  /** Set when chat has messages the user has not seen. Drives the tab dot. */
  get chatUnread(): boolean {
    return this.chatUnreadCount > 0;
  }

  /** Page visibility drives every poll (section 9). */
  visible = $state(true);

  get intervals() {
    return POLL_INTERVALS[this.settings.pollSpeed];
  }

  get route(): FleetRoute {
    return this.stack[this.stack.length - 1];
  }

  get offline(): boolean {
    return this.failures >= 2;
  }

  get needsAttention(): boolean {
    return this.panes.some((p) => p.agent_status === 'blocked');
  }

  /** Pane lookup by id, rebuilt only when the pane list itself changes. */
  get paneIndex(): PaneIndex {
    return paneIndex(this.panes);
  }

  /**
   * The machines the bridge knows about, from /machines when that has answered
   * and otherwise from the machines the panes themselves name.
   *
   * Both are needed. /machines is the only thing that lists a machine with no
   * panes on it, which is how a machine shows as offline rather than simply
   * absent. The panes are the fallback for a bridge too old to serve
   * /machines, and they arrive first.
   */
  get machineNames(): string[] {
    const names = new Set(this.machines.map((m) => m.name));
    for (const p of this.panes) if (p.machine) names.add(p.machine);
    return [...names];
  }

  /** Record a pane poll, including an empty-but-successful one. */
  setPanes(panes: Pane[]) {
    this.panes = panes;
    this.panesKnown = true;
  }

  setMachines(machines: Machine[]) {
    this.machines = machines;
  }

  async init() {
    this.settings = await loadSettings();
    this.settingsLoaded = true;
  }

  async updateSettings(patch: Partial<Settings>) {
    this.settings = { ...this.settings, ...patch };
    await saveSettings(this.settings);
  }

  // ---------- navigation ----------

  /** Wraps a state change in a view transition when the platform has one. */
  transition(fn: () => void) {
    const doc = document as Document & {
      startViewTransition?: (cb: () => void) => { finished: Promise<void> };
    };
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (doc.startViewTransition && !reduced) doc.startViewTransition(fn);
    else fn();
  }

  push(route: FleetRoute) {
    this.transition(() => {
      this.stack = [...this.stack, route];
    });
  }

  pop() {
    if (this.stack.length <= 1) return false;
    this.transition(() => {
      this.stack = this.stack.slice(0, -1);
    });
    return true;
  }

  setTab(tab: Tab) {
    if (tab === this.tab) return;
    this.transition(() => {
      this.tab = tab;
    });
    if (tab === 'chat') this.chatUnreadCount = 0;
    if (typeof location !== 'undefined') history.replaceState(history.state, '', tab === 'fleet' ? location.pathname + location.search : `#${tab}`);
  }

  /** Open a session by its bridge pane id, from the Sessions list or a chat event. */
  openSession(paneId: string) {
    // The Sessions list sits under it, so Back from a session deep-linked out
    // of chat lands somewhere useful rather than at the project root.
    this.stack = [{ screen: 'projects' }, { screen: 'sessions' }, { screen: 'session', paneId }];
    this.setTab('fleet');
  }

  /** Deep link from a chat event: push the task and switch to Fleet. */
  openTask(taskId: number, projectId: number) {
    this.stack = [{ screen: 'projects' }, { screen: 'project', projectId }, { screen: 'task', taskId, projectId }];
    this.setTab('fleet');
  }

  /** Android back: pop the Fleet stack, else leave Chat, else let the app exit. */
  handleBack(): boolean {
    if (this.settingsOpen) {
      this.settingsOpen = false;
      return true;
    }
    if (this.tab === 'chat' || this.tab === 'usage') {
      this.setTab('fleet');
      return true;
    }
    return this.pop();
  }

  // ---------- the orchestrator's news ----------

  /** Everything up to `id` has been seen. Called by the Chat screen while it
   *  is on screen, and by the watcher when it first looks. */
  noteChatSeen(id: number) {
    if (id > this.chatSeenId) this.chatSeenId = id;
    this.chatUnreadCount = 0;
  }

  /** `count` messages arrived while Casper was somewhere else. */
  noteChatArrivals(id: number, count: number) {
    if (id > this.chatSeenId) this.chatSeenId = id;
    this.chatUnreadCount += count;
  }

  // ---------- feedback ----------

  showToast(text: string, tone: 'normal' | 'alert' = 'normal') {
    this.toast = { text, tone, id: Date.now() };
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toast = null), 3000);
  }

  noteSuccess() {
    this.failures = 0;
  }

  noteFailure() {
    this.failures += 1;
  }
}

export const app = new AppStore();
