<script lang="ts">
  // Section 5.3. One screen, two modes: running tasks with a session_ref get the
  // live view, everything else gets history.
  import Header from '../components/Header.svelte';
  import LiveStatusLine from '../components/LiveStatusLine.svelte';
  import SegmentedFilter from '../components/SegmentedFilter.svelte';
  import MessageBlock from '../components/MessageBlock.svelte';
  import UserBlock from '../components/UserBlock.svelte';
  import ToolLine from '../components/ToolLine.svelte';
  import DialogCard from '../components/DialogCard.svelte';
  import SpinnerLine from '../components/SpinnerLine.svelte';
  import TerminalView from '../components/TerminalView.svelte';
  import Composer from '../components/Composer.svelte';
  import QuickKeys from '../components/QuickKeys.svelte';
  import SectionLabel from '../components/SectionLabel.svelte';
  import ErrorBanner from '../components/ErrorBanner.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import StatusDot from '../components/StatusDot.svelte';
  import TimeDivider from '../components/TimeDivider.svelte';
  import ActionSheet from '../components/ActionSheet.svelte';
  import { app } from '../lib/store.svelte';
  import { ApiError, apiFailureText, bridge, PANE_LINES, PANE_LINES_MAX, projtrack } from '../lib/api';
  import { parsePane, type Block } from '../lib/pane-parse';
  import { isRefUnresolved, isRemote, machineForRef, paneIdForRef } from '../lib/pane-id';
  import { isSettled, liveTaskStatus, paneIsGone, shouldPollPane } from '../lib/live';
  import { clockTime, dayKey, dayLabel, relativeTime, statusSpec } from '../lib/format';
  import type { AgentStatus, TaskDetail } from '../lib/types';
  import { onMount, tick } from 'svelte';

  /**
   * One screen, two ways in.
   *
   * `taskId` opens a projtrack task and finds its session from `session_ref`.
   * `paneId` opens a session directly, with no task in the way: the Sessions
   * list addresses the panes the bridge is serving, most of which the ledger
   * either does not know about or names with a ref whose pane is long gone.
   * Exactly one is given. Everything below the pane id is shared, which is the
   * point: the live transcript, the composer and the quick keys are the same
   * code either way.
   */
  let {
    taskId,
    paneId,
    onBack,
    onComposerFocus,
  }: {
    taskId?: number;
    paneId?: string;
    onBack: () => void;
    onComposerFocus?: (focused: boolean) => void;
  } = $props();

  /** True when this screen was opened on a pane rather than on a task. */
  const sessionOnly = $derived(paneId !== undefined);

  let task = $state<TaskDetail | null>(null);
  let loadingTask = $state(true);
  let taskError = $state<string | null>(null);

  // Live mode state.
  let paneText = $state('');
  let paneStatus = $state<AgentStatus>('unknown');
  let paneLabel = $state<string | undefined>(undefined);
  let paneGone = $state(false);
  let paneError = $state<string | null>(null);
  /** Set when the bridge answered but could not reach the machine the pane is on. */
  let machineUnreachable = $state(false);
  let paneFailures = 0;
  let firstRead = $state(true);
  let view = $state<'messages' | 'terminal'>('messages');
  /** Set when a finished task's session is still alive and the user opened it. */
  let forceLive = $state(false);
  let sessionAlive = $state(false);
  let menuOpen = $state(false);

  /** Locally echoed sends, shown at 60% until the pane read contains them or 5s
   *  pass, whichever comes first (section 5.3a). */
  let pending = $state<{ text: string; at: number }[]>([]);

  let scroller: HTMLDivElement | undefined = $state();
  let atBottom = $state(true);
  let showJump = $state(false);

  /**
   * How much scrollback this screen is reading, and whether a wider read is in
   * flight (section 5.3a).
   *
   * The poll asks for `PANE_LINES` until Casper taps "Earlier", and for
   * `PANE_LINES_MAX` from then until the screen closes. It stays widened on
   * purpose: dropping back to 200 on the next tick would take the history away
   * two seconds after it arrived.
   */
  let paneLines = $state(PANE_LINES);
  let expanding = $state(false);

  /**
   * The bridge pane id for this task's session.
   *
   * The ledger stores `box:w6:p1` and the bridge addresses `box/w6:p1`, so
   * every call that reaches a pane goes through this rather than through
   * session_ref directly. Local sessions come back unchanged.
   */
  const bridgePaneId = $derived(
    // A pane id from the Sessions list is already the bridge's own spelling;
    // it came from /panes. Only a ledger ref needs translating.
    paneId ?? paneIdForRef(task?.session_ref, app.machineNames)
  );
  /** Which machine this session is on, shown when it is not this laptop. */
  const sessionMachine = $derived(
    paneId ? (app.paneIndex.get(paneId)?.machine ?? 'local') : machineForRef(task?.session_ref, app.machineNames)
  );
  /**
   * True while a `<machine>:<id>` ref has no machine list to resolve against.
   *
   * Reading the pane in this window asks the bridge for `box:wC:p1`, an id it
   * has never issued, and gets HTTP 404 back for a session that is working.
   * Nothing calls the bridge until the list lands.
   */
  // A pane id from /panes is never pending: it is the id the bridge issued, so
  // there is no machine list to wait for and no ref to translate.
  const refPending = $derived(
    sessionOnly ? false : isRefUnresolved(task?.session_ref, app.machineNames)
  );

  /**
   * True when the machine this session is on is known to be down.
   *
   * Two sources, and they are split because only one of them can gate a poll.
   * `machineListedDown` is the bridge's own /machines list, which keeps arriving
   * from App's poll whether or not this screen reads anything, so the gate
   * clears itself the moment the machine answers again. `machineUnreachable` is
   * the 503 a read against a down machine returns; gating on that would switch
   * off the only call that could clear it. The banner reads both, the poll gate
   * reads the list alone.
   *
   * Only for a session on another machine. `sessionMachine` is `local` both for
   * a genuinely local pane and for a remote ref the machine list has not
   * resolved yet, so naming it here would put "Can't reach local" on a laptop
   * session, and would do it in exactly the window where nothing is known.
   */
  const machineListedDown = $derived(
    isRemote(sessionMachine) && app.machines.some((m) => m.name === sessionMachine && !m.reachable)
  );
  const machineDown = $derived(isRemote(sessionMachine) && (machineUnreachable || machineListedDown));

  /** The ledger crossed with the pane list, for the header and the banner. */
  const live = $derived(task ? liveTaskStatus(task, app.paneIndex, app.panesKnown, app.machineNames) : 'queued');

  // Live mode still turns on for a ledger-running task whose agent has stopped:
  // the transcript is the most useful thing on screen, and the composer is how
  // Casper answers. What changes is that the header stops calling it Running and
  // a banner says what actually happened.
  /**
   * Whether the pane list holds this pane. `undefined` until the list arrives.
   *
   * This, and not the agent's state, is what says a pane exists. A pane the list
   * holds is there whether its agent is working, blocked, idle or done; asking
   * about the agent instead conflated "the list has dropped it" with "the list
   * has it and it is not busy", and the second is most of the fleet.
   */
  const paneListed = $derived(
    !app.panesKnown || refPending || !bridgePaneId ? undefined : app.paneIndex.has(bridgePaneId)
  );

  /**
   * A 404 from the pane read, believed only when the pane list has dropped the
   * pane too.
   *
   * The list is the same signal every other screen judges this task by, and it
   * addresses the pane by the id the bridge itself issued. While it still holds
   * the pane, a 404 from the read is a failed read: the bridge answers 404 for
   * anything that is not a missing socket, its own 15 s exec timeout included.
   * Letting one win is what put "Pane gone" on a session that was running on
   * box, and then on every listed-but-idle pane whose read timed out once.
   */
  const paneReallyGone = $derived(paneIsGone(paneGone, paneListed));

  // A session opened on its pane is always the live view: there is no ledger
  // row to consult and no history list to fall back to. It stays live even
  // once the agent goes idle or done, because reading what it said and
  // answering it is the whole reason the screen was opened.
  const isLive = $derived(
    sessionOnly
      ? !paneReallyGone
      : !!task && !!task.session_ref && (task.status === 'running' || forceLive) && !paneReallyGone
  );

  /**
   * Whether the pane poll should run.
   *
   * Deliberately not gated on `paneGone`: that flag is set by the 404 itself, so
   * gating the timer on it made a single 404 permanent. The only code that
   * clears `paneGone` is the read the gate had just switched off, so a pane that
   * comes back, or a 404 that was only ever the unresolved-ref race, had no way
   * to correct itself short of leaving the screen.
   *
   * `paneReallyGone` does gate it, and does not have that problem: it needs the
   * pane list to agree, and the list keeps arriving from App's poll regardless
   * of what this screen reads. Without it a ledger-running task whose pane is
   * genuinely gone fired a read every pane interval, as low as one second, for
   * as long as the screen stayed open, each one a `herdr pane read` exec on the
   * bridge answering the same 404.
   */
  const shouldPoll = $derived(
    shouldPollPane({
      hasSession: sessionOnly || (!!task && !!task.session_ref),
      // No ledger to ask. The pane itself is the only authority here, and the
      // poll is what keeps a working session's text arriving.
      ledgerRunning: sessionOnly || task?.status === 'running',
      forceLive,
      refPending,
      paneReallyGone,
      machineListedDown,
    })
  );

  /**
   * The pane read is the freshest signal; fall back to the polled pane list.
   *
   * While the ref is unresolved nothing has been read and the pane list cannot
   * be looked up either, so the only thing left is the ledger. Rendering that as
   * "Working" states a fact about the agent that nothing has checked, next to a
   * body that honestly says "Reading pane…". `pending` says that instead, and is
   * not `unknown`, whose label "No agent" would be a different false claim.
   */
  const headerStatus = $derived(
    paneReallyGone
      ? 'gone'
      : paneStatus !== 'unknown'
        ? paneStatus
        : refPending
          ? 'pending'
          : liveToPane(live)
  );

  /** Map a live task status onto the pane vocabulary the header line speaks. */
  function liveToPane(v: string): string {
    if (v === 'running') return 'working';
    if (v === 'blocked') return 'blocked';
    if (v === 'finished') return 'done';
    if (v === 'stalled') return 'idle';
    if (v === 'orphan') return 'gone';
    return 'unknown';
  }

  /** Shown when the ledger still calls this running but the agent has stopped. */
  const staleNote = $derived.by(() => {
    if (!task || task.status !== 'running' || !isSettled(live)) return null;
    if (live === 'finished') return 'This agent has finished. projtrack still lists the task as running.';
    if (live === 'stalled') return 'This agent stopped without reporting a result.';
    return 'No live session for this task. It is still listed as running.';
  });
  const blocks = $derived<Block[]>(paneText ? parsePane(paneText) : []);

  const visiblePending = $derived(
    pending.filter((p) => Date.now() - p.at < 5000 || !paneText.includes(p.text.slice(0, 40)))
  );

  async function loadTask() {
    // Opened on a pane: there is no task to load, and asking projtrack for one
    // would raise a banner about a backend this screen does not need.
    if (taskId === undefined) {
      loadingTask = false;
      return;
    }
    try {
      task = await projtrack.task(app.settings, taskId);
      taskError = null;
      app.noteSuccess();
    } catch (e) {
      taskError = apiFailureText('projtrack', e, !!app.settings.token);
      app.noteFailure();
    } finally {
      loadingTask = false;
    }
  }

  /**
   * What the empty transcript is waiting for.
   *
   * It used to say "Reading pane…" in every case, including the two where
   * nothing is being read at all: `readPane` returns before it starts when the
   * ref cannot be resolved yet, so a bridge that never answers left that line
   * on screen for as long as the screen was open, under a header that said
   * "Finding session", with nothing anywhere naming the bridge. A wait with no
   * end and no reason is the one thing a status line must not be.
   */
  const waitingLabel = $derived(
    refPending && app.bridgeError
      ? app.bridgeError
      : refPending
        ? 'Finding the session…'
        : 'Reading pane…'
  );

  async function readPane() {
    const paneId = bridgePaneId;
    if (!paneId) return;
    // The machine list has not arrived, so `paneId` is not yet the id the
    // bridge knows. Asking anyway returns 404 for a live session.
    if (refPending) return;
    try {
      const r = await bridge.read(app.settings, paneId, paneLines);
      // Re-render only when the text actually changed (section 5.3a).
      if (r.text !== paneText) {
        paneText = r.text;
        await tick();
        if (atBottom) scrollToBottom(true);
      }
      paneStatus = r.agent_status;
      paneGone = false;
      paneError = null;
      machineUnreachable = false;
      paneFailures = 0;
      app.noteSuccess();
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        paneGone = true;
        paneError = null;
        machineUnreachable = false;
        return;
      }
      // 503 is the bridge saying it is fine and the machine is not: it answered
      // the request in order to tell us so. Counting it as a bridge failure put
      // "Can't reach the pane bridge" on screen and, through app.failures,
      // tripped the OfflineStrip within two pane polls while projtrack and the
      // bridge were both answering normally. The machine is what is down, and
      // that is what the banner now says.
      if (e instanceof ApiError && e.status === 503) {
        machineUnreachable = true;
        paneError = null;
        paneFailures = 0;
        app.noteSuccess();
        return;
      }
      machineUnreachable = false;
      paneFailures += 1;
      // Three failures in a row raise the banner; the last transcript stays on
      // screen either way, and is never cleared (section 9).
      if (paneFailures >= 3)
        paneError = apiFailureText(
          `the pane bridge at ${app.settings.bridgeUrl}`,
          e,
          !!app.settings.token
        );
      app.noteFailure();
    } finally {
      firstRead = false;
    }
  }

  /** A finished task whose pane is still alive gets an "Open session" button. */
  async function checkSession() {
    // Already in the live view; nothing to offer to open.
    if (sessionOnly) return;
    if (!task?.session_ref || task.status === 'running') return;
    // Same unresolved-ref race as readPane: a 404 here would report a live
    // session on another machine as dead.
    if (refPending) return;
    try {
      const p = await bridge.pane(app.settings, bridgePaneId);
      sessionAlive = true;
      paneLabel = p.label;
    } catch {
      sessionAlive = false;
    }
  }

  /**
   * Widen this screen's read to the whole window herdr will give (section 5.3a).
   *
   * The extra lines arrive above what is already on screen, so the viewport is
   * held at its distance from the bottom rather than its offset from the top:
   * anchoring to the top would leave Casper looking at a point ~800 lines
   * further back than the one they tapped from.
   */
  async function expandScrollback() {
    if (paneLines >= PANE_LINES_MAX || expanding) return;
    expanding = true;
    const fromBottom = scroller ? scroller.scrollHeight - scroller.scrollTop : 0;
    const wasAtBottom = atBottom;
    paneLines = PANE_LINES_MAX;
    try {
      await readPane();
    } finally {
      expanding = false;
    }
    await tick();
    // At the bottom, readPane has already scrolled there and that is where the
    // newest output belongs; only a scrolled-up viewport needs holding.
    if (scroller && !wasAtBottom) scroller.scrollTop = scroller.scrollHeight - fromBottom;
  }

  function scrollToBottom(smooth = false) {
    if (!scroller) return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  function onScroll() {
    if (!scroller) return;
    const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    atBottom = gap < 24;
    // Autoscroll stops once the user is more than 80px up (section 5.3a).
    showJump = gap > 80;
  }

  async function sendText(text: string) {
    const paneId = bridgePaneId;
    if (!paneId) return;
    // Same unresolved-ref window readPane waits out: `box:wC:p1` is not an
    // id the bridge has, so the send would 404 and toast at Casper.
    if (refPending) return;
    pending = [...pending, { text, at: Date.now() }];
    try {
      await bridge.send(app.settings, paneId, text);
      app.showToast('Sent');
      await readPane();
    } catch (e) {
      pending = pending.filter((p) => p.text !== text);
      app.showToast(e instanceof Error ? e.message : 'Send failed', 'alert');
    }
  }

  async function sendKey(key: string) {
    const paneId = bridgePaneId;
    if (!paneId) return;
    // Same unresolved-ref window readPane waits out: `box:wC:p1` is not an
    // id the bridge has, so the send would 404 and toast at Casper.
    if (refPending) return;
    try {
      await bridge.keys(app.settings, paneId, [key]);
      app.showToast('Sent');
      setTimeout(() => void readPane(), 250);
    } catch (e) {
      app.showToast(e instanceof Error ? e.message : 'Send failed', 'alert');
    }
  }

  async function sendDigit(digit: string) {
    const paneId = bridgePaneId;
    if (!paneId) return;
    // Same unresolved-ref window readPane waits out: `box:wC:p1` is not an
    // id the bridge has, so the send would 404 and toast at Casper.
    if (refPending) return;
    try {
      await bridge.text(app.settings, paneId, digit);
      setTimeout(() => void readPane(), 250);
    } catch (e) {
      app.showToast(e instanceof Error ? e.message : 'Send failed', 'alert');
    }
  }

  // Both of these write to a projtrack row. Neither is reachable without one:
  // the note composer belongs to history mode and the menu is only offered when
  // a task loaded, so the guard is the type's, not a case to handle.
  async function addNote(note: string) {
    if (taskId === undefined) return;
    try {
      await projtrack.addNote(app.settings, taskId, note);
      app.showToast('Note added');
      await loadTask();
    } catch (e) {
      app.showToast(e instanceof Error ? e.message : 'Could not add note', 'alert');
    }
  }

  async function abandon() {
    if (taskId === undefined) return;
    try {
      await projtrack.setTaskStatus(app.settings, taskId, 'abandoned');
      app.showToast('Marked abandoned');
      await loadTask();
    } catch (e) {
      app.showToast(e instanceof Error ? e.message : 'Could not update', 'alert');
    }
  }

  onMount(() => {
    // A session opened on its pane reads immediately: nothing has to be
    // fetched first to learn which pane it is.
    if (sessionOnly) void readPane();
    void loadTask().then(() => {
      void checkSession();
      if (task?.status === 'running' && task.session_ref) void readPane();
    });

    const paneTimer = setInterval(() => {
      if (app.visible && shouldPoll) void readPane();
    }, app.intervals.pane);
    const taskTimer = setInterval(() => {
      if (app.visible && !sessionOnly) void loadTask();
    }, 15_000);
    return () => {
      clearInterval(paneTimer);
      clearInterval(taskTimer);
    };
  });

  let wasVisible = true;
  $effect(() => {
    const now = app.visible;
    if (now && !wasVisible && shouldPoll) void readPane();
    wasVisible = now;
  });

  // The first read of a remote session usually cannot happen on mount: the
  // machine list comes from App's own poll and may land after this screen does.
  // Reading on the edge where the ref becomes resolvable shows a box task's
  // transcript as soon as the list arrives, rather than a pane interval later.
  // It also clears a `paneGone` left over from a read that raced the list.
  let wasPending = false;
  $effect(() => {
    const pending = refPending;
    if (wasPending && !pending) {
      paneGone = false;
      if (shouldPoll) void readPane();
      else void checkSession();
    }
    wasPending = pending;
  });

  // Opening the live view of a still-alive finished session starts its poll.
  $effect(() => {
    if (forceLive && !paneText) void readPane();
  });

  /**
   * What the history line calls this task, and which vocabulary says it.
   *
   * Normally the ledger's own word in the task vocabulary. With the pane gone
   * that word is still "running", which put "Running · 14 min ago" directly
   * above a banner reading "Pane gone": the header and the banner describing
   * one task two ways. The live vocabulary has the honest word for it,
   * `orphan`, "Session gone" - the ledger says running and there is no such
   * pane. Saying `abandoned` instead would invent a ledger state projtrack has
   * not written.
   */
  const histStatus = $derived<{ domain: 'task' | 'live'; value: string }>(
    paneReallyGone && task?.status === 'running'
      ? { domain: 'live', value: 'orphan' }
      : { domain: 'task', value: task?.status ?? 'queued' }
  );

  /** History events grouped with a divider whenever the day changes. */
  const events = $derived(task?.events ?? []);

  /**
   * What the header calls this screen.
   *
   * A task has a title. A session has whatever the pane list calls it, which is
   * the agent's own name where it set one and the workspace label otherwise;
   * the pane id is the last resort, and is at least unambiguous.
   */
  const screenTitle = $derived.by(() => {
    if (!sessionOnly) return task?.title ?? '';
    return app.paneIndex.get(bridgePaneId)?.label || paneLabel || bridgePaneId;
  });
</script>

<Header title={screenTitle} onBack={onBack} compact onMore={task ? () => (menuOpen = true) : undefined}>
  {#snippet subtitle()}
    {#if task || sessionOnly}
      {#if isLive}
        <!-- The ledger's ref where there is one, so the line keeps naming the
             session the way the task does; the bridge's own id otherwise. -->
        <LiveStatusLine
          agentStatus={headerStatus}
          paneId={task?.session_ref ?? bridgePaneId}
          machine={sessionMachine}
          label={sessionOnly ? undefined : paneLabel}
        />
      {:else if task}
        <!-- `histStatus` rather than `task.status`: with the pane gone the
             ledger still says running, and printing that put "Running" directly
             above a banner reading "Pane gone". -->
        <div class="hist-status">
          <StatusDot domain={histStatus.domain} value={histStatus.value} size={9} />
          <span class="t-meta">
            {statusSpec(histStatus.domain, histStatus.value).label} · {relativeTime(task.updated_at)}
          </span>
        </div>
      {/if}
    {/if}
  {/snippet}
</Header>

{#if machineDown}
  <!-- The bridge answered; it just cannot reach the machine. Saying "can't
       reach the pane bridge" here sent Casper to check a service that was up. -->
  <div class="pad">
    <ErrorBanner
      text="Can't reach {sessionMachine}. The pane bridge is up."
      onRetry={() => void readPane()}
    />
  </div>
{:else if paneReallyGone}
  <div class="pad"><ErrorBanner text="Pane gone" /></div>
{:else if staleNote}
  <div class="pad"><p class="t-meta stale">{staleNote}</p></div>
{/if}

{#if isLive}
  <div class="pad toggle">
    <SegmentedFilter
      options={[
        { value: 'messages', label: 'Messages' },
        { value: 'terminal', label: 'Terminal' },
      ]}
      value={view}
      onChange={(v) => (view = v)}
    />
  </div>

  <div class="scroll" bind:this={scroller} onscroll={onScroll}>
    <!-- Both views read the same text, so the scrollback control sits above
         the switch rather than inside the messages branch. -->
    {#if paneText}
      {#if paneLines < PANE_LINES_MAX}
        <button class="earlier t-meta" onclick={() => void expandScrollback()} disabled={expanding}>
          {expanding ? 'Loading earlier…' : '↑ Earlier'}
        </button>
      {:else}
        <p class="earlier-end t-meta">Start of available scrollback</p>
      {/if}
    {/if}
    {#if firstRead && !paneText}
      <p class="t-meta center">{waitingLabel}</p>
    {:else if !paneText}
      <!-- A read has completed and the screen was empty. Rendering the block
           loop here drew literally nothing: a blank scroller under a header
           saying "Working", with no way to tell a silent agent from a broken
           view. `firstRead` only covers the window before the first answer. -->
      <EmptyState text="This session has not printed anything yet" />
    {:else if view === 'terminal'}
      <TerminalView text={paneText} />
    {:else}
      {#each blocks as b, i (i)}
        {#if b.kind === 'message'}
          <MessageBlock text={b.text} />
        {:else if b.kind === 'tool'}
          <ToolLine head={b.head} result={b.result} />
        {:else if b.kind === 'user'}
          <UserBlock text={b.text} />
        {:else if b.kind === 'dialog'}
          <DialogCard lines={b.lines} />
        {:else if b.kind === 'spinner'}
          <SpinnerLine word={b.word} elapsed={b.elapsed} />
        {:else if b.kind === 'raw'}
          <!-- No glyph on this screen was recognised. Showing it verbatim beats
               an empty Messages tab, which is what an unknown TUI used to get. -->
          <TerminalView text={b.text} />
        {/if}
      {/each}
      {#each visiblePending as p (p.at)}
        <UserBlock text={p.text} pending />
      {/each}
    {/if}
  </div>

  {#if showJump}
    <button class="jump" onclick={() => { scrollToBottom(true); showJump = false; atBottom = true; }}>
      ⌄ latest
    </button>
  {/if}

  <div class="foot">
    {#if paneError}
      <ErrorBanner
        text={paneError}
        onRetry={() => void readPane()}
      />
    {/if}
    <Composer
      placeholder="Message this session…"
      disabled={paneReallyGone || refPending}
      onSend={sendText}
      onFocusChange={onComposerFocus}
    />
    <QuickKeys
      onKey={sendKey}
      onText={sendDigit}
      disabled={paneReallyGone || refPending}
      alertDigits={paneStatus === 'blocked'}
    />
  </div>
{:else if sessionOnly}
  <!-- Opened on a pane the bridge no longer has. There is no ledger row behind
       this screen to fall back to, so it says that plainly rather than offering
       a note composer for a task that does not exist. -->
  <div class="scroll">
    <EmptyState text="This session is gone. The pane bridge no longer lists it." />
  </div>
{:else}
  <!-- 5.3b history mode -->
  <div class="scroll">
    {#if taskError}
      <ErrorBanner text={taskError} onRetry={loadTask} />
    {/if}

    {#if loadingTask && !task}
      <p class="t-meta center">Loading…</p>
    {:else if task}
      {#if sessionAlive && !forceLive}
        <button class="open-session" onclick={() => (forceLive = true)}>Open session</button>
      {/if}

      {#if task.result_summary?.trim()}
        <SectionLabel text="Result" />
        <div class="result t-body selectable">{task.result_summary}</div>
      {/if}

      {#if events.length}
        <SectionLabel text="History" />
        {#each events as ev, i (ev.id)}
          {#if i === 0 || dayKey(ev.created_at) !== dayKey(events[i - 1].created_at)}
            <TimeDivider label={dayLabel(ev.created_at)} />
          {/if}
          <div class="event">
            <span class="mono time">{clockTime(ev.created_at)}</span>
            <span class="t-body note selectable">{ev.note}</span>
          </div>
        {/each}
      {:else if !task.result_summary?.trim()}
        <EmptyState text="Nothing recorded for this task yet" />
      {/if}
    {/if}
  </div>

  <div class="foot">
    <Composer placeholder="Add a note…" onSend={addNote} onFocusChange={onComposerFocus} />
  </div>
{/if}

<ActionSheet
  open={menuOpen}
  title={task?.title ?? ''}
  onClose={() => (menuOpen = false)}
  actions={[
    {
      label: 'Abandon task',
      destructive: true,
      disabled: !task || ['done', 'abandoned'].includes(task.status),
      onSelect: abandon,
    },
  ]}
/>

<style>
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 8px var(--pad-screen) 12px;
  }
  .pad {
    padding: 0 var(--pad-screen);
  }
  .toggle {
    padding-top: 8px;
    padding-bottom: 4px;
  }
  .foot {
    flex: none;
    padding: 4px var(--pad-screen) calc(8px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--hairline);
    background: var(--bg);
  }
  .center {
    text-align: center;
    padding: 32px 0;
  }
  /* The correction sits above the transcript, in done-green rather than alert
     red: nothing is broken, the ledger is just behind. */
  .stale {
    margin: 6px 0 0;
    padding: 8px 10px;
    border-radius: var(--r-card);
    color: var(--t-primary);
    background: color-mix(in srgb, var(--c-done) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--c-done) 30%, var(--hairline));
  }
  .hist-status {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  /* Sits at the head of the transcript, where a scrolled-up reader meets it.
     Quiet by default: it is a way further back, not an action on the task. */
  .earlier {
    display: block;
    width: 100%;
    padding: 8px 0 10px;
    min-height: 44px;
    text-align: center;
    color: var(--t-secondary);
  }
  .earlier:disabled {
    color: var(--t-tertiary);
  }
  .earlier-end {
    margin: 0;
    padding: 8px 0 10px;
    text-align: center;
    color: var(--t-tertiary);
  }
  .jump {
    position: absolute;
    right: var(--pad-screen);
    bottom: 132px;
    z-index: 5;
    padding: 8px 14px;
    border-radius: var(--r-chip);
    background: var(--surface-2);
    border: 1px solid var(--hairline);
    color: var(--t-primary);
    font-size: 13px;
    animation: block-in var(--d-base) var(--ease-out);
  }
  .result {
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: var(--r-card);
    padding: 14px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .event {
    display: flex;
    gap: 12px;
    padding: 8px 0;
    align-items: baseline;
  }
  .time {
    color: var(--t-secondary);
    flex: none;
  }
  .note {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .open-session {
    color: var(--accent);
    font-size: 13px;
    font-weight: 600;
    padding: 10px 0;
    min-height: 44px;
  }
</style>
