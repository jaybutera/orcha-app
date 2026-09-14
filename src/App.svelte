<script lang="ts">
  import AppShell from './components/AppShell.svelte';
  import Toast from './components/Toast.svelte';
  import OfflineStrip from './components/OfflineStrip.svelte';
  import EmptyState from './components/EmptyState.svelte';
  import Projects from './screens/Projects.svelte';
  import ProjectDetail from './screens/ProjectDetail.svelte';
  import TaskDetail from './screens/TaskDetail.svelte';
  import Sessions from './screens/Sessions.svelte';
  import Chat from './screens/Chat.svelte';
  import Usage from './screens/Usage.svelte';
  import SettingsSheet from './screens/SettingsSheet.svelte';
  import { app } from './lib/store.svelte';
  import { apiFailureText, bridge, projtrack } from './lib/api';
  import { paneIdForRef } from './lib/pane-id';
  import { startChatWatch } from './lib/chat-watch';
  import type { Task } from './lib/types';
  import { onMount } from 'svelte';

  let wide = $state(false);
  let composerFocused = $state(false);

  const route = $derived(app.route);
  // The bottom bar hides on Task detail and whenever a composer has focus (3.1).
  const hideBar = $derived(
    route.screen === 'task' || route.screen === 'session' || composerFocused
  );

  function openProject(id: number) {
    app.push({ screen: 'project', projectId: id });
  }

  function openTask(task: Task) {
    app.push({ screen: 'task', taskId: task.id, projectId: task.project_id });
  }

  function openSessions() {
    app.push({ screen: 'sessions' });
  }

  function openSession(paneId: string) {
    app.push({ screen: 'session', paneId });
  }

  /**
   * A chat event's pane id opens that session.
   *
   * It prefers the projtrack task where one matches, because the task screen
   * carries the ledger's history alongside the transcript. But a pane with no
   * task is the common case rather than the exception, and this used to answer
   * it with a toast reading "No task for this pane" and go nowhere. The pane
   * itself is always openable, so that is the fallback rather than a dead end.
   *
   * The lookup compares both spellings: projtrack stores `box:w6:p1` and the
   * bridge issues `box/w6:p1`, so matching the raw ref alone missed every
   * remote session.
   */
  async function openPane(paneId: string) {
    try {
      const summary = await projtrack.summary(app.settings);
      const wanted = paneIdForRef(paneId, app.machineNames);
      for (const p of summary.projects) {
        const hit = [...(p.running_tasks ?? []), ...(p.open_tasks ?? [])].find(
          (t) =>
            t.session_ref === paneId ||
            paneIdForRef(t.session_ref, app.machineNames) === wanted
        );
        if (hit) {
          app.openTask(hit.id, p.id);
          return;
        }
      }
      app.openSession(wanted);
    } catch {
      // projtrack is not answering; the bridge is a different backend and may
      // well be. Opening the pane is still the thing that was asked for.
      app.openSession(paneIdForRef(paneId, app.machineNames));
    }
  }

  onMount(() => {
    if (location.hash === '#usage') app.tab = 'usage';
    else if (location.hash === '#chat') app.tab = 'chat';
    const mq = window.matchMedia('(min-width: 900px)');
    const apply = () => (wide = mq.matches);
    apply();
    mq.addEventListener('change', apply);

    // All polling stops when the page is hidden and resumes on return (§9).
    const onVis = () => {
      app.visible = document.visibilityState === 'visible';
      document.body.classList.toggle('hidden', !app.visible);
    };
    document.addEventListener('visibilitychange', onVis);
    onVis();

    // Android hardware/gesture back pops the Fleet stack (section 3.1). The
    // history entry is the hook Tauri's WebView gives us for that.
    history.replaceState({ herdr: true }, '');
    const onPop = () => {
      const handled = app.handleBack();
      if (handled) history.pushState({ herdr: true }, '');
      // Not handled means the Fleet root: let the app exit.
    };
    window.addEventListener('popstate', onPop);
    history.pushState({ herdr: true }, '');

    // The pane list is the live half of every task status (section 3.2), so it
    // polls on the same cadence as the projects list rather than at a third of
    // it: a task that finishes should stop reading "Working" within one tick,
    // not up to 20s later.
    const pollPanes = async () => {
      if (!app.visible) return;
      try {
        const r = await bridge.panes(app.settings);
        app.setPanes(r.panes ?? []);
        app.bridgeError = null;
      } catch (e) {
        // The bridge may not be up. `panesKnown` stays as it was, so screens
        // fall back to the ledger rather than calling every session an orphan
        // — but the reason is kept now, because screens that wait on this list
        // used to wait on it silently and forever.
        // Named, the way the projtrack banner names its address. Without it a
        // reader is told the bridge said something without being told which
        // bridge, and the whole question in that moment — the two addresses in
        // Settings are separate, and one of them is wrong — is which one it
        // asked.
        app.bridgeError = apiFailureText(
          `the pane bridge at ${app.settings.bridgeUrl}`,
          e,
          !!app.settings.token
        );
      }
      try {
        const m = await bridge.machines(app.settings);
        app.setMachines(m.machines ?? []);
      } catch {
        // A bridge without /machines is an older one. The machines named by
        // the panes themselves still come through, so a session on another
        // machine keeps resolving; what is lost is only knowing about a
        // machine that currently has no panes on it.
      }
    };
    void pollPanes();
    const paneTimer = setInterval(pollPanes, app.intervals.projects);

    // The orchestrator's news while the chat is not on screen: the tab dot, a
    // toast, and a system notification. Lives here rather than in Chat because
    // Chat is not mounted when it is needed.
    const stopChatWatch = startChatWatch();

    return () => {
      mq.removeEventListener('change', apply);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('popstate', onPop);
      clearInterval(paneTimer);
      stopChatWatch();
    };
  });

  const selectedProjectId = $derived(
    route.screen === 'project' || route.screen === 'task' ? route.projectId : undefined
  );
</script>

<AppShell {hideBar}>
  <OfflineStrip show={app.offline} />

  {#if app.tab === 'chat'}
    <div class="pane full">
      <Chat onOpenPane={openPane} />
    </div>
  {:else if app.tab === 'usage'}
    <div class="pane full"><Usage /></div>
  {:else if wide}
    <!-- 3.3 master-detail: Projects at 320px, detail in the second column. -->
    <div class="split">
      <div class="master">
        <Projects onOpenProject={openProject} onOpenSessions={openSessions} selectedId={selectedProjectId} />
      </div>
      <div class="detail">
        {#if route.screen === 'task'}
          {#key route.taskId}
            <TaskDetail
              taskId={route.taskId}
              onBack={() => app.pop()}
              onComposerFocus={(f) => (composerFocused = f)}
            />
          {/key}
        {:else if route.screen === 'session'}
          {#key route.paneId}
            <TaskDetail
              paneId={route.paneId}
              onBack={() => app.pop()}
              onComposerFocus={(f) => (composerFocused = f)}
            />
          {/key}
        {:else if route.screen === 'sessions'}
          <Sessions onOpenSession={openSession} onBack={() => app.pop()} />
        {:else if route.screen === 'project'}
          {#key route.projectId}
            <ProjectDetail
              projectId={route.projectId}
              onBack={() => app.pop()}
              onOpenTask={openTask}
            />
          {/key}
        {:else}
          <EmptyState text="Select a project" />
        {/if}
      </div>
    </div>
  {:else}
    <div class="pane full">
      {#if route.screen === 'projects'}
        <Projects onOpenProject={openProject} onOpenSessions={openSessions} />
      {:else if route.screen === 'project'}
        {#key route.projectId}
          <div class="pushed">
            <ProjectDetail
              projectId={route.projectId}
              onBack={() => app.pop()}
              onOpenTask={openTask}
            />
          </div>
        {/key}
      {:else if route.screen === 'task'}
        {#key route.taskId}
          <div class="pushed">
            <TaskDetail
              taskId={route.taskId}
              onBack={() => app.pop()}
              onComposerFocus={(f) => (composerFocused = f)}
            />
          </div>
        {/key}
      {:else if route.screen === 'sessions'}
        <div class="pushed">
          <Sessions onOpenSession={openSession} onBack={() => app.pop()} />
        </div>
      {:else if route.screen === 'session'}
        {#key route.paneId}
          <div class="pushed">
            <TaskDetail
              paneId={route.paneId}
              onBack={() => app.pop()}
              onComposerFocus={(f) => (composerFocused = f)}
            />
          </div>
        {/key}
      {/if}
    </div>
  {/if}
</AppShell>

<SettingsSheet open={app.settingsOpen} onClose={() => (app.settingsOpen = false)} />
<Toast />

<style>
  .pane {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .full {
    width: 100%;
  }
  /* Push: slide in from the right while fading (section 7). */
  .pushed {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    animation: screen-in var(--d-base) var(--ease-out);
  }
  .split {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 320px 1fr;
  }
  .master,
  .detail {
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .master {
    border-right: 1px solid var(--hairline);
  }
</style>
