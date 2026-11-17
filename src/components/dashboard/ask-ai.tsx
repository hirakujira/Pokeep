import { useState } from "react";
import { Send } from "lucide-react";
import Markdown from "react-markdown";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkGfm from "remark-gfm";
import { api } from "./api";

type Message = { role: "user" | "assistant"; content: string };

export function AskAiView({ apiConfigured }: { apiConfigured: boolean }) {
  const [messages, setMessages] = useState<Message[]>([]),
    [draft, setDraft] = useState(""),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const send = async () => {
    const question = draft.trim();
    if (!question || pending) return;
    // The server caps a conversation at 20 messages; keep the newest ones.
    const next = [...messages, { role: "user" as const, content: question }].slice(-19);
    setMessages(next);
    setDraft("");
    setPending(true);
    setError("");
    try {
      const { answer } = await api<{ answer: string }>("ask", "POST", { messages: next });
      setMessages([...next, { role: "assistant", content: answer }]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="panel ask-panel">
      <div className="panel-heading">
        <div>
          <h2>詢問 AI</h2>
          <p>AI 會依資料庫中仍持有的寶可夢與評估結果回答。</p>
        </div>
      </div>
      <div className="ask-log" aria-live="polite">
        {messages.map((m, i) =>
          m.role === "assistant" ? (
            <div key={i} className="ask-message assistant markdown">
              <Markdown
                remarkPlugins={[remarkGfm, remarkCjkFriendly]}
                components={{ a: (props) => <a {...props} target="_blank" rel="noreferrer" /> }}
              >
                {m.content}
              </Markdown>
            </div>
          ) : (
            <p key={i} className="ask-message user">{m.content}</p>
          ),
        )}
        {pending && <p className="ask-message assistant">思考中…</p>}
        {error && <p className="ask-message error" role="alert">{error}</p>}
      </div>
      <form
        className="ask-form"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          aria-label="問題"
          rows={3}
          value={draft}
          maxLength={4000}
          disabled={!apiConfigured}
          placeholder={apiConfigured ? "例如：哪些寶可夢最值得用星塵強化？" : "請先到「設定」填入 API key"}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button className="button primary" disabled={!apiConfigured || pending || !draft.trim()}>
          <Send size={16} />
          送出
        </button>
      </form>
    </section>
  );
}
