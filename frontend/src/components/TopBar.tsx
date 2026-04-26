import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { Files, GitBranch, Mic, MicOff, Volume2, VolumeX, Box } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useSessionStore } from "@/state/sessionStore";
import { ArtifactButton } from "@/components/ArtifactButton";
import { useArtifactStore } from "@/state/artifactStore";

/**
 * Pinned bar across the top of the canvas. 56 px tall, near-transparent
 * with a backdrop blur and a thin bottom border. Wordmark + phosphor-dot
 * logomark on the left, editable session name in the center, status
 * affordances on the right (sound toggle, branch chip, LIVE/OFF mic pill).
 *
 * The mic pill is the only thing that should pull the eye when active —
 * it picks up the volt signature accent and softly pulses.
 */
export function TopBar() {
  const reduce = useReducedMotion();
  const sessionName = useSessionStore((s) => s.currentSessionName);
  const setSessionName = useSessionStore((s) => s.setSessionName);
  const micActive = useSessionStore((s) => s.micActive);
  const setMicActive = useSessionStore((s) => s.setMicActive);
  const branches = useSessionStore((s) => s.branchedSessions);
  const sidePanelOpen = useSessionStore((s) => s.sidePanelOpen);
  const setSidePanelOpen = useSessionStore((s) => s.setSidePanelOpen);
  const soundEnabled = useSessionStore((s) => s.soundEnabled);
  const setSoundEnabled = useSessionStore((s) => s.setSoundEnabled);
  const navigate = useNavigate();
  const currentSessionId = useSessionStore((s) => s.currentSessionId);

  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="topbar-mark" aria-hidden>
          <svg className="topbar-mark-glyph" viewBox="0 0 18 18" width="16" height="16">
            <defs>
              <radialGradient id="phosphor" cx="0.5" cy="0.5" r="0.5">
                <stop offset="0%" stopColor="var(--signature-accent)" stopOpacity="1" />
                <stop offset="100%" stopColor="var(--signature-accent)" stopOpacity="0" />
              </radialGradient>
            </defs>
            <circle cx="9" cy="9" r="8" fill="url(#phosphor)" opacity="0.55" />
            <circle cx="9" cy="9" r="2.4" fill="var(--signature-accent)" />
            <circle cx="3" cy="14" r="1.1" fill="var(--signature-accent)" opacity="0.78" />
            <circle cx="15" cy="4" r="1.1" fill="var(--signature-accent)" opacity="0.78" />
            <line x1="9" y1="9" x2="3" y2="14" stroke="var(--signature-accent)" strokeWidth="0.6" opacity="0.32" />
            <line x1="9" y1="9" x2="15" y2="4" stroke="var(--signature-accent)" strokeWidth="0.6" opacity="0.32" />
          </svg>
          <span className="topbar-mark-text">MINDMAP</span>
        </span>
        <span className="topbar-divider" aria-hidden />
        {editing ? (
          <input
            ref={inputRef}
            className="topbar-name-input"
            value={sessionName}
            onChange={(e) => setSessionName(e.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="topbar-name"
            onClick={() => setEditing(true)}
            title="Rename session"
          >
            {sessionName || "Untitled"}
          </button>
        )}
        {branches.length > 0 ? (
          <button
            type="button"
            className="topbar-branch"
            onClick={() => setSidePanelOpen(!sidePanelOpen)}
            aria-label="Toggle branches panel"
          >
            <GitBranch size={11} />
            <span className="tabular">{branches.length}</span>
          </button>
        ) : null}
      </div>

      <div className="topbar-right">
        <button
          type="button"
          className={`topbar-icon ${soundEnabled ? "is-on" : ""}`}
          onClick={() => setSoundEnabled(!soundEnabled)}
          aria-label={soundEnabled ? "Mute sounds" : "Enable sounds"}
          title={soundEnabled ? "Mute sounds" : "Enable sound effects"}
        >
          {soundEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
        </button>
        <ArtifactHistoryButton />
        <ArtifactButton />
        <button
          type="button"
          className="topbar-3d"
          disabled={!currentSessionId}
          title={
            micActive
              ? "Open 3D / AR view (live — orbs appear as you talk)"
              : "Open 3D / AR view"
          }
          onClick={() => currentSessionId && navigate("/ar")}
          aria-label="Open 3D AR view"
        >
          <Box size={14} />
          <span>3D</span>
        </button>
        <motion.button
          type="button"
          className={`topbar-mic ${micActive ? "is-live" : ""}`}
          onClick={() => setMicActive(!micActive)}
          aria-pressed={micActive}
          aria-label={micActive ? "Stop mic" : "Start mic"}
          animate={
            micActive && !reduce
              ? {
                  boxShadow: [
                    "0 0 0 0 rgba(214,255,58,0.55), 0 0 18px rgba(214,255,58,0.30)",
                    "0 0 0 6px rgba(214,255,58,0.00), 0 0 22px rgba(214,255,58,0.20)",
                  ],
                }
              : { boxShadow: "none" }
          }
          transition={{ duration: 1.4, repeat: micActive ? Infinity : 0, ease: "easeOut" }}
        >
          <span className={`topbar-mic-led ${micActive ? "is-live" : ""}`} />
          {micActive ? <Mic size={12} /> : <MicOff size={12} />}
          <span className="tabular">{micActive ? "LIVE" : "OFF"}</span>
        </motion.button>
      </div>

      <style>{`
        .topbar {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 56px;
          z-index: 50;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 var(--sp-5);
          background: rgba(6, 9, 13, 0.72);
          backdrop-filter: blur(14px) saturate(160%);
          -webkit-backdrop-filter: blur(14px) saturate(160%);
          border-bottom: 1px solid var(--border-subtle);
        }
        .topbar-left, .topbar-right {
          display: flex;
          align-items: center;
          gap: var(--sp-3);
        }
        .topbar-mark {
          display: inline-flex;
          align-items: center;
          gap: var(--sp-2);
        }
        .topbar-mark-dot {
          width: 9px; height: 9px;
          border-radius: 999px;
          background: var(--signature-accent);
          box-shadow: 0 0 14px var(--signature-accent-glow);
          display: inline-block;
        }
        .topbar-mark-glyph {
          display: inline-block;
          filter: drop-shadow(0 0 10px var(--signature-accent-glow));
        }
        .topbar-mark-text {
          font-family: var(--font-display);
          font-weight: 600;
          font-size: var(--fs-xs);
          letter-spacing: 0.22em;
          color: var(--text-secondary);
        }
        .topbar-divider {
          width: 1px; height: 18px;
          background: var(--border-subtle);
        }
        .topbar-name {
          font-family: var(--font-display);
          font-size: var(--fs-md);
          font-weight: 500;
          color: var(--text-primary);
          padding: 6px 10px;
          border-radius: var(--radius-sm);
          letter-spacing: -0.005em;
        }
        .topbar-name:hover { background: var(--bg-overlay); color: var(--text-primary); }
        .topbar-name-input {
          font-family: var(--font-display);
          font-size: var(--fs-md);
          font-weight: 500;
          color: var(--text-primary);
          background: var(--bg-overlay);
          padding: 6px 10px;
          border-radius: var(--radius-sm);
          min-width: 220px;
          border: 1px solid var(--border-default);
        }
        .topbar-branch {
          display: inline-flex;
          align-items: center;
          gap: var(--sp-1);
          padding: 4px 8px;
          font-family: var(--font-mono);
          font-size: var(--fs-xs);
          color: var(--text-secondary);
          border: 1px solid var(--border-subtle);
          border-radius: 999px;
          background: var(--bg-raised);
        }
        .topbar-branch:hover {
          color: var(--signature-accent);
          border-color: var(--signature-accent-soft);
        }
        .topbar-icon {
          width: 30px; height: 30px;
          display: grid; place-items: center;
          border-radius: var(--radius-sm);
          color: var(--text-tertiary);
        }
        .topbar-icon:hover {
          background: var(--bg-overlay);
          color: var(--text-primary);
        }
        .topbar-icon.is-on { color: var(--signature-accent); }

        .topbar-mic {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px 6px 10px;
          border-radius: 999px;
          background: var(--bg-raised);
          border: 1px solid var(--border-default);
          color: var(--text-secondary);
          font-family: var(--font-display);
          font-size: var(--fs-xs);
          font-weight: 600;
          letter-spacing: 0.12em;
        }
        .topbar-mic.is-live {
          background: var(--signature-accent);
          color: var(--signature-accent-fg);
          border-color: var(--signature-accent);
        }
        .topbar-mic-led {
          width: 6px; height: 6px;
          border-radius: 999px;
          background: var(--text-tertiary);
          display: inline-block;
        }
        .topbar-mic-led.is-live {
          background: var(--signature-accent-fg);
          box-shadow: 0 0 6px rgba(0,0,0,0.35) inset;
        }
        .topbar-3d {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px;
          border-radius: 6px;
          background: transparent;
          border: 1px solid rgba(214, 255, 58, 0.3);
          color: var(--signature-accent);
          font-family: var(--font-display);
          font-size: var(--fs-xs);
          letter-spacing: 0.08em;
          cursor: pointer;
        }
        .topbar-3d:disabled {
          opacity: 0.35;
          cursor: not-allowed;
        }
        .topbar-3d:hover:not(:disabled) {
          background: rgba(214, 255, 58, 0.08);
        }
      `}</style>
    </header>
  );
}

/**
 * Tiny icon-only button that opens the artifact history dropdown. Defined
 * inline to keep TopBar's wiring contained.
 */
function ArtifactHistoryButton() {
  const openHistory = useArtifactStore((s) => s.openHistory);
  return (
    <button
      type="button"
      className="topbar-icon"
      onClick={() => void openHistory()}
      aria-label="Open artifact history"
      title="Past artifacts"
      data-testid="artifact-history-button"
    >
      <Files size={14} />
    </button>
  );
}

export default TopBar;
