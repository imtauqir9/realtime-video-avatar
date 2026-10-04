import { useCallback, useEffect, useRef, useState } from "react";
import Daily, { type DailyCall } from "@daily-co/daily-js";
import { createConversation, endConversation, getBrief, getMe, getReplica, login, logout, type Replica } from "./api";

type Status = "idle" | "connecting" | "live" | "error";
type Auth = "loading" | "open" | "locked" | "ok";
type Mode = "text" | "voice" | "video";
type Line = { role: "you" | "avatar"; text: string };

// Who the avatar is. Keep in sync with the heading in knowledge/ME.md.
const AVATAR_NAME = "Imran Tauqir";
const FIRST_NAME = AVATAR_NAME.split(" ")[0];
const AVATAR_ROLE = "VP Global Technology · Bank of America";
const TAGLINE = "Building the infrastructure that runs AI.";
const INITIALS = AVATAR_NAME.split(" ").map((w) => w[0]).join("").slice(0, 2);
const CREDENTIALS = ["Dual CCIE #12172", "20+ years in infrastructure", "GenAI · Agentic AI · Multi-cloud"];

// Conversation starters, drawn from knowledge/ME.md so the avatar has a good answer to each.
const SUGGESTIONS = [
  "How did you go from network engineering to AI?",
  "What makes a data center AI-ready?",
  "How do you run agentic AI safely in a bank?",
  "Where should a beginner start with AI?",
];

// How long to wait for the replica's video before giving up. A join can stall with
// no error at all - the permission prompt is dismissed, the camera is held by another
// app, or the replica never sends a track - and a paid conversation stays open the
// whole time, so this has to fail loudly rather than spin forever.
const CONNECT_TIMEOUT_MS = 25000;

// Loudness (0-1 RMS of the replica's audio) above which the avatar counts as speaking.
const SPEAKING_LEVEL = 0.02;

const svg = (children: JSX.Element) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

const ICONS = {
  text: svg(<><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" /></>),
  voice: svg(<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>),
  video: svg(<><rect x="3" y="7" width="13" height="10" rx="2" /><path d="M16 11l5-3v8l-5-3" /></>),
  micOff: svg(<><path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.7-1.3" /><path d="M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18" /></>),
  camOff: svg(<><path d="M16 11l5-3v8l-2.2-1.3M13 7h1a2 2 0 0 1 2 2v1M16 16a2 2 0 0 1-2 1H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2" /><path d="M3 3l18 18" /></>),
  chevron: svg(<path d="M6 9l6 6 6-6" />),
  arrow: svg(<path d="M5 12h14M13 6l6 6-6 6" />),
  send: svg(<path d="M5 12h14M13 6l6 6-6 6" />),
  spark: svg(<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />),
  hangup: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.956.956 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.27 11.27 0 0 0-2.67-1.85.996.996 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z" />
    </svg>
  ),
};

const STATUS_LABEL: Record<Status, string> = {
  idle: "Available",
  connecting: "Connecting",
  live: "In call",
  error: "Error",
};

const MODES: { id: Mode; title: string; desc: string }[] = [
  { id: "text", title: "Type", desc: "Text in, video out. No mic or camera needed." },
  { id: "voice", title: "Talk", desc: "Speak with your mic and hear the reply." },
  { id: "video", title: "Face to face", desc: "Mic and camera, so it can see and hear you." },
];

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

function Face({ replica, className = "" }: { replica: Replica; className?: string }) {
  return replica.image ? (
    <img className={`face ${className}`} src={replica.image} alt="" />
  ) : (
    <span className={`face face--initials ${className}`} aria-hidden>{INITIALS}</span>
  );
}

// A native <select> laid invisibly over a small chevron button, so picking a device
// opens the platform's own menu without taking up room in the control bar.
function DevicePicker({
  label,
  devices,
  value,
  onChange,
}: {
  label: string;
  devices: MediaDeviceInfo[];
  value: string;
  onChange: (id: string) => void;
}) {
  if (devices.length < 2) return null;
  return (
    <label className="ctl-more" title={`Choose ${label.toLowerCase()}`}>
      {ICONS.chevron}
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {devices.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `${label} ${i + 1}`}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function App() {
  const [status, setStatus] = useState<Status>("idle");
  const [mode, setMode] = useState<Mode>("text");
  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [camId, setCamId] = useState("");
  const [micId, setMicId] = useState("");
  const [error, setError] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [replica, setReplica] = useState<Replica>({ image: "", video: "" });
  const [speaking, setSpeaking] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [maxSeconds, setMaxSeconds] = useState(0);
  const [remaining, setRemaining] = useState(0);

  const callRef = useRef<DailyCall | null>(null);
  const conversationIdRef = useRef("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const selfVideoRef = useRef<HTMLVideoElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const meterRef = useRef<HTMLSpanElement>(null);
  const meterStopRef = useRef<() => void>(() => {});
  const pendingRef = useRef(""); // a suggestion picked on the landing page, sent once live

  const [auth, setAuth] = useState<Auth>("loading");
  const [code, setCode] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);

  useEffect(() => {
    getMe()
      .then((me) => setAuth(!me.authRequired ? "open" : me.authed ? "ok" : "locked"))
      .catch(() => setAuth("open")); // backend unreachable: let the normal error path report it
  }, []);

  useEffect(() => {
    if (auth !== "open" && auth !== "ok") return;
    getReplica().then(setReplica).catch(() => {});
  }, [auth]);

  // Opened from an article: say so, so it is clear the avatar knows what it is about.
  const [brief, setBrief] = useState<{ title: string; error: string }>({ title: "", error: "" });
  useEffect(() => {
    if (auth !== "open" && auth !== "ok") return;
    getBrief().then(setBrief).catch(() => {});
  }, [auth]);
  const suggestions = brief.title
    ? ["What is the main point, in a minute?", "What would you do first?", "What did the article leave out?"]
    : SUGGESTIONS;

  const signIn = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!code.trim()) return;
      setAuthBusy(true);
      setAuthError("");
      try {
        await login(code.trim());
        setCode("");
        setAuth("ok");
      } catch (err: any) {
        setAuthError(err?.message || String(err));
      } finally {
        setAuthBusy(false);
      }
    },
    [code],
  );

  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [lines, thinking]);

  // Watch the replica's audio so the stage can show when it is talking. The level is
  // written straight to a CSS variable each frame; React only hears about on/off flips.
  const meter = useCallback((track: MediaStreamTrack) => {
    meterStopRef.current();
    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch {
      return;
    }
    ctx.resume().catch(() => {});
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(new MediaStream([track])).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let raf = 0;
    let on = false;
    let quietSince = 0;
    const tick = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      meterRef.current?.style.setProperty("--level", Math.min(1, rms * 8).toFixed(3));
      const now = performance.now();
      if (rms > SPEAKING_LEVEL) {
        quietSince = now;
        if (!on) setSpeaking((on = true));
      } else if (on && now - quietSince > 350) {
        setSpeaking((on = false)); // brief hold so pauses between words don't flicker
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    meterStopRef.current = () => {
      cancelAnimationFrame(raf);
      ctx.close().catch(() => {});
      setSpeaking(false);
    };
  }, []);

  const cleanup = useCallback((resetStatus = true) => {
    const id = conversationIdRef.current;
    conversationIdRef.current = "";
    if (id) endConversation(id);

    const call = callRef.current;
    callRef.current = null;
    if (call) {
      // leave fully before destroying; sequencing avoids a "use after destroy" race
      call.leave().catch(() => {}).finally(() => {
        call.destroy().catch(() => {});
      });
    }
    for (const ref of [videoRef, audioRef, selfVideoRef]) {
      if (ref.current) ref.current.srcObject = null;
    }
    meterStopRef.current();
    meterStopRef.current = () => {};
    pendingRef.current = "";
    setThinking(false);
    setCameras([]);
    setMics([]);
    setCamId("");
    setMicId("");
    if (resetStatus) setStatus("idle");
  }, []);

  const refreshDevices = useCallback(async () => {
    const call = callRef.current;
    if (!call) return;
    try {
      const { devices } = await call.enumerateDevices();
      const cams = devices.filter((d) => d.kind === "videoinput" && d.deviceId);
      const ins = devices.filter((d) => d.kind === "audioinput" && d.deviceId);
      setCameras(cams);
      setMics(ins);
      const current: any = await call.getInputDevices();
      setCamId(current?.camera?.deviceId || cams[0]?.deviceId || "");
      setMicId(current?.mic?.deviceId || ins[0]?.deviceId || "");
    } catch {
      // device enumeration can fail before permission is granted; ignore
    }
  }, []);

  const selectCamera = useCallback(async (id: string) => {
    const call = callRef.current;
    if (!call) return;
    await call.setInputDevicesAsync({ videoDeviceId: id });
    setCamId(id);
  }, []);

  const selectMic = useCallback(async (id: string) => {
    const call = callRef.current;
    if (!call) return;
    await call.setInputDevicesAsync({ audioDeviceId: id });
    setMicId(id);
  }, []);

  const start = useCallback(
    async (chosen: Mode, firstQuestion = "") => {
      setError("");
      setLines([]);
      setMode(chosen);
      setStatus("connecting");
      pendingRef.current = firstQuestion;

      const wantAudio = chosen !== "text";
      const wantVideo = chosen === "video";
      try {
        // Create the conversation first. If this fetch fails there's no Daily object yet to tear
        // down, so the next attempt starts clean (this is what caused the "use after destroy").
        const { conversation_url, conversation_id, max_seconds } = await createConversation();
        setMaxSeconds(max_seconds || 0);

        const call = Daily.createCallObject({
          audioSource: wantAudio, // false => no device acquired, no permission prompt
          videoSource: wantVideo,
          subscribeToTracksAutomatically: true,
        });
        callRef.current = call;

        call.on("track-started", (ev: any) => {
          const track = ev?.track;
          if (!track) return;
          if (ev.participant?.local) {
            if (track.kind === "video" && selfVideoRef.current) {
              selfVideoRef.current.srcObject = new MediaStream([track]);
            }
            return;
          }
          if (track.kind === "video" && videoRef.current) {
            videoRef.current.srcObject = new MediaStream([track]);
            setStatus("live");
          }
          if (track.kind === "audio" && audioRef.current) {
            audioRef.current.srcObject = new MediaStream([track]);
            meter(track);
          }
        });

        call.on("track-stopped", (ev: any) => {
          if (ev?.participant?.local && ev?.track?.kind === "video" && selfVideoRef.current) {
            selfVideoRef.current.srcObject = null;
          }
        });

        call.on("app-message", (ev: any) => {
          const d = ev?.data;
          if (d?.event_type !== "conversation.utterance") return;
          const role = d.properties?.role;
          const text = String(d.properties?.speech || "");
          if (!text) return;
          if (role === "replica") {
            setThinking(false);
            setLines((prev) => [...prev, { role: "avatar", text }]);
          } else if (role === "user") {
            setThinking(true);
            // spoken input shows up here; dedupe against text we already added on send
            setLines((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.role === "you" && last.text === text) return prev;
              return [...prev, { role: "you", text }];
            });
          }
        });

        call.on("camera-error", (ev: any) => {
          const detail = String(ev?.error?.type || ev?.errorMsg?.errorMsg || "");
          cleanup(false);
          setError(
            /permission|denied|not-?allowed|blocked/i.test(detail)
              ? "Camera and microphone access was blocked. Allow it in your browser, then start again."
              : "Could not start your camera or microphone. Check that no other app is using it.",
          );
          setStatus("error");
        });

        call.on("left-meeting", () => cleanup());
        call.on("available-devices-updated", () => refreshDevices());

        conversationIdRef.current = conversation_id;
        await call.join({ url: conversation_url });
        setMicOn(wantAudio);
        setCamOn(wantVideo);
        if (wantAudio || wantVideo) await refreshDevices();
      } catch (e: any) {
        cleanup(false);
        if (/HTTP 401|sign in/i.test(String(e?.message))) {
          setStatus("idle");
          setAuth("locked");
          return;
        }
        setError(e?.message || String(e));
        setStatus("error");
      }
    },
    [cleanup, refreshDevices, meter],
  );

  const toggleMic = useCallback(() => {
    const call = callRef.current;
    if (!call) return;
    const next = !micOn;
    call.setLocalAudio(next);
    setMicOn(next);
  }, [micOn]);

  const toggleCam = useCallback(() => {
    const call = callRef.current;
    if (!call) return;
    const next = !camOn;
    call.setLocalVideo(next);
    setCamOn(next);
  }, [camOn]);

  const ask = useCallback((raw: string) => {
    const text = raw.trim();
    const call = callRef.current;
    if (!text || !call) return;
    call.sendAppMessage(
      {
        message_type: "conversation",
        event_type: "conversation.respond",
        conversation_id: conversationIdRef.current,
        properties: { text },
      },
      "*",
    );
    setLines((prev) => [...prev, { role: "you", text }]);
    setThinking(true);
  }, []);

  const send = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      ask(input);
      setInput("");
    },
    [ask, input],
  );

  const signOut = useCallback(async () => {
    cleanup();
    await logout();
    setAuth("locked");
  }, [cleanup]);

  // status only becomes "live" when the replica's video track arrives.
  useEffect(() => {
    if (status !== "connecting") return;
    const timer = setTimeout(() => {
      cleanup(false);
      setError(
        "Could not connect. If your browser asked for camera or microphone access, allow it and try again.",
      );
      setStatus("error");
    }, CONNECT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [status, cleanup]);

  // Once live: send any question picked on the landing page, and count down the call.
  useEffect(() => {
    if (status !== "live") return;
    inputRef.current?.focus(); // the composer is disabled until now, so autofocus can't do this
    if (pendingRef.current) {
      const q = pendingRef.current;
      pendingRef.current = "";
      ask(q);
    }
    if (!maxSeconds) return;
    const endsAt = Date.now() + maxSeconds * 1000;
    const tick = () => setRemaining(Math.max(0, Math.round((endsAt - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [status, maxSeconds, ask]);

  const showSession = status === "connecting" || status === "live";
  const locked = auth === "locked";
  const lowTime = maxSeconds > 0 && remaining <= 30;

  return (
    <div className={`app ${showSession ? "app--session" : ""}`}>
      <header className="topbar">
        <div className="brand">
          {replica.image ? <Face replica={replica} className="brand-face" /> : <span className="brand-mark" aria-hidden>{INITIALS}</span>}
          <span className="brand-text">
            <span className="brand-name">{AVATAR_NAME}</span>
            <span className="brand-sub">AI Avatar</span>
          </span>
        </div>
        <div className="topbar-right">
          <div className={`status status--${status}`}>
            <span className="dot" />
            {STATUS_LABEL[status]}
            {showSession && <span className="mode-tag">{mode}</span>}
          </div>
          {auth === "ok" && (
            <button className="btn btn-link" type="button" onClick={signOut}>
              Sign out
            </button>
          )}
        </div>
      </header>

      <main className="main">
        {auth === "loading" ? (
          <div className="overlay-page">
            <span className="spinner" aria-hidden />
          </div>
        ) : locked ? (
          <section className="gate">
            <div className="gate-mark" aria-hidden>
              <span>{INITIALS}</span>
            </div>
            <h1 className="gate-title">{AVATAR_NAME}</h1>
            <p className="gate-sub">This avatar is private. Enter the access code to continue.</p>
            <form className="gate-form" onSubmit={signIn}>
              <input
                className="field"
                type="password"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Access code"
                autoComplete="current-password"
                autoFocus
              />
              <button className="btn btn-primary" type="submit" disabled={authBusy || !code.trim()}>
                {authBusy ? "Checking…" : "Enter"}
              </button>
            </form>
            {authError && <p className="error">{authError}</p>}
          </section>
        ) : !showSession ? (
          <section className="hero">
            <div className="hero-copy">
              <p className="eyebrow">
                <span className="eyebrow-dot" aria-hidden />
                Realtime AI video avatar
              </p>
              <h1 className="hero-title">
                {brief.title ? (
                  <>Talk with <em>{FIRST_NAME}</em> about this article</>
                ) : (
                  <>Have a conversation with <em>{FIRST_NAME}</em></>
                )}
              </h1>
              {brief.title && (
                <div className="brief-card" role="note">
                  <span className="brief-label">Briefed on</span>
                  <span className="brief-title">{brief.title}</span>
                  <span className="brief-hint">{FIRST_NAME} has read it and will start there. Pick a mode to begin.</span>
                </div>
              )}
              {brief.error && <p className="error">{brief.error}</p>}
              <p className="hero-sub">
                A lifelike AI twin of {AVATAR_NAME}, {AVATAR_ROLE}. Ask about AI infrastructure, agentic
                systems, or the path from network engineer to AI leader.
              </p>

              <div className="modes" role="list">
                {MODES.map((m) => (
                  <button key={m.id} role="listitem" className="mode" type="button" onClick={() => start(m.id)}>
                    <span className="mode-icon">{ICONS[m.id]}</span>
                    <span className="mode-text">
                      <span className="mode-title">{m.title}</span>
                      <span className="mode-desc">{m.desc}</span>
                    </span>
                    <span className="mode-arrow">{ICONS.arrow}</span>
                  </button>
                ))}
              </div>
              {error && <p className="error">{error}</p>}

              <div className="starters">
                <span className="starters-label">{ICONS.spark} Or start with a question</span>
                <div className="starters-list">
                  {suggestions.map((q) => (
                    <button key={q} className="starter" type="button" onClick={() => start("text", q)}>
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <figure className="portrait">
              <div className="portrait-frame">
                {replica.video ? (
                  <video className="portrait-media" src={replica.video} poster={replica.image} autoPlay muted loop playsInline />
                ) : replica.image ? (
                  <img className="portrait-media" src={replica.image} alt="" />
                ) : (
                  <div className="portrait-media portrait-fallback" aria-hidden>{INITIALS}</div>
                )}
                <span className="portrait-pill">
                  <span className="eyebrow-dot" aria-hidden />
                  Available now
                </span>
                <figcaption className="portrait-plate">
                  <span className="portrait-name">{AVATAR_NAME}</span>
                  <span className="portrait-role">{AVATAR_ROLE}</span>
                </figcaption>
              </div>
              <ul className="creds">
                {CREDENTIALS.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <p className="tagline">“{TAGLINE}”</p>
            </figure>
          </section>
        ) : (
          <div className="session">
            <div className={`stage ${speaking ? "is-speaking" : ""}`}>
              {replica.image && <div className="stage-backdrop" style={{ backgroundImage: `url(${replica.image})` }} aria-hidden />}
              <video ref={videoRef} className={`video ${status === "live" ? "is-on" : ""}`} autoPlay playsInline muted />

              {status === "connecting" && (
                <div className="overlay">
                  <div className="ring">
                    <Face replica={replica} className="ring-face" />
                  </div>
                  <span>Connecting to {FIRST_NAME}…</span>
                  <span className="overlay-sub">This usually takes a few seconds</span>
                </div>
              )}

              {status === "live" && (
                <div className="stage-top">
                  <span className="badge">
                    <span className="dot" />
                    Live
                    {maxSeconds > 0 && <span className={`badge-time ${lowTime ? "is-low" : ""}`}>{clock(remaining)}</span>}
                  </span>
                  <span className={`badge badge--speaking ${speaking ? "is-on" : ""}`} ref={meterRef} aria-live="polite">
                    <span className="bars" aria-hidden>
                      <i /><i /><i /><i />
                    </span>
                    {speaking ? `${FIRST_NAME} is speaking` : thinking ? "Thinking…" : "Listening"}
                  </span>
                </div>
              )}

              {mode === "video" && (
                <video ref={selfVideoRef} className={`selfview ${camOn ? "" : "is-off"}`} autoPlay playsInline muted />
              )}

              <div className="controls" role="toolbar" aria-label="Call controls">
                {mode !== "text" && (
                  <div className="ctl-group">
                    <button
                      className={`ctl ${micOn ? "" : "is-off"}`}
                      type="button"
                      onClick={toggleMic}
                      aria-pressed={micOn}
                      aria-label={micOn ? "Mute microphone" : "Unmute microphone"}
                      title={micOn ? "Mute" : "Unmute"}
                    >
                      {micOn ? ICONS.voice : ICONS.micOff}
                    </button>
                    <DevicePicker label="Microphone" devices={mics} value={micId} onChange={selectMic} />
                  </div>
                )}
                {mode === "video" && (
                  <div className="ctl-group">
                    <button
                      className={`ctl ${camOn ? "" : "is-off"}`}
                      type="button"
                      onClick={toggleCam}
                      aria-pressed={camOn}
                      aria-label={camOn ? "Turn camera off" : "Turn camera on"}
                      title={camOn ? "Camera off" : "Camera on"}
                    >
                      {camOn ? ICONS.video : ICONS.camOff}
                    </button>
                    <DevicePicker label="Camera" devices={cameras} value={camId} onChange={selectCamera} />
                  </div>
                )}
                <button className="ctl ctl--end" type="button" onClick={() => cleanup()} aria-label="End call" title="End call">
                  {ICONS.hangup}
                  <span className="ctl-label">End</span>
                </button>
              </div>
            </div>

            <aside className="panel">
              <div className="panel-head">
                <span>Conversation</span>
                {lines.length > 0 && <span className="panel-count">{lines.length}</span>}
              </div>
              <div className="transcript" ref={transcriptRef}>
                {lines.length === 0 && !thinking ? (
                  <div className="empty">
                    <p className="hint">
                      {mode === "text"
                        ? `Type a question below, or try one of these:`
                        : `Say hello, or try one of these:`}
                    </p>
                    {SUGGESTIONS.map((q) => (
                      <button key={q} className="starter" type="button" disabled={status !== "live"} onClick={() => ask(q)}>
                        {q}
                      </button>
                    ))}
                  </div>
                ) : (
                  <>
                    {lines.map((l, i) => (
                      <div key={i} className={`msg msg--${l.role}`}>
                        {l.role === "avatar" && <Face replica={replica} className="msg-face" />}
                        <div className="bubble">{l.text}</div>
                      </div>
                    ))}
                    {thinking && (
                      <div className="msg msg--avatar">
                        <Face replica={replica} className="msg-face" />
                        <div className="bubble bubble--typing" aria-label={`${FIRST_NAME} is thinking`}>
                          <i /><i /><i />
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
              <form className="composer" onSubmit={send}>
                <input
                  ref={inputRef}
                  className="composer-input"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={`Ask ${FIRST_NAME} anything…`}
                  disabled={status !== "live"}
                />
                <button className="composer-send" type="submit" disabled={!input.trim() || status !== "live"} aria-label="Send">
                  {ICONS.send}
                </button>
              </form>
            </aside>
          </div>
        )}
      </main>

      <audio ref={audioRef} autoPlay />

      {/* Gamma lift for the replica video (see --video-filter). Exponent < 1 brightens mid-tones
          while 1.0 stays 1.0, so highlights never clip. */}
      <svg className="defs" aria-hidden>
        <filter id="lift" colorInterpolationFilters="sRGB">
          <feComponentTransfer>
            <feFuncR type="gamma" exponent="0.8" />
            <feFuncG type="gamma" exponent="0.8" />
            <feFuncB type="gamma" exponent="0.8" />
          </feComponentTransfer>
        </filter>
      </svg>
    </div>
  );
}
