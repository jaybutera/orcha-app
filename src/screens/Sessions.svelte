<script lang="ts">
  /**
   * Every session the pane bridge is serving, openable.
   *
   * The Fleet tab reaches a session through its projtrack task, and the ledger
   * is not a reliable index of what is running. Measured against the live
   * daemon on 2026-09-14: of 11 panes the bridge was serving, 5 had no task row
   * at all (the Codex pane among them) and so had no route into the app; of 22
   * task session_refs, 16 named panes that no longer existed. This list is the
   * bridge's own answer instead, so what is on screen is what is running.
   *
   * It reuses App's `/panes` poll rather than starting a third one; that poll
   * already runs for every task status in the app.
   */
  import Header from '../components/Header.svelte';
  import StatusDot from '../components/StatusDot.svelte';
  import Icon from '../components/Icon.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import ErrorBanner from '../components/ErrorBanner.svelte';
  import SectionLabel from '../components/SectionLabel.svelte';
  import SegmentedFilter from '../components/SegmentedFilter.svelte';
  import { app } from '../lib/store.svelte';
  import { statusSpec } from '../lib/format';
  import { isRemote } from '../lib/pane-id';
  import type { Pane } from '../lib/types';

  let {
    onOpenSession,
    onBack,
  }: { onOpenSession: (paneId: string) => void; onBack?: () => void } = $props();

  let filter = $state<'active' | 'all'>('active');

  /**
   * Working and blocked first, then the rest.
   *
   * A blocked agent is waiting on an answer and a working one is producing
   * text; both are worth more than an idle pane, and sorting by status keeps
   * them at the top of a list that is otherwise in whatever order herdr
   * enumerated its workspaces.
   */
  const RANK: Record<string, number> = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };

  const sorted = $derived(
    [...app.panes].sort(
      (a, b) =>
        (RANK[a.agent_status] ?? 9) - (RANK[b.agent_status] ?? 9) ||
        a.pane_id.localeCompare(b.pane_id)
    )
  );

  /** "Active" hides the idle panes, which on a busy laptop are most of them. */
  const shown = $derived(
    filter === 'all'
      ? sorted
      : sorted.filter((p) => p.agent_status === 'working' || p.agent_status === 'blocked')
  );

  const needsYou = $derived(app.panes.filter((p) => p.agent_status === 'blocked').length);

  /** The cwd's last segment: which project this session is in, in one word. */
  function project(p: Pane): string {
    const parts = (p.cwd ?? '').split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

  /** Shown only for a provider the bridge actually named. */
  function providerLabel(p: Pane): string {
    if (p.provider === 'claude') return 'Claude';
    if (p.provider === 'codex') return 'Codex';
    return '';
  }
</script>

<Header title="Sessions" {onBack} />

<div class="scroll">
  {#if app.bridgeError}
    <ErrorBanner text={app.bridgeError} />
  {/if}

  <div class="filter">
    <SegmentedFilter
      options={[
        { value: 'active', label: 'Active' },
        { value: 'all', label: `All (${app.panes.length})` },
      ]}
      value={filter}
      onChange={(v) => (filter = v as 'active' | 'all')}
    />
  </div>

  {#if needsYou}
    <SectionLabel text="{needsYou} waiting on you" />
  {/if}

  {#if !app.panesKnown}
    <p class="t-meta center">Asking the pane bridge…</p>
  {:else if !shown.length}
    <EmptyState
      text={filter === 'active' && app.panes.length
        ? 'Nothing is working right now. Tap All to see idle sessions.'
        : 'The pane bridge is not serving any sessions.'}
    />
  {:else}
    {#each shown as p (p.pane_id)}
      <button class="row" onclick={() => onOpenSession(p.pane_id)}>
        <span class="glyph">
          <StatusDot domain="pane" value={p.agent_status} size={10} />
        </span>
        <span class="mid">
          <span class="t-body title">{p.label || p.pane_id}</span>
          <span class="t-meta sub">
            <span class="flag">{statusSpec('pane', p.agent_status).label}</span>
            {#if isRemote(p.machine)} · <span class="machine mono">{p.machine}</span>{/if}
            {#if providerLabel(p)} · {providerLabel(p)}{/if}
            {#if project(p)} · {project(p)}{/if}
            · <span class="mono pane">{p.pane_id}</span>
          </span>
        </span>
        <span class="chev"><Icon name="forward" size={18} /></span>
      </button>
    {/each}
  {/if}
</div>

<style>
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 4px var(--pad-screen) 12px;
  }
  .filter {
    padding: 8px 0 4px;
  }
  .center {
    text-align: center;
    padding: 32px 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 56px;
    padding: 10px 0;
    text-align: left;
    border-bottom: 1px solid var(--hairline);
  }
  .glyph {
    flex: none;
    display: flex;
    align-items: center;
  }
  .mid {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .flag {
    color: var(--t-secondary);
  }
  .machine,
  .pane {
    color: var(--t-tertiary);
  }
  .chev {
    flex: none;
    color: var(--t-tertiary);
  }
</style>
