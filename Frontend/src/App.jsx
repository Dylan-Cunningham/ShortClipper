import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  FileText,
  FolderOpen,
  LoaderCircle,
  Megaphone,
  Mic,
  Plus,
  RefreshCw,
  Scissors,
  Trash2,
  Video,
} from "lucide-react";
import { buildChatGptPrompt } from "./promptTemplate";

const API_BASE = "http://localhost:8787";
const DEFAULT_OUTPUT_DIR = "D:\\Dylan\\projects\\ShortClipper\\outputs";
const DEFAULT_BROWSER_PATH = "D:\\Dylan\\projects\\ShortClipper";
const APP_STATE_STORAGE_KEY = "shortclipper.appState.v1";
const REVIEW_STORAGE_PREFIX = "shortclipper.review.v1:";
const DEFAULT_CTA_IMAGE_PATH = "D:\\Dylan\\projects\\ShortClipper\\outputs\\cta-previews\\dylan-book-of-mormon-poster.png";
const DEFAULT_CTA = {
  enabled: true,
  style: "image",
  preset: "followNext",
  title: "FOLLOW FOR",
  subtitle: "THE NEXT CHAPTER",
  durationSeconds: 3,
  backgroundSeconds: 2,
  imagePath: DEFAULT_CTA_IMAGE_PATH,
};
const DEFAULT_CUT_PADDING = {
  editStyle: "smooth",
  startSeconds: 0.75,
  endSeconds: 0,
  mergeGapSeconds: 15,
};
const SAMPLE_PLAN = `Short 1 - Principles Guide Action

Suggested title:
Do Your Beliefs Actually Produce Good Results?

Use these pieces:

Hook
00:00:55:15 - 00:01:01:03
"The question I'm kind of asking myself here is, what are the principles?"

Main point
00:01:01:06 - 00:01:16:13
"Principles guide action. Action leads to results..."

Payoff
00:01:16:14 - 00:01:24:15
"So 1 Nephi chapter 1 - what are the principles taught, and are those going to lead me to positive outcomes?"`;

function classNames(...values) {
  return values.filter(Boolean).join(" ");
}

function secondsToClock(value) {
  const totalMs = Math.max(0, Math.round(Number(value || 0) * 1000));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
    2,
    "0",
  )}.${String(ms).padStart(3, "0")}`;
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.message || `Request failed (${response.status})`);
  }
  return payload;
}

function StatusPill({ status }) {
  const isReady = status?.ok;
  return (
    <div
      className={classNames(
        "inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-semibold",
        isReady ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800",
      )}
    >
      {isReady ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
      {isReady ? "Backend ready" : "Backend offline"}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">{label}</div>
      {children}
    </label>
  );
}

function TextInput(props) {
  return (
    <input
      {...props}
      className="h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm font-semibold text-neutral-950 outline-none transition focus:border-neutral-950"
    />
  );
}

function IconButton({ children, variant = "secondary", className = "", ...props }) {
  return (
    <button
      type="button"
      {...props}
      className={classNames(
        "inline-flex h-10 items-center justify-center gap-2 rounded-md border px-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60",
        variant === "primary"
          ? "border-neutral-950 bg-neutral-950 text-white hover:bg-neutral-800"
          : "border-neutral-300 bg-white text-neutral-800 hover:bg-neutral-100",
        className,
      )}
    >
      {children}
    </button>
  );
}

function ShortPreview({ shorts }) {
  if (!shorts.length) {
    return (
      <div className="flex min-h-52 items-center justify-center rounded-lg border border-dashed border-neutral-300 bg-white text-sm font-semibold text-neutral-500">
        No parsed shorts yet
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {shorts.map((shortItem) => (
        <div key={`${shortItem.number}-${shortItem.title}`} className="rounded-lg border border-neutral-300 bg-white p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Short {shortItem.number}</div>
              <div className="mt-1 text-base font-bold text-neutral-950">{shortItem.title}</div>
            </div>
            <div className="rounded-md bg-neutral-100 px-2.5 py-1 text-xs font-semibold text-neutral-600">
              {shortItem.segments.length} pieces
            </div>
          </div>
          <div className="mt-4 space-y-2">
            {shortItem.segments.map((segment, index) => (
              <div key={`${segment.start}-${segment.end}-${index}`} className="rounded-md border border-neutral-200 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-semibold text-neutral-900">{segment.label}</div>
                  <div className="font-mono text-xs font-semibold text-neutral-600">
                    {segment.start} - {segment.end}
                  </div>
                </div>
                {segment.excerpt ? <div className="mt-2 text-sm leading-6 text-neutral-600">{segment.excerpt}</div> : null}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function PromptBuilder({ onUsePlan, transcriptSeed, embedded = false }) {
  const [transcript, setTranscript] = useState(transcriptSeed || "");
  const [filename, setFilename] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const prompt = useMemo(() => buildChatGptPrompt(transcript), [transcript]);
  const hasTranscript = transcript.trim().length > 0;

  useEffect(() => {
    if (transcriptSeed) {
      setTranscript(transcriptSeed);
      setFilename("generated transcript");
      setCopyStatus("Generated transcript loaded. Copy the ChatGPT prompt when you're ready.");
    }
  }, [transcriptSeed]);

  async function readTranscriptFile(file) {
    if (!file) return;
    setFilename(file.name);
    setCopyStatus("");
    const text = await file.text();
    setTranscript(text);
  }

  async function copyPrompt() {
    if (!hasTranscript) {
      setCopyStatus("Add a transcript first.");
      return;
    }
    await navigator.clipboard.writeText(prompt);
    setCopyStatus("Prompt copied. Paste it into ChatGPT, then paste the returned JSON into Clip plan.");
  }

  return (
    <div className={embedded ? "" : "rounded-lg border border-neutral-300 bg-white p-5"}>
      {!embedded ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-bold text-neutral-950">
            <Clipboard size={17} />
            ChatGPT prompt builder
          </div>
          {filename ? (
            <div className="max-w-sm truncate rounded-md bg-neutral-100 px-2.5 py-1 text-xs font-semibold text-neutral-600">
              {filename}
            </div>
          ) : null}
        </div>
      ) : filename ? (
        <div className="mb-4 max-w-sm truncate rounded-md bg-neutral-100 px-2.5 py-1 text-xs font-semibold text-neutral-600">
          {filename}
        </div>
      ) : null}

      <div className={classNames("grid gap-4", embedded ? "" : "mt-4")}>
        <Field label="Transcript file">
          <input
            type="file"
            accept=".txt,.srt,.vtt,text/plain"
            onChange={(event) => readTranscriptFile(event.target.files?.[0])}
            className="block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-semibold text-neutral-800 file:mr-3 file:rounded-md file:border-0 file:bg-neutral-950 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white"
          />
        </Field>

        <Field label="Transcript text">
          <textarea
            value={transcript}
            onChange={(event) => {
              setTranscript(event.target.value);
              setCopyStatus("");
            }}
            className="min-h-36 w-full resize-y rounded-md border border-neutral-300 bg-white p-3 font-mono text-sm leading-6 text-neutral-950 outline-none transition focus:border-neutral-950"
            placeholder="Upload a transcript file, or paste the transcript here."
            spellCheck={false}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-2">
          <IconButton variant="primary" onClick={copyPrompt} disabled={!hasTranscript}>
            <Clipboard size={16} />
            Copy ChatGPT prompt
          </IconButton>
          <IconButton
            onClick={() => {
              onUsePlan("");
              setCopyStatus("Clip plan cleared. Paste ChatGPT's JSON response there.");
            }}
          >
            <FileText size={16} />
            Clear clip plan
          </IconButton>
          <div className="text-sm font-semibold text-neutral-500">
            {hasTranscript ? `${transcript.length.toLocaleString()} transcript characters` : "No transcript loaded"}
          </div>
        </div>

        {copyStatus ? (
          <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm font-semibold text-neutral-700">
            {copyStatus}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TranscriptionPanel({ videoPath, onTranscriptCreated, onBrowseTranscripts, embedded = false }) {
  const [model, setModel] = useState("Xenova/whisper-small.en");
  const [language, setLanguage] = useState("english");
  const [intervalSeconds, setIntervalSeconds] = useState("30");
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [outputs, setOutputs] = useState(null);
  const [segmentCount, setSegmentCount] = useState(0);
  const [wordCount, setWordCount] = useState(0);

  async function createTranscript() {
    setIsTranscribing(true);
    setStatus("Preparing audio and loading the local transcription model...");
    setError("");
    setOutputs(null);
    setSegmentCount(0);
    setWordCount(0);
    try {
      const payload = await api("/api/transcribe", {
        method: "POST",
        body: JSON.stringify({ videoPath, model, language, intervalSeconds: Number(intervalSeconds) || 15 }),
      });
      setOutputs(payload.outputs);
      setSegmentCount(payload.sentenceCount || payload.segmentCount || 0);
      setWordCount(payload.wordCount || 0);
      setStatus(
        `Transcript created with ${payload.sentenceCount || payload.segmentCount || 0} sentences and ${
          payload.wordCount || 0
        } word timestamps.`,
      );
      onTranscriptCreated(payload.transcriptText || "");
    } catch (nextError) {
      setError(nextError.message);
      setStatus("");
    } finally {
      setIsTranscribing(false);
    }
  }

  return (
    <div className={embedded ? "" : "rounded-lg border border-neutral-300 bg-white p-5"}>
      {!embedded ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-bold text-neutral-950">
            <Mic size={17} />
            Create transcript
          </div>
          <div className="rounded-md bg-neutral-100 px-2.5 py-1 text-xs font-semibold text-neutral-600">
            {segmentCount ? `${segmentCount} sentences / ${wordCount} words` : "Word timing"}
          </div>
        </div>
      ) : (
        <div className="mb-4 inline-flex rounded-md bg-neutral-100 px-2.5 py-1 text-xs font-semibold text-neutral-600">
          {segmentCount ? `${segmentCount} sentences / ${wordCount} words` : "Word timing"}
        </div>
      )}

      <div className={classNames("grid gap-4 md:grid-cols-3", embedded ? "" : "mt-4")}>
        <Field label="Model">
          <select
            value={model}
            onChange={(event) => setModel(event.target.value)}
            className="h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm font-semibold text-neutral-950 outline-none transition focus:border-neutral-950"
          >
            <option value="Xenova/whisper-tiny.en">Tiny English - fastest</option>
            <option value="Xenova/whisper-base.en">Base English - better</option>
            <option value="Xenova/whisper-small.en">Small English - slower</option>
          </select>
        </Field>
        <Field label="Language">
          <TextInput value={language} onChange={(event) => setLanguage(event.target.value)} />
        </Field>
        <Field label="Audio window">
          <select
            value={intervalSeconds}
            onChange={(event) => setIntervalSeconds(event.target.value)}
            className="h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm font-semibold text-neutral-950 outline-none transition focus:border-neutral-950"
          >
            <option value="15">15 seconds - tighter context</option>
            <option value="30">30 seconds - balanced</option>
            <option value="45">45 seconds - fewer chunks</option>
          </select>
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <IconButton variant="primary" onClick={createTranscript} disabled={isTranscribing || !videoPath.trim()}>
          {isTranscribing ? <LoaderCircle className="animate-spin" size={16} /> : <Mic size={16} />}
          Create transcript
        </IconButton>
        <IconButton onClick={onBrowseTranscripts}>
          <FolderOpen size={16} />
          View transcripts
        </IconButton>
        <div className="text-sm font-semibold text-neutral-500">
          {isTranscribing ? "First run may download the model." : "Exports sentence and word timing files."}
        </div>
      </div>

      {status ? (
        <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
          {status}
        </div>
      ) : null}
      {error ? (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">
          {error}
        </div>
      ) : null}
      {outputs ? (
        <div className="mt-4 space-y-2">
          {Object.entries(outputs).map(([key, value]) => (
            <div key={key} className="rounded-md border border-neutral-200 bg-neutral-50 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{key}</div>
              <div className="mt-1 truncate font-mono text-xs text-neutral-700">{value}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CandidateReview({ videoPath, transcriptSeed, onUsePlan, embedded = false }) {
  const [transcript, setTranscript] = useState(transcriptSeed || "");
  const [candidates, setCandidates] = useState([]);
  const [activeId, setActiveId] = useState("");
  const [isFinding, setIsFinding] = useState(false);
  const [isSavingCandidate, setIsSavingCandidate] = useState(false);
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);
  const [reviewHydratedKey, setReviewHydratedKey] = useState("");
  const [libraryClips, setLibraryClips] = useState([]);
  const [selectedLibraryIds, setSelectedLibraryIds] = useState([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [trimSide, setTrimSide] = useState("end");
  const [trimSeconds, setTrimSeconds] = useState("2");
  const [splitSeconds, setSplitSeconds] = useState("");

  useEffect(() => {
    if (transcriptSeed) {
      setTranscript(transcriptSeed);
      setStatus("Generated transcript loaded. Find candidates when ready.");
    }
  }, [transcriptSeed]);

  const activeCandidate = candidates.find((candidate) => candidate.id === activeId) || candidates[0] || null;
  const keptCandidates = candidates.filter((candidate) => candidate.status === "keep");
  const rejectedCount = candidates.filter((candidate) => candidate.status === "reject").length;
  const reviewStorageKey = useMemo(() => `${REVIEW_STORAGE_PREFIX}${videoPath.trim()}`, [videoPath]);

  function prepareCandidate(candidate) {
    return {
      ...candidate,
      originalStartSeconds: candidate.originalStartSeconds ?? candidate.startSeconds,
      originalEndSeconds: candidate.originalEndSeconds ?? candidate.endSeconds,
      originalStart: candidate.originalStart || candidate.start,
      originalEnd: candidate.originalEnd || candidate.end,
      originalDurationSeconds: candidate.originalDurationSeconds ?? candidate.durationSeconds,
      originalText: candidate.originalText || candidate.text,
    };
  }

  function libraryClipToCandidate(clip, index) {
    const startSeconds = Number(clip.startSeconds || 0);
    const endSeconds = Number(clip.endSeconds || startSeconds + 1);
    return prepareCandidate({
      id: `library-${index + 1}-${String(clip.savedAt || clip.libraryJsonPath || Date.now()).replace(/[^\w-]/g, "")}`,
      number: index + 1,
      title: clip.title || `Library clip ${index + 1}`,
      startSeconds,
      endSeconds,
      start: clip.start || secondsToClock(startSeconds),
      end: clip.end || secondsToClock(endSeconds),
      durationSeconds: Number(clip.durationSeconds || (endSeconds - startSeconds).toFixed(1)),
      text: clip.text || "",
      reasons: ["loaded from library"],
      score: 0,
      status: "keep",
      savedOutputs: {
        videoPath: clip.libraryVideoPath,
        textPath: clip.libraryTextPath,
        jsonPath: clip.libraryJsonPath,
      },
      sourceVideo: clip.sourceVideo || "",
    });
  }

  useEffect(() => {
    setReviewHydratedKey("");
    if (!videoPath.trim()) {
      setReviewHydratedKey(reviewStorageKey);
      return;
    }

    try {
      const raw = window.localStorage.getItem(reviewStorageKey);
      if (raw) {
        const saved = JSON.parse(raw);
        setTranscript(saved.transcript || transcriptSeed || "");
        setCandidates(Array.isArray(saved.candidates) ? saved.candidates.map(prepareCandidate) : []);
        setActiveId(saved.activeId || saved.candidates?.[0]?.id || "");
        setTrimSide(saved.trimSide || "end");
        setTrimSeconds(saved.trimSeconds || "2");
        setSplitSeconds(saved.splitSeconds || "");
        setStatus("Restored saved review work for this video.");
      } else {
        setCandidates([]);
        setActiveId("");
        if (transcriptSeed) setTranscript(transcriptSeed);
      }
    } catch {
      setStatus("Could not restore saved review work.");
    } finally {
      setReviewHydratedKey(reviewStorageKey);
    }
  }, [reviewStorageKey, videoPath, transcriptSeed]);

  useEffect(() => {
    if (reviewHydratedKey !== reviewStorageKey || !videoPath.trim()) return;
    if (!candidates.length) return;

    try {
      window.localStorage.setItem(
        reviewStorageKey,
        JSON.stringify({
          savedAt: new Date().toISOString(),
          videoPath,
          transcript,
          candidates,
          activeId,
          trimSide,
          trimSeconds,
          splitSeconds,
        }),
      );
    } catch {
      setStatus("Review work changed, but local autosave is full or unavailable.");
    }
  }, [activeId, candidates, reviewHydratedKey, reviewStorageKey, splitSeconds, transcript, trimSeconds, trimSide, videoPath]);

  async function readTranscriptFile(file) {
    if (!file) return;
    setTranscript(await file.text());
    setStatus(`${file.name} loaded.`);
    setError("");
  }

  async function findCandidates() {
    setIsFinding(true);
    setError("");
    setStatus("");
    try {
      const payload = await api("/api/candidates", {
        method: "POST",
        body: JSON.stringify({
          transcriptText: transcript,
          options: { maxCandidates: 30, minSeconds: 12, maxSeconds: 65 },
        }),
      });
      const nextCandidates = (payload.candidates || []).map(prepareCandidate);
      setCandidates(nextCandidates);
      setActiveId(nextCandidates[0]?.id || "");
      setStatus(`${nextCandidates.length} candidate moments found.`);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setIsFinding(false);
    }
  }

  async function loadLibraryClips() {
    setIsLoadingLibrary(true);
    setError("");
    try {
      const payload = await api("/api/library/clips");
      const clips = payload.clips || [];
      setLibraryClips(clips);
      const matching = videoPath.trim()
        ? clips.filter((clip) => String(clip.sourceVideo || "").toLowerCase() === videoPath.trim().toLowerCase())
        : [];
      setSelectedLibraryIds((matching.length ? matching : clips).map((clip) => clip.libraryJsonPath));
      setStatus(`${clips.length} saved clips found. ${matching.length ? `${matching.length} match this video.` : ""}`.trim());
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setIsLoadingLibrary(false);
    }
  }

  function toggleLibraryClip(clipPath) {
    setSelectedLibraryIds((current) =>
      current.includes(clipPath) ? current.filter((item) => item !== clipPath) : [...current, clipPath],
    );
  }

  function importSelectedLibraryClips() {
    const selected = libraryClips.filter((clip) => selectedLibraryIds.includes(clip.libraryJsonPath));
    if (!selected.length) {
      setError("Select at least one library clip to load.");
      return;
    }

    const nextCandidates = selected.map(libraryClipToCandidate);
    setCandidates(nextCandidates);
    setActiveId(nextCandidates[0]?.id || "");
    const firstSource = selected.find((clip) => clip.sourceVideo)?.sourceVideo;
    if (firstSource && firstSource !== videoPath) {
      setStatus(`Loaded ${nextCandidates.length} library clips. Source video: ${firstSource}`);
    } else {
      setStatus(`Loaded ${nextCandidates.length} library clips into Review.`);
    }
    setError("");
  }

  function clearSavedReview() {
    if (videoPath.trim()) {
      window.localStorage.removeItem(reviewStorageKey);
    }
    setCandidates([]);
    setActiveId("");
    setStatus("Saved review work cleared for this video.");
    setError("");
  }

  function updateCandidate(id, patch) {
    setCandidates((current) =>
      current.map((candidate) => (candidate.id === id ? { ...candidate, ...patch } : candidate)),
    );
  }

  function updateActiveText(value) {
    if (!activeCandidate) return;
    updateCandidate(activeCandidate.id, { text: value });
  }

  function markCandidate(statusValue) {
    if (!activeCandidate) return;
    updateCandidate(activeCandidate.id, { status: statusValue });
    const currentIndex = candidates.findIndex((candidate) => candidate.id === activeCandidate.id);
    const next =
      candidates.slice(currentIndex + 1).find((candidate) => candidate.status !== "reject") ||
      candidates.slice(0, currentIndex).find((candidate) => candidate.status !== "reject");
    if (next) setActiveId(next.id);
  }

  function adjustActive({ startDelta = 0, endDelta = 0 }) {
    if (!activeCandidate) return;
    const startSeconds = Math.max(0, activeCandidate.startSeconds + startDelta);
    const endSeconds = Math.max(startSeconds + 2, activeCandidate.endSeconds + endDelta);
    updateCandidate(activeCandidate.id, {
      startSeconds,
      endSeconds,
      start: secondsToClock(startSeconds),
      end: secondsToClock(endSeconds),
      durationSeconds: Number((endSeconds - startSeconds).toFixed(1)),
    });
  }

  function applyCustomTrim() {
    if (!activeCandidate) return;
    const amount = Number(trimSeconds);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Enter a trim amount greater than 0.");
      return;
    }

    const nextStart = trimSide === "beginning" ? activeCandidate.startSeconds + amount : activeCandidate.startSeconds;
    const nextEnd = trimSide === "end" ? activeCandidate.endSeconds - amount : activeCandidate.endSeconds;
    if (nextEnd - nextStart < 0.5) {
      setError("That trim would leave less than half a second.");
      return;
    }

    updateCandidate(activeCandidate.id, {
      startSeconds: nextStart,
      endSeconds: nextEnd,
      start: secondsToClock(nextStart),
      end: secondsToClock(nextEnd),
      durationSeconds: Number((nextEnd - nextStart).toFixed(1)),
    });
    setError("");
    setStatus(`Trimmed ${amount} sec from the ${trimSide}. Preview reloaded.`);
  }

  function resetActiveCandidate() {
    if (!activeCandidate) return;
    const startSeconds = activeCandidate.originalStartSeconds ?? activeCandidate.startSeconds;
    const endSeconds = activeCandidate.originalEndSeconds ?? activeCandidate.endSeconds;
    updateCandidate(activeCandidate.id, {
      startSeconds,
      endSeconds,
      start: activeCandidate.originalStart || secondsToClock(startSeconds),
      end: activeCandidate.originalEnd || secondsToClock(endSeconds),
      durationSeconds: Number((endSeconds - startSeconds).toFixed(1)),
      text: activeCandidate.originalText || activeCandidate.text,
      status: "new",
    });
    setError("");
    setStatus("Working candidate reset to its original timing and words.");
  }

  async function saveActiveCandidate() {
    if (!activeCandidate) return;
    const sourceVideo = activeCandidate.sourceVideo || videoPath;
    if (!sourceVideo.trim()) {
      setError("Add a video path before saving a clip.");
      return;
    }
    setIsSavingCandidate(true);
    setError("");
    try {
      const payload = await api("/api/library/clip", {
        method: "POST",
        body: JSON.stringify({ videoPath: sourceVideo, candidate: activeCandidate }),
      });
      updateCandidate(activeCandidate.id, {
        status: "keep",
        savedOutputs: payload.outputs,
      });
      setStatus(`Saved trimmed clip and words: ${payload.outputs?.videoPath || "clip saved"}`);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setIsSavingCandidate(false);
    }
  }

  function splitTextAtRatio(text, ratio) {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    if (words.length < 6) return [text, text];
    const splitIndex = Math.min(words.length - 2, Math.max(2, Math.round(words.length * ratio)));
    return [words.slice(0, splitIndex).join(" "), words.slice(splitIndex).join(" ")];
  }

  function splitActiveCandidate() {
    if (!activeCandidate) return;
    const offset = Number(splitSeconds);
    const duration = activeCandidate.endSeconds - activeCandidate.startSeconds;
    if (!Number.isFinite(offset) || offset <= 0 || offset >= duration) {
      setError("Enter a split second inside the current candidate.");
      return;
    }

    const splitPoint = activeCandidate.startSeconds + offset;
    if (splitPoint - activeCandidate.startSeconds < 0.5 || activeCandidate.endSeconds - splitPoint < 0.5) {
      setError("Each split part needs to be at least half a second.");
      return;
    }

    const ratio = offset / duration;
    const [firstText, secondText] = splitTextAtRatio(activeCandidate.text, ratio);
    const currentIndex = candidates.findIndex((candidate) => candidate.id === activeCandidate.id);
    const stamp = Date.now();
    const first = {
      ...prepareCandidate(activeCandidate),
      id: `${activeCandidate.id}-split-a-${stamp}`,
      title: `${activeCandidate.title} - Part 1`,
      startSeconds: activeCandidate.startSeconds,
      endSeconds: splitPoint,
      start: secondsToClock(activeCandidate.startSeconds),
      end: secondsToClock(splitPoint),
      durationSeconds: Number((splitPoint - activeCandidate.startSeconds).toFixed(1)),
      text: firstText,
      originalStartSeconds: activeCandidate.startSeconds,
      originalEndSeconds: splitPoint,
      originalStart: secondsToClock(activeCandidate.startSeconds),
      originalEnd: secondsToClock(splitPoint),
      originalDurationSeconds: Number((splitPoint - activeCandidate.startSeconds).toFixed(1)),
      originalText: firstText,
      savedOutputs: null,
      status: "new",
    };
    const second = {
      ...prepareCandidate(activeCandidate),
      id: `${activeCandidate.id}-split-b-${stamp}`,
      title: `${activeCandidate.title} - Part 2`,
      startSeconds: splitPoint,
      endSeconds: activeCandidate.endSeconds,
      start: secondsToClock(splitPoint),
      end: secondsToClock(activeCandidate.endSeconds),
      durationSeconds: Number((activeCandidate.endSeconds - splitPoint).toFixed(1)),
      text: secondText,
      originalStartSeconds: splitPoint,
      originalEndSeconds: activeCandidate.endSeconds,
      originalStart: secondsToClock(splitPoint),
      originalEnd: secondsToClock(activeCandidate.endSeconds),
      originalDurationSeconds: Number((activeCandidate.endSeconds - splitPoint).toFixed(1)),
      originalText: secondText,
      savedOutputs: null,
      status: "new",
    };

    setCandidates((current) => {
      const next = [...current.slice(0, currentIndex), first, second, ...current.slice(currentIndex + 1)];
      return next.map((candidate, index) => ({ ...candidate, number: index + 1 }));
    });
    setActiveId(first.id);
    setSplitSeconds("");
    setError("");
    setStatus("Candidate split into two reviewable parts.");
  }

  function buildPlanFromKept() {
    if (!keptCandidates.length) {
      setError("Keep at least one candidate first.");
      return;
    }
    const plan = keptCandidates
      .map(
        (candidate, index) => `Short ${index + 1} - ${candidate.title}

Use these pieces:

Approved clip
${candidate.start} - ${candidate.end}
"${candidate.text}"`,
      )
      .join("\n\n");
    onUsePlan(plan);
    setStatus(`${keptCandidates.length} kept clips copied into the clip plan.`);
    setError("");
  }

  return (
    <div className={embedded ? "" : "rounded-lg border border-neutral-300 bg-white p-5"}>
      {!embedded ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-bold text-neutral-950">
            <Scissors size={17} />
            Review candidates
          </div>
          <div className="rounded-md bg-neutral-100 px-2.5 py-1 text-xs font-semibold text-neutral-600">
            {keptCandidates.length} kept / {rejectedCount} rejected
          </div>
        </div>
      ) : (
        <div className="mb-4 inline-flex rounded-md bg-neutral-100 px-2.5 py-1 text-xs font-semibold text-neutral-600">
          {keptCandidates.length} kept / {rejectedCount} rejected
        </div>
      )}

      <div className={classNames("grid gap-4", embedded ? "" : "mt-4")}>
        <Field label="Transcript source">
          <input
            type="file"
            accept=".txt,.srt,.vtt,text/plain"
            onChange={(event) => readTranscriptFile(event.target.files?.[0])}
            className="block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-semibold text-neutral-800 file:mr-3 file:rounded-md file:border-0 file:bg-neutral-950 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white"
          />
        </Field>

        <Field label="Timestamped transcript">
          <textarea
            value={transcript}
            onChange={(event) => setTranscript(event.target.value)}
            className="min-h-32 w-full resize-y rounded-md border border-neutral-300 bg-white p-3 font-mono text-sm leading-6 text-neutral-950 outline-none transition focus:border-neutral-950"
            placeholder="Use the generated transcript, upload one, or paste timestamped transcript text here."
            spellCheck={false}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-2">
          <IconButton variant="primary" onClick={findCandidates} disabled={isFinding || !transcript.trim()}>
            {isFinding ? <LoaderCircle className="animate-spin" size={16} /> : <RefreshCw size={16} />}
            Find candidates
          </IconButton>
          <IconButton onClick={buildPlanFromKept} disabled={!keptCandidates.length}>
            <FileText size={16} />
            Use kept as clip plan
          </IconButton>
          <IconButton onClick={clearSavedReview} disabled={!videoPath.trim() && !candidates.length}>
            <Trash2 size={16} />
            Clear saved review
          </IconButton>
          <IconButton onClick={loadLibraryClips} disabled={isLoadingLibrary}>
            {isLoadingLibrary ? <LoaderCircle className="animate-spin" size={16} /> : <FolderOpen size={16} />}
            Load clip library
          </IconButton>
          <div className="text-sm font-semibold text-neutral-500">
            {candidates.length ? `${candidates.length} candidates ready` : "No candidates yet"}
          </div>
        </div>

        {libraryClips.length ? (
          <div className="rounded-lg border border-neutral-300 bg-neutral-50 p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-bold text-neutral-950">Clip library</div>
                <div className="mt-1 text-sm font-semibold text-neutral-500">
                  Select saved clips to bring back into the Review queue.
                </div>
              </div>
              <IconButton onClick={importSelectedLibraryClips} disabled={!selectedLibraryIds.length}>
                Load selected
              </IconButton>
            </div>
            <div className="mt-3 grid max-h-72 gap-2 overflow-auto md:grid-cols-2">
              {libraryClips.map((clip) => {
                const selected = selectedLibraryIds.includes(clip.libraryJsonPath);
                const matchesVideo =
                  videoPath.trim() &&
                  String(clip.sourceVideo || "").toLowerCase() === videoPath.trim().toLowerCase();
                return (
                  <label
                    key={clip.libraryJsonPath}
                    className={classNames(
                      "block rounded-md border bg-white p-3",
                      selected ? "border-neutral-950" : "border-neutral-200",
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleLibraryClip(clip.libraryJsonPath)}
                        className="mt-1 h-4 w-4 accent-neutral-950"
                      />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-bold text-neutral-950">{clip.title || "Saved clip"}</div>
                        <div className="mt-1 font-mono text-xs font-semibold text-neutral-500">
                          {clip.start} - {clip.end}
                        </div>
                        <div className="mt-2 line-clamp-2 text-xs font-semibold leading-5 text-neutral-600">
                          {clip.text}
                        </div>
                        {matchesVideo ? (
                          <div className="mt-2 inline-flex rounded-md bg-emerald-100 px-2 py-0.5 text-[11px] font-bold uppercase text-emerald-800">
                            matches current video
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        ) : null}

        {activeCandidate ? (
          <div className="grid gap-4 xl:grid-cols-[minmax(280px,0.8fr)_minmax(0,1fr)]">
            <div className="rounded-lg border border-neutral-300 bg-neutral-950 p-3">
              {videoPath.trim() || activeCandidate.sourceVideo ? (
                <video
                  key={`${activeCandidate.id}-${activeCandidate.start}-${activeCandidate.end}`}
                  src={`${API_BASE}/api/preview?path=${encodeURIComponent(
                    activeCandidate.sourceVideo || videoPath,
                  )}&start=${activeCandidate.startSeconds}&end=${activeCandidate.endSeconds}`}
                  controls
                  className="aspect-[9/16] max-h-[560px] w-full rounded-md bg-black object-contain"
                />
              ) : (
                <div className="flex aspect-[9/16] max-h-[560px] items-center justify-center rounded-md bg-black p-6 text-center text-sm font-semibold text-white/70">
                  Add a video path on the Source step to preview candidates.
                </div>
              )}
            </div>

            <div className="rounded-lg border border-neutral-300 bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                    Candidate {activeCandidate.number}
                  </div>
                  <div className="mt-1 text-base font-bold text-neutral-950">{activeCandidate.title}</div>
                </div>
                <div
                  className={classNames(
                    "rounded-md px-2.5 py-1 text-xs font-bold uppercase",
                    activeCandidate.status === "keep"
                      ? "bg-emerald-100 text-emerald-800"
                      : activeCandidate.status === "reject"
                        ? "bg-red-100 text-red-800"
                        : "bg-neutral-100 text-neutral-600",
                  )}
                >
                  {activeCandidate.status}
                </div>
              </div>

              <div className="mt-3 grid gap-2 md:grid-cols-3">
                <div className="rounded-md bg-neutral-100 p-2">
                  <div className="text-xs font-semibold uppercase text-neutral-500">Start</div>
                  <div className="mt-1 font-mono text-xs font-bold text-neutral-800">{activeCandidate.start}</div>
                </div>
                <div className="rounded-md bg-neutral-100 p-2">
                  <div className="text-xs font-semibold uppercase text-neutral-500">End</div>
                  <div className="mt-1 font-mono text-xs font-bold text-neutral-800">{activeCandidate.end}</div>
                </div>
                <div className="rounded-md bg-neutral-100 p-2">
                  <div className="text-xs font-semibold uppercase text-neutral-500">Length</div>
                  <div className="mt-1 text-xs font-bold text-neutral-800">{activeCandidate.durationSeconds} sec</div>
                </div>
              </div>

              <Field label="Words for this candidate">
                <textarea
                  value={activeCandidate.text}
                  onChange={(event) => updateActiveText(event.target.value)}
                  className="min-h-28 w-full resize-y rounded-md border border-neutral-300 bg-neutral-50 p-3 text-sm leading-6 text-neutral-900 outline-none transition focus:border-neutral-950"
                  spellCheck={false}
                />
              </Field>

              {activeCandidate.reasons?.length ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {activeCandidate.reasons.map((reason) => (
                    <span key={reason} className="rounded-md bg-blue-50 px-2 py-1 text-xs font-bold text-blue-800">
                      {reason}
                    </span>
                  ))}
                </div>
              ) : null}

              <div className="mt-4 flex flex-wrap gap-2">
                <IconButton variant="primary" onClick={() => markCandidate("keep")}>
                  <CheckCircle2 size={16} />
                  Keep
                </IconButton>
                <IconButton onClick={() => markCandidate("reject")}>
                  <Trash2 size={16} />
                  Reject
                </IconButton>
                <IconButton onClick={() => updateCandidate(activeCandidate.id, { status: "new" })}>Undo status</IconButton>
                <IconButton onClick={resetActiveCandidate}>Restart candidate</IconButton>
                <IconButton
                  variant="primary"
                  onClick={saveActiveCandidate}
                  disabled={isSavingCandidate || !(videoPath.trim() || activeCandidate.sourceVideo)}
                >
                  {isSavingCandidate ? <LoaderCircle className="animate-spin" size={16} /> : <CheckCircle2 size={16} />}
                  Save clip + words
                </IconButton>
              </div>

              {activeCandidate.savedOutputs ? (
                <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3">
                  <div className="text-xs font-bold uppercase tracking-wide text-emerald-800">Saved library item</div>
                  <div className="mt-1 truncate font-mono text-xs text-emerald-900">
                    {activeCandidate.savedOutputs.videoPath}
                  </div>
                </div>
              ) : null}

              <div className="mt-4 grid gap-2 md:grid-cols-2">
                <IconButton onClick={() => adjustActive({ startDelta: -1 })}>Extend start 1 sec</IconButton>
                <IconButton onClick={() => adjustActive({ startDelta: 1 })}>Trim start 1 sec</IconButton>
                <IconButton onClick={() => adjustActive({ endDelta: -2 })}>Too choppy: end -2 sec</IconButton>
                <IconButton onClick={() => adjustActive({ endDelta: 2 })}>Extend end 2 sec</IconButton>
                <IconButton onClick={() => adjustActive({ startDelta: -2, endDelta: 2 })} className="md:col-span-2">
                  Needs context: widen both sides
                </IconButton>
              </div>

              <div className="mt-4 rounded-lg border border-neutral-300 bg-neutral-50 p-3">
                <div className="text-sm font-bold text-neutral-950">Custom trim</div>
                <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_140px_auto]">
                  <Field label="Trim from">
                    <select
                      value={trimSide}
                      onChange={(event) => setTrimSide(event.target.value)}
                      className="h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm font-semibold text-neutral-950 outline-none transition focus:border-neutral-950"
                    >
                      <option value="end">End</option>
                      <option value="beginning">Beginning</option>
                    </select>
                  </Field>
                  <Field label="Seconds">
                    <TextInput
                      type="number"
                      min="0"
                      step="0.1"
                      value={trimSeconds}
                      onChange={(event) => setTrimSeconds(event.target.value)}
                      placeholder="1.5"
                    />
                  </Field>
                  <div className="self-end">
                    <IconButton onClick={applyCustomTrim} className="w-full">
                      Trim and reload
                    </IconButton>
                  </div>
                </div>
              </div>

              <div className="mt-4 rounded-lg border border-neutral-300 bg-neutral-50 p-3">
                <div className="text-sm font-bold text-neutral-950">Split candidate</div>
                <div className="mt-1 text-sm font-semibold text-neutral-500">
                  Split at a second mark inside this preview, measured from the current clip start.
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-[160px_auto]">
                  <Field label="Split at second">
                    <TextInput
                      type="number"
                      min="0"
                      step="0.1"
                      value={splitSeconds}
                      onChange={(event) => setSplitSeconds(event.target.value)}
                      placeholder="8.5"
                    />
                  </Field>
                  <div className="self-end">
                    <IconButton onClick={splitActiveCandidate} className="w-full">
                      Split into two candidates
                    </IconButton>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {candidates.length ? (
          <div className="grid max-h-72 gap-2 overflow-auto rounded-lg border border-neutral-300 bg-neutral-50 p-2 md:grid-cols-2">
            {candidates.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                onClick={() => setActiveId(candidate.id)}
                className={classNames(
                  "rounded-md border p-3 text-left transition",
                  activeCandidate?.id === candidate.id
                    ? "border-neutral-950 bg-white"
                    : "border-neutral-200 bg-white hover:border-neutral-400",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="truncate text-sm font-bold text-neutral-950">{candidate.title}</div>
                  <div
                    className={classNames(
                      "rounded px-1.5 py-0.5 text-[10px] font-black uppercase",
                      candidate.status === "keep"
                        ? "bg-emerald-100 text-emerald-800"
                        : candidate.status === "reject"
                          ? "bg-red-100 text-red-800"
                          : "bg-neutral-100 text-neutral-600",
                    )}
                  >
                    {candidate.status}
                  </div>
                </div>
                <div className="mt-1 font-mono text-xs font-semibold text-neutral-500">
                  {candidate.start} - {candidate.end}
                </div>
              </button>
            ))}
          </div>
        ) : null}

        {status ? (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
            {status}
          </div>
        ) : null}
        {error ? (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CtaPanel({ cta, onChange, embedded = false }) {
  function updateField(field, value) {
    onChange({ ...cta, [field]: value });
  }

  function applyPreset(value) {
    const presets = {
      readTomorrow: { title: "READ WITH ME TOMORROW", subtitle: "1 NEPHI 2" },
      followNext: { title: "FOLLOW FOR", subtitle: "THE NEXT CHAPTER" },
      custom: { title: cta.title, subtitle: cta.subtitle },
    };
    onChange({ ...cta, preset: value, ...(presets[value] || presets.custom) });
  }

  return (
    <div className={embedded ? "" : "rounded-lg border border-neutral-300 bg-white p-5"}>
      {!embedded ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-bold text-neutral-950">
            <Megaphone size={17} />
            Ending CTA
          </div>
          <label className="inline-flex items-center gap-2 text-sm font-semibold text-neutral-700">
            <input
              type="checkbox"
              checked={cta.enabled}
              onChange={(event) => updateField("enabled", event.target.checked)}
              className="h-4 w-4 accent-neutral-950"
            />
            Append to every short
          </label>
        </div>
      ) : (
        <label className="inline-flex items-center gap-2 text-sm font-semibold text-neutral-700">
          <input
            type="checkbox"
            checked={cta.enabled}
            onChange={(event) => updateField("enabled", event.target.checked)}
            className="h-4 w-4 accent-neutral-950"
          />
          Append to every short
        </label>
      )}

      <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_140px]">
        <Field label="Card style">
          <select
            value={cta.style}
            onChange={(event) => updateField("style", event.target.value)}
            className="h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm font-semibold text-neutral-950 outline-none transition focus:border-neutral-950"
          >
            <option value="image">Custom image</option>
            <option value="poster">Poster frame</option>
            <option value="minimal">Minimal black</option>
          </select>
        </Field>
        <Field label="Preset">
          <select
            value={cta.preset}
            onChange={(event) => applyPreset(event.target.value)}
            className="h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm font-semibold text-neutral-950 outline-none transition focus:border-neutral-950"
          >
            <option value="readTomorrow">Read with me tomorrow</option>
            <option value="followNext">Follow for the next chapter</option>
            <option value="custom">Custom</option>
          </select>
        </Field>
        <Field label="Duration">
          <select
            value={String(cta.durationSeconds)}
            onChange={(event) => updateField("durationSeconds", Number(event.target.value))}
            className="h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm font-semibold text-neutral-950 outline-none transition focus:border-neutral-950"
          >
            <option value="2">2 sec</option>
            <option value="3">3 sec</option>
            <option value="4">4 sec</option>
            <option value="5">5 sec</option>
          </select>
        </Field>
      </div>

      {cta.style === "image" ? (
        <div className="mt-4">
          <Field label="Image file path">
            <TextInput
              value={cta.imagePath || ""}
              onChange={(event) => updateField("imagePath", event.target.value)}
              placeholder={DEFAULT_CTA_IMAGE_PATH}
            />
          </Field>
        </div>
      ) : (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Field label="Main text">
            <TextInput value={cta.title} onChange={(event) => updateField("title", event.target.value)} />
          </Field>
          <Field label="Subtext">
            <TextInput value={cta.subtitle} onChange={(event) => updateField("subtitle", event.target.value)} />
          </Field>
        </div>
      )}

      {cta.style === "poster" ? (
        <div className="mt-4">
          <Field label="Background frame second">
            <TextInput
              type="number"
              min="0"
              step="0.5"
              value={cta.backgroundSeconds}
              onChange={(event) => updateField("backgroundSeconds", event.target.value)}
            />
          </Field>
        </div>
      ) : null}

      {cta.style === "image" ? (
        <div className="mt-4 overflow-hidden rounded-lg border border-neutral-900 bg-neutral-950 p-3 text-white">
          <div className="grid gap-3 md:grid-cols-[160px_minmax(0,1fr)] md:items-center">
            {cta.imagePath ? (
              <img
                src={`${API_BASE}/api/image?path=${encodeURIComponent(cta.imagePath)}`}
                alt="Custom CTA preview"
                className="aspect-[9/16] h-56 w-full rounded-md object-cover md:h-auto"
              />
            ) : (
              <div className="flex aspect-[9/16] h-56 items-center justify-center rounded-md bg-neutral-900 text-xs font-bold uppercase text-neutral-500 md:h-auto">
                No image
              </div>
            )}
            <div className="min-w-0">
              <div className="text-sm font-black uppercase tracking-normal text-[#38bdf8]">Custom image ending</div>
              <div className="mt-2 break-all font-mono text-xs leading-5 text-white/70">{cta.imagePath || "Add an image path"}</div>
              <div className="mt-3 text-sm font-semibold text-white/70">
                The image is scaled and center-cropped to match the short before it is appended.
              </div>
            </div>
          </div>
        </div>
      ) : (
      <div
        className={classNames(
          "mt-4 overflow-hidden rounded-lg border border-neutral-900 p-5 text-white",
          cta.style === "poster"
            ? "bg-[radial-gradient(circle_at_70%_20%,#3b3b3b,#111_45%,#050505)] text-left"
            : "bg-black text-center",
        )}
      >
        <div className={classNames("font-black uppercase leading-tight tracking-normal", cta.style === "poster" ? "text-3xl text-[#ff4b16]" : "text-xl")}>
          {cta.title || "CTA TEXT"}
        </div>
        {cta.subtitle ? (
          <div className={classNames("mt-2 font-bold uppercase", cta.style === "poster" ? "font-mono text-base text-white" : "text-sm text-white/80")}>
            {cta.subtitle}
          </div>
        ) : null}
        {cta.style === "poster" ? (
          <div className="mt-6 rounded-lg bg-neutral-800/90 p-3 text-center font-mono text-sm text-white/80">
            Watch the next chapter
            <div className="mt-2 font-sans text-xs font-black tracking-wide text-[#ff4b16]">FOLLOW • SAVE • SHARE</div>
          </div>
        ) : null}
      </div>
      )}
    </div>
  );
}

function CutPaddingPanel({ cutPadding, onChange }) {
  function updateField(field, value) {
    onChange({ ...cutPadding, [field]: field === "editStyle" ? value : Number(value) });
  }

  function applyStyle(editStyle) {
    const presets = {
      smooth: { editStyle: "smooth", startSeconds: 0.75, endSeconds: 0, mergeGapSeconds: 15 },
      precise: { editStyle: "precise", startSeconds: 0.25, endSeconds: 1.1, mergeGapSeconds: 1.5 },
      jump: { editStyle: "jump", startSeconds: 0.1, endSeconds: 0.35, mergeGapSeconds: 0 },
    };
    onChange(presets[editStyle] || presets.smooth);
  }

  return (
    <div className="mt-5 rounded-lg border border-neutral-300 bg-neutral-50 p-4">
      <div className="text-sm font-bold text-neutral-950">Cut smoothing</div>
      <div className="mt-1 text-sm font-semibold text-neutral-500">
        Adds breathing room around sentence timestamps and merges nearby pieces.
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_repeat(3,140px)]">
        <Field label="Edit style">
          <select
            value={cutPadding.editStyle}
            onChange={(event) => applyStyle(event.target.value)}
            className="h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm font-semibold text-neutral-950 outline-none transition focus:border-neutral-950"
          >
            <option value="smooth">Smooth continuous - recommended</option>
            <option value="precise">Precise sentence cuts</option>
            <option value="jump">Fast jump cuts</option>
          </select>
        </Field>
        <Field label="Before start">
          <select
            value={String(cutPadding.startSeconds)}
            onChange={(event) => updateField("startSeconds", event.target.value)}
            className="h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm font-semibold text-neutral-950 outline-none transition focus:border-neutral-950"
          >
            <option value="0">0 sec</option>
            <option value="0.25">0.25 sec</option>
            <option value="0.5">0.5 sec</option>
            <option value="0.75">0.75 sec</option>
          </select>
        </Field>
        <Field label="After end">
          <select
            value={String(cutPadding.endSeconds)}
            onChange={(event) => updateField("endSeconds", event.target.value)}
            className="h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm font-semibold text-neutral-950 outline-none transition focus:border-neutral-950"
          >
            <option value="0">0 sec</option>
            <option value="0.75">0.75 sec</option>
            <option value="1.1">1.1 sec</option>
            <option value="1.5">1.5 sec</option>
            <option value="2">2 sec</option>
          </select>
        </Field>
        <Field label="Merge gap">
          <select
            value={String(cutPadding.mergeGapSeconds)}
            onChange={(event) => updateField("mergeGapSeconds", event.target.value)}
            className="h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm font-semibold text-neutral-950 outline-none transition focus:border-neutral-950"
          >
            <option value="0">Off</option>
            <option value="1">1 sec</option>
            <option value="1.5">1.5 sec</option>
            <option value="2.5">2.5 sec</option>
            <option value="4">4 sec</option>
            <option value="15">15 sec</option>
            <option value="45">45 sec</option>
            <option value="90">90 sec</option>
          </select>
        </Field>
      </div>
    </div>
  );
}

function PublishPanel({ outputs, outputDir, onBrowse }) {
  const [caption, setCaption] = useState("Follow for the next chapter in THE BOOK OF MORMON.");
  const [hashtags, setHashtags] = useState("#BookOfMormon #ComeUntoChrist #ChristianTikTok #ScriptureStudy");
  const [copyStatus, setCopyStatus] = useState("");
  const publishItems = outputs || [];

  function captionFor(output) {
    const titleLine = output?.title ? `${output.title}\n\n` : "";
    return `${titleLine}${caption}\n\n${hashtags}`.trim();
  }

  async function copyCaption(output) {
    await navigator.clipboard.writeText(captionFor(output));
    setCopyStatus(`Caption copied for ${output?.title || "clip"}.`);
  }

  async function copyPath(output) {
    await navigator.clipboard.writeText(output?.outputPath || "");
    setCopyStatus("Video path copied.");
  }

  return (
    <div className="grid gap-5">
      <div className="rounded-lg border border-neutral-300 bg-neutral-50 p-4">
        <div className="text-sm font-bold text-neutral-950">TikTok publish prep</div>
        <div className="mt-1 text-sm font-semibold leading-6 text-neutral-600">
          This step prepares clips and captions now. Actual TikTok inbox upload comes next after OAuth/API credentials are added.
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Field label="Default caption">
            <textarea
              value={caption}
              onChange={(event) => setCaption(event.target.value)}
              className="min-h-24 w-full resize-y rounded-md border border-neutral-300 bg-white p-3 text-sm font-semibold leading-6 text-neutral-950 outline-none transition focus:border-neutral-950"
            />
          </Field>
          <Field label="Hashtags">
            <textarea
              value={hashtags}
              onChange={(event) => setHashtags(event.target.value)}
              className="min-h-24 w-full resize-y rounded-md border border-neutral-300 bg-white p-3 text-sm font-semibold leading-6 text-neutral-950 outline-none transition focus:border-neutral-950"
            />
          </Field>
        </div>
      </div>

      <div className="rounded-lg border border-neutral-300 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-bold text-neutral-950">Publish queue</div>
            <div className="mt-1 text-sm font-semibold text-neutral-500">
              {publishItems.length ? `${publishItems.length} rendered clips ready` : "Render clips first, then they will appear here."}
            </div>
          </div>
          <IconButton onClick={() => onBrowse(outputDir)}>
            <FolderOpen size={16} />
            Open output folder
          </IconButton>
        </div>

        <div className="mt-4 space-y-3">
          {publishItems.length ? (
            publishItems.map((output) => (
              <div key={output.outputPath} className="rounded-md border border-neutral-200 bg-neutral-50 p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-neutral-950">{output.title}</div>
                    <div className="mt-1 truncate font-mono text-xs text-neutral-600">{output.outputPath}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <IconButton onClick={() => copyCaption(output)}>
                      <Clipboard size={16} />
                      Copy caption
                    </IconButton>
                    <IconButton onClick={() => copyPath(output)}>
                      <Video size={16} />
                      Copy path
                    </IconButton>
                  </div>
                </div>
                <div className="mt-3 rounded-md border border-neutral-200 bg-white p-3 text-sm leading-6 text-neutral-700">
                  {captionFor(output)}
                </div>
              </div>
            ))
          ) : (
            <div className="rounded-md border border-dashed border-neutral-300 p-5 text-sm font-semibold text-neutral-500">
              No rendered outputs in this session yet.
            </div>
          )}
        </div>

        {copyStatus ? (
          <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
            {copyStatus}
          </div>
        ) : null}
      </div>

      <div className="rounded-lg border border-neutral-300 bg-white p-4">
        <div className="text-sm font-bold text-neutral-950">Needed before one-click TikTok upload</div>
        <div className="mt-3 grid gap-2 text-sm font-semibold leading-6 text-neutral-700 md:grid-cols-2">
          <div className="rounded-md bg-neutral-50 p-3">TikTok Developer app client key</div>
          <div className="rounded-md bg-neutral-50 p-3">TikTok Developer app client secret</div>
          <div className="rounded-md bg-neutral-50 p-3">Redirect URI for this local app</div>
          <div className="rounded-md bg-neutral-50 p-3">Scopes enabled: video.upload first, video.publish later</div>
          <div className="rounded-md bg-neutral-50 p-3">Your TikTok account authorized through OAuth</div>
          <div className="rounded-md bg-neutral-50 p-3">Decision: inbox upload first or audited direct post later</div>
        </div>
      </div>
    </div>
  );
}

function WizardNav({ steps, activeStep, onStepChange }) {
  return (
    <div className="rounded-lg border border-neutral-300 bg-white p-3">
      <div className="grid gap-2 md:grid-cols-7">
        {steps.map((step, index) => {
          const active = activeStep === index;
          const complete = activeStep > index;
          return (
            <button
              key={step.key}
              type="button"
              onClick={() => onStepChange(index)}
              className={classNames(
                "flex min-h-14 items-center gap-3 rounded-md border px-3 text-left transition",
                active
                  ? "border-neutral-950 bg-neutral-950 text-white"
                  : complete
                    ? "border-neutral-300 bg-neutral-100 text-neutral-950"
                    : "border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50",
              )}
            >
              <span
                className={classNames(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-black",
                  active ? "bg-white text-neutral-950" : "bg-neutral-950 text-white",
                )}
              >
                {index + 1}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-bold">{step.label}</span>
                <span className={classNames("block truncate text-xs font-semibold", active ? "text-white/65" : "text-neutral-500")}>
                  {step.caption}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function WizardFrame({ title, icon, children, activeStep, stepCount, onBack, onNext, nextLabel = "Next" }) {
  return (
    <div className="rounded-lg border border-neutral-300 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 p-5">
        <div className="flex items-center gap-2 text-sm font-bold text-neutral-950">
          {icon}
          {title}
        </div>
        <div className="rounded-md bg-neutral-100 px-2.5 py-1 text-xs font-semibold text-neutral-600">
          Step {activeStep + 1} of {stepCount}
        </div>
      </div>
      <div className="p-5">{children}</div>
      <div className="flex items-center justify-between gap-3 border-t border-neutral-200 p-4">
        <IconButton onClick={onBack} disabled={activeStep === 0}>
          Back
        </IconButton>
        <IconButton variant="primary" onClick={onNext} disabled={activeStep === stepCount - 1}>
          {nextLabel}
        </IconButton>
      </div>
    </div>
  );
}

function FileBrowser({ fsState, onBrowse, onCreateFolder, onDelete }) {
  const [folderName, setFolderName] = useState("");
  const items = fsState.payload?.items || [];
  const currentPath = fsState.payload?.path || DEFAULT_BROWSER_PATH;

  return (
    <section className="rounded-lg border border-neutral-300 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 p-4">
        <div>
          <div className="text-sm font-bold text-neutral-950">Files</div>
          <div className="mt-1 max-w-3xl truncate font-mono text-xs text-neutral-500">{currentPath}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <IconButton onClick={() => onBrowse(fsState.payload?.parent || DEFAULT_BROWSER_PATH)}>
            <FolderOpen size={16} />
            Up
          </IconButton>
          <IconButton onClick={() => onBrowse(currentPath)}>
            <RefreshCw size={16} />
            Refresh
          </IconButton>
        </div>
      </div>

      <div className="grid gap-3 border-b border-neutral-200 p-4 md:grid-cols-[minmax(0,1fr)_auto]">
        <TextInput value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder="New folder name" />
        <IconButton
          onClick={async () => {
            await onCreateFolder(currentPath, folderName);
            setFolderName("");
          }}
        >
          <Plus size={16} />
          Folder
        </IconButton>
      </div>

      <div className="max-h-80 overflow-auto">
        {fsState.error ? (
          <div className="p-4 text-sm font-semibold text-red-700">{fsState.error}</div>
        ) : items.length ? (
          <div className="divide-y divide-neutral-200">
            {items.map((item) => (
              <div key={item.path} className="grid gap-3 p-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                <button
                  type="button"
                  onClick={() => (item.type === "folder" ? onBrowse(item.path) : undefined)}
                  className="min-w-0 text-left"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="text-sm font-bold text-neutral-950">{item.type === "folder" ? "Folder" : "File"}</span>
                    <span className="truncate text-sm font-semibold text-neutral-800">{item.name}</span>
                  </div>
                  <div className="mt-1 truncate font-mono text-xs text-neutral-500">{item.path}</div>
                </button>
                <IconButton
                  disabled={!item.managed}
                  onClick={() => onDelete(item)}
                  className="justify-self-start md:justify-self-end"
                >
                  <Trash2 size={16} />
                  Delete
                </IconButton>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-4 text-sm font-semibold text-neutral-500">No files in this folder</div>
        )}
      </div>
    </section>
  );
}

export default function App() {
  const [appHydrated, setAppHydrated] = useState(false);
  const [health, setHealth] = useState({ ok: false });
  const [videoPath, setVideoPath] = useState("");
  const [outputDir, setOutputDir] = useState(DEFAULT_OUTPUT_DIR);
  const [clipPlan, setClipPlan] = useState(SAMPLE_PLAN);
  const [generatedTranscript, setGeneratedTranscript] = useState("");
  const [includeOptional, setIncludeOptional] = useState(true);
  const [cta, setCta] = useState(DEFAULT_CTA);
  const [cutPadding, setCutPadding] = useState(DEFAULT_CUT_PADDING);
  const [activeStep, setActiveStep] = useState(0);
  const [shorts, setShorts] = useState([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isParsing, setIsParsing] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const [outputs, setOutputs] = useState([]);
  const [browserPath, setBrowserPath] = useState(DEFAULT_BROWSER_PATH);
  const [fsState, setFsState] = useState({ payload: null, error: "" });

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(APP_STATE_STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        setVideoPath(saved.videoPath || "");
        setOutputDir(saved.outputDir || DEFAULT_OUTPUT_DIR);
        setClipPlan(saved.clipPlan || SAMPLE_PLAN);
        setGeneratedTranscript(saved.generatedTranscript || "");
        setIncludeOptional(saved.includeOptional !== false);
        setCta(saved.cta || DEFAULT_CTA);
        setCutPadding(saved.cutPadding || DEFAULT_CUT_PADDING);
        setOutputs(saved.outputs || []);
        setActiveStep(Number.isFinite(saved.activeStep) ? saved.activeStep : 0);
      }
    } catch {
      setMessage("Could not restore the previous app state.");
    } finally {
      setAppHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!appHydrated) return;
    try {
      window.localStorage.setItem(
        APP_STATE_STORAGE_KEY,
        JSON.stringify({
          savedAt: new Date().toISOString(),
          videoPath,
          outputDir,
          clipPlan,
          generatedTranscript,
          includeOptional,
          cta,
          cutPadding,
          outputs,
          activeStep,
        }),
      );
    } catch {
      setMessage("App state changed, but local autosave is full or unavailable.");
    }
  }, [activeStep, appHydrated, clipPlan, cta, cutPadding, generatedTranscript, includeOptional, outputDir, outputs, videoPath]);

  const selectedSegmentCount = useMemo(
    () =>
      shorts.reduce(
        (count, shortItem) => count + shortItem.segments.filter((segment) => includeOptional || segment.required).length,
        0,
      ),
    [includeOptional, shorts],
  );
  const wizardSteps = [
    { key: "source", label: "Source", caption: "Video and output" },
    { key: "transcript", label: "Transcript", caption: "Words and sentences" },
    { key: "review", label: "Review", caption: "Find good clips" },
    { key: "prompt", label: "Prompt", caption: "ChatGPT handoff" },
    { key: "plan", label: "Plan", caption: "Parse clips" },
    { key: "render", label: "Render", caption: "CTA and export" },
    { key: "publish", label: "Publish", caption: "TikTok prep" },
  ];

  function goToStep(step) {
    setActiveStep(Math.min(wizardSteps.length - 1, Math.max(0, step)));
  }

  async function refreshHealth() {
    try {
      setHealth(await api("/api/health"));
    } catch {
      setHealth({ ok: false });
    }
  }

  async function parsePlan() {
    setIsParsing(true);
    setError("");
    setMessage("");
    try {
      const payload = await api("/api/parse", {
        method: "POST",
        body: JSON.stringify({ clipPlan }),
      });
      setShorts(payload.shorts || []);
      setMessage(`${payload.shorts?.length || 0} shorts parsed`);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setIsParsing(false);
    }
  }

  async function renderClips() {
    setIsRendering(true);
    setError("");
    setMessage("");
    setOutputs([]);
    try {
      const payload = await api("/api/render", {
        method: "POST",
        body: JSON.stringify({ videoPath, outputDir, clipPlan, includeOptional, cta, cutPadding }),
      });
      setOutputs(payload.outputs || []);
      setMessage(`Rendered ${payload.outputs?.length || 0} shorts at ${payload.fps?.toFixed?.(3) || payload.fps} fps`);
      browse(outputDir);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setIsRendering(false);
    }
  }

  async function browse(path) {
    const target = path || DEFAULT_BROWSER_PATH;
    setBrowserPath(target);
    try {
      const payload = await api(`/api/fs?path=${encodeURIComponent(target)}`);
      setFsState({ payload, error: "" });
    } catch (nextError) {
      setFsState((current) => ({ ...current, error: nextError.message }));
    }
  }

  async function createFolder(parent, name) {
    if (!name.trim()) return;
    try {
      await api("/api/fs/folder", {
        method: "POST",
        body: JSON.stringify({ parent, name }),
      });
      await browse(parent);
    } catch (nextError) {
      setFsState((current) => ({ ...current, error: nextError.message }));
    }
  }

  async function deleteItem(item) {
    const confirmed = window.confirm(`Delete ${item.name}?`);
    if (!confirmed) return;
    try {
      await api("/api/fs", {
        method: "DELETE",
        body: JSON.stringify({ path: item.path, recursive: item.type === "folder" }),
      });
      await browse(fsState.payload?.path || browserPath);
    } catch (nextError) {
      setFsState((current) => ({ ...current, error: nextError.message }));
    }
  }

  useEffect(() => {
    document.title = "ShortClipper";
    refreshHealth();
    browse(DEFAULT_BROWSER_PATH);
  }, []);

  return (
    <div className="min-h-screen bg-[#f7f7f5] text-neutral-950">
      <header className="border-b border-neutral-300 bg-white">
        <div className="mx-auto flex w-full max-w-[1500px] flex-wrap items-center justify-between gap-4 px-5 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-neutral-950 text-white">
              <Scissors size={20} />
            </div>
            <div>
              <h1 className="m-0 text-xl font-bold leading-none">ShortClipper</h1>
              <div className="mt-1 text-sm font-semibold text-neutral-500">Local timestamp cutter</div>
            </div>
          </div>
          <StatusPill status={health} />
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-[1500px] gap-5 px-5 py-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(420px,0.65fr)]">
        <section className="space-y-5">
          <WizardNav steps={wizardSteps} activeStep={activeStep} onStepChange={goToStep} />

          {activeStep === 0 ? (
            <WizardFrame
              title="Source and output"
              icon={<Video size={17} />}
              activeStep={activeStep}
              stepCount={wizardSteps.length}
              onBack={() => goToStep(activeStep - 1)}
              onNext={() => goToStep(activeStep + 1)}
            >
              <div className="grid gap-4">
                <Field label="Video file path">
                  <TextInput
                    value={videoPath}
                    onChange={(event) => setVideoPath(event.target.value)}
                    placeholder="D:\Videos\my-iphone-video.mov"
                  />
                </Field>
                <Field label="Output folder">
                  <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
                    <TextInput value={outputDir} onChange={(event) => setOutputDir(event.target.value)} />
                    <IconButton onClick={() => browse(outputDir)}>
                      <FolderOpen size={16} />
                      View
                    </IconButton>
                  </div>
                </Field>
              </div>
            </WizardFrame>
          ) : null}

          {activeStep === 1 ? (
            <WizardFrame
              title="Create transcript"
              icon={<Mic size={17} />}
              activeStep={activeStep}
              stepCount={wizardSteps.length}
              onBack={() => goToStep(activeStep - 1)}
              onNext={() => goToStep(activeStep + 1)}
            >
              <TranscriptionPanel
                videoPath={videoPath}
                onTranscriptCreated={setGeneratedTranscript}
                onBrowseTranscripts={() => browse("D:\\Dylan\\projects\\ShortClipper\\outputs\\transcripts")}
                embedded
              />
            </WizardFrame>
          ) : null}

          <div className={activeStep === 2 ? "" : "hidden"}>
            <WizardFrame
              title="Review candidates"
              icon={<Scissors size={17} />}
              activeStep={activeStep}
              stepCount={wizardSteps.length}
              onBack={() => goToStep(activeStep - 1)}
              onNext={() => goToStep(activeStep + 1)}
            >
              <CandidateReview
                videoPath={videoPath}
                transcriptSeed={generatedTranscript}
                onUsePlan={async (plan) => {
                  setClipPlan(plan);
                  goToStep(4);
                  try {
                    const payload = await api("/api/parse", {
                      method: "POST",
                      body: JSON.stringify({ clipPlan: plan }),
                    });
                    setShorts(payload.shorts || []);
                    setMessage(`${payload.shorts?.length || 0} kept candidates copied into Clip plan.`);
                  } catch (nextError) {
                    setError(nextError.message);
                  }
                }}
                embedded
              />
            </WizardFrame>
          </div>

          {activeStep === 3 ? (
            <WizardFrame
              title="ChatGPT prompt"
              icon={<Clipboard size={17} />}
              activeStep={activeStep}
              stepCount={wizardSteps.length}
              onBack={() => goToStep(activeStep - 1)}
              onNext={() => goToStep(activeStep + 1)}
            >
              <PromptBuilder onUsePlan={setClipPlan} transcriptSeed={generatedTranscript} embedded />
            </WizardFrame>
          ) : null}

          {activeStep === 4 ? (
            <WizardFrame
              title="Clip plan"
              icon={<FileText size={17} />}
              activeStep={activeStep}
              stepCount={wizardSteps.length}
              onBack={() => goToStep(activeStep - 1)}
              onNext={() => goToStep(activeStep + 1)}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm font-semibold text-neutral-500">
                  {shorts.length} shorts, {selectedSegmentCount} selected pieces
                </div>
                <label className="inline-flex items-center gap-2 text-sm font-semibold text-neutral-700">
                  <input
                    type="checkbox"
                    checked={includeOptional}
                    onChange={(event) => setIncludeOptional(event.target.checked)}
                    className="h-4 w-4 accent-neutral-950"
                  />
                  Include optional pieces
                </label>
              </div>
              <textarea
                value={clipPlan}
                onChange={(event) => setClipPlan(event.target.value)}
                className="mt-4 min-h-[420px] w-full resize-y rounded-md border border-neutral-300 bg-white p-3 font-mono text-sm leading-6 text-neutral-950 outline-none transition focus:border-neutral-950"
                spellCheck={false}
              />
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <IconButton onClick={parsePlan} disabled={isParsing}>
                  {isParsing ? <LoaderCircle className="animate-spin" size={16} /> : <RefreshCw size={16} />}
                  Parse
                </IconButton>
              </div>
            </WizardFrame>
          ) : null}

          {activeStep === 5 ? (
            <WizardFrame
              title="Render shorts"
              icon={<Scissors size={17} />}
              activeStep={activeStep}
              stepCount={wizardSteps.length}
              onBack={() => goToStep(activeStep - 1)}
              onNext={() => goToStep(activeStep + 1)}
              nextLabel="Publish"
            >
              <CtaPanel cta={cta} onChange={setCta} embedded />
              <CutPaddingPanel cutPadding={cutPadding} onChange={setCutPadding} />
              <div className="mt-5 flex flex-wrap items-center gap-2">
                <IconButton variant="primary" onClick={renderClips} disabled={isRendering || !videoPath.trim()}>
                  {isRendering ? <LoaderCircle className="animate-spin" size={16} /> : <Scissors size={16} />}
                  Generate clips
                </IconButton>
                <div className="text-sm font-semibold text-neutral-500">
                  {shorts.length} shorts, {selectedSegmentCount} selected pieces
                </div>
              </div>
              {outputs.length ? (
                <div className="mt-4 space-y-2">
                  {outputs.map((output) => (
                    <div key={output.outputPath} className="rounded-md border border-neutral-200 bg-neutral-50 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-sm font-bold text-neutral-950">{output.title}</div>
                        {output.ctaAppended ? (
                          <div className="rounded-md bg-neutral-900 px-2 py-0.5 text-[11px] font-bold uppercase text-white">
                            CTA appended
                          </div>
                        ) : null}
                        {output.renderedPartCount < output.segmentCount ? (
                          <div className="rounded-md bg-emerald-100 px-2 py-0.5 text-[11px] font-bold uppercase text-emerald-800">
                            {output.segmentCount - output.renderedPartCount} cuts merged
                          </div>
                        ) : null}
                      </div>
                      <div className="mt-1 truncate font-mono text-xs text-neutral-600">{output.outputPath}</div>
                    </div>
                  ))}
                </div>
              ) : null}
            </WizardFrame>
          ) : null}

          {activeStep === 6 ? (
            <WizardFrame
              title="Publish queue"
              icon={<Megaphone size={17} />}
              activeStep={activeStep}
              stepCount={wizardSteps.length}
              onBack={() => goToStep(activeStep - 1)}
              onNext={() => goToStep(activeStep + 1)}
              nextLabel="Done"
            >
              <PublishPanel outputs={outputs} outputDir={outputDir} onBrowse={browse} />
            </WizardFrame>
          ) : null}

          {error ? (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">
              {error}
            </div>
          ) : null}
          {message ? (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
              {message}
            </div>
          ) : null}
        </section>

        <aside className="space-y-5">
          <div className="rounded-lg border border-neutral-300 bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-bold text-neutral-950">Parsed preview</div>
                <div className="mt-1 text-sm font-semibold text-neutral-500">Review the cut list before rendering.</div>
              </div>
              <IconButton onClick={parsePlan} disabled={isParsing}>
                {isParsing ? <LoaderCircle className="animate-spin" size={16} /> : <RefreshCw size={16} />}
                Update
              </IconButton>
            </div>
            <div className="mt-4">
              <ShortPreview shorts={shorts} />
            </div>
          </div>

          <div className="rounded-lg border border-neutral-300 bg-white p-4">
            <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
              <TextInput value={browserPath} onChange={(event) => setBrowserPath(event.target.value)} />
              <IconButton onClick={() => browse(browserPath)}>
                <FolderOpen size={16} />
                Browse
              </IconButton>
            </div>
          </div>

          <FileBrowser fsState={fsState} onBrowse={browse} onCreateFolder={createFolder} onDelete={deleteItem} />
        </aside>
      </main>
    </div>
  );
}
