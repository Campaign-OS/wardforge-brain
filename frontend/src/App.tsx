import { useEffect, useState, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type User } from "./api";

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
}

interface InboxProposal {
  token: string;
  line: string;
  expires_at: number;
}

const fmtTime = (ts: number): string =>
  new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<
    Array<{ id: string; question: string; user: User; ts: number }>
  >([]);
  const [proposal, setProposal] = useState<InboxProposal | null>(null);
  const [proposalEdit, setProposalEdit] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auth check on mount
  useEffect(() => {
    api.me().then((r) => {
      if (r.ok) setUser(r.data.user);
      setAuthChecked(true);
    });
  }, []);

  // Load history on login
  const refreshHistory = useCallback(async () => {
    const r = await api.history(20);
    if (r.ok) {
      setHistory(
        r.data.queries.map((q) => ({
          id: q.id,
          question: q.question,
          user: q.user,
          ts: q.ts,
        }))
      );
    }
  }, []);

  useEffect(() => {
    if (user) refreshHistory();
  }, [user, refreshHistory]);

  // Scroll to bottom on new message
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const submit = async () => {
    if (!input.trim() || loading) return;
    const question = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: question, ts: Date.now() }]);
    setLoading(true);

    const r = await api.query(question);
    setLoading(false);
    if (r.ok) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: r.data.answer, ts: Date.now() },
      ]);
      refreshHistory();
    } else {
      setMessages((prev) => [
        ...prev,
        {
          role: "system",
          content: `Error (${r.status}): ${r.error}`,
          ts: Date.now(),
        },
      ]);
    }
  };

  const proposeAdd = async (intent: string) => {
    const r = await api.proposeInbox(intent);
    if (r.ok) {
      setProposal({
        token: r.data.token,
        line: r.data.proposal.line,
        expires_at: Date.now() + r.data.expires_in * 1000,
      });
      setProposalEdit(r.data.proposal.line);
    }
  };

  const confirmProposal = async () => {
    if (!proposal) return;
    const r = await api.confirmInbox(proposal.token, proposalEdit);
    if (r.ok) {
      setMessages((prev) => [
        ...prev,
        {
          role: "system",
          content: `✓ Added to inbox: "${r.data.committed}". [View commit](${r.data.commit_url})`,
          ts: Date.now(),
        },
      ]);
      setProposal(null);
      setProposalEdit("");
    } else {
      setMessages((prev) => [
        ...prev,
        { role: "system", content: `Inbox add failed: ${r.error}`, ts: Date.now() },
      ]);
    }
  };

  if (!authChecked) {
    return <div className="min-h-screen flex items-center justify-center text-stone-400">…</div>;
  }

  if (!user) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-6 p-8">
        <div className="text-center">
          <h1 className="text-3xl font-semibold mb-2">WardForge Brain</h1>
          <p className="text-stone-400 text-sm">
            Internal Q&A and synthesis surface. Ask anything about the company.
          </p>
        </div>
        <a
          href={api.loginUrl()}
          className="px-5 py-2.5 bg-stone-100 text-stone-950 rounded-md font-medium hover:bg-white transition"
        >
          Sign in with Google
        </a>
        <p className="text-xs text-stone-500">Restricted to @ward-forge.com accounts.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-72 border-r border-stone-800 flex flex-col">
        <div className="p-4 border-b border-stone-800">
          <h1 className="font-semibold">WardForge Brain</h1>
          <div className="text-xs text-stone-500 mt-1">{user.email}</div>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="text-xs uppercase tracking-wide text-stone-500 mb-2">
            Recent questions
          </div>
          {history.length === 0 && (
            <div className="text-xs text-stone-600">No questions yet.</div>
          )}
          {history.map((q) => (
            <button
              key={q.id}
              onClick={() => setInput(q.question)}
              className="block w-full text-left text-xs text-stone-300 hover:bg-stone-900 p-2 rounded mb-1"
            >
              <div className="line-clamp-2">{q.question}</div>
              <div className="text-stone-600 text-[10px] mt-0.5">
                {q.user.name.split(" ")[0]} · {fmtTime(q.ts)}
              </div>
            </button>
          ))}
        </div>
        <div className="p-4 border-t border-stone-800">
          <button
            onClick={() => api.logout().then(() => setUser(null))}
            className="text-xs text-stone-500 hover:text-stone-300"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col h-screen">
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-6">
          {messages.length === 0 && (
            <div className="max-w-2xl mx-auto pt-12 text-stone-500 text-sm">
              <p className="mb-3">Ask anything about WardForge. The brain reads:</p>
              <ul className="list-disc list-inside space-y-1 text-stone-600">
                <li>architecture, build plan, features</li>
                <li>recent ADRs and weekly states</li>
                <li>commits from the past 14 days</li>
                <li>recent questions other people asked</li>
              </ul>
              <p className="mt-4 text-stone-600">
                Try: <em>"What's our highest-risk dependency?"</em> or{" "}
                <em>"Why did we pick MapLibre?"</em>
              </p>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className="max-w-3xl mx-auto">
              <div className="text-xs text-stone-500 mb-1">
                {m.role === "user" ? user.name : m.role === "assistant" ? "Brain" : "System"} ·{" "}
                {fmtTime(m.ts)}
              </div>
              <div
                className={
                  m.role === "user"
                    ? "bg-stone-900 rounded-lg p-4 prose-brain"
                    : m.role === "assistant"
                      ? "bg-stone-950 border border-stone-800 rounded-lg p-4 prose-brain"
                      : "text-stone-500 italic text-sm"
                }
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
              </div>
              {m.role === "assistant" && (
                <div className="mt-2 flex gap-2 text-xs">
                  <button
                    onClick={() =>
                      proposeAdd(
                        `From brain on ${new Date(m.ts).toLocaleDateString()}: ${
                          messages[i - 1]?.content?.slice(0, 80) || "follow up"
                        }`
                      )
                    }
                    className="text-stone-500 hover:text-stone-300"
                  >
                    + add to inbox
                  </button>
                </div>
              )}
            </div>
          ))}
          {loading && (
            <div className="max-w-3xl mx-auto text-stone-500 text-sm italic">
              Thinking…
            </div>
          )}
        </div>

        {/* Proposal modal */}
        {proposal && (
          <div className="border-t border-amber-700 bg-amber-950/30 p-4">
            <div className="max-w-3xl mx-auto">
              <div className="text-xs uppercase tracking-wide text-amber-400 mb-2">
                Proposed inbox addition — review before confirming
              </div>
              <textarea
                value={proposalEdit}
                onChange={(e) => setProposalEdit(e.target.value)}
                className="w-full bg-stone-900 border border-stone-700 rounded p-2 text-sm"
                rows={2}
              />
              <div className="flex gap-2 mt-2">
                <button
                  onClick={confirmProposal}
                  className="px-3 py-1.5 bg-amber-500 text-stone-950 rounded text-sm font-medium"
                >
                  Confirm and commit
                </button>
                <button
                  onClick={() => setProposal(null)}
                  className="px-3 py-1.5 text-stone-400 text-sm hover:text-stone-200"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Input */}
        <div className="border-t border-stone-800 p-4">
          <div className="max-w-3xl mx-auto flex gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Ask the brain anything…"
              className="flex-1 bg-stone-900 border border-stone-800 rounded-md px-3 py-2 text-sm resize-none focus:outline-none focus:border-stone-600"
              rows={2}
              disabled={loading}
            />
            <button
              onClick={submit}
              disabled={loading || !input.trim()}
              className="px-4 py-2 bg-stone-100 text-stone-950 rounded-md text-sm font-medium disabled:opacity-50"
            >
              Ask
            </button>
          </div>
          <div className="max-w-3xl mx-auto text-xs text-stone-600 mt-2">
            Enter to send · Shift+Enter for newline · queries are logged for the team
          </div>
        </div>
      </main>
    </div>
  );
}
