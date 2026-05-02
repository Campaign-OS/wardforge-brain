import { useEffect, useState, useCallback } from "react";
import {
  api,
  type DashboardData,
  type Commitment,
  type CommitmentStatus,
  type CommitmentHorizon,
} from "./api";

const fmtDate = (s: string | null): string => {
  if (!s) return "—";
  return s;
};

const STATUS_COLORS: Record<CommitmentStatus, string> = {
  open: "bg-stone-700 text-stone-100",
  "in-progress": "bg-blue-900 text-blue-100",
  blocked: "bg-amber-900 text-amber-100",
  done: "bg-emerald-900 text-emerald-100",
  dropped: "bg-stone-800 text-stone-400",
};

// Each kanban column gets its own visual identity: header bar color,
// background tint, accent color. Helps the eye land in the right place
// without reading the column label every time.
interface ColumnTheme {
  key: CommitmentHorizon | "done";
  label: string;
  headerClass: string; // colored header bar
  bgClass: string; // column body background
  borderClass: string; // column border
  accentClass: string; // count badge
}

const KANBAN_COLUMNS: ColumnTheme[] = [
  {
    key: "today",
    label: "TODAY",
    headerClass: "bg-rose-600 text-rose-50",
    bgClass: "bg-rose-950/30",
    borderClass: "border-rose-900/60",
    accentClass: "bg-rose-900 text-rose-100",
  },
  {
    key: "this-week",
    label: "THIS WEEK",
    headerClass: "bg-amber-600 text-amber-50",
    bgClass: "bg-amber-950/20",
    borderClass: "border-amber-900/60",
    accentClass: "bg-amber-900 text-amber-100",
  },
  {
    key: "later",
    label: "LATER",
    headerClass: "bg-sky-700 text-sky-50",
    bgClass: "bg-sky-950/20",
    borderClass: "border-sky-900/60",
    accentClass: "bg-sky-900 text-sky-100",
  },
  {
    key: "done",
    label: "DONE",
    headerClass: "bg-emerald-700 text-emerald-50",
    bgClass: "bg-emerald-950/20",
    borderClass: "border-emerald-900/60",
    accentClass: "bg-emerald-900 text-emerald-100",
  },
];

interface Props {
  onOpenChat: () => void;
}

export default function Dashboard({ onOpenChat }: Props) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"company" | "personal">("personal");
  const [pendingChange, setPendingChange] = useState<{
    token: string;
    description: string;
  } | null>(null);
  const [showNewModal, setShowNewModal] = useState(false);
  const [newDraft, setNewDraft] = useState<Partial<Commitment>>({
    title: "",
    horizon: "today",
    status: "open",
    deadline: null,
    notes: "",
  });

  const refresh = useCallback(async () => {
    setLoading(true);
    const r = await api.dashboard();
    if (r.ok) {
      setData(r.data);
      setError(null);
    } else {
      setError(`${r.status}: ${r.error}`);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (loading && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center text-stone-500 text-base">
        Loading dashboard…
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center text-amber-400 text-base">
        {error}
      </div>
    );
  }
  if (!data) return null;

  const ownerKey = data.signed_in_as.owner_key;
  const visibleCommitments =
    view === "personal"
      ? data.commitments.filter((c) => c.owner === ownerKey)
      : data.commitments;

  const grouped: Record<string, Commitment[]> = {
    today: [],
    "this-week": [],
    later: [],
    done: [],
  };
  for (const c of visibleCommitments) {
    if (c.status === "done") {
      grouped.done.push(c);
    } else if (c.status === "dropped") {
      continue;
    } else {
      grouped[c.horizon].push(c);
    }
  }
  const sortFn = (a: Commitment, b: Commitment): number => {
    if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
    if (a.deadline && !b.deadline) return -1;
    if (!a.deadline && b.deadline) return 1;
    return b.created.localeCompare(a.created);
  };
  for (const k of Object.keys(grouped)) grouped[k].sort(sortFn);

  const proposeChange = async (
    id: string,
    field: keyof Commitment,
    newValue: string | null,
    description: string
  ) => {
    const r = await api.commitments.propose({
      change: { id, field, new_value: newValue },
    });
    if (r.ok) {
      setPendingChange({ token: r.data.token, description });
    }
  };

  const proposeNew = async () => {
    if (!newDraft.title || newDraft.title.trim().length === 0) return;
    const r = await api.commitments.propose({
      new_commitment: {
        ...newDraft,
        owner: newDraft.owner || ownerKey,
      },
    });
    if (r.ok) {
      setPendingChange({
        token: r.data.token,
        description: `Add new commitment: "${newDraft.title}"`,
      });
      setShowNewModal(false);
      setNewDraft({
        title: "",
        horizon: "today",
        status: "open",
        deadline: null,
        notes: "",
      });
    }
  };

  const confirmChange = async () => {
    if (!pendingChange) return;
    const r = await api.commitments.confirm(pendingChange.token);
    if (r.ok) {
      setPendingChange(null);
      refresh();
    }
  };

  const m = data.metrics;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="min-h-screen p-6 space-y-6 text-base">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-semibold">Dashboard</h1>
          <div className="text-sm text-stone-500 mt-1">
            {data.signed_in_as.name} · {data.signed_in_as.email} · {today}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex border border-stone-800 rounded overflow-hidden text-base">
            <button
              onClick={() => setView("personal")}
              className={`px-4 py-2 ${
                view === "personal"
                  ? "bg-stone-100 text-stone-950"
                  : "text-stone-400 hover:bg-stone-900"
              }`}
            >
              My view
            </button>
            <button
              onClick={() => setView("company")}
              className={`px-4 py-2 ${
                view === "company"
                  ? "bg-stone-100 text-stone-950"
                  : "text-stone-400 hover:bg-stone-900"
              }`}
            >
              Company
            </button>
          </div>
          <button
            onClick={() => setShowNewModal(true)}
            className="px-4 py-2 bg-stone-900 hover:bg-stone-800 border border-stone-700 rounded text-base"
          >
            + New commitment
          </button>
          <button
            onClick={onOpenChat}
            className="px-4 py-2 bg-stone-900 hover:bg-stone-800 border border-stone-700 rounded text-base"
          >
            Chat ↗
          </button>
        </div>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        <MetricCard label="Open" value={m.open_count} />
        <MetricCard label="In progress" value={m.in_progress_count} />
        <MetricCard
          label="Blocked"
          value={m.blocked_count}
          highlight={m.blocked_count > 0 ? "amber" : undefined}
        />
        <MetricCard
          label="Slipping"
          value={m.slipping_count}
          highlight={m.slipping_count > 0 ? "red" : undefined}
        />
        <MetricCard label="Done this week" value={m.done_this_week} />
        <MetricCard label="Commits 7d" value={m.commits_past_7_days} />
        <MetricCard
          label="Days since state"
          value={m.days_since_last_state_file ?? "—"}
          highlight={
            m.days_since_last_state_file !== null && m.days_since_last_state_file > 7
              ? "amber"
              : undefined
          }
        />
      </div>

      {/* Kanban */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {KANBAN_COLUMNS.map((col) => (
          <div
            key={col.key}
            className={`border rounded-lg overflow-hidden flex flex-col ${col.borderClass} ${col.bgClass}`}
          >
            {/* Colored header bar — strong visual anchor per column */}
            <div
              className={`${col.headerClass} px-4 py-2.5 flex items-center justify-between font-semibold tracking-wide`}
            >
              <span className="text-base">{col.label}</span>
              <span
                className={`${col.accentClass} text-sm rounded-full px-2.5 py-0.5 font-medium tabular-nums`}
              >
                {grouped[col.key].length}
              </span>
            </div>
            <div className="p-3 space-y-2.5 min-h-[180px] flex-1">
              {grouped[col.key].length === 0 && (
                <div className="text-sm text-stone-700 italic px-1 py-2">
                  empty
                </div>
              )}
              {grouped[col.key].map((c) => (
                <CommitmentCard
                  key={c.id}
                  commitment={c}
                  view={view}
                  today={today}
                  onChangeStatus={(s) =>
                    proposeChange(
                      c.id,
                      "status",
                      s,
                      `${c.id}: status → ${s}`
                    )
                  }
                  onChangeHorizon={(h) =>
                    proposeChange(
                      c.id,
                      "horizon",
                      h,
                      `${c.id}: horizon → ${h}`
                    )
                  }
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Bottom panels — inbox + state preview, side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title={`Inbox (${data.inbox_preview.today_count} today)`}>
          <pre className="text-sm text-stone-300 whitespace-pre-wrap font-mono leading-relaxed">
            {data.inbox_preview.raw_excerpt || "(empty)"}
          </pre>
        </Panel>

        <Panel
          title={`Most recent state file${
            data.weekly_state_preview.most_recent_path
              ? ` — ${data.weekly_state_preview.most_recent_path.split("/").pop()}`
              : ""
          }`}
        >
          <pre className="text-sm text-stone-300 whitespace-pre-wrap leading-relaxed">
            {data.weekly_state_preview.most_recent_excerpt}
          </pre>
        </Panel>
      </div>

      {/* Confirm modal */}
      {pendingChange && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
          <div className="bg-stone-950 border border-amber-700 rounded-lg p-6 max-w-md w-full">
            <div className="text-sm uppercase tracking-wide text-amber-400 mb-2">
              Proposed change — review before committing
            </div>
            <div className="text-base text-stone-100 mb-4 break-words">
              {pendingChange.description}
            </div>
            <div className="text-sm text-stone-500 mb-4">
              Will commit to{" "}
              <span className="font-mono">docs/state/commitments.md</span> in
              the substrate repo.
            </div>
            <div className="flex gap-2">
              <button
                onClick={confirmChange}
                className="px-4 py-2 bg-amber-500 text-stone-950 rounded text-base font-medium"
              >
                Confirm and commit
              </button>
              <button
                onClick={() => setPendingChange(null)}
                className="px-4 py-2 text-stone-400 text-base hover:text-stone-200"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New commitment modal */}
      {showNewModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
          <div className="bg-stone-950 border border-stone-700 rounded-lg p-6 max-w-md w-full space-y-4">
            <div className="text-base font-medium text-stone-100">
              New commitment
            </div>
            <div>
              <label className="text-sm text-stone-500">Title</label>
              <input
                value={newDraft.title || ""}
                onChange={(e) =>
                  setNewDraft({ ...newDraft, title: e.target.value })
                }
                className="w-full bg-stone-900 border border-stone-700 rounded px-3 py-2 text-base mt-1"
                placeholder="e.g. Talk to Matthew about May 31 milestone"
                autoFocus
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-stone-500">Owner</label>
                <select
                  value={newDraft.owner || ownerKey}
                  onChange={(e) =>
                    setNewDraft({ ...newDraft, owner: e.target.value })
                  }
                  className="w-full bg-stone-900 border border-stone-700 rounded px-3 py-2 text-base mt-1"
                >
                  <option value="troy">troy</option>
                  <option value="matthew">matthew</option>
                </select>
              </div>
              <div>
                <label className="text-sm text-stone-500">Horizon</label>
                <select
                  value={newDraft.horizon || "today"}
                  onChange={(e) =>
                    setNewDraft({
                      ...newDraft,
                      horizon: e.target.value as CommitmentHorizon,
                    })
                  }
                  className="w-full bg-stone-900 border border-stone-700 rounded px-3 py-2 text-base mt-1"
                >
                  <option value="today">Today</option>
                  <option value="this-week">This Week</option>
                  <option value="later">Later</option>
                </select>
              </div>
            </div>
            <div>
              <label className="text-sm text-stone-500">Deadline (optional)</label>
              <input
                type="date"
                value={newDraft.deadline || ""}
                onChange={(e) =>
                  setNewDraft({
                    ...newDraft,
                    deadline: e.target.value || null,
                  })
                }
                className="w-full bg-stone-900 border border-stone-700 rounded px-3 py-2 text-base mt-1"
              />
            </div>
            <div>
              <label className="text-sm text-stone-500">Notes (optional)</label>
              <textarea
                value={newDraft.notes || ""}
                onChange={(e) =>
                  setNewDraft({ ...newDraft, notes: e.target.value })
                }
                className="w-full bg-stone-900 border border-stone-700 rounded px-3 py-2 text-base mt-1"
                rows={3}
              />
            </div>
            <div className="flex gap-2 pt-2">
              <button
                onClick={proposeNew}
                disabled={!newDraft.title?.trim()}
                className="px-4 py-2 bg-stone-100 text-stone-950 rounded text-base font-medium disabled:opacity-50"
              >
                Propose
              </button>
              <button
                onClick={() => setShowNewModal(false)}
                className="px-4 py-2 text-stone-400 text-base hover:text-stone-200"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface MetricCardProps {
  label: string;
  value: number | string;
  highlight?: "amber" | "red";
}

function MetricCard({ label, value, highlight }: MetricCardProps) {
  const colorClass =
    highlight === "red"
      ? "border-red-700/60"
      : highlight === "amber"
        ? "border-amber-700/60"
        : "border-stone-800";
  return (
    <div className={`bg-stone-950 border ${colorClass} rounded-lg p-4`}>
      <div className="text-sm uppercase tracking-wide text-stone-500">
        {label}
      </div>
      <div className="text-3xl font-semibold mt-1 tabular-nums">{value}</div>
    </div>
  );
}

interface CommitmentCardProps {
  commitment: Commitment;
  view: "personal" | "company";
  today: string;
  onChangeStatus: (s: CommitmentStatus) => void;
  onChangeHorizon: (h: CommitmentHorizon) => void;
}

function CommitmentCard({
  commitment: c,
  view,
  today,
  onChangeStatus,
  onChangeHorizon,
}: CommitmentCardProps) {
  const slipping =
    c.deadline &&
    c.deadline < today &&
    c.status !== "done" &&
    c.status !== "dropped";
  return (
    <div
      className={`bg-stone-900/90 border rounded-md p-3 ${
        slipping ? "border-red-700" : "border-stone-700"
      }`}
    >
      <div className="text-base text-stone-100 font-medium leading-snug">
        {c.title}
      </div>
      <div className="flex items-center justify-between mt-2 gap-2 text-xs text-stone-400">
        {view === "company" && (
          <span className="capitalize">{c.owner}</span>
        )}
        <span>
          {c.deadline ? (
            <span className={slipping ? "text-red-400" : ""}>
              due {fmtDate(c.deadline)}
            </span>
          ) : (
            "no deadline"
          )}
        </span>
      </div>
      <div className="flex items-center gap-1.5 mt-2.5 flex-wrap">
        <select
          value={c.status}
          onChange={(e) => onChangeStatus(e.target.value as CommitmentStatus)}
          className={`text-xs px-2 py-1 rounded font-medium ${STATUS_COLORS[c.status]}`}
        >
          <option value="open">open</option>
          <option value="in-progress">in-progress</option>
          <option value="blocked">blocked</option>
          <option value="done">done</option>
          <option value="dropped">dropped</option>
        </select>
        {c.status !== "done" && c.status !== "dropped" && (
          <select
            value={c.horizon}
            onChange={(e) =>
              onChangeHorizon(e.target.value as CommitmentHorizon)
            }
            className="text-xs px-2 py-1 rounded bg-stone-800 text-stone-300"
          >
            <option value="today">today</option>
            <option value="this-week">this week</option>
            <option value="later">later</option>
          </select>
        )}
      </div>
      {c.notes && (
        <div className="text-xs text-stone-400 mt-2.5 leading-snug line-clamp-3">
          {c.notes}
        </div>
      )}
    </div>
  );
}

interface PanelProps {
  title: string;
  children: React.ReactNode;
}

function Panel({ title, children }: PanelProps) {
  return (
    <div className="bg-stone-950 border border-stone-800 rounded-lg p-5">
      <div className="text-sm uppercase tracking-wide text-stone-500 mb-3 font-medium">
        {title}
      </div>
      <div className="max-h-80 overflow-y-auto">{children}</div>
    </div>
  );
}
