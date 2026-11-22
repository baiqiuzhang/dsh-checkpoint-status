/**
 * dsh-checkpoint-status — icon-only session states plus a workspace-wide
 * checkpoint inheritance tree.
 *
 * Everything here runs in the browser. Three contributions:
 *
 *   1. `sidebar.session.row.leading`   one 14px mark per row: checkpointed
 *      (a `/project-checkpoint` turn), inheriting (its first prompt references
 *      a `ckpt-*.md` another session produced), stale (no prompt for N days —
 *      clicking it asks before archiving). Live activity and pending scheduled
 *      tasks keep their own built-in mark in the same cell; this mark never
 *      competes for them.
 *   2. `sidebar.footer.action`        one toolbar button that opens the tree.
 *   3. `shell.overlay`                the inheritance tree: one forest per
 *      workspace, per-node digest (progress + unfinished work), child counts,
 *      and a statistics panel summing the workspace.
 *
 * Data sources are read-only and local to the Client:
 *   - `ctx.sessions.list`      catalog metadata (title, cwd, running, updatedAt)
 *   - `ctx.sessions.refreshProjections(id)` + `projectionValues(id)`
 *                              turnOutline / todos / goal / sessionStats
 *   - `ctx.workspaces.list`    workspace paths, pinned and archived ids
 *
 * No Host plugin, no HTTP route, no typert surface, no extra dependency: the
 * browser already holds every row listed above.
 */

window.__ModuleLoader__.load({
  id: 'dsh-checkpoint-status',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useMemo, useSyncExternalStore } = React;

    const NS = 'dsh-checkpoint-status';
    const CONFIG_KEY = 'dsh.session-status.config.v1';
    const DEFAULT_CONFIG = { staleDays: 7 };
    const DAY = 86400000;
    // Two naming conventions exist in the wild: `ckpt-202610181545-slug.md`
    // (the skill's compact form) and the older `ckpt-20260918-1715-hash.md`.
    const CKPT_FILE_RE = /ckpt-\d{8}[-_]?\d{4,6}[A-Za-z0-9._-]*\.md/gi;
    const CKPT_DIR_RE = /checkpoints[\\/][^\s"'`]*ckpt-[A-Za-z0-9._-]+\.md/i;
    const CHECKPOINT_PROMPT_RE = /(?:^|\s)\/project-checkpoint\b|project-checkpoint\b|写(?:一份|个)?(?:阶段)?检查点|生成(?:一份|个)?(?:阶段)?检查点/i;

    /* ------------------------------------------------------------------ *
     * Plug-in state: one observable object, read through useSyncExternalStore.
     * ------------------------------------------------------------------ */

    const listeners = new Set();
    const state = {
      rev: 0,
      /** sessionId -> { at, values, error? } */
      loaded: new Map(),
      loading: new Set(),
      /** sessionId -> { attempts, nextAt, error }: failed reads back off. */
      failures: new Map(),
      open: false,
      /** Workspace scope of the open panel: normalized cwd, or null for all. */
      scope: null,
      scopeLabel: '',
      archiveTarget: null,
      staleDays: DEFAULT_CONFIG.staleDays,
      services: null,
    };

    function bump() {
      state.rev += 1;
      syncEntryStates();
      for (const listener of listeners) {
        try {
          listener();
        } catch (error) {
          console.warn(`${NS}: state listener failed`, error);
        }
      }
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    function readConfig() {
      try {
        const raw = window.localStorage.getItem(CONFIG_KEY);
        if (raw === null) return { ...DEFAULT_CONFIG };
        const parsed = JSON.parse(raw);
        const days = Number(parsed?.staleDays);
        return {
          staleDays: Number.isFinite(days) && days > 0 ? Math.min(Math.max(days, 1), 365) : DEFAULT_CONFIG.staleDays,
        };
      } catch {
        return { ...DEFAULT_CONFIG };
      }
    }

    /* ------------------------------------------------------------------ *
     * Projection loading.
     *
     * `refreshProjections` performs one Host read per Session and caches the
     * rows in the Client store; subsequent calls are cheap. We keep the read
     * results next to a timestamp because a digest is only as fresh as the turn
     * it summarises.
     * ------------------------------------------------------------------ */

    // Read-only refresh cadence. `turnOutline` is a projection of events that
    // are already logged host-side: reading it costs one IPC round-trip and
    // zero provider tokens, but there is no reason to re-read it on every
    // render, so a row mark is content with a copy that is a few minutes old.
    const PROJECTION_TTL = 300000;
    // A failed read must not masquerade as "this Session never checkpointed":
    // an empty store and a broken store look identical through `statusOf`, so
    // failures back off and retry instead of being cached as empty results.
    const FAILURE_BACKOFF_MS = 8000;
    const FAILURE_MAX_ATTEMPTS = 4;
    const LOAD_CONCURRENCY = 2;
    const LOAD_SPACING_MS = 90;

    /** Diagnostics sink, readable from the LevelDB of the renderer profile. */
    function diag(event, extra) {
      try {
        const key = 'dss.diag.v1';
        const list = JSON.parse(window.localStorage.getItem(key) ?? '[]');
        list.push({ t: Date.now(), event, ...(extra ?? {}) });
        window.localStorage.setItem(key, JSON.stringify(list.slice(-160)));
      } catch {
        /* diagnostics must never break the UI */
      }
    }

    function shortId(sessionId) {
      if (typeof sessionId !== 'string') return String(sessionId);
      return sessionId.replace(/^session-/, '').slice(0, 8);
    }

    function projectionOf(sessionId) {
      const hit = state.loaded.get(sessionId);
      if (hit !== undefined) return hit;
      const services = state.services;
      const values = services?.sessions?.manager?.projectionValues?.(sessionId);
      // Every projection store starts on its `init()` value, so a seeded
      // `turnOutline: {turns: []}` means "not read yet", not "no turns yet".
      // Only a value fetched through `refreshProjections` (or a row that
      // already carries a non-trivial outline) may be trusted.
      if (values === undefined) return undefined;
      const outline = values.turnOutline;
      if (outline === undefined) return undefined;
      if (Array.isArray(outline.turns) && outline.turns.length === 0) return undefined;
      return { at: 0, values };
    }

    async function loadProjection(sessionId, force = false) {
      const services = state.services;
      if (services === null) return;
      if (state.loading.has(sessionId)) return;
      const cached = state.loaded.get(sessionId);
      if (!force && cached !== undefined && Date.now() - cached.at < PROJECTION_TTL) return;
      state.loading.add(sessionId);
      bump();
      try {
        await services.sessions.refreshProjections(sessionId);
        const values = services.sessions.manager?.projectionValues?.(sessionId) ?? {};
        state.loaded.set(sessionId, { at: Date.now(), values });
        state.failures.delete(sessionId);
        const turns = values.turnOutline?.turns;
        diag('load-ok', {
          id: shortId(sessionId),
          keys: Object.keys(values).length,
          turns: Array.isArray(turns) ? turns.length : -1,
        });
      } catch (error) {
        const previous = state.failures.get(sessionId);
        const attempts = (previous?.attempts ?? 0) + 1;
        const backoff = Math.min(60000, FAILURE_BACKOFF_MS * 2 ** (attempts - 1));
        state.failures.set(sessionId, { attempts, nextAt: Date.now() + backoff, error: String(error) });
        diag('load-failed', { id: shortId(sessionId), attempts, error: String(error).slice(0, 180) });
        if (attempts <= FAILURE_MAX_ATTEMPTS) {
          window.setTimeout(() => bump(), backoff + 50);
        }
      } finally {
        state.loading.delete(sessionId);
        bump();
      }
    }

    /* Reads are paced: every visible row mounts at once, so an unpaced read
     * per row would fan out into a request storm against the Host. */
    const loadQueue = [];
    const loadQueued = new Set();
    let loadActive = 0;

    function requestLoad(sessionId, force = false) {
      if (state.loading.has(sessionId) || loadQueued.has(sessionId)) return;
      if (!force) {
        const cached = state.loaded.get(sessionId);
        if (cached !== undefined && Date.now() - cached.at < PROJECTION_TTL) return;
        const failure = state.failures.get(sessionId);
        if (failure !== undefined && Date.now() < failure.nextAt) return;
      }
      loadQueued.add(sessionId);
      loadQueue.push({ sessionId, force });
      pumpLoads();
    }

    function pumpLoads() {
      while (loadActive < LOAD_CONCURRENCY && loadQueue.length > 0) {
        const job = loadQueue.shift();
        loadQueued.delete(job.sessionId);
        loadActive += 1;
        void loadProjection(job.sessionId, job.force).finally(() => {
          loadActive -= 1;
          window.setTimeout(pumpLoads, LOAD_SPACING_MS);
        });
      }
    }

    /**
     * Load the projections of every listed Session, two at a time, so the row
     * marks and the tree settle without a request storm on open.
     */
    let warmToken = 0;

    async function warm(sessionIds, force = false) {
      const token = (warmToken += 1);
      const queue = sessionIds.slice();
      const workers = new Array(2).fill(0).map(async () => {
        while (queue.length > 0 && token === warmToken) {
          const id = queue.shift();
          await loadProjection(id, force);
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
      });
      await Promise.all(workers);
    }

    /* ------------------------------------------------------------------ *
     * Derivations — pure functions over catalog rows and projection values.
     * ------------------------------------------------------------------ */

    function turnsOf(projection) {
      const turns = projection?.values?.turnOutline?.turns;
      return Array.isArray(turns) ? turns : [];
    }

    function todosOf(projection) {
      const todos = projection?.values?.todos;
      return Array.isArray(todos) ? todos : [];
    }

    function objectiveOf(projection) {
      const objective = projection?.values?.goal?.current?.goal?.objective;
      return typeof objective === 'string' ? objective : '';
    }

    function statsOf(projection) {
      return projection?.values?.sessionStats ?? null;
    }

    function lastPromptAtOf(row, projection) {
      const stamped = projection?.values?.sessionListMetadata?.lastPromptAt;
      if (typeof stamped === 'number' && stamped > 0) return stamped;
      return typeof row?.updatedAt === 'number' ? row.updatedAt : 0;
    }

    /**
     * The full text of the first human message.
     *
     * `turnOutline` clips prompts to ~50 characters, which hides a checkpoint
     * path pasted mid-sentence, so the title projection's untouched copy is the
     * authority here and the clipped prompt is only a fallback.
     */
    function firstMessageText(projection) {
      const text = projection?.values?.titleInput?.first?.text;
      if (typeof text === 'string' && text.trim() !== '') return text;
      const first = turnsOf(projection)[0];
      return typeof first?.prompt === 'string' ? first.prompt : '';
    }

    function checkpointNamesIn(text) {
      if (typeof text !== 'string' || text === '') return [];
      const names = text.match(CKPT_FILE_RE) ?? [];
      if (names.length > 0) return [...new Set(names.map((name) => name.replace(/[\\/]+$/, '')))];
      const directories = text.match(new RegExp(CKPT_DIR_RE.source, 'gi')) ?? [];
      return [...new Set(directories.map((entry) => entry.split(/[\\/]/).pop()))];
    }

    /** Whether any turn of this Session asked for a checkpoint to be written. */
    function producedCheckpoint(projection) {
      const asked = turnsOf(projection).some((turn) => typeof turn?.prompt === 'string' && CHECKPOINT_PROMPT_RE.test(turn.prompt));
      return asked || producedCheckpoints(projection).length > 0;
    }

    /**
     * Checkpoint files this Session wrote.
     *
     * A checkpoint is "produced" when a turn's response names the file — the
     * agent reports what it wrote. Names that only appear in the prompts are
     * citations of somebody else's work.
     */
    function producedCheckpoints(projection) {
      const names = new Set();
      for (const turn of turnsOf(projection)) {
        if (typeof turn?.response !== 'string') continue;
        for (const name of checkpointNamesIn(turn.response)) names.add(name);
      }
      return [...names];
    }

    /** Checkpoint files the first message references — the inheritance edge. */
    function inheritedCheckpoints(projection) {
      return checkpointNamesIn(firstMessageText(projection));
    }

    function statusOf(row, projection, now, staleDays) {
      if (row === undefined) return 'idle';
      if (row.running === true) return 'running';
      if (inheritedCheckpoints(projection).length > 0) return 'inheriting';
      if (producedCheckpoint(projection)) return 'checkpointed';
      const last = lastPromptAtOf(row, projection);
      if (last > 0 && now - last > staleDays * DAY) return 'stale';
      return 'idle';
    }

    function digestOf(row, projection, limit) {
      const turns = turnsOf(projection);
      const first = turns[0];
      const last = turns[turns.length - 1];
      const objective = objectiveOf(projection);
      const opens = todosOf(projection)
        .filter((todo) => todo?.status !== 'completed')
        .map((todo) => String(todo?.content ?? '').trim())
        .filter((text) => text !== '');

      const parts = [];
      const head = objective || (typeof first?.prompt === 'string' ? first.prompt : '');
      if (head !== '') parts.push(clip(squash(head), limit.head));
      if (turns.length > 1 && typeof last?.response === 'string' && last.response.trim() !== '') {
        parts.push(clip(squash(last.response), limit.middle));
      }
      if (opens.length > 0) parts.push(clip(squash(opens.join(' · ')), limit.tail, true));
      if (parts.length === 0 && row !== undefined) parts.push(clip(squash(row.displayTitle ?? ''), limit.head));
      return { lines: parts, openTodos: opens.length, turns: turns.length };
    }

    function squash(text) {
      return String(text).replace(/\s+/g, ' ').trim();
    }

    function clip(text, max, keepHead = false) {
      if (text.length <= max) return text;
      if (keepHead) return `${text.slice(0, max)}…`;
      return `${text.slice(0, Math.max(1, max - 1))}…`;
    }

    /**
     * Build one forest per workspace.
     *
     * Two kinds of edge, both facts rather than guesses:
     *   - `ckpt`: a Session whose first prompt cites a checkpoint file inherits
     *     from the nearest same-directory Session that wrote a checkpoint
     *     strictly earlier.
     *   - `subagent`: the session list carries `parentId` for sessions a parent
     *     spawned; the sidebar hides those rows, the tree shows them.
     */
    function buildForest(rows, projections, workspaceSnapshot, now, staleDays) {
      const archived = new Set(workspaceSnapshot?.archivedSessionIds ?? []);
      const items = Array.isArray(workspaceSnapshot?.items) ? workspaceSnapshot.items : [];
      const byPath = new Map();
      for (const item of items) if (typeof item?.path === 'string') byPath.set(normalizePath(item.path), item);

      const isTop = (node) => node.row.parentId === undefined || node.row.parentId === null;
      const visible = rows.filter((row) => row.blank !== true);
      const nodes = new Map();
      for (const row of visible) {
        const projection = projections.get(row.id);
        nodes.set(row.id, {
          id: row.id,
          row,
          projection,
          cwd: typeof row.cwd === 'string' ? row.cwd : '',
          title: typeof row.title === 'string' && row.title !== '' ? row.title : row.displayTitle,
          status: statusOf(row, projection, now, staleDays),
          archived: archived.has(row.id),
          inherited: inheritedCheckpoints(projection),
          produced: producedCheckpoint(projection),
          producedNames: producedCheckpoints(projection),
          children: [],
          parent: null,
          childCount: 0,
          inheritChildren: 0,
          subagentChildren: 0,
          subagents: 0,
          edge: { kind: 'root', label: '' },
        });
      }

      // Edge 1 — checkpoint inheritance. A citation is matched by checkpoint
      // FILE NAME, not by directory: the same workspace root can hold the
      // checkpoint while the citing session keeps a deeper `cwd`, and the
      // timestamped name is unique enough to identify the producer on its own.
      const producersByName = new Map();
      for (const node of nodes.values()) {
        for (const name of node.producedNames) {
          if (!producersByName.has(name)) producersByName.set(name, []);
          producersByName.get(name).push(node);
        }
      }
      const reaches = (node, ancestorId) => {
        let cursor = node;
        for (let hop = 0; hop < 32 && cursor !== null; hop += 1) {
          if (cursor.id === ancestorId) return true;
          cursor = cursor.parent === null ? null : nodes.get(cursor.parent) ?? null;
        }
        return false;
      };
      for (const node of nodes.values()) {
        if (!isTop(node) || node.archived || node.inherited.length === 0) continue;
        let chosen = null;
        let label = '';
        for (const name of node.inherited) {
          const owners = (producersByName.get(name) ?? []).filter((owner) => owner.id !== node.id);
          if (owners.length === 0) continue;
          // Prefer producers that did not themselves cite this checkpoint.
          const clean = owners.filter((owner) => !owner.inherited.includes(name));
          const pool = (clean.length > 0 ? clean : owners)
            .slice()
            .sort((left, right) => (left.row.updatedAt ?? 0) - (right.row.updatedAt ?? 0));
          const owner = pool[0];
          if (owner === undefined) continue;
          if (reaches(owner, node.id)) continue;
          chosen = owner;
          label = name;
          break;
        }
        if (chosen !== null) {
          node.parent = chosen.id;
          node.edge = { kind: 'ckpt', label };
          chosen.children.push(node);
        }
      }

      // Edge 2 — subagent sessions hang under the session that spawned them.
      for (const node of nodes.values()) {
        const parentId = node.row.parentId;
        if (parentId === undefined || parentId === null) continue;
        const parent = nodes.get(parentId);
        if (parent === undefined || parent.id === node.id) continue;
        node.parent = parent.id;
        node.edge = { kind: 'subagent', label: '' };
        parent.children.push(node);
      }

      // A subagent without a directory of its own reads in its parent's group.
      const resolveCwd = (node, guard) => {
        if (node.cwd !== '' || node.parent === null || guard > 16) return node.cwd;
        const parent = nodes.get(node.parent);
        if (parent === undefined) return node.cwd;
        node.cwd = resolveCwd(parent, guard + 1);
        return node.cwd;
      };
      for (const node of nodes.values()) resolveCwd(node, 0);

      for (const node of nodes.values()) {
        node.children.sort(
          (left, right) =>
            (left.edge.kind === 'subagent' ? 1 : 0) - (right.edge.kind === 'subagent' ? 1 : 0) ||
            (left.row.updatedAt ?? 0) - (right.row.updatedAt ?? 0)
        );
        node.childCount = node.children.length;
        node.subagentChildren = node.children.filter((child) => child.edge.kind === 'subagent').length;
        node.inheritChildren = node.childCount - node.subagentChildren;
        // `subagentCatalog` is not an id array in this build (it carries
        // `inheritedEventCount`), so the count that matters is the child
        // sessions the list actually reports.
        node.subagents = node.subagentChildren;
        node.digest = digestOf(node.row, node.projection, { head: 72, middle: 190, tail: 130 });
        node.stats = statsOf(node.projection);
      }

      const groups = new Map();
      const keyOf = (node) => normalizePath(node.cwd) || '~';
      const groupOf = (node) => {
        const key = keyOf(node);
        if (!groups.has(key)) {
          const workspace = byPath.get(key);
          groups.set(key, {
            key,
            title: workspace?.title ?? basename(node.cwd) ?? '~',
            cwd: node.cwd,
            roots: [],
            all: [],
          });
        }
        groups.get(key).all.push(node);
        return groups.get(key);
      };
      for (const node of nodes.values()) {
        const group = groupOf(node);
        const parent = node.parent === null ? null : nodes.get(node.parent) ?? null;
        // An edge that leaves this workspace still has to be reachable here, so
        // the node keeps its own group and surfaces as a root carrying its edge.
        if (parent === null || keyOf(parent) !== group.key) {
          if (parent !== null) node.edge = { ...node.edge, detached: true };
          group.roots.push(node);
        }
      }

      const forests = [...groups.values()].sort((left, right) => right.all.length - left.all.length);
      for (const group of forests) {
        group.roots.sort((left, right) => (right.row.updatedAt ?? 0) - (left.row.updatedAt ?? 0));
        // Subagent rows are not conversations the sidebar shows, so the statistics
        // count top-level sessions only; their child sessions add to `subagents`.
        group.stats = countStats(group.all.filter((node) => isTop(node)), archived);
        group.stats.subagents = group.all.filter((node) => !isTop(node)).length;
      }
      return forests;
    }

    function countStats(nodes, archived) {
      const stats = {
        sessions: nodes.length,
        archived: 0,
        running: 0,
        checkpointed: 0,
        inheriting: 0,
        stale: 0,
        subagents: 0,
        turns: 0,
        steps: 0,
        tokens: 0,
      };
      for (const node of nodes) {
        if (archived.has(node.id)) stats.archived += 1;
        if (node.status === 'running') stats.running += 1;
        if (node.status === 'checkpointed' || node.produced) stats.checkpointed += 1;
        if (node.status === 'inheriting') stats.inheriting += 1;
        if (node.status === 'stale') stats.stale += 1;
        stats.subagents += node.subagents;
        const detail = node.stats;
        if (detail !== null) {
          stats.turns += Number(detail.turns ?? 0) || 0;
          stats.steps += Number(detail.steps ?? 0) || 0;
          stats.tokens += Number(detail.decodeTokens ?? 0) || 0;
        }
      }
      return stats;
    }

    function normalizePath(path) {
      return typeof path === 'string' ? path.replace(/[\\/]+$/, '').toLowerCase() : '';
    }

    function basename(path) {
      if (typeof path !== 'string' || path === '') return '';
      const parts = path.split(/[\\/]/).filter(Boolean);
      return parts[parts.length - 1] ?? '';
    }

    /* ------------------------------------------------------------------ *
     * Icons — 14px inline SVG, currentColor, no dependency on primitives.
     * ------------------------------------------------------------------ */

    function MarkCheckpoint() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, className: 'dss-icon dss-icon-checkpoint' },
        h('path', { d: 'M4 2.2h8a1 1 0 0 1 1 1v10.1l-5-2.9-5 2.9V3.2a1 1 0 0 1 1-1Z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.35, strokeLinejoin: 'round' }),
        h('path', { d: 'M5.9 6.3 7.4 7.8 10.2 5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round', strokeLinejoin: 'round' })
      );
    }

    function MarkInherit() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, className: 'dss-icon dss-icon-inherit' },
        h('path', { d: 'M5 3v4.2a3 3 0 0 0 3 3h3', fill: 'none', stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round' }),
        h('circle', { cx: 3.6, cy: 3, r: 1.35, fill: 'none', stroke: 'currentColor', strokeWidth: 1.35 }),
        h('path', { d: 'M9.6 8.4 11.6 10.2 9.6 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round', strokeLinejoin: 'round' })
      );
    }

    function MarkStale() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, className: 'dss-icon dss-icon-stale' },
        h('path', { d: 'M12.6 9.9A5 5 0 0 1 6.1 3.4 5 5 0 1 0 12.6 9.9Z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.35, strokeLinejoin: 'round' })
      );
    }

    function MarkTree() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 15, height: 15, 'aria-hidden': true, className: 'dss-icon' },
        h('path', { d: 'M3 3.4v9.2M3 8h4.2a2 2 0 0 0 2-2V3.4M3 9.6h4.2a2 2 0 0 1 2 2v1.4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('circle', { cx: 10.8, cy: 3.4, r: 1.4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }),
        h('circle', { cx: 10.8, cy: 12.4, r: 1.4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 })
      );
    }

    function Icon({ status }) {
      if (status === 'checkpointed') return h(MarkCheckpoint, null);
      if (status === 'inheriting') return h(MarkInherit, null);
      if (status === 'stale') return h(MarkStale, null);
      return null;
    }

    /* ------------------------------------------------------------------ *
     * Styles.
     * ------------------------------------------------------------------ */

    const STYLE_ID = `${NS}/styles`;

    const CSS = `
.dss-icon{display:block;color:var(--dsw-alias-label-secondary,#a8a8ad)}
.dss-icon-checkpoint{color:var(--dsw-alias-state-success-primary,#3fb950)}
.dss-icon-inherit{color:var(--dsw-alias-label-tertiary,#8a8a90)}
.dss-icon-stale{opacity:.62;animation:dss-breathe 5.5s ease-in-out infinite}
@keyframes dss-breathe{0%,100%{opacity:.45}50%{opacity:.85}}
@media (prefers-reduced-motion:reduce){.dss-icon-stale{animation:none}}
.dss-mark{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border:0;background:none;padding:0;cursor:default;border-radius:var(--dsw-radius-sm,4px)}
.dss-mark-stale{cursor:pointer}
.dss-mark-stale:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.dss-tree-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;background:none;color:var(--dsw-alias-label-secondary,#a8a8ad);padding:6px;border-radius:var(--dsw-radius-sm,6px);cursor:pointer}
.dss-tree-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#f2f2f4)}
.dss-row-entry{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;flex:none;border:0;background:none;padding:0;margin:0 2px 0 0;border-radius:var(--dsw-radius-sm,4px);color:var(--dsw-alias-label-tertiary,#8a8a90);cursor:pointer;opacity:.6;transition:opacity .12s ease,background-color .12s ease,color .12s ease}
.dss-row-entry:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1));color:var(--dsw-alias-label-primary,#f2f2f4)}
.dss-row-entry[data-open="true"]{opacity:1;color:var(--dsw-alias-brand-primary,#6aa6ff)}
.dss-overlay{position:fixed;inset:0;z-index:70;pointer-events:auto;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.55));padding:24px}
.dss-panel{width:min(1040px,92vw);height:min(720px,86vh);display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-2,#1b1b1e);color:var(--dsw-alias-label-primary,#f2f2f4);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:var(--dsw-radius-panel,12px);box-shadow:var(--dsw-elevation-panel,0 18px 48px rgba(0,0,0,.55));overflow:hidden}
.dss-panel-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}
.dss-panel-title{font-size:14px;font-weight:600}
.dss-panel-close{margin-left:auto;border:0;background:none;color:inherit;cursor:pointer;font-size:18px;line-height:1;padding:4px 8px;border-radius:var(--dsw-radius-sm,6px)}
.dss-panel-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1))}
.dss-chips{display:flex;flex-wrap:wrap;gap:6px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06));font-size:12px;color:var(--dsw-alias-label-secondary,#a8a8ad)}
.dss-chip{display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-4,rgba(255,255,255,.07))}
.dss-chip b{font-weight:600;color:var(--dsw-alias-label-primary,#f2f2f4)}
.dss-body{flex:1;overflow:auto;padding:8px 16px 24px}
.dss-group{margin:14px 0 6px}
.dss-group-head{display:flex;align-items:baseline;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#a8a8ad)}
.dss-group-name{font-weight:600;color:var(--dsw-alias-label-primary,#f2f2f4)}
.dss-tnode{position:relative;margin:6px 0}
.dss-tnode.is-root{margin-top:10px}
.dss-tcard{border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));border-radius:var(--dsw-radius-md,8px);padding:7px 10px;background:var(--dsw-alias-bg-layer-3,#242428)}
.dss-tcard.is-stale{opacity:.72}
.dss-tcard.is-subagent{padding:5px 9px;background:transparent;border-style:dashed;border-color:var(--dsw-alias-border-l2,rgba(255,255,255,.14))}
.dss-tcard-head{display:flex;align-items:center;gap:6px}
.dss-tcard-title{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:520px}
.dss-tedge{flex:none;font-size:10px;line-height:1.5;padding:1px 5px;border-radius:var(--dsw-radius-sm,4px);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));background:var(--dsw-alias-bg-layer-4,rgba(255,255,255,.06));color:var(--dsw-alias-label-tertiary,#8a8a90);white-space:nowrap}
.dss-tedge.is-root{color:var(--dsw-alias-label-secondary,#a8a8ad)}
.dss-tedge.is-ckpt{color:var(--dsw-alias-state-success-primary,#3fb950);border-color:var(--dsw-alias-state-success-primary,#3fb950)}
.dss-tedge.is-subagent{border-style:dashed}
.dss-branch{position:relative;margin-left:9px;padding-left:16px;border-left:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14))}
.dss-branch.is-subagent{border-left-style:dashed}
.dss-branch>.dss-tnode::before{content:'';position:absolute;left:-16px;top:15px;width:12px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14))}
.dss-branch>.dss-tnode:last-child::after{content:'';position:absolute;left:-17px;top:16px;bottom:-3px;width:2px;background:var(--dsw-alias-bg-layer-2,#1b1b1e)}
.dss-branch-toggle{display:inline-flex;align-items:center;gap:4px;margin:4px 0 0;border:0;background:none;color:var(--dsw-alias-label-secondary,#a8a8ad);font-size:11px;padding:2px 6px;border-radius:var(--dsw-radius-sm,4px);cursor:pointer}
.dss-branch-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#f2f2f4)}
.dss-branch-toggle.is-subagent{color:var(--dsw-alias-label-tertiary,#8a8a90)}
.dss-badge.is-count{color:var(--dsw-alias-label-tertiary,#8a8a90)}
.dss-legend{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:6px 16px 0;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a90)}
.dss-legend-note{opacity:.85}
.dss-group-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a90);margin:4px 0 0 2px}
.dss-badge{font-size:11px;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-4,rgba(255,255,255,.08));color:var(--dsw-alias-label-secondary,#a8a8ad)}
.dss-line{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#a8a8ad);margin-top:3px;word-break:break-word}
.dss-line.open{color:var(--dsw-alias-state-warn-primary,#d29922)}
.dss-empty{padding:24px;text-align:center;font-size:13px;color:var(--dsw-alias-label-tertiary,#8a8a90)}
.dss-dialog{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.55));padding:24px}
.dss-dialog-card{width:min(420px,90vw);background:var(--dsw-alias-bg-layer-2,#1b1b1e);color:var(--dsw-alias-label-primary,#f2f2f4);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:var(--dsw-radius-panel,12px);padding:18px 18px 14px;box-shadow:var(--dsw-elevation-panel,0 18px 48px rgba(0,0,0,.55))}
.dss-dialog-title{font-size:14px;font-weight:600}
.dss-dialog-text{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary,#a8a8ad);margin-top:8px}
.dss-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.dss-activity{margin:10px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;max-height:180px;overflow:auto}.dss-activity-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;font-size:12px;line-height:1.5}.dss-activity-kind{flex:none;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-4,rgba(255,255,255,.08));border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));color:var(--dsw-alias-label-secondary,#a8a8ad)}.dss-activity-detail{color:var(--dsw-alias-label-primary,#f2f2f4);word-break:break-all}.dss-activity-items{margin:2px 0 0 10px;padding:0;list-style:disc;color:var(--dsw-alias-label-secondary,#a8a8ad);font-size:11px}.dss-dialog-error{margin-top:10px;font-size:12px;color:var(--dsw-alias-state-error-primary,#f85149);word-break:break-word}
.dss-btn{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));background:var(--dsw-alias-bg-layer-3,#242428);color:inherit;border-radius:var(--dsw-radius-md,8px);padding:6px 14px;font-size:13px;cursor:pointer}
.dss-btn-primary{background:var(--dsw-alias-brand-primary,#3b82f6);color:#fff;border-color:transparent}
.dss-btn:hover{filter:brightness(1.08)}
`;

    function injectStyles() {
      if (typeof document === 'undefined') return () => {};
      if (document.getElementById(STYLE_ID) !== null) return () => {};
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
      return () => {
        if (style.parentNode !== null) style.parentNode.removeChild(style);
      };
    }

    /* ------------------------------------------------------------------ *
     * Locale dictionaries.
     * ------------------------------------------------------------------ */

    const ZH = {
      'mark.checkpointed': '已生成检查点',
      'mark.inheriting': '继承自上一会话的检查点',
      'mark.stale': '长期未访问，点击确认归档',
      'tree.button': '会话继承树',
      'tree.title': '会话继承树',
      'tree.close': '关闭',
      'tree.empty': '暂无可展示的会话',
      'tree.loading': '正在读取会话投影…',
      'tree.groupMeta': '{sessions} 会话 · {edges} 条继承边',
      'tree.noEdge': '本工作区未检测到检查点继承边',
      'tree.legendNote': '继承边来自检查点文件引用；子代理来自会话父级',
      'edge.root': '起点',
      'edge.ckpt': '继承检查点',
      'edge.subagent': '子代理',
      'edge.detached': '父会话在其它工作区',
      'node.inheritCount': '{count} 个后继会话',
      'node.subagentCount': '{count} 个子代理会话',
      'node.subagentsShort': '{count} 子代理',
      'stats.sessions': '会话',
      'stats.running': '进行中',
      'stats.checkpointed': '已存档',
      'stats.inheriting': '继承',
      'stats.stale': '废弃',
      'stats.archived': '已归档',
      'stats.subagents': '子代理',
      'stats.turns': '轮次',
      'stats.steps': '步骤',
      'stats.tokens': '输出 token',
      'node.subagents': '子代理 {count}',
      'node.turns': '{count} 轮',
      'node.open': '未完成 {count}',
      'archive.title': '归档这个会话？',
      'archive.text': '该会话已 {days} 天没有新的提示。归档后它会从工作区列表移入归档区，可随时取消归档。',
      'archive.cancel': '取消',
      'archive.confirm': '归档',
      'archive.working': '归档中…',
      'archive.activeTitle': '这个会话还在活动，不能直接归档',
      'archive.activeText': '以下活动仍在进行。强制归档会先停止它们，且被停掉的定时提醒无法恢复。',
      'archive.force': '停止活动并归档',
      'archive.back': '返回',
      'activity.turn': '正在进行的回合',
      'activity.job': '后台任务',
      'activity.subagent': '子代理',
      'activity.schedule': '定时提醒',
      'activity.other': '其他活动',
    };

    const EN = {
      'mark.checkpointed': 'Checkpoint written',
      'mark.inheriting': 'Inherits a checkpoint',
      'mark.stale': 'Idle for a long time — click to archive',
      'tree.button': 'Session inheritance',
      'tree.title': 'Session inheritance tree',
      'tree.close': 'Close',
      'tree.empty': 'No sessions to show',
      'tree.loading': 'Reading session projections…',
      'tree.groupMeta': '{sessions} sessions · {edges} edges',
      'tree.noEdge': 'No checkpoint inheritance edge detected in this workspace',
      'tree.legendNote': 'Edges come from checkpoint citations; subagents come from the session parent',
      'edge.root': 'Root',
      'edge.ckpt': 'Checkpoint',
      'edge.subagent': 'Subagent',
      'edge.detached': 'parent lives in another workspace',
      'node.inheritCount': '{count} follow-ups',
      'node.subagentCount': '{count} subagent sessions',
      'node.subagentsShort': '{count} subagents',
      'stats.sessions': 'Sessions',
      'stats.running': 'Running',
      'stats.checkpointed': 'Checkpointed',
      'stats.inheriting': 'Inheriting',
      'stats.stale': 'Stale',
      'stats.archived': 'Archived',
      'stats.subagents': 'Subagents',
      'stats.turns': 'Turns',
      'stats.steps': 'Steps',
      'stats.tokens': 'Output tokens',
      'node.subagents': '{count} subagents',
      'node.turns': '{count} turns',
      'node.open': '{count} open',
      'archive.title': 'Archive this session?',
      'archive.text': 'It has no new prompt for {days} days. Archiving moves it out of the workspace list; it stays restorable.',
      'archive.cancel': 'Cancel',
      'archive.confirm': 'Archive',
      'archive.working': 'Archiving…',
      'archive.activeTitle': 'This session is still active',
      'archive.activeText': 'The activities below are still running. Forcing the archive stops them first, and stopped reminders cannot be restored.',
      'archive.force': 'Stop and archive',
      'archive.back': 'Back',
      'activity.turn': 'Running turn',
      'activity.job': 'Background job',
      'activity.subagent': 'Subagent',
      'activity.schedule': 'Scheduled reminder',
      'activity.other': 'Other activity',
    };

    /** Locale seat with a built-in Chinese fallback so a refused dictionary still renders. */
    function translator(t) {
      return (key, vars) => {
        let text = '';
        if (typeof t === 'function') {
          try {
            text = t(key, vars) ?? '';
          } catch {
            text = '';
          }
        }
        if (text === '' || text === key) text = ZH[key] ?? key;
        if (vars !== undefined) {
          for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value));
        }
        return text;
      };
    }

    /* ------------------------------------------------------------------ *
     * Components.
     * ------------------------------------------------------------------ */

    function useStatusStore() {
      return useSyncExternalStore(
        subscribe,
        () => state.rev,
        () => state.rev
      );
    }

    /**
     * The leading 16px cell of one sidebar row.
     *
     * Renders nothing unless this Session has a fact of its own to show. Live
     * activity and pending scheduled tasks are the built-in markers' job, so
     * this mark never fights them for the same slot.
     */
    const mountedOnce = new Set();
    const reportedOnce = new Set();

    function SessionStatusMark(props) {
      const { sessionId, useSessions, t } = props;
      const rev = useStatusStore();
      const row = typeof useSessions === 'function' ? useSessions((snapshot) => snapshot.byId[sessionId]) : undefined;
      const projection = useMemo(() => projectionOf(sessionId), [sessionId, rev, row?.updatedAt]);
      const say = translator(t);

      const updatedAt = row?.updatedAt ?? 0;
      useEffect(() => {
        if (mountedOnce.has(sessionId)) return;
        mountedOnce.add(sessionId);
        diag('mount', { id: shortId(sessionId) });
      }, [sessionId]);
      useEffect(() => {
        if (state.services === null) return;
        // Idempotent: the cache TTL, the in-flight set and the failure backoff
        // all gate the actual read. `updatedAt` re-reads after new activity.
        requestLoad(sessionId);
      }, [sessionId, updatedAt]);

      const status = statusOf(row, projection, Date.now(), state.staleDays);
      if (!reportedOnce.has(sessionId) && status !== 'idle') {
        reportedOnce.add(sessionId);
        diag('status', {
          id: shortId(sessionId),
          status,
          hasProjection: projection !== undefined,
          turns: turnsOf(projection).length,
        });
      }
      if (status === 'idle' || status === 'running') return null;

      if (status === 'stale') {
        const days = state.staleDays;
        return h(
          'button',
          {
            type: 'button',
            className: 'dss-mark dss-mark-stale',
            title: say('mark.stale'),
            'aria-label': say('mark.stale'),
            onClick: (event) => {
              event.preventDefault();
              event.stopPropagation();
              state.archiveTarget = { id: sessionId, title: row?.title ?? row?.displayTitle ?? sessionId, days };
              bump();
            },
          },
          h(Icon, { status })
        );
      }

      const label = status === 'checkpointed' ? say('mark.checkpointed') : say('mark.inheriting');
      return h(
        'span',
        {
          className: 'dss-mark',
          title: label,
          'aria-label': label,
          'data-session-status': status,
          onClick: (event) => event.stopPropagation(),
        },
        h(Icon, { status })
      );
    }

    /** Sidebar footer button: opens the whole-sidebar tree (all workspaces). */
    function TreeButton(props) {
      const rev = useStatusStore();
      const say = translator(props.t);
      return h(
        'button',
        {
          type: 'button',
          className: 'dss-tree-button',
          title: say('tree.button'),
          'aria-label': say('tree.button'),
          'aria-pressed': state.open && state.scope === null ? 'true' : 'false',
          'data-open': state.open && state.scope === null ? '' : undefined,
          onClick: () => openTree(null, ''),
          style: state.open && state.scope === null ? { color: 'var(--dsw-alias-label-primary,#f2f2f4)' } : undefined,
          key: rev,
        },
        h(MarkTree, null)
      );
    }

    /* ------------------------------------------------------------------ *
     * Per-workspace entry.
     *
     * The sidebar exposes `sidebar.footer.action` (one global slot) and nothing
     * at workspace-row level, so a per-workspace button has to be injected next
     * to the row's own actions: `div[data-row-key="workspace:<key>"]` with the
     * built-in buttons in its last child span. React never diffs the node we
     * append, and the observer re-attaches it whenever the row is rebuilt.
     * ------------------------------------------------------------------ */

    const ENTRY_ATTR = 'data-dss-tree-entry';
    const ENTRY_ROW_RE = /^workspace:(.*)$/;
    const ENTRY_SVG =
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 3.4v9.2M3 8h4.2a2 2 0 0 0 2-2V3.4M3 9.6h4.2a2 2 0 0 1 2 2v1.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

    function workspaceSnapshot() {
      const list = state.services?.workspaces?.list;
      if (list === undefined || typeof list.getSnapshot !== 'function') return {};
      try {
        return list.getSnapshot() ?? {};
      } catch {
        return {};
      }
    }

    /** `workspace:<group.key>` -> the normalized cwd our forests are grouped by. */
    function scopeOfRowKey(rowKey) {
      const matched = ENTRY_ROW_RE.exec(rowKey);
      if (matched === null) return null;
      const key = matched[1];
      const items = Array.isArray(workspaceSnapshot().items) ? workspaceSnapshot().items : [];
      const item = items.find((candidate) => candidate?.workspaceId === key);
      if (item !== undefined && typeof item.path === 'string') return normalizePath(item.path);
      if (/[\\/]/.test(key)) return normalizePath(key);
      // The ungrouped bucket holds sessions whose cwd is not a workspace (yet).
      return '~';
    }

    function labelOfScope(scope) {
      const items = Array.isArray(workspaceSnapshot().items) ? workspaceSnapshot().items : [];
      const item = items.find((candidate) => typeof candidate?.path === 'string' && normalizePath(candidate.path) === scope);
      if (item !== undefined && typeof item.title === 'string' && item.title !== '') return item.title;
      return basename(scope) || scope;
    }

    function openTree(scope, label) {
      const same = state.open && state.scope === scope;
      state.open = !same;
      state.scope = same ? null : scope;
      state.scopeLabel = same ? '' : label;
      bump();
      if (state.open) void warmLoaded();
    }

    function syncEntryStates() {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
      for (const entry of document.querySelectorAll(`[${ENTRY_ATTR}]`)) {
        const scope = entry.getAttribute('data-dss-scope');
        if (state.open && scope === (state.scope ?? '') && state.scope !== null) {
          entry.setAttribute('data-open', 'true');
        } else if (state.open && state.scope === null) {
          entry.removeAttribute('data-open');
        } else {
          entry.removeAttribute('data-open');
        }
      }
      for (const button of document.querySelectorAll('.dss-tree-button')) {
        if (state.open && state.scope === null) button.setAttribute('data-open', '');
        else button.removeAttribute('data-open');
      }
    }

    function buildEntry(scope, label, rowKey) {
      const entry = document.createElement('button');
      entry.type = 'button';
      entry.className = 'dss-row-entry';
      entry.setAttribute(ENTRY_ATTR, rowKey);
      entry.setAttribute('data-dss-scope', scope ?? '');
      entry.setAttribute('title', `${label} · 会话继承树`);
      entry.setAttribute('aria-label', `${label} · 会话继承树`);
      entry.innerHTML = ENTRY_SVG;
      entry.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      entry.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openTree(scope, label);
      });
      return entry;
    }

    /** Mount the per-workspace entries and keep them attached across re-renders. */
    function mountWorkspaceEntries() {
      if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return () => {};
      let scheduled = false;
      const scan = () => {
        scheduled = false;
        if (typeof document.querySelectorAll !== 'function') return;
        const rows = document.querySelectorAll('[data-row-key^="workspace:"]');
        for (const row of rows) {
          const rowKey = row.getAttribute('data-row-key');
          if (rowKey === null) continue;
          if (row.querySelector(`[${ENTRY_ATTR}]`) !== null) continue;
          const actions = row.lastElementChild;
          if (actions === null || actions === undefined) continue;
          const scope = scopeOfRowKey(rowKey);
          const label = labelOfScope(scope);
          try {
            actions.insertBefore(buildEntry(scope, label, rowKey), actions.firstChild);
            diag('entry', { rowKey, scope });
          } catch (error) {
            console.warn(`${NS}: could not place the workspace entry`, error);
          }
        }
        syncEntryStates();
      };
      const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        // The sidebar streams text while a turn runs, so coalesce bursts instead
        // of rescanning on every animation frame.
        setTimeout(scan, 200);
      };
      const observer = new MutationObserver(schedule);
      try {
        observer.observe(document.body, { childList: true, subtree: true });
      } catch (error) {
        console.warn(`${NS}: could not observe the sidebar`, error);
        return () => {};
      }
      scan();
      return () => {
        observer.disconnect();
        for (const entry of document.querySelectorAll(`[${ENTRY_ATTR}]`)) {
          if (entry.parentNode !== null) entry.parentNode.removeChild(entry);
        }
      };
    }

    /** Load projections for everything currently listed, once per open. */
    let warmedAt = 0;

    async function warmLoaded() {
      const services = state.services;
      if (services === null) return;
      if (Date.now() - warmedAt < 15000) return;
      warmedAt = Date.now();
      const snapshot = services.sessions.list.getSnapshot();
      const ids = Array.isArray(snapshot.ids) ? snapshot.ids : [];
      await warm(ids.filter((id) => services.sessions.list.getSnapshot().byId[id]?.blank !== true));
    }

    /** One row of the tree: the card, its toggles, and the branches below it. */
    function TreeNode({ node, depth, say }) {
      const [open, setOpen] = React.useState(depth === 0);
      const [openSub, setOpenSub] = React.useState(false);
      const inheritKids = node.children.filter((child) => child.edge.kind !== 'subagent');
      const subKids = node.children.filter((child) => child.edge.kind === 'subagent');
      const lines = node.digest?.lines ?? [];
      const badges = [];
      if (node.digest?.turns > 0) badges.push(say('node.turns', { count: node.digest.turns }));
      if (node.digest?.openTodos > 0) badges.push(say('node.open', { count: node.digest.openTodos }));

      const edge = node.edge ?? { kind: 'root', label: '' };
      const edgeText = edge.kind === 'ckpt' ? say('edge.ckpt') : edge.kind === 'subagent' ? say('edge.subagent') : say('edge.root');
      const detached = edge.detached === true;
      const edgeTitle = `${edge.kind === 'ckpt' && edge.label !== '' ? edge.label : edgeText}${detached ? ` · ${say('edge.detached')}` : ''}`;

      return h(
        'div',
        { className: depth === 0 ? 'dss-tnode is-root' : 'dss-tnode' },
        h(
          'div',
          { className: node.edge.kind === 'subagent' ? 'dss-tcard is-subagent' : 'dss-tcard' },
          h(
            'div',
            { className: 'dss-tcard-head' },
            h('span', { className: `dss-tedge is-${edge.kind}`, title: edgeTitle }, detached ? `${edgeText} ↗` : edgeText),
            h(Icon, { status: node.status }),
            h('span', { className: 'dss-tcard-title', title: node.title }, node.title || node.id),
            ...badges.map((text) => h('span', { className: 'dss-badge', key: text }, text)),
            node.subagents > 0 ? h('span', { className: 'dss-badge is-count', title: say('node.subagents', { count: node.subagents }) }, say('node.subagentsShort', { count: node.subagents })) : null
          ),
          lines.length === 0
            ? null
            : lines.map((line, index) =>
                h('div', { className: index === lines.length - 1 && node.digest?.openTodos > 0 ? 'dss-line open' : 'dss-line', key: index }, line)
              )
        ),
        inheritKids.length === 0
          ? null
          : h(
              'button',
              {
                type: 'button',
                className: 'dss-branch-toggle',
                onClick: () => setOpen(!open),
                'aria-expanded': open ? 'true' : 'false',
              },
              open ? '▾' : '▸',
              say('node.inheritCount', { count: inheritKids.length })
            ),
        open && inheritKids.length > 0
          ? h(
              'div',
              { className: 'dss-branch' },
              inheritKids.map((child) => h(TreeNode, { key: child.id, node: child, depth: depth + 1, say }))
            )
          : null,
        subKids.length === 0
          ? null
          : h(
              'button',
              {
                type: 'button',
                className: 'dss-branch-toggle is-subagent',
                onClick: () => setOpenSub(!openSub),
                'aria-expanded': openSub ? 'true' : 'false',
              },
              openSub ? '▾' : '▸',
              say('node.subagentCount', { count: subKids.length })
            ),
        openSub && subKids.length > 0
          ? h(
              'div',
              { className: 'dss-branch is-subagent' },
              subKids.map((child) => h(TreeNode, { key: child.id, node: child, depth: depth + 1, say }))
            )
          : null
      );
    }

    function StatChip({ label, value }) {
      return h('span', { className: 'dss-chip' }, `${label} `, h('b', null, String(value)));
    }

    /** The overlay: workspace forests, per-node digest, workspace statistics. */
    function TreePanel(props) {
      const rev = useStatusStore();
      const say = translator(props.t);
      const sessions = props.useSessions((snapshot) => snapshot);
      const workspaces = props.useWorkspaces((snapshot) => snapshot);
      useEscape(state.open, () => {
        state.open = false;
        bump();
      });

      useEffect(() => {
        if (!state.open) return;
        void warmLoaded();
      }, [state.open, rev === 0]);

      if (!state.open) return null;

      const snapshot = sessions ?? { ids: [], byId: {} };
      const rows = (snapshot.ids ?? []).map((id) => snapshot.byId[id]).filter((row) => row !== undefined);
      const projections = new Map();
      for (const row of rows) projections.set(row.id, projectionOf(row.id));
      const all = buildForest(rows, projections, workspaces ?? {}, Date.now(), state.staleDays);
      // A per-workspace entry shows only that workspace's forest; the footer
      // entry shows everything.
      const forests = state.scope === null ? all : all.filter((forest) => forest.key === state.scope);
      const heading = state.scope === null ? say('tree.title') : `${say('tree.title')} · ${state.scopeLabel}`;

      return h(
        'div',
        { className: 'dss-overlay', onMouseDown: (event) => { if (event.target === event.currentTarget) { state.open = false; bump(); } } },
        h(
          'div',
          { className: 'dss-panel', role: 'dialog', 'aria-label': heading },
          h(
            'div',
            { className: 'dss-panel-head' },
            h(MarkTree, null),
            h('span', { className: 'dss-panel-title' }, heading),
            h(
              'button',
              { type: 'button', className: 'dss-panel-close', 'aria-label': say('tree.close'), onClick: () => { state.open = false; bump(); } },
              '×'
            )
          ),
          h(
            'div',
            { className: 'dss-chips' },
            ...chipsFor(forests, say)
          ),
          h(
            'div',
            { className: 'dss-legend' },
            h('span', { className: 'dss-tedge is-root' }, say('edge.root')),
            h('span', { className: 'dss-tedge is-ckpt' }, say('edge.ckpt')),
            h('span', { className: 'dss-tedge is-subagent' }, say('edge.subagent')),
            h('span', { className: 'dss-legend-note' }, say('tree.legendNote'))
          ),
          h(
            'div',
            { className: 'dss-body' },
            forests.length === 0
              ? h('div', { className: 'dss-empty' }, say('tree.empty'))
              : forests.map((forest) => {
                  const edges = forest.all.filter((node) => node.edge.kind !== 'root').length;
                  return h(
                    'div',
                    { className: 'dss-group', key: forest.key },
                    h(
                      'div',
                      { className: 'dss-group-head' },
                      h('span', { className: 'dss-group-name' }, forest.title || forest.cwd || '~'),
                      h('span', null, say('tree.groupMeta', { sessions: forest.stats?.sessions ?? 0, edges }))
                    ),
                    edges === 0 ? h('div', { className: 'dss-group-hint' }, say('tree.noEdge')) : null,
                    forest.roots.map((node) => h(TreeNode, { key: node.id, node, depth: 0, say }))
                  );
                })
          )
        )
      );
    }

    /** One aggregate row: every workspace summed, plus per-workspace chips. */
    function chipsFor(forests, say) {
      const total = {
        sessions: 0,
        running: 0,
        checkpointed: 0,
        inheriting: 0,
        stale: 0,
        archived: 0,
        subagents: 0,
        turns: 0,
        steps: 0,
        tokens: 0,
      };
      for (const forest of forests) for (const key of Object.keys(total)) total[key] += Number(forest.stats?.[key] ?? 0) || 0;
      const chips = [
        ['stats.sessions', total.sessions],
        ['stats.running', total.running],
        ['stats.checkpointed', total.checkpointed],
        ['stats.inheriting', total.inheriting],
        ['stats.stale', total.stale],
        ['stats.archived', total.archived],
        ['stats.subagents', total.subagents],
        ['stats.turns', total.turns],
        ['stats.steps', total.steps],
        ['stats.tokens', total.tokens],
      ];
      return chips.map(([key, value]) => h(StatChip, { key, label: say(key), value }));
    }

    /**
     * `shell.overlay` hands out a frame and nothing else — no close button, no
     * Escape handling, no focus management — so every surface we mount there
     * owns its own dismissal.
     */
    function useEscape(active, onEscape) {
      useEffect(() => {
        if (!active || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          onEscape();
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
        // Dismissal only flips module state, so a closure captured on the open
        // transition stays correct and does not need to re-subscribe per render.
      }, [active]);
      return undefined;
    }

    /**
     * The archive Remote answers with a result object (`{ok, value|error}`)
     * and the Client may also throw `WorkspaceArchiveError`; both spell the
     * same refusal `workspace/session-active` and both name the running work
     * in `details.activity`. One pure reader keeps both paths honest.
     */
    function archiveVerdict(result) {
      if (result === null || result === undefined || result.ok === true) return { kind: 'done' };
      return archiveFailure(result.error);
    }

    function archiveFailure(error) {
      const code = error?.code;
      if (code === 'workspace/session-active') {
        const activity = error?.details?.activity;
        return { kind: 'refused', activity: Array.isArray(activity) ? activity : [] };
      }
      return { kind: 'error', message: String(error?.message ?? code ?? 'archive failed') };
    }

    /** Archive confirmation for a stale row, including the Host's activity refusal. */
    function ArchiveDialog(props) {
      useStatusStore();
      const target = state.archiveTarget;
      const say = translator(props.t);
      const [busy, setBusy] = React.useState(false);
      const [activity, setActivity] = React.useState(null);
      const [error, setError] = React.useState(null);

      useEffect(() => {
        if (target !== null) {
          setBusy(false);
          setActivity(null);
          setError(null);
        }
      }, [target?.id]);

      const close = () => {
        state.archiveTarget = null;
        bump();
      };
      useEscape(target !== null, close);
      if (target === null) return null;

      /**
       * One call, two possible verdicts: the Session archives, or the Host
       * refuses because work is still running and names that work in
       * `error.details.activity`. We never pass `stopActivity` before the
       * refusal, because stopping a Session's reminders cannot be undone.
       */
      const confirm = async (stopActivity) => {
        const services = state.services;
        setBusy(true);
        setError(null);
        try {
          const verdict = archiveVerdict(services === null ? null : await services.workspaces.archiveSession(target.id, stopActivity ? { stopActivity: true } : {}));
          if (verdict.kind === 'refused') {
            setActivity(verdict.activity);
            return;
          }
          if (verdict.kind === 'error') {
            setError(verdict.message);
            return;
          }
          close();
        } catch (thrown) {
          const verdict = archiveFailure(thrown);
          if (verdict.kind === 'refused') setActivity(verdict.activity);
          else setError(verdict.message);
        } finally {
          setBusy(false);
        }
      };

      const rows = (activity ?? []).map((item, index) => {
        const kind = typeof item?.kind === 'string' ? item.kind : 'other';
        const key = `activity.${kind}`;
        const label = say(key) === key ? say('activity.other') : say(key);
        const detail = typeof item?.label === 'string' && item.label.length > 0 ? item.label : typeof item?.id === 'string' ? item.id : '';
        const items = Array.isArray(item?.items) ? item.items : [];
        return h(
          'li',
          { key: `${kind}-${index}`, className: 'dss-activity-row' },
          h('span', { className: 'dss-activity-kind' }, label),
          detail === '' ? null : h('span', { className: 'dss-activity-detail' }, detail),
          items.length === 0
            ? null
            : h(
                'ul',
                { className: 'dss-activity-items' },
                items.slice(0, 6).map((entry, sub) =>
                  h('li', { key: sub }, typeof entry?.label === 'string' ? entry.label : String(entry?.id ?? ''))
                )
              )
        );
      });

      const refused = activity !== null;

      return h(
        'div',
        { className: 'dss-dialog', onMouseDown: (event) => { if (event.target === event.currentTarget) close(); } },
        h(
          'div',
          { className: 'dss-dialog-card', role: 'dialog', 'aria-modal': 'true' },
          h('div', { className: 'dss-dialog-title' }, say(refused ? 'archive.activeTitle' : 'archive.title')),
          h('div', { className: 'dss-dialog-text' }, refused ? say('archive.activeText') : say('archive.text', { days: target.days })),
          h('div', { className: 'dss-dialog-text', style: { fontWeight: 500 } }, target.title),
          refused && rows.length > 0 ? h('ul', { className: 'dss-activity' }, rows) : null,
          error === null ? null : h('div', { className: 'dss-dialog-error' }, error),
          h(
            'div',
            { className: 'dss-dialog-actions' },
            h('button', { type: 'button', className: 'dss-btn', onClick: close, disabled: busy }, say('archive.cancel')),
            h(
              'button',
              {
                type: 'button',
                className: 'dss-btn dss-btn-primary',
                onClick: () => void confirm(refused),
                disabled: busy,
              },
              busy ? say('archive.working') : say(refused ? 'archive.force' : 'archive.confirm')
            )
          )
        )
      );
    }
    function ArchiveDialog(props) {
      useStatusStore();
      const target = state.archiveTarget;
      const say = translator(props.t);
      const [busy, setBusy] = React.useState(false);

      useEffect(() => {
        if (target !== null) setBusy(false);
      }, [target?.id]);

      if (target === null) return null;

      const close = () => {
        state.archiveTarget = null;
        bump();
      };

      const confirm = async () => {
        const services = state.services;
        setBusy(true);
        try {
          if (services !== null) await services.workspaces.archiveSession(target.id, {});
        } catch (error) {
          console.warn(`${NS}: could not archive ${target.id}`, error);
        } finally {
          setBusy(false);
          close();
        }
      };

      return h(
        'div',
        { className: 'dss-dialog', onMouseDown: (event) => { if (event.target === event.currentTarget) close(); } },
        h(
          'div',
          { className: 'dss-dialog-card', role: 'dialog', 'aria-modal': 'true' },
          h('div', { className: 'dss-dialog-title' }, say('archive.title')),
          h('div', { className: 'dss-dialog-text' }, say('archive.text', { days: target.days })),
          h(
            'div',
            { className: 'dss-dialog-text', style: { fontWeight: 500 } },
            target.title
          ),
          h(
            'div',
            { className: 'dss-dialog-actions' },
            h('button', { type: 'button', className: 'dss-btn', onClick: close, disabled: busy }, say('archive.cancel')),
            h('button', { type: 'button', className: 'dss-btn dss-btn-primary', onClick: () => void confirm(), disabled: busy }, busy ? say('archive.working') : say('archive.confirm'))
          )
        )
      );
    }

    /* ------------------------------------------------------------------ *
     * Entry.
     * ------------------------------------------------------------------ */

    function apply(ctx) {
      try {
        const sessions = ctx.get('sessions');
        const workspaces = ctx.get('workspaces');
        if (sessions === undefined || workspaces === undefined) {
          console.warn(`${NS}: sessions or workspaces service is unavailable`);
          return;
        }
        state.services = { sessions, workspaces };
        state.staleDays = readConfig().staleDays;
        diag('apply', {
          staleDays: state.staleDays,
          list: typeof sessions.list?.getSnapshot,
          refresh: typeof sessions.refreshProjections,
          values: typeof sessions.manager?.projectionValues,
        });

        try {
          ctx.effect(() => injectStyles(), `${NS}: styles`);
        } catch (error) {
          console.warn(`${NS}: could not inject styles`, error);
        }

        try {
          ctx.effect(() => mountWorkspaceEntries(), `${NS}: workspace entries`);
        } catch (error) {
          diag('entry-mount-failed', { error: String(error).slice(0, 160) });
          console.warn(`${NS}: could not mount the workspace entries`, error);
        }

        try {
          ctx.effect(
            () => {
              try {
                return ctx.locale.register(NS, { zh: ZH, en: EN });
              } catch (error) {
                console.warn(`${NS}: could not register dictionaries`, error);
                return () => {};
              }
            },
            `${NS}: dictionaries`
          );
        } catch (error) {
          console.warn(`${NS}: locale channel rejected the dictionaries`, error);
        }

        const contributions = [
          {
            name: 'sidebar.session.row.leading',
            id: 'session-status',
            order: 60,
            locale: NS,
            inject: () => ({ hooks: { sessions: sessions.list } }),
            component: SessionStatusMark,
          },
          {
            name: 'sidebar.footer.action',
            id: 'session-status-tree',
            order: 40,
            locale: NS,
            component: TreeButton,
          },
          {
            name: 'shell.overlay',
            id: 'session-status-tree',
            locale: NS,
            inject: () => ({ hooks: { sessions: sessions.list, workspaces: workspaces.list } }),
            component: TreePanel,
          },
          {
            name: 'shell.overlay',
            id: 'session-status-archive',
            locale: NS,
            component: ArchiveDialog,
          },
        ];

        for (const spec of contributions) {
          const contribute = () => {
            try {
              return ctx.slots.register(spec, spec.component);
            } catch (error) {
              console.warn(`${NS}: could not register ${spec.name}#${spec.id}`, error);
              return () => {};
            }
          };
          try {
            ctx.slots.inject(spec.name, contribute);
            diag('inject', { slot: spec.name, id: spec.id, ok: true });
          } catch (error) {
            diag('inject', { slot: spec.name, id: spec.id, ok: false, error: String(error).slice(0, 180) });
            console.warn(`${NS}: slot ${spec.name} is unavailable`, error);
          }
        }
      } catch (error) {
        console.warn(`${NS}: plugin setup failed`, error);
      }
    }

    const api = {
      inject: ['slots', 'locale', 'sessions', 'workspaces'],
      apply,
    };

    // Test seam: the harness loads this bundle in a vm with the flag set so the
    // pure derivations (status, inheritance, forest, digest) stay unit-testable
    // without a React renderer.
    if (globalThis.__DSS_STATUS_TEST_SEAM__ === true) {
      api.__internals = {
        NS,
      archiveVerdict,
      archiveFailure,
        statusOf,
        producedCheckpoint,
        inheritedCheckpoints,
        buildForest,
        digestOf,
        lastPromptAtOf,
        normalizePath,
        basename,
        clip,
        squash,
        scopeOfRowKey,
        labelOfScope,
        translator,
        TreeNode,
        TreePanel,
        state,
      };
    }

    return api;
  },
});
