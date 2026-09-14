<script lang="ts">
  import { projtrackBase } from '../lib/settings';
  // Fleet root, section 5.1.
  import Header from '../components/Header.svelte';
  import SummaryLine from '../components/SummaryLine.svelte';
  import SegmentedFilter from '../components/SegmentedFilter.svelte';
  import ProjectCard from '../components/ProjectCard.svelte';
  import Skeleton from '../components/Skeleton.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import ErrorBanner from '../components/ErrorBanner.svelte';
  import ActionSheet from '../components/ActionSheet.svelte';
  import Icon from '../components/Icon.svelte';
  import { app } from '../lib/store.svelte';
  import { apiFailureText, projtrack } from '../lib/api';
  import { isSettled, liveTaskStatus } from '../lib/live';
  import { DEFAULT_DORMANT_AFTER_HOURS, wentDormant } from '../lib/dormancy';
  import type { ProjectStatus, Summary, SummaryProject } from '../lib/types';
  import { onMount } from 'svelte';

  let {
    onOpenProject,
    onOpenSessions,
    selectedId,
  }: {
    onOpenProject: (id: number) => void;
    onOpenSessions?: () => void;
    selectedId?: number;
  } = $props();

  /**
   * Live sessions, counted from the bridge rather than from the ledger.
   *
   * These are the panes themselves, so the figure includes the ones projtrack
   * has no task for; those are the sessions this row exists to reach.
   */
  const paneCounts = $derived.by(() => {
    let working = 0;
    let blocked = 0;
    for (const p of app.panes) {
      if (p.agent_status === 'working') working += 1;
      else if (p.agent_status === 'blocked') blocked += 1;
    }
    return { working, blocked, total: app.panes.length };
  });

  type Filter = ProjectStatus | 'all';

  let summary = $state<Summary | null>(null);
  let loading = $state(true);
  let refreshing = $state(false);
  let error = $state<string | null>(null);
  let menuFor = $state<SummaryProject | null>(null);
  let filter = $state<Filter>((app.settings.projectFilter as Filter) || 'active');

  const FILTERS: { value: Filter; label: string }[] = [
    { value: 'active', label: 'Active' },
    { value: 'dormant', label: 'Dormant' },
    { value: 'dead', label: 'Dead' },
    { value: 'all', label: 'All' },
  ];

  /**
   * A project's running tasks split by what their panes actually report.
   *
   * Blocked is its own figure. Counting it as running claimed work was in
   * flight for an agent sitting at a prompt, and counting it as review used the
   * phrase a stalled task earns for the one task that can still be answered.
   */
  function liveCount(p: SummaryProject) {
    let running = 0;
    let blocked = 0;
    let review = 0;
    for (const t of p.running_tasks ?? []) {
      const s = liveTaskStatus(t, app.paneIndex, app.panesKnown, app.machineNames);
      if (s === 'blocked') blocked += 1;
      else if (isSettled(s)) review += 1;
      else running += 1;
    }
    return { running, blocked, review };
  }

  /** Fleet totals counted from the panes, not from the ledger's running_tasks. */
  const totals = $derived.by(() => {
    let running = 0;
    let blocked = 0;
    let review = 0;
    for (const p of summary?.projects ?? []) {
      const c = liveCount(p);
      running += c.running;
      blocked += c.blocked;
      review += c.review;
    }
    // Tasks the summary counts as running but does not list are still counted;
    // the ledger's total is the floor, and only what we can see gets moved.
    const listed = (summary?.projects ?? []).reduce((n, p) => n + (p.running_tasks?.length ?? 0), 0);
    const unseen = Math.max(0, (summary?.running_tasks ?? 0) - listed);
    return { running: running + unseen, blocked, review };
  });

  /** Filter is applied client-side so switching it never spins (section 5.1). */
  const shown = $derived.by(() => {
    const all = summary?.projects ?? [];
    const list = filter === 'all' ? [...all] : all.filter((p) => p.status === filter);
    return list.sort((a, b) => {
      // Dead always last in the All view.
      if (filter === 'all') {
        const deadA = a.status === 'dead' ? 1 : 0;
        const deadB = b.status === 'dead' ? 1 : 0;
        if (deadA !== deadB) return deadA - deadB;
      }
      // Projects with a genuinely running task first, then those with an agent
      // waiting on Casper, then updated_at descending. Sorting on the ledger's
      // running list floated projects whose every agent had already stopped.
      const rank = (p: SummaryProject) => {
        const c = liveCount(p);
        if (c.running > 0) return 0;
        if (c.review > 0) return 1;
        return 2;
      };
      const rankA = rank(a);
      const rankB = rank(b);
      if (rankA !== rankB) return rankA - rankB;
      return Date.parse(b.updated_at) - Date.parse(a.updated_at);
    });
  });

  async function load(quiet = false) {
    if (quiet) refreshing = true;
    try {
      const next = await projtrack.summary(app.settings);
      // A project the clock moved while the list was on screen otherwise just
      // vanishes from the Active filter, which reads as the app losing it.
      // Say it happened, once, naming the project.
      announce(wentDormant(summary?.projects ?? null, next.projects));
      summary = next;
      error = null;
      app.noteSuccess();
    } catch (e) {
      error = apiFailureText(`projtrack at ${projtrackBase(app.settings)}`, e, !!app.settings.token);
      app.noteFailure();
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  /** Tell the user which projects went quiet on their own, in one toast. */
  function announce(moved: SummaryProject[]) {
    if (moved.length === 0) return;
    const what =
      moved.length === 1
        ? `${moved[0].name} went dormant`
        : `${moved.length} projects went dormant`;
    app.showToast(`${what} · untouched for ${dormantAfterHours} h`);
  }

  function setFilter(v: Filter) {
    filter = v;
    void app.updateSettings({ projectFilter: v });
  }

  async function setStatus(p: SummaryProject, status: ProjectStatus) {
    try {
      await projtrack.setProjectStatus(app.settings, p.id, status);
      // Update in place so the card does not wait for the next poll.
      if (summary) {
        summary = {
          ...summary,
          projects: summary.projects.map((x) => (x.id === p.id ? { ...x, status } : x)),
        };
      }
      app.showToast(`Marked ${status}`);
    } catch (e) {
      app.showToast(e instanceof Error ? e.message : 'Could not update', 'alert');
    }
  }

  /** The dormancy window projtrack is running, so the cards count down to it. */
  const dormantAfterHours = $derived(summary?.dormant_after_hours ?? DEFAULT_DORMANT_AFTER_HOURS);

  const emptyText = $derived(
    filter === 'all' ? 'No projects yet' : `No ${filter} projects`
  );

  onMount(() => {
    void load();
    // Every 15s while visible; polling stops when hidden (section 9).
    const timer = setInterval(() => {
      if (app.visible) void load(true);
    }, app.intervals.projects);
    return () => clearInterval(timer);
  });

  // Returning to the foreground refetches immediately (section 9). Only the
  // false -> true edge fires; `loading` is deliberately not read here.
  let wasVisible = true;
  $effect(() => {
    const now = app.visible;
    if (now && !wasVisible) void load(true);
    wasVisible = now;
  });
</script>

<Header title="Orcha" onGear={() => (app.settingsOpen = true)}>
  {#snippet subtitle()}
    <SummaryLine
      running={totals.running}
      blocked={totals.blocked}
      needsReview={totals.review}
      queued={summary?.queued_tasks ?? 0}
      projects={shown.length}
      {refreshing}
      loading={loading && !summary}
    />
  {/snippet}
</Header>

<div class="scroll">
  <!-- Straight to the panes the bridge is serving. The project list below can
       only reach a session projtrack has a task for, and most running panes
       either have no task or have one whose ref names a pane that is gone. -->
  {#if onOpenSessions}
    <button class="sessions" onclick={onOpenSessions}>
      <span class="mid">
        <span class="t-body title">Sessions</span>
        <span class="t-meta sub">
          {#if !app.panesKnown}
            Asking the pane bridge…
          {:else if paneCounts.blocked}
            {paneCounts.blocked} waiting on you · {paneCounts.working} working · {paneCounts.total} open
          {:else}
            {paneCounts.working} working · {paneCounts.total} open
          {/if}
        </span>
      </span>
      {#if paneCounts.blocked}<span class="badge"></span>{/if}
      <span class="chev"><Icon name="forward" size={18} /></span>
    </button>
  {/if}

  <div class="filter">
    <SegmentedFilter options={FILTERS} value={filter} onChange={setFilter} />
  </div>

  {#if error}
    <ErrorBanner
      text={error}
      onRetry={() => load()}
    />
  {/if}

  <div class="list" class:dim={error && summary}>
    {#if loading && !summary}
      <Skeleton shape="card" />
      <Skeleton shape="card" />
      <Skeleton shape="card" />
    {:else if shown.length === 0}
      <EmptyState text={emptyText} />
    {:else}
      {#each shown as p (p.id)}
        <ProjectCard
          project={p}
          selected={selectedId === p.id}
          {dormantAfterHours}
          onOpen={() => onOpenProject(p.id)}
          onLongPress={() => (menuFor = p)}
        />
      {/each}
    {/if}
  </div>
</div>

<ActionSheet
  open={menuFor !== null}
  title={menuFor?.name ?? ''}
  onClose={() => (menuFor = null)}
  actions={(['active', 'dormant', 'dead'] as ProjectStatus[]).map((s) => ({
    label: `Mark ${s}`,
    disabled: menuFor?.status === s,
    destructive: s === 'dead',
    onSelect: () => menuFor && setStatus(menuFor, s),
  }))}
/>

<style>
  .sessions {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 56px;
    padding: 12px 0;
    text-align: left;
    border-bottom: 1px solid var(--hairline);
  }
  .sessions .mid {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .sessions .sub {
    color: var(--t-secondary);
  }
  .sessions .badge {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--c-alert);
  }
  .sessions .chev {
    flex: none;
    color: var(--t-tertiary);
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 var(--pad-screen) 16px;
  }
  .filter {
    margin: 12px 0 16px;
  }
  .list {
    transition: opacity var(--d-base) var(--ease-out);
  }
  .list.dim {
    opacity: 0.6;
  }
</style>
