import cors from "cors";
import express from "express";
import ffmpegPath from "ffmpeg-static";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { env, pipeline } from "@huggingface/transformers";

const PORT = Number(process.env.PORT || 8787);
const PROJECT_ROOT = path.resolve("D:\\Dylan\\projects\\ShortClipper");
const OUTPUT_ROOT = path.join(PROJECT_ROOT, "outputs");
const TEMP_ROOT = path.join(PROJECT_ROOT, "temp");
const TRANSCRIPT_ROOT = path.join(OUTPUT_ROOT, "transcripts");
const CLIP_LIBRARY_ROOT = path.join(OUTPUT_ROOT, "clip-library");
const ffprobePath = ffprobeInstaller.path;
const DEFAULT_TRANSCRIPTION_MODEL = "Xenova/whisper-tiny.en";
const DEFAULT_CTA = {
  enabled: false,
  style: "image",
  title: "READ WITH ME TOMORROW",
  subtitle: "1 NEPHI 2",
  durationSeconds: 3,
  backgroundSeconds: 2,
  imagePath: path.join(OUTPUT_ROOT, "cta-previews", "dylan-book-of-mormon-poster.png"),
};
const DEFAULT_CUT_PADDING = {
  startSeconds: 0.75,
  endSeconds: 0,
  mergeGapSeconds: 15,
  editStyle: "smooth",
};

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

await fs.mkdir(OUTPUT_ROOT, { recursive: true });
await fs.mkdir(TEMP_ROOT, { recursive: true });
await fs.mkdir(TRANSCRIPT_ROOT, { recursive: true });
await fs.mkdir(CLIP_LIBRARY_ROOT, { recursive: true });

env.allowLocalModels = false;
env.useBrowserCache = false;

const transcriberCache = new Map();

function isInsideProject(targetPath) {
  const resolved = path.resolve(targetPath);
  const relative = path.relative(PROJECT_ROOT, resolved);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function ensureNameIsSafe(name) {
  const cleaned = String(name || "").trim();
  if (!cleaned || cleaned.includes("/") || cleaned.includes("\\") || cleaned === "." || cleaned === "..") {
    throw new Error("Folder name is not valid.");
  }
  return cleaned;
}

function parseRate(value) {
  const text = String(value || "").trim();
  if (!text || text === "0/0") return 0;
  if (text.includes("/")) {
    const [numerator, denominator] = text.split("/").map(Number);
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0;
    return numerator / denominator;
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : 0;
}

function timecodeToSeconds(value, fps) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{2}):(\d{2}):(\d{2})([:.])(\d{2,3})$/);
  if (!match) throw new Error(`Invalid timestamp: ${value}`);

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const separator = match[4];
  const tail = Number(match[5]);
  const base = hours * 3600 + minutes * 60 + seconds;

  if (separator === ".") {
    return base + tail / 10 ** match[5].length;
  }
  return base + tail / fps;
}

function secondsToFfmpegTime(value) {
  return Number(value).toFixed(3);
}

function clampNumber(value, min, max, fallback) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.min(max, Math.max(min, next));
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

function secondsToSrtClock(value) {
  return secondsToClock(value).replace(".", ",");
}

function secondsToVttClock(value) {
  return secondsToClock(value);
}

function sanitizeFilePart(value, fallback) {
  const text = String(value || "")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
  return text || fallback;
}

function escapeDrawtextText(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/,/g, "\\,")
    .replace(/%/g, "\\%")
    .trim();
}

function escapeDrawtextFontPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/:/g, "\\:");
}

function normalizeCta(rawCta) {
  const cta = rawCta && typeof rawCta === "object" ? rawCta : {};
  const preset = String(cta.preset || "").trim();
  const presets = {
    readTomorrow: { title: "READ WITH ME TOMORROW", subtitle: "1 NEPHI 2" },
    followNext: { title: "FOLLOW FOR", subtitle: "THE NEXT CHAPTER" },
  };
  const selected = presets[preset] || {};
  const imagePath = String(cta.imagePath || DEFAULT_CTA.imagePath || "").trim();
  return {
    enabled: cta.enabled === true,
    style: ["image", "poster", "minimal"].includes(String(cta.style || "")) ? String(cta.style) : DEFAULT_CTA.style,
    title: String(cta.title || selected.title || DEFAULT_CTA.title).trim(),
    subtitle: String(cta.subtitle || selected.subtitle || DEFAULT_CTA.subtitle).trim(),
    durationSeconds: clampNumber(cta.durationSeconds, 1, 10, DEFAULT_CTA.durationSeconds),
    backgroundSeconds: clampNumber(cta.backgroundSeconds, 0, 36000, DEFAULT_CTA.backgroundSeconds),
    imagePath,
  };
}

function normalizeCutPadding(rawPadding) {
  const padding = rawPadding && typeof rawPadding === "object" ? rawPadding : {};
  const editStyle = ["smooth", "precise", "jump"].includes(String(padding.editStyle || ""))
    ? String(padding.editStyle)
    : DEFAULT_CUT_PADDING.editStyle;
  const defaults =
    editStyle === "jump"
      ? { startSeconds: 0.1, endSeconds: 0.35, mergeGapSeconds: 0 }
      : editStyle === "precise"
        ? { startSeconds: 0.25, endSeconds: 1.1, mergeGapSeconds: 1.5 }
        : { startSeconds: 0.75, endSeconds: 0, mergeGapSeconds: 15 };
  return {
    editStyle,
    startSeconds: clampNumber(padding.startSeconds, 0, 5, defaults.startSeconds),
    endSeconds: clampNumber(padding.endSeconds, 0, 8, defaults.endSeconds),
    mergeGapSeconds: clampNumber(padding.mergeGapSeconds, 0, 120, defaults.mergeGapSeconds),
  };
}

function normalizeSegment(segment, index) {
  return {
    label: String(segment?.label || `Segment ${index + 1}`).trim(),
    required: segment?.required !== false,
    start: String(segment?.start || "").trim(),
    end: String(segment?.end || "").trim(),
    excerpt: String(segment?.excerpt || "").trim(),
  };
}

function normalizeShort(shortItem, index) {
  const number = Number(shortItem?.number || index + 1);
  const title = String(shortItem?.title || shortItem?.suggestedTitle || `Short ${number}`).trim();
  const segments = Array.isArray(shortItem?.segments)
    ? shortItem.segments.map(normalizeSegment).filter((segment) => segment.start && segment.end)
    : [];

  return {
    number,
    title,
    coreIdea: String(shortItem?.coreIdea || "").trim(),
    strength: String(shortItem?.strength || "").trim(),
    estimatedRuntimeSeconds: Number(shortItem?.estimatedRuntimeSeconds || 0),
    segments,
  };
}

function tryParseJsonPlan(rawPlan) {
  const text = String(rawPlan || "").trim();
  if (!text) return null;

  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text.startsWith("{") ? text : null;
  if (!candidate) return null;

  try {
    const parsed = JSON.parse(candidate);
    if (!Array.isArray(parsed?.shorts)) return null;
    return parsed.shorts.map(normalizeShort).filter((shortItem) => shortItem.segments.length > 0);
  } catch {
    return null;
  }
}

function isIgnoredLabel(line) {
  return /^(use these pieces|core idea|why it works|estimated runtime|editor notes|suggested title|optional pieces|rejected ideas):?$/i.test(
    line,
  );
}

function cleanTitle(value) {
  return String(value || "")
    .trim()
    .replace(/^["“]+|["”]+$/g, "")
    .replace(/:$/, "")
    .trim();
}

function parseClipPlan(rawPlan) {
  const jsonPlan = tryParseJsonPlan(rawPlan);
  if (jsonPlan) return jsonPlan;

  const lines = String(rawPlan || "").replace(/\r\n/g, "\n").split("\n");
  const shorts = [];
  let current = null;
  let lastLabel = "";

  function startShort(number, title = "") {
    current = {
      number: Number(number || shorts.length + 1),
      title: cleanTitle(title) || `Short ${number || shorts.length + 1}`,
      coreIdea: "",
      strength: "",
      estimatedRuntimeSeconds: 0,
      segments: [],
    };
    shorts.push(current);
    lastLabel = "";
  }

  function ensureCurrentShort() {
    if (!current) startShort(shorts.length + 1);
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;

    const shortMatch = line.match(/^Short\s+(\d+)\s*(?:[-—:]\s*(.+))?$/i);
    if (shortMatch) {
      startShort(shortMatch[1], shortMatch[2] || "");
      continue;
    }

    const titleMatch = line.match(/^Suggested title:\s*(.*)$/i);
    if (titleMatch) {
      ensureCurrentShort();
      const inlineTitle = cleanTitle(titleMatch[1]);
      if (inlineTitle) {
        current.title = inlineTitle;
      } else {
        for (let j = i + 1; j < lines.length; j += 1) {
          const next = cleanTitle(lines[j]);
          if (next) {
            current.title = next;
            break;
          }
        }
      }
      continue;
    }

    const coreMatch = line.match(/^Core idea:\s*(.*)$/i);
    if (coreMatch) {
      ensureCurrentShort();
      current.coreIdea = coreMatch[1].trim();
      continue;
    }

    const rangeMatch = line.match(/(\d{2}:\d{2}:\d{2}[:.]\d{2,3})\s*-\s*(\d{2}:\d{2}:\d{2}[:.]\d{2,3})/);
    if (rangeMatch) {
      ensureCurrentShort();
      const excerptLines = [];

      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j].trim();
        if (!next) break;
        if (next.match(/^Short\s+\d+/i)) break;
        if (next.match(/(\d{2}:\d{2}:\d{2}[:.]\d{2,3})\s*-\s*(\d{2}:\d{2}:\d{2}[:.]\d{2,3})/)) break;
        excerptLines.push(next.replace(/^["“]+|["”]+$/g, ""));
      }

      const label = lastLabel && !isIgnoredLabel(lastLabel) ? lastLabel : `Segment ${current.segments.length + 1}`;
      current.segments.push({
        label,
        required: !/optional/i.test(label),
        start: rangeMatch[1],
        end: rangeMatch[2],
        excerpt: excerptLines.join(" ").trim(),
      });
      lastLabel = "";
      continue;
    }

    if (!line.startsWith('"') && !line.startsWith("“") && line.length <= 80 && !isIgnoredLabel(line)) {
      lastLabel = line.replace(/:$/, "");
    }
  }

  return shorts.filter((shortItem) => shortItem.segments.length > 0);
}

function normalizeTranscriptSegments(result) {
  const chunks = Array.isArray(result?.chunks) ? result.chunks : [];
  if (!chunks.length && result?.text) {
    return [{ start: 0, end: 0, text: String(result.text).trim() }].filter((segment) => segment.text);
  }

  return chunks
    .map((chunk) => {
      const timestamp = Array.isArray(chunk?.timestamp) ? chunk.timestamp : [chunk?.start, chunk?.end];
      const start = Number(timestamp?.[0] ?? 0);
      const end = Number(timestamp?.[1] ?? start);
      return {
        start: Number.isFinite(start) ? start : 0,
        end: Number.isFinite(end) ? end : Number.isFinite(start) ? start : 0,
        text: String(chunk?.text || "").replace(/\s+/g, " ").trim(),
      };
    })
    .filter((segment) => segment.text);
}

function parseTimestampedTranscript(transcriptText) {
  const text = String(transcriptText || "").replace(/\r\n/g, "\n");
  const pattern =
    /\[(\d{2}:\d{2}:\d{2}[:.]\d{2,3})\s*-\s*(\d{2}:\d{2}:\d{2}[:.]\d{2,3})\]\s*([\s\S]*?)(?=\n\s*\[\d{2}:\d{2}:\d{2}[:.]\d{2,3}\s*-|\s*$)/g;
  const segments = [];
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const transcript = match[3].replace(/\s+/g, " ").trim();
    if (!transcript) continue;
    const start = timecodeToSeconds(match[1], 30);
    const end = timecodeToSeconds(match[2], 30);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    segments.push({
      start,
      end,
      text: transcript,
    });
  }

  return segments;
}

function scoreCandidateText(text, durationSeconds) {
  const lower = text.toLowerCase();
  const reasons = [];
  let score = 0;

  if (durationSeconds >= 18 && durationSeconds <= 55) {
    score += 18;
    reasons.push("shorts-friendly length");
  } else if (durationSeconds >= 10 && durationSeconds <= 75) {
    score += 8;
  } else {
    score -= 20;
  }

  const signals = [
    { pattern: /\?/, points: 12, reason: "question hook" },
    { pattern: /\b(the question|what are|why|how|so you tell me)\b/, points: 10, reason: "curiosity hook" },
    { pattern: /\bprinciples?\b|\bbeliefs?\b|\baction\b|\bresults?\b|\boutcomes?\b/, points: 12, reason: "principle/action idea" },
    { pattern: /\bfaith\b|\blord\b|\bgod\b|\bchrist\b|\bmessiah\b|\btender mercies\b/, points: 12, reason: "spiritual center" },
    { pattern: /\bscripture\b|\bbook\b|\bchapter\b|\bverse\b|\bnephi\b/, points: 9, reason: "scripture reference" },
    { pattern: /\bso the principle\b|\bthe principle there is\b|\bthat means\b|\bleads to\b/, points: 14, reason: "clear takeaway" },
    { pattern: /\bovercom(e|ing)\b|\bchallenge\b|\bpositive\b|\bmighty\b|\bfilled with the spirit\b/, points: 8, reason: "emotional payoff" },
  ];

  for (const signal of signals) {
    if (signal.pattern.test(lower)) {
      score += signal.points;
      reasons.push(signal.reason);
    }
  }

  if (/^(and|but|so|then|because)\b/i.test(text.trim())) {
    score -= 4;
  }
  if (!/[.!?]"?$/.test(text.trim())) {
    score -= 8;
  }

  const uniqueReasons = [...new Set(reasons)];
  return { score, reasons: uniqueReasons.slice(0, 3) };
}

function candidateTitleFromText(text, index) {
  const clean = String(text || "")
    .replace(/^["']+|["']+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return `Candidate ${index + 1}`;

  const words = clean.split(/\s+/).slice(0, 9).join(" ");
  return words.length < clean.length ? `${words}...` : words;
}

function overlapRatio(a, b) {
  const overlap = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const shorter = Math.min(a.end - a.start, b.end - b.start);
  return shorter > 0 ? overlap / shorter : 0;
}

function findClipCandidates(transcriptText, options = {}) {
  const sentences = parseTimestampedTranscript(transcriptText);
  const maxCandidates = clampNumber(options.maxCandidates, 5, 60, 25);
  const minSeconds = clampNumber(options.minSeconds, 5, 45, 12);
  const maxSeconds = clampNumber(options.maxSeconds, 20, 90, 65);
  const rawCandidates = [];

  for (let startIndex = 0; startIndex < sentences.length; startIndex += 1) {
    let text = "";
    for (let endIndex = startIndex; endIndex < Math.min(sentences.length, startIndex + 6); endIndex += 1) {
      const start = sentences[startIndex].start;
      const end = sentences[endIndex].end;
      const durationSeconds = end - start;
      text = `${text} ${sentences[endIndex].text}`.trim();
      if (durationSeconds < minSeconds) continue;
      if (durationSeconds > maxSeconds) break;

      const { score, reasons } = scoreCandidateText(text, durationSeconds);
      rawCandidates.push({
        start,
        end,
        durationSeconds,
        text,
        score,
        reasons,
        sentenceCount: endIndex - startIndex + 1,
      });
    }
  }

  const selected = [];
  for (const candidate of rawCandidates.sort((a, b) => b.score - a.score || a.start - b.start)) {
    if (selected.some((item) => overlapRatio(item, candidate) > 0.7)) continue;
    selected.push(candidate);
    if (selected.length >= maxCandidates) break;
  }

  return selected
    .sort((a, b) => a.start - b.start)
    .map((candidate, index) => ({
      id: `candidate-${index + 1}-${Math.round(candidate.start * 1000)}`,
      number: index + 1,
      title: candidateTitleFromText(candidate.text, index),
      startSeconds: Number(candidate.start.toFixed(3)),
      endSeconds: Number(candidate.end.toFixed(3)),
      start: secondsToClock(candidate.start),
      end: secondsToClock(candidate.end),
      durationSeconds: Number(candidate.durationSeconds.toFixed(1)),
      text: candidate.text,
      score: Math.round(candidate.score),
      reasons: candidate.reasons,
      status: "new",
    }));
}

function transcriptToPromptText(segments) {
  return segments
    .map((segment) => `[${secondsToClock(segment.start)} - ${secondsToClock(segment.end)}]\n${segment.text}`)
    .join("\n\n");
}

function wordsToPromptText(words) {
  return words.map((word) => `[${secondsToClock(word.start)} - ${secondsToClock(word.end)}] ${word.text}`).join("\n");
}

function normalizeWordChunk(chunk, offsetSeconds) {
  const timestamp = Array.isArray(chunk?.timestamp) ? chunk.timestamp : [chunk?.start, chunk?.end];
  const start = Number(timestamp?.[0]);
  const end = Number(timestamp?.[1]);
  const text = String(chunk?.text || "").replace(/\s+/g, " ").trim();
  if (!text || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  return {
    start: Number((start + offsetSeconds).toFixed(3)),
    end: Number((end + offsetSeconds).toFixed(3)),
    text,
  };
}

function wordsToSentences(words) {
  const sentences = [];
  let current = [];

  function flush() {
    if (!current.length) return;
    const text = current.map((word) => word.text).join(" ").replace(/\s+([,.;:!?])/g, "$1").trim();
    if (text) {
      sentences.push({
        start: current[0].start,
        end: current[current.length - 1].end,
        text,
      });
    }
    current = [];
  }

  for (const word of words) {
    current.push(word);
    const endsSentence = /[.!?]["')\]]?$/.test(word.text);
    if (endsSentence || current.length >= 32) {
      flush();
    }
  }

  flush();
  return sentences;
}

function transcriptToSrt(segments) {
  return segments
    .map(
      (segment, index) =>
        `${index + 1}\n${secondsToSrtClock(segment.start)} --> ${secondsToSrtClock(segment.end)}\n${segment.text}`,
    )
    .join("\n\n");
}

function transcriptToVtt(segments) {
  return `WEBVTT\n\n${segments
    .map((segment) => `${secondsToVttClock(segment.start)} --> ${secondsToVttClock(segment.end)}\n${segment.text}`)
    .join("\n\n")}\n`;
}

async function extractAudioToFloat32(videoPath, runTempDir) {
  const audioPath = path.join(runTempDir, "audio-16khz-f32le.raw");
  await runCommand(ffmpegPath, [
    "-hide_banner",
    "-y",
    "-i",
    videoPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-f",
    "f32le",
    audioPath,
  ]);

  const buffer = await fs.readFile(audioPath);
  return new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
}

async function getTranscriber(model) {
  const modelName = String(model || DEFAULT_TRANSCRIPTION_MODEL).trim() || DEFAULT_TRANSCRIPTION_MODEL;
  if (!transcriberCache.has(modelName)) {
    transcriberCache.set(modelName, pipeline("automatic-speech-recognition", modelName));
  }
  return transcriberCache.get(modelName);
}

async function transcribeVideo({ videoPath, model, language, intervalSeconds = 30 }) {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runTempDir = path.join(TEMP_ROOT, `transcribe-${runId}`);
  await fs.mkdir(runTempDir, { recursive: true });

  try {
    const audio = await extractAudioToFloat32(videoPath, runTempDir);
    const transcriber = await getTranscriber(model);
    const sampleRate = 16000;
    const chunkSamples = Math.max(5, Math.min(60, Number(intervalSeconds) || 15)) * sampleRate;
    const words = [];
    const fallbackSegments = [];

    for (let offset = 0; offset < audio.length; offset += chunkSamples) {
      const endOffset = Math.min(audio.length, offset + chunkSamples);
      const chunk = audio.slice(offset, endOffset);
      const generationOptions = String(model || "").endsWith(".en")
        ? { return_timestamps: "word" }
        : {
            language: language || "english",
            task: "transcribe",
            return_timestamps: "word",
          };
      const result = await transcriber(chunk, generationOptions);
      const offsetSeconds = offset / sampleRate;
      const chunkWords = Array.isArray(result?.chunks)
        ? result.chunks.map((wordChunk) => normalizeWordChunk(wordChunk, offsetSeconds)).filter(Boolean)
        : [];

      if (chunkWords.length) {
        words.push(...chunkWords);
      }

      const text = String(result?.text || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      fallbackSegments.push({
        start: offsetSeconds,
        end: endOffset / sampleRate,
        text,
      });
    }

    const sentences = words.length ? wordsToSentences(words) : fallbackSegments;
    return { words, sentences, segments: fallbackSegments };
  } finally {
    await fs.rm(runTempDir, { recursive: true, force: true });
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(stderr || stdout || `Command failed with exit code ${code}`);
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

async function probeFrameRate(videoPath) {
  const { stdout } = await runCommand(ffprobePath, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=avg_frame_rate,r_frame_rate",
    "-of",
    "json",
    videoPath,
  ]);
  const payload = JSON.parse(stdout || "{}");
  const stream = payload?.streams?.[0] || {};
  return parseRate(stream.avg_frame_rate) || parseRate(stream.r_frame_rate) || 30;
}

async function probeVideoInfo(videoPath) {
  const { stdout } = await runCommand(ffprobePath, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,avg_frame_rate,r_frame_rate:format=duration",
    "-of",
    "json",
    videoPath,
  ]);
  const payload = JSON.parse(stdout || "{}");
  const stream = payload?.streams?.[0] || {};
  const duration = Number(payload?.format?.duration);
  return {
    width: Number(stream.width) || 1920,
    height: Number(stream.height) || 1080,
    fps: parseRate(stream.avg_frame_rate) || parseRate(stream.r_frame_rate) || 30,
    duration: Number.isFinite(duration) ? duration : null,
  };
}

function concatFileLine(filePath) {
  const normalized = filePath.replace(/\\/g, "/").replace(/'/g, "'\\''");
  return `file '${normalized}'`;
}

async function sendVideoFile({ filePath, response, contentType = "video/mp4", range }) {
  const stat = await fs.stat(filePath);
  if (!range) {
    response.writeHead(200, {
      "Content-Length": stat.size,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
    });
    fsSync.createReadStream(filePath).pipe(response);
    return;
  }

  const parts = range.replace(/bytes=/, "").split("-");
  const start = Number.parseInt(parts[0], 10);
  const end = parts[1] ? Number.parseInt(parts[1], 10) : stat.size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= stat.size) {
    response.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
    response.end();
    return;
  }

  response.writeHead(206, {
    "Content-Range": `bytes ${start}-${end}/${stat.size}`,
    "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1,
    "Content-Type": contentType,
  });
  fsSync.createReadStream(filePath, { start, end }).pipe(response);
}

async function createPreviewClip({ videoPath, startSeconds, endSeconds }) {
  const videoStats = await fs.stat(videoPath);
  const durationSeconds = Math.max(1, endSeconds - startSeconds);
  const cacheKey = crypto
    .createHash("sha1")
    .update(`${videoPath}|${videoStats.mtimeMs}|${videoStats.size}|${startSeconds.toFixed(3)}|${endSeconds.toFixed(3)}`)
    .digest("hex");
  const previewDir = path.join(TEMP_ROOT, "previews");
  const previewPath = path.join(previewDir, `${cacheKey}.mp4`);
  await fs.mkdir(previewDir, { recursive: true });

  if (fsSync.existsSync(previewPath)) {
    return previewPath;
  }

  const inProgressPath = `${previewPath}.part.mp4`;
  await runCommand(ffmpegPath, [
    "-hide_banner",
    "-y",
    "-ss",
    secondsToFfmpegTime(startSeconds),
    "-i",
    videoPath,
    "-t",
    secondsToFfmpegTime(durationSeconds),
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-vf",
    "scale='min(720,iw)':-2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    inProgressPath,
  ]);
  await fs.rename(inProgressPath, previewPath);
  return previewPath;
}

async function saveLibraryClip({ videoPath, candidate }) {
  const startSeconds = Math.max(0, Number(candidate?.startSeconds || 0));
  const endSeconds = Math.max(startSeconds + 0.5, Number(candidate?.endSeconds || startSeconds + 0.5));
  const title = String(candidate?.title || "approved clip").trim();
  const text = String(candidate?.text || "").trim();
  const clipPath = await createPreviewClip({ videoPath, startSeconds, endSeconds });
  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = sanitizeFilePart(title, "approved-clip");
  const baseName = `${now}-${slug}`;
  const outputVideoPath = path.join(CLIP_LIBRARY_ROOT, `${baseName}.mp4`);
  const outputTextPath = path.join(CLIP_LIBRARY_ROOT, `${baseName}.txt`);
  const outputJsonPath = path.join(CLIP_LIBRARY_ROOT, `${baseName}.json`);

  await fs.copyFile(clipPath, outputVideoPath);
  await fs.writeFile(outputTextPath, text, "utf8");
  await fs.writeFile(
    outputJsonPath,
    JSON.stringify(
      {
        id: candidate?.id || "",
        title,
        text,
        sourceVideo: videoPath,
        startSeconds,
        endSeconds,
        start: secondsToClock(startSeconds),
        end: secondsToClock(endSeconds),
        durationSeconds: Number((endSeconds - startSeconds).toFixed(3)),
        savedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    videoPath: outputVideoPath,
    textPath: outputTextPath,
    jsonPath: outputJsonPath,
  };
}

async function listLibraryClips() {
  const entries = await fs.readdir(CLIP_LIBRARY_ROOT, { withFileTypes: true });
  const jsonFiles = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"));
  const clips = [];

  for (const entry of jsonFiles) {
    const jsonPath = path.join(CLIP_LIBRARY_ROOT, entry.name);
    try {
      const stat = await fs.stat(jsonPath);
      const metadata = JSON.parse(await fs.readFile(jsonPath, "utf8"));
      const baseName = path.basename(entry.name, ".json");
      clips.push({
        ...metadata,
        libraryJsonPath: jsonPath,
        libraryVideoPath: path.join(CLIP_LIBRARY_ROOT, `${baseName}.mp4`),
        libraryTextPath: path.join(CLIP_LIBRARY_ROOT, `${baseName}.txt`),
        modifiedAt: stat.mtime.toISOString(),
      });
    } catch {
      // Skip malformed library entries rather than breaking the whole library view.
    }
  }

  return clips.sort((a, b) => String(b.savedAt || b.modifiedAt).localeCompare(String(a.savedAt || a.modifiedAt)));
}

async function extractCtaBackgroundFrame({ videoPath, cta, videoInfo, outputPath }) {
  const seekSeconds = videoInfo.duration
    ? Math.min(Math.max(0, cta.backgroundSeconds), Math.max(0, videoInfo.duration - 0.25))
    : Math.max(0, cta.backgroundSeconds);
  await runCommand(ffmpegPath, [
    "-hide_banner",
    "-y",
    "-ss",
    secondsToFfmpegTime(seekSeconds),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    outputPath,
  ]);
}

async function createImageCtaClip({ cta, videoInfo, outputPath }) {
  const imagePath = path.resolve(cta.imagePath || "");
  if (!imagePath || !fsSync.existsSync(imagePath)) {
    throw new Error("Custom CTA image file was not found.");
  }

  const filters = [
    `scale=${videoInfo.width}:${videoInfo.height}:force_original_aspect_ratio=increase`,
    `crop=${videoInfo.width}:${videoInfo.height}`,
    "setsar=1",
    "format=yuv420p",
  ];

  await runCommand(ffmpegPath, [
    "-hide_banner",
    "-y",
    "-loop",
    "1",
    "-framerate",
    String(videoInfo.fps),
    "-i",
    imagePath,
    "-f",
    "lavfi",
    "-i",
    "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-t",
    secondsToFfmpegTime(cta.durationSeconds),
    "-vf",
    filters.join(","),
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-r",
    String(videoInfo.fps),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    "-movflags",
    "+faststart",
    outputPath,
  ]);
}

async function createCtaClip({ cta, videoInfo, outputPath, videoPath, runTempDir }) {
  if (cta.style === "image") {
    await createImageCtaClip({ cta, videoInfo, outputPath });
    return;
  }

  const fontPath = fsSync.existsSync("C:\\Windows\\Fonts\\segoeuib.ttf")
    ? "C:\\Windows\\Fonts\\segoeuib.ttf"
    : "C:\\Windows\\Fonts\\arialbd.ttf";
  const monoFontPath = fsSync.existsSync("C:\\Windows\\Fonts\\consolab.ttf")
    ? "C:\\Windows\\Fonts\\consolab.ttf"
    : fontPath;
  const shortSide = Math.min(videoInfo.width, videoInfo.height);
  const titleFontSize = Math.max(36, Math.round(shortSide * 0.072));
  const subtitleFontSize = Math.max(28, Math.round(shortSide * 0.052));
  const gap = Math.round(shortSide * 0.05);
  const titleY = cta.subtitle
    ? `(h-text_h)/2-${Math.round(gap * 0.9)}`
    : "(h-text_h)/2";
  const subtitleY = `(h-text_h)/2+${Math.round(gap * 0.95)}`;
  const escapedFontPath = escapeDrawtextFontPath(fontPath);
  const escapedMonoFontPath = escapeDrawtextFontPath(monoFontPath);

  if (cta.style === "poster") {
    const framePath = path.join(runTempDir, `cta-background-${sanitizeFilePart(cta.title, "card")}.jpg`);
    await extractCtaBackgroundFrame({ videoPath, cta, videoInfo, outputPath: framePath });
    const posterTitleFontSize = Math.max(54, Math.round(shortSide * 0.12));
    const posterSubtitleFontSize = Math.max(30, Math.round(shortSide * 0.052));
    const panelY = Math.round(videoInfo.height * 0.72);
    const panelHeight = Math.round(videoInfo.height * 0.13);
    const panelX = Math.round(videoInfo.width * 0.08);
    const panelWidth = Math.round(videoInfo.width * 0.84);
    const filters = [
      `scale=${videoInfo.width}:${videoInfo.height}:force_original_aspect_ratio=increase`,
      `crop=${videoInfo.width}:${videoInfo.height}`,
      "hue=s=0",
      "eq=contrast=1.18:brightness=-0.11",
      "drawbox=x=0:y=0:w=iw:h=ih:color=black@0.28:t=fill",
      `drawtext=fontfile='${escapedFontPath}':text='${escapeDrawtextText(
        cta.title,
      )}':fontcolor=0xff4b16:fontsize=${posterTitleFontSize}:line_spacing=${Math.round(
        posterTitleFontSize * 0.08,
      )}:x=${Math.round(videoInfo.width * 0.08)}:y=${Math.round(videoInfo.height * 0.31)}`,
      `drawtext=fontfile='${escapedMonoFontPath}':text='${escapeDrawtextText(
        cta.subtitle,
      )}':fontcolor=white:fontsize=${posterSubtitleFontSize}:x=${Math.round(
        videoInfo.width * 0.08,
      )}:y=${Math.round(videoInfo.height * 0.52)}`,
      `drawbox=x=${panelX}:y=${panelY}:w=${panelWidth}:h=${panelHeight}:color=0x2c292c@0.88:t=fill`,
      `drawtext=fontfile='${escapedMonoFontPath}':text='${escapeDrawtextText(
        "Watch the next chapter",
      )}':fontcolor=white@0.88:fontsize=${Math.round(shortSide * 0.045)}:x=(w-text_w)/2:y=${panelY + Math.round(
        panelHeight * 0.22,
      )}`,
      `drawtext=fontfile='${escapedFontPath}':text='${escapeDrawtextText(
        "FOLLOW  •  SAVE  •  SHARE",
      )}':fontcolor=0xff4b16:fontsize=${Math.round(shortSide * 0.038)}:x=(w-text_w)/2:y=${panelY + Math.round(
        panelHeight * 0.61,
      )}`,
      "format=yuv420p",
    ];

    await runCommand(ffmpegPath, [
      "-hide_banner",
      "-y",
      "-loop",
      "1",
      "-i",
      framePath,
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-t",
      secondsToFfmpegTime(cta.durationSeconds),
      "-vf",
      filters.join(","),
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-r",
      String(videoInfo.fps),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      outputPath,
    ]);
    return;
  }

  const filters = [
    `drawtext=fontfile='${escapedFontPath}':text='${escapeDrawtextText(
      cta.title,
    )}':fontcolor=white:fontsize=${titleFontSize}:line_spacing=${Math.round(
      titleFontSize * 0.25,
    )}:x=(w-text_w)/2:y=${titleY}`,
  ];

  if (cta.subtitle) {
    filters.push(
      `drawtext=fontfile='${escapedFontPath}':text='${escapeDrawtextText(
        cta.subtitle,
      )}':fontcolor=white@0.88:fontsize=${subtitleFontSize}:x=(w-text_w)/2:y=${subtitleY}`,
    );
  }

  await runCommand(ffmpegPath, [
    "-hide_banner",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=${videoInfo.width}x${videoInfo.height}:r=${videoInfo.fps}:d=${cta.durationSeconds}`,
    "-f",
    "lavfi",
    "-i",
    "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-t",
    secondsToFfmpegTime(cta.durationSeconds),
    "-vf",
    filters.join(","),
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    outputPath,
  ]);
}

function buildRenderRanges({ segments, videoInfo, cutPadding }) {
  const ranges = segments.map((segment) => {
    const rawStart = timecodeToSeconds(segment.start, videoInfo.fps);
    const rawEnd = timecodeToSeconds(segment.end, videoInfo.fps);
    const paddedStart = Math.max(0, rawStart - cutPadding.startSeconds);
    const paddedEnd = videoInfo.duration
      ? Math.min(videoInfo.duration, rawEnd + cutPadding.endSeconds)
      : rawEnd + cutPadding.endSeconds;
    return {
      label: segment.label,
      start: paddedStart,
      end: paddedEnd,
      rawStart,
      rawEnd,
    };
  });

  const merged = [];
  for (const range of ranges) {
    if (range.end <= range.start) {
      throw new Error(`Segment "${range.label}" ends before it starts.`);
    }

    const previous = merged[merged.length - 1];
    const canMerge =
      previous &&
      range.start >= previous.start &&
      range.start - previous.end <= cutPadding.mergeGapSeconds;

    if (canMerge) {
      previous.end = Math.max(previous.end, range.end);
      previous.rawEnd = Math.max(previous.rawEnd, range.rawEnd);
      previous.label = `${previous.label} + ${range.label}`;
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}

async function renderShort({ videoPath, shortItem, outputDir, videoInfo, includeOptional, runTempDir, cta, cutPadding }) {
  const selectedSegments = shortItem.segments.filter((segment) => includeOptional || segment.required);
  if (selectedSegments.length === 0) {
    throw new Error(`${shortItem.title} has no selected segments.`);
  }
  const renderRanges = buildRenderRanges({ segments: selectedSegments, videoInfo, cutPadding });

  const segmentPaths = [];
  for (let index = 0; index < renderRanges.length; index += 1) {
    const range = renderRanges[index];
    const segmentPath = path.join(
      runTempDir,
      `short-${shortItem.number}-segment-${String(index + 1).padStart(2, "0")}.mp4`,
    );
    segmentPaths.push(segmentPath);

    await runCommand(ffmpegPath, [
      "-hide_banner",
      "-y",
      "-ss",
      secondsToFfmpegTime(range.start),
      "-to",
      secondsToFfmpegTime(range.end),
      "-i",
      videoPath,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      segmentPath,
    ]);
  }

  let ctaAppended = false;
  if (cta?.enabled) {
    const ctaPath = path.join(runTempDir, `short-${shortItem.number}-cta.mp4`);
    await createCtaClip({ cta, videoInfo, outputPath: ctaPath, videoPath, runTempDir });
    segmentPaths.push(ctaPath);
    ctaAppended = true;
  }

  const outputName = `short-${shortItem.number}-${sanitizeFilePart(shortItem.title, `short-${shortItem.number}`)}.mp4`;
  const outputPath = path.join(outputDir, outputName);

  if (segmentPaths.length === 1) {
    await fs.copyFile(segmentPaths[0], outputPath);
  } else {
    const listPath = path.join(runTempDir, `short-${shortItem.number}-concat.txt`);
    await fs.writeFile(listPath, segmentPaths.map(concatFileLine).join(os.EOL), "utf8");
    await runCommand(ffmpegPath, [
      "-hide_banner",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      outputPath,
    ]);
  }

  return {
    number: shortItem.number,
    title: shortItem.title,
    outputPath,
    segmentCount: selectedSegments.length,
    renderedPartCount: renderRanges.length,
    ctaAppended,
  };
}

async function listDirectory(targetPath) {
  const resolved = path.resolve(targetPath || PROJECT_ROOT);
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const items = await Promise.all(
    entries.map(async (entry) => {
      const itemPath = path.join(resolved, entry.name);
      const stats = await fs.stat(itemPath);
      return {
        name: entry.name,
        path: itemPath,
        type: entry.isDirectory() ? "folder" : "file",
        size: entry.isDirectory() ? null : stats.size,
        modifiedAt: stats.mtime.toISOString(),
        managed: isInsideProject(itemPath),
      };
    }),
  );

  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    path: resolved,
    parent: path.dirname(resolved),
    managed: resolved === PROJECT_ROOT || isInsideProject(resolved),
    projectRoot: PROJECT_ROOT,
    outputRoot: OUTPUT_ROOT,
    items,
  };
}

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    projectRoot: PROJECT_ROOT,
    outputRoot: OUTPUT_ROOT,
    tempRoot: TEMP_ROOT,
    transcriptRoot: TRANSCRIPT_ROOT,
    clipLibraryRoot: CLIP_LIBRARY_ROOT,
    defaultTranscriptionModel: DEFAULT_TRANSCRIPTION_MODEL,
    ffmpegReady: Boolean(ffmpegPath && fsSync.existsSync(ffmpegPath)),
    ffprobeReady: Boolean(ffprobePath && fsSync.existsSync(ffprobePath)),
  });
});

app.get("/api/image", (request, response) => {
  const imagePath = path.resolve(String(request.query.path || ""));
  const allowedExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);
  if (!imagePath || !fsSync.existsSync(imagePath) || !allowedExtensions.has(path.extname(imagePath).toLowerCase())) {
    return response.status(404).json({ message: "Image file was not found." });
  }
  return response.sendFile(imagePath);
});

app.get("/api/video", async (request, response) => {
  const videoPath = path.resolve(String(request.query.path || ""));
  if (!videoPath || !fsSync.existsSync(videoPath)) {
    return response.status(404).json({ message: "Video file was not found." });
  }

  const contentType = path.extname(videoPath).toLowerCase() === ".mov" ? "video/quicktime" : "video/mp4";
  return sendVideoFile({ filePath: videoPath, response, contentType, range: request.headers.range });
});

app.get("/api/preview", async (request, response) => {
  try {
    const videoPath = path.resolve(String(request.query.path || ""));
    const startSeconds = Math.max(0, Number(request.query.start || 0));
    const endSeconds = Math.max(startSeconds + 1, Number(request.query.end || startSeconds + 1));
    if (!videoPath || !fsSync.existsSync(videoPath)) {
      return response.status(404).json({ message: "Video file was not found." });
    }
    const previewPath = await createPreviewClip({ videoPath, startSeconds, endSeconds });
    return sendVideoFile({ filePath: previewPath, response, contentType: "video/mp4", range: request.headers.range });
  } catch (error) {
    return response.status(500).json({ message: error.message || "Preview failed." });
  }
});

app.post("/api/parse", (request, response) => {
  const shorts = parseClipPlan(request.body?.clipPlan || "");
  response.json({ shorts });
});

app.post("/api/candidates", (request, response) => {
  const candidates = findClipCandidates(request.body?.transcriptText || "", request.body?.options || {});
  response.json({ candidates, count: candidates.length });
});

app.get("/api/library/clips", async (_request, response) => {
  try {
    const clips = await listLibraryClips();
    return response.json({ clips, count: clips.length, libraryRoot: CLIP_LIBRARY_ROOT });
  } catch (error) {
    return response.status(500).json({ message: error.message || "Could not load clip library." });
  }
});

app.post("/api/library/clip", async (request, response) => {
  try {
    const videoPath = path.resolve(String(request.body?.videoPath || ""));
    if (!videoPath || !fsSync.existsSync(videoPath)) {
      return response.status(400).json({ message: "Video file was not found." });
    }
    const outputs = await saveLibraryClip({ videoPath, candidate: request.body?.candidate || {} });
    return response.json({ ok: true, outputs, libraryRoot: CLIP_LIBRARY_ROOT });
  } catch (error) {
    return response.status(500).json({ message: error.message || "Could not save clip." });
  }
});

app.post("/api/render", async (request, response) => {
  try {
    const videoPath = path.resolve(String(request.body?.videoPath || ""));
    const outputDir = path.resolve(String(request.body?.outputDir || OUTPUT_ROOT));
    const includeOptional = request.body?.includeOptional !== false;
    const cta = normalizeCta(request.body?.cta);
    const cutPadding = normalizeCutPadding(request.body?.cutPadding);
    const shorts = parseClipPlan(request.body?.clipPlan || "");

    if (!videoPath || !fsSync.existsSync(videoPath)) {
      return response.status(400).json({ message: "Video file was not found." });
    }
    if (!shorts.length) {
      return response.status(400).json({ message: "No clip segments were found in the plan." });
    }

    await fs.mkdir(outputDir, { recursive: true });
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const runTempDir = path.join(TEMP_ROOT, runId);
    await fs.mkdir(runTempDir, { recursive: true });

    const videoInfo = await probeVideoInfo(videoPath);
    const outputs = [];

    for (const shortItem of shorts) {
      outputs.push(
        await renderShort({ videoPath, shortItem, outputDir, videoInfo, includeOptional, runTempDir, cta, cutPadding }),
      );
    }

    await fs.rm(runTempDir, { recursive: true, force: true });
    response.json({ outputs, fps: videoInfo.fps, videoInfo, cta, cutPadding });
  } catch (error) {
    response.status(500).json({ message: error.message || "Render failed." });
  }
});

app.post("/api/transcribe", async (request, response) => {
  try {
    const videoPath = path.resolve(String(request.body?.videoPath || ""));
    const model = String(request.body?.model || DEFAULT_TRANSCRIPTION_MODEL).trim() || DEFAULT_TRANSCRIPTION_MODEL;
    const language = String(request.body?.language || "english").trim() || "english";
    const intervalSeconds = Math.max(10, Math.min(60, Number(request.body?.intervalSeconds || 30)));

    if (!videoPath || !fsSync.existsSync(videoPath)) {
      return response.status(400).json({ message: "Video file was not found." });
    }

    const transcript = await transcribeVideo({ videoPath, model, language, intervalSeconds });
    const sentences = transcript.sentences || [];
    const words = transcript.words || [];
    const segments = transcript.segments || [];
    if (!sentences.length) {
      return response.status(500).json({ message: "Transcription finished, but no transcript text was produced." });
    }

    const videoBaseName = sanitizeFilePart(path.basename(videoPath, path.extname(videoPath)), "transcript");
    const outputBase = `${videoBaseName}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const jsonPath = path.join(TRANSCRIPT_ROOT, `${outputBase}.json`);
    const txtPath = path.join(TRANSCRIPT_ROOT, `${outputBase}.txt`);
    const sentenceTxtPath = path.join(TRANSCRIPT_ROOT, `${outputBase}.sentences.txt`);
    const wordsTxtPath = path.join(TRANSCRIPT_ROOT, `${outputBase}.words.txt`);
    const sentencesJsonPath = path.join(TRANSCRIPT_ROOT, `${outputBase}.sentences.json`);
    const wordsJsonPath = path.join(TRANSCRIPT_ROOT, `${outputBase}.words.json`);
    const srtPath = path.join(TRANSCRIPT_ROOT, `${outputBase}.srt`);
    const vttPath = path.join(TRANSCRIPT_ROOT, `${outputBase}.vtt`);
    const promptText = transcriptToPromptText(sentences);
    const wordsText = wordsToPromptText(words);
    const plainText = sentences.map((segment) => segment.text).join(" ");

    await fs.writeFile(
      jsonPath,
      JSON.stringify(
        {
          sourceVideo: videoPath,
          model,
          language,
          intervalSeconds,
          createdAt: new Date().toISOString(),
          words,
          sentences,
          segments,
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(txtPath, promptText, "utf8");
    await fs.writeFile(sentenceTxtPath, promptText, "utf8");
    await fs.writeFile(wordsTxtPath, wordsText, "utf8");
    await fs.writeFile(sentencesJsonPath, JSON.stringify(sentences, null, 2), "utf8");
    await fs.writeFile(wordsJsonPath, JSON.stringify(words, null, 2), "utf8");
    await fs.writeFile(srtPath, transcriptToSrt(sentences), "utf8");
    await fs.writeFile(vttPath, transcriptToVtt(sentences), "utf8");

    response.json({
      model,
      language,
      intervalSeconds,
      segmentCount: sentences.length,
      sentenceCount: sentences.length,
      wordCount: words.length,
      transcriptText: promptText,
      plainText,
      outputs: {
        jsonPath,
        txtPath,
        sentenceTxtPath,
        wordsTxtPath,
        sentencesJsonPath,
        wordsJsonPath,
        srtPath,
        vttPath,
      },
    });
  } catch (error) {
    response.status(500).json({ message: error.message || "Transcription failed." });
  }
});

app.get("/api/fs", async (request, response) => {
  try {
    response.json(await listDirectory(String(request.query.path || PROJECT_ROOT)));
  } catch (error) {
    response.status(400).json({ message: error.message || "Could not list folder." });
  }
});

app.post("/api/fs/folder", async (request, response) => {
  try {
    const parent = path.resolve(String(request.body?.parent || PROJECT_ROOT));
    const name = ensureNameIsSafe(request.body?.name);
    const target = path.join(parent, name);
    if (!isInsideProject(target)) {
      return response.status(403).json({ message: "Create is restricted to the ShortClipper project folder." });
    }
    await fs.mkdir(target, { recursive: false });
    response.json({ ok: true, item: target });
  } catch (error) {
    response.status(400).json({ message: error.message || "Could not create folder." });
  }
});

app.delete("/api/fs", async (request, response) => {
  try {
    const target = path.resolve(String(request.body?.path || ""));
    if (!isInsideProject(target)) {
      return response.status(403).json({ message: "Delete is restricted to the ShortClipper project folder." });
    }
    await fs.rm(target, { recursive: Boolean(request.body?.recursive), force: false });
    response.json({ ok: true });
  } catch (error) {
    response.status(400).json({ message: error.message || "Could not delete item." });
  }
});

app.listen(PORT, () => {
  console.log(`ShortClipper backend listening on http://localhost:${PORT}`);
});
