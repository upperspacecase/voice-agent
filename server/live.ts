// WebSocket relay: browser <-> Node <-> Gemini Live API.
// One browser WS = one Gemini Live session. Transcript turns stream to
// Firestore as they arrive. Report generation lives in the local skill
// pipeline (see CLAUDE.md), NOT here — this server's job ends at flushing
// the transcript and recording call end timestamps.

import { config as loadDotenv } from "dotenv";
// Prefer .env.local (Next convention); fall back to .env.
loadDotenv({ path: ".env.local" });
loadDotenv();

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { nanoid } from "nanoid";
import {
  GoogleGenAI,
  Modality,
  type Session,
  type LiveServerMessage,
} from "@google/genai";
import { randomUUID } from "crypto";
import twilio from "twilio";
import { TOOL_DECLARATIONS } from "./tools.js";
import { TranscriptBuffer } from "./firestore-writer.js";
import { mulaw8kToPcm16k, pcm24kToMulaw8k } from "./audio.js";
import { finalizeAssessment } from "../lib/finalize.js";
import { verifyVoiceSessionToken } from "../lib/voice-token.js";
import { adminDb } from "../lib/firebase-admin.js";
import {
  getActivePrompt,
  getPrompt,
  toSnapshot,
  type PromptSnapshot,
} from "../lib/prompts.js";
import { getWorkflow } from "../lib/taxonomy.js";
import { FieldValue } from "firebase-admin/firestore";

const PORT = Number(process.env.LIVE_WS_PORT ?? 3043);

function escapeForBracketText(input: string): string {
  return input.replace(/["\\\]]/g, " ").replace(/\s+/g, " ").trim();
}

function buildKickoffText(
  firstName: string | null,
  businessName: string | null,
  workflowLabel: string | null,
): string {
  const safeName = firstName ? escapeForBracketText(firstName) : "";
  const safeBiz = businessName ? escapeForBracketText(businessName) : "";
  const parts: string[] = ["The user is now connected."];
  if (safeName && safeBiz) {
    parts.push(
      `Their first name is "${safeName}" and they are from "${safeBiz}". Greet them by name and skip asking for their name.`,
    );
  } else if (safeName) {
    parts.push(
      `Their first name is "${safeName}". Greet them by name and skip asking for their name.`,
    );
  }
  if (workflowLabel) {
    parts.push(
      `On the form they chose the workflow "${escapeForBracketText(workflowLabel)}" as the one costing them most — that is the sole focus of this call.`,
    );
  }
  parts.push("Begin Phase 0 of your contract.");
  return `[${parts.join(" ")}]`;
}

if (!process.env.GEMINI_API_KEY) {
  console.error("[SERVER] GEMINI_API_KEY missing — aborting");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Only needed to hang up the PSTN leg when the agent ends the interview.
// Absent in local browser-only development, so keep it optional. Supports
// API-key auth (TWILIO_API_KEY/TWILIO_API_SECRET) so the server never needs
// the account auth token, with auth-token auth as the fallback.
const twilioClient =
  process.env.TWILIO_API_KEY && process.env.TWILIO_API_SECRET && process.env.TWILIO_ACCOUNT_SID
    ? twilio(process.env.TWILIO_API_KEY, process.env.TWILIO_API_SECRET, {
        accountSid: process.env.TWILIO_ACCOUNT_SID,
      })
    : process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
      ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
      : null;

// ------- HTTP server (health only) -------

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...corsHeaders,
  });
  res.end(JSON.stringify(body));
}

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "not_found" });
});

// ------- WebSocket server -------

const wss = new WebSocketServer({ server: httpServer });

type ClientToServer =
  | { type: "start"; language?: string }
  | { type: "audio"; data: string } // base64 PCM16 16k LE
  | { type: "text"; text: string }
  | { type: "end" }; // user hit End-call

type ServerToClient =
  | { type: "session"; id: string }
  | { type: "ready" }
  | { type: "audio"; data: string } // base64 PCM16 24k LE
  | { type: "transcript"; who: "agent" | "user"; text: string }
  | { type: "interrupted" }
  | { type: "turn_complete" }
  | { type: "language"; language: string }
  | { type: "end_signal"; reason: string } // model called end_interview tool
  | { type: "error"; message: string };

function send(ws: WebSocket, msg: ServerToClient) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

wss.on("connection", async (ws, req) => {
  const sessionId = nanoid(12);
  let liveSession: Session | null = null;
  let endTriggered = false;
  let kickoffSent = false;
  let audioFramesFromClient = 0;
  let audioFramesToGemini = 0;
  let audioFramesFromGemini = 0;

  let assessmentId: string | null = null;
  let shareId: string | null = null;
  let voiceSessionUuid: string | null = null;
  let currentSessionHandle = "";
  let transcriptBuffer: TranscriptBuffer | null = null;
  let promptSnapshot: PromptSnapshot | null = null;
  let callerFirstName: string | null = null;
  let callerBusinessName: string | null = null;
  let callerWorkflowLabel: string | null = null;
  const clientConnectedAtMs = Date.now();

  const reqUrl = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // Two transports share this handler. The browser widget connects to "/" and
  // carries its token in the query string. Twilio Media Streams connect to
  // "/media" and deliver the token in the `start` event's customParameters,
  // which lands a few ms after the socket opens — hence the deferred token.
  const isTwilio = reqUrl.pathname === "/media";
  let resolveToken!: (t: string | null) => void;
  const tokenPromise = new Promise<string | null>((r) => {
    resolveToken = r;
  });
  if (!isTwilio) resolveToken(reqUrl.searchParams.get("token"));

  // Twilio-only call state.
  let streamSid: string | null = null;
  let callSid: string | null = null;
  const pendingMulaw: Buffer[] = [];
  // Latency instrumentation: how long after the caller picks up before they
  // hear anything, and how long each of their turns waits for a reply.
  let twilioStartMs = 0;
  let firstAudioLogged = false;
  let lastUserAudioMs = 0;
  let awaitingReply = false;

  console.log(
    `[SERVER] WS opened session=${sessionId} transport=${isTwilio ? "twilio" : "browser"}`,
  );

  // The browser widget's JSON protocol means nothing to Twilio's socket, so
  // swallow those frames there. Audio and barge-in have real Twilio
  // equivalents and are handled separately below.
  const notify = (msg: ServerToClient) => {
    if (!isTwilio) send(ws, msg);
  };

  // Gemini emits PCM16 24k; Twilio wants base64 μ-law 8k wrapped in a media
  // envelope. Frames can arrive before Twilio's `start` gives us a streamSid,
  // so hold them until it does.
  const sendAudioOut = (base64Pcm24k: string) => {
    if (!isTwilio) {
      send(ws, { type: "audio", data: base64Pcm24k });
      return;
    }
    if (!firstAudioLogged && twilioStartMs) {
      firstAudioLogged = true;
      console.log(`[LATENCY] greeting session=${sessionId} ${Date.now() - twilioStartMs}ms after start`);
    }
    if (awaitingReply && lastUserAudioMs) {
      awaitingReply = false;
      console.log(`[LATENCY] reply session=${sessionId} ${Date.now() - lastUserAudioMs}ms after caller stopped`);
    }
    const mulaw = pcm24kToMulaw8k(Buffer.from(base64Pcm24k, "base64"));
    if (!streamSid) {
      pendingMulaw.push(mulaw);
      return;
    }
    ws.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: mulaw.toString("base64") },
      }),
    );
  };

  const flushPendingAudio = () => {
    if (!streamSid || pendingMulaw.length === 0) return;
    console.log(
      `[TWILIO] flushing ${pendingMulaw.length} buffered audio frames session=${sessionId}`,
    );
    for (const mulaw of pendingMulaw.splice(0)) {
      ws.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: mulaw.toString("base64") },
        }),
      );
    }
  };

  // Barge-in: drop audio Twilio has buffered but not yet played.
  const clearPlayback = () => {
    if (isTwilio && streamSid) {
      ws.send(JSON.stringify({ event: "clear", streamSid }));
    }
  };

  // Kick off async setup (token verify + active prompt fetch + Firestore
  // writes) but DO NOT await it here — message and close listeners must be
  // registered synchronously so the client's `start` message isn't lost
  // during the setup window.
  let setupRejected: string | null = null;
  const setupPromise = (async () => {
    // Active prompt is required for any session — tokenized or not. Without
    // it we have nothing to send to Gemini, so fail closed.
    try {
      const activePrompt = await getActivePrompt();
      if (!activePrompt) {
        setupRejected = "no_active_prompt";
        console.error(
          `[SERVER] session=${sessionId} no active prompt configured — closing`,
        );
        notify({ type: "error", message: "no_active_prompt" });
        try { ws.close(1011, "no_active_prompt"); } catch {}
        return;
      }
      promptSnapshot = toSnapshot(activePrompt);
      console.log(
        `[SERVER] session=${sessionId} active prompt=${promptSnapshot.id} name=${JSON.stringify(promptSnapshot.name)} voice=${promptSnapshot.voice} model=${promptSnapshot.model}`,
      );
    } catch (e) {
      setupRejected = e instanceof Error ? e.message : String(e);
      console.error(`[SERVER] session=${sessionId} active prompt fetch failed:`, setupRejected);
      notify({ type: "error", message: "prompt_fetch_failed" });
      try { ws.close(1011, "prompt_fetch_failed"); } catch {}
      return;
    }

    // Browser resolves this synchronously; Twilio resolves it on `start`.
    // The active-prompt fetch above runs in parallel with that wait.
    const token = await tokenPromise;

    if (!token) {
      console.warn(
        `[SERVER] session=${sessionId} no token — Firestore writes disabled`,
      );
      return;
    }
    try {
      const payload = await verifyVoiceSessionToken(token);
      assessmentId = payload.assessmentId;
      shareId = payload.shareId;
      voiceSessionUuid = randomUUID();
      currentSessionHandle = voiceSessionUuid;
      transcriptBuffer = new TranscriptBuffer(assessmentId);
      transcriptBuffer.startAutoFlush(500);
      console.log(
        `[SERVER] session=${sessionId} verified assessment=${assessmentId} share=${shareId}`,
      );
    } catch (e) {
      setupRejected = e instanceof Error ? e.message : String(e);
      console.warn(`[SERVER] session=${sessionId} invalid token: ${setupRejected}`);
      try { ws.close(4401, "invalid_token"); } catch {}
      return;
    }
    try {
      const docRef = adminDb().collection("assessments").doc(assessmentId!);
      const docSnap = await docRef.get();
      const docData = docSnap.data() ?? {};
      const fn = docData.firstName;
      const bn = docData.businessName;
      callerFirstName = typeof fn === "string" && fn.trim().length > 0 ? fn.trim() : null;
      callerBusinessName = typeof bn === "string" && bn.trim().length > 0 ? bn.trim() : null;

      // PRD free calls focus on one pre-selected workflow and run a
      // dedicated prompt (config/global.freeCallPromptId). Whole-operation
      // calls keep the globally active prompt.
      const selected = Array.isArray(docData.selectedWorkflows)
        ? (docData.selectedWorkflows[0] as string | undefined)
        : undefined;
      if (docData.tier === "free" && selected) {
        callerWorkflowLabel = getWorkflow(selected)?.label ?? null;
        const cfg = await adminDb().collection("config").doc("global").get();
        const freeId = cfg.data()?.freeCallPromptId;
        if (typeof freeId === "string" && freeId.length > 0) {
          const freePrompt = await getPrompt(freeId);
          if (freePrompt) {
            promptSnapshot = toSnapshot(freePrompt);
            console.log(
              `[SERVER] session=${sessionId} using free-call prompt=${promptSnapshot.id} workflow=${selected}`,
            );
          }
        }
      }

      await docRef.update({
        voiceSessionId: voiceSessionUuid,
        callStartedAt: FieldValue.serverTimestamp(),
        promptUsed: promptSnapshot,
      });
      console.log(
        `[FIRESTORE] assessment marked in_call assessment=${assessmentId} voiceSessionId=${voiceSessionUuid} promptId=${promptSnapshot.id} firstName=${callerFirstName ? "yes" : "no"} businessName=${callerBusinessName ? "yes" : "no"}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `[FIRESTORE] connect-time update failed assessment=${assessmentId}:`,
        msg,
      );
    }
  })();

  notify({ type: "session", id: sessionId });

  const endCall = (reason: string) => {
    if (endTriggered) return;
    endTriggered = true;
    notify({ type: "end_signal", reason });

    // On the phone there is no UI to close the call, so hang up the PSTN leg.
    // Delay it so the agent's spoken goodbye finishes playing first — audio
    // already handed to Twilio is still in flight.
    if (isTwilio && callSid && twilioClient) {
      const sid = callSid;
      setTimeout(() => {
        twilioClient.calls(sid).update({ status: "completed" }).then(
          () => console.log(`[TWILIO] hung up call=${sid} reason=${reason}`),
          (e) => console.error(`[TWILIO] hangup failed call=${sid}:`, e),
        );
      }, 2500);
    }

    try {
      liveSession?.close();
    } catch {
      /* ignore */
    }
  };

  let reconnecting = false;
  const reconnectWithResume = async () => {
    if (reconnecting || endTriggered) return;
    if (!currentSessionHandle) {
      console.warn(
        `[GEMINI-LIVE] goAway but no resume handle yet session=${sessionId} — letting call drop`,
      );
      return;
    }
    reconnecting = true;
    try {
      console.log(
        `[GEMINI-LIVE] reconnecting with resume handle session=${sessionId}`,
      );
      await openLive(currentSessionHandle);
    } finally {
      reconnecting = false;
    }
  };

  const openLive = async (resumeHandle?: string) => {
    if (!promptSnapshot) {
      const msg = "no_active_prompt";
      console.error(`[GEMINI-LIVE] openLive without prompt session=${sessionId}`);
      notify({ type: "error", message: msg });
      return;
    }
    const snapshot = promptSnapshot;
    const systemInstruction = snapshot.persona.trim()
      ? `${snapshot.persona.trim()}\n\n---\n\n${snapshot.prompt}`
      : snapshot.prompt;
    try {
      console.log(
        `[GEMINI-LIVE] open session=${sessionId} promptId=${snapshot.id} model=${snapshot.model} voice=${snapshot.voice} personaChars=${snapshot.persona.length} promptChars=${snapshot.prompt.length} resume=${resumeHandle ? "yes" : "no"}`,
      );
      let myReconnectTriggered = false;
      const newSession = await ai.live.connect({
        model: snapshot.model,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: snapshot.voice } },
          },
          // The 2.5 native-audio model enables dynamic thinking by default,
          // which puts a pause before every spoken reply. On a phone call that
          // reads as lag, so turn it off. (3.1 already defaults to minimal.)
          thinkingConfig: { thinkingBudget: 0 },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
          sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
        },
        callbacks: {
          onopen: () => {
            console.log(
              `[GEMINI-LIVE] open session=${sessionId} resume=${resumeHandle ? "yes" : "no"}`,
            );
            if (!resumeHandle) notify({ type: "ready" });
          },
          onmessage: async (msg: LiveServerMessage) => {
            // Debug: surface the shape of every non-audio message.
            const summary = {
              setupComplete: !!msg.setupComplete,
              hasModelTurn: !!msg.serverContent?.modelTurn,
              modelTurnParts: msg.serverContent?.modelTurn?.parts?.length ?? 0,
              input: !!msg.serverContent?.inputTranscription,
              output: !!msg.serverContent?.outputTranscription,
              interrupted: !!msg.serverContent?.interrupted,
              turnComplete: !!msg.serverContent?.turnComplete,
              toolCall: !!msg.toolCall,
              goAway: !!msg.goAway,
            };
            if (
              summary.setupComplete ||
              summary.input ||
              summary.output ||
              summary.turnComplete ||
              summary.toolCall ||
              summary.goAway
            ) {
              console.log(
                `[GEMINI-LIVE] msg session=${sessionId}`,
                JSON.stringify(summary)
              );
            }

            const newHandle = (
              msg as LiveServerMessage & {
                sessionResumptionUpdate?: { newHandle?: string };
              }
            ).sessionResumptionUpdate?.newHandle;
            if (newHandle && assessmentId) {
              currentSessionHandle = newHandle;
              try {
                await adminDb()
                  .collection("assessments")
                  .doc(assessmentId)
                  .update({
                    voiceSessionHandles: FieldValue.arrayUnion(newHandle),
                  });
              } catch (e) {
                const errMsg = e instanceof Error ? e.message : String(e);
                console.error(
                  `[FIRESTORE] failed to append voiceSessionHandle assessment=${assessmentId}:`,
                  errMsg,
                );
              }
            }

            // Gemini is asking us to migrate to a fresh session. Open a new
            // one with the latest resume handle so we keep context across the
            // ~15min hard limit. Quick (~15min) calls won't normally see this.
            if (msg.goAway && !myReconnectTriggered && !endTriggered) {
              myReconnectTriggered = true;
              void reconnectWithResume();
            }

            // Send the kickoff as soon as Gemini acknowledges setup. Skip on
            // resumed sessions — Gemini restores prior context, so a fresh
            // greeting would be jarring.
            if (
              msg.setupComplete &&
              !resumeHandle &&
              !kickoffSent &&
              liveSession
            ) {
              kickoffSent = true;
              const kickoffText = buildKickoffText(
                callerFirstName,
                callerBusinessName,
                callerWorkflowLabel,
              );
              try {
                liveSession.sendClientContent({
                  turns: [
                    {
                      role: "user",
                      parts: [{ text: kickoffText }],
                    },
                  ],
                  turnComplete: true,
                });
                console.log(
                  `[GEMINI-LIVE] kickoff sent post-setup session=${sessionId}`
                );
              } catch (e) {
                console.error("[GEMINI-LIVE] kickoff failed:", e);
              }
            }

            // Audio out (PCM16 24k LE base64)
            const parts = msg.serverContent?.modelTurn?.parts;
            if (parts) {
              for (const part of parts) {
                if (part.inlineData?.data) {
                  audioFramesFromGemini++;
                  if (audioFramesFromGemini % 20 === 1) {
                    console.log(
                      `[GEMINI-LIVE] audio from gemini session=${sessionId} frames=${audioFramesFromGemini}`
                    );
                  }
                  sendAudioOut(part.inlineData.data);
                }
              }
            }

            // Transcriptions
            const inputT = msg.serverContent?.inputTranscription?.text;
            if (inputT) {
              // Marks that the caller has been heard; the next audio frame out
              // closes the loop and reports how long they waited.
              lastUserAudioMs = Date.now();
              awaitingReply = true;
              notify({ type: "transcript", who: "user", text: inputT });
              // Untokenized sessions have nowhere to persist the transcript,
              // so surface it in the log. Tokenized calls stay quiet — their
              // text belongs in Firestore, not stdout.
              if (!transcriptBuffer) {
                console.log(`[TRANSCRIPT] user: ${inputT}`);
              }
              if (transcriptBuffer) {
                transcriptBuffer.push({
                  role: "user",
                  text: inputT,
                  sessionHandle: currentSessionHandle,
                  isFinal: !!msg.serverContent?.turnComplete,
                });
              }
            }

            const outputT = msg.serverContent?.outputTranscription?.text;
            if (outputT) {
              notify({ type: "transcript", who: "agent", text: outputT });
              if (!transcriptBuffer) {
                console.log(`[TRANSCRIPT] agent: ${outputT}`);
              }
              if (transcriptBuffer) {
                transcriptBuffer.push({
                  role: "agent",
                  text: outputT,
                  sessionHandle: currentSessionHandle,
                  isFinal: !!msg.serverContent?.turnComplete,
                });
              }
            }

            // Barge-in
            if (msg.serverContent?.interrupted) {
              notify({ type: "interrupted" });
              clearPlayback();
            }

            if (msg.serverContent?.turnComplete) {
              notify({ type: "turn_complete" });
            }

            // Tool calls
            const toolCall = msg.toolCall;
            if (toolCall?.functionCalls && liveSession) {
              const responses = [];
              for (const fc of toolCall.functionCalls) {
                if (fc.name === "end_interview") {
                  const reason =
                    (fc.args as { reason?: string } | undefined)?.reason ??
                    "agent_ended";
                  responses.push({
                    id: fc.id,
                    name: fc.name,
                    response: { result: "ok" },
                  });
                  queueMicrotask(() => endCall(reason));
                } else {
                  responses.push({
                    id: fc.id,
                    name: fc.name,
                    response: { error: "unknown_tool" },
                  });
                }
              }
              try {
                liveSession.sendToolResponse({ functionResponses: responses });
              } catch (e) {
                console.error("[GEMINI-LIVE] sendToolResponse failed:", e);
              }
            }
          },
          onerror: (e) => {
            console.error(
              `[GEMINI-LIVE] error session=${sessionId}:`,
              e.message
            );
            notify({ type: "error", message: e.message });
          },
          onclose: (e) => {
            console.log(
              `[GEMINI-LIVE] close session=${sessionId} reason=${e.reason}`
            );
          },
        },
      });

      // Swap atomically: client audio frames sent during the brief overlap
      // window may be dropped by the closing session, but the new session is
      // ready to receive immediately afterwards.
      const oldSession = liveSession;
      liveSession = newSession;
      if (oldSession) {
        try {
          oldSession.close();
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[GEMINI-LIVE] connect failed session=${sessionId}:`, msg);
      notify({ type: "error", message: msg });
    }
  };

  // Twilio Media Streams protocol. Note the ordering constraint: `start`
  // carries the token that setupPromise is waiting on, so it must resolve the
  // token *before* awaiting setup, or the two deadlock.
  const handleTwilioMessage = async (raw: unknown) => {
    let evt: {
      event?: string;
      start?: {
        streamSid?: string;
        callSid?: string;
        customParameters?: Record<string, string>;
      };
      media?: { payload?: string };
    };
    try {
      evt = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (evt.event === "start") {
      streamSid = evt.start?.streamSid ?? null;
      callSid = evt.start?.callSid ?? null;
      twilioStartMs = Date.now();
      const twilioToken = evt.start?.customParameters?.token ?? null;
      console.log(
        `[TWILIO] start session=${sessionId} stream=${streamSid} call=${callSid} token=${twilioToken ? "yes" : "no"}`,
      );
      resolveToken(twilioToken);
      flushPendingAudio();

      await setupPromise;
      if (setupRejected) return;
      if (!liveSession) await openLive();
      return;
    }

    if (evt.event === "media") {
      // Frames arriving before Gemini is connected are dropped. The agent
      // speaks first, so the caller is silent during that window.
      if (!liveSession || !evt.media?.payload) return;
      const pcm16 = mulaw8kToPcm16k(Buffer.from(evt.media.payload, "base64"));
      try {
        liveSession.sendRealtimeInput({
          audio: { data: pcm16.toString("base64"), mimeType: "audio/pcm;rate=16000" },
        });
        audioFramesToGemini++;
        if (audioFramesToGemini % 250 === 1) {
          console.log(
            `[GEMINI-LIVE] audio forwarded session=${sessionId} frames=${audioFramesToGemini}`,
          );
        }
      } catch (e) {
        console.error("[GEMINI-LIVE] sendRealtimeInput failed:", e);
      }
      return;
    }

    if (evt.event === "stop") {
      console.log(`[TWILIO] stop session=${sessionId}`);
      // The leg is already down; clearing callSid skips the hangup REST call
      // that would otherwise fail against a completed call.
      callSid = null;
      endCall("caller_hung_up");
      return;
    }
  };

  ws.on("message", async (raw) => {
    if (isTwilio) return handleTwilioMessage(raw);

    let msg: ClientToServer;
    try {
      msg = JSON.parse(raw.toString()) as ClientToServer;
    } catch {
      return notify({ type: "error", message: "bad_json" });
    }

    // Wait for setup (token verify + Firestore prefetch) before handling any
    // message. The client's `start` arrives within milliseconds of WS open;
    // setup may still be running.
    await setupPromise;
    if (setupRejected) return;

    if (msg.type === "start") {
      if (!liveSession) await openLive();
      return;
    }

    if (msg.type === "audio" && liveSession) {
      audioFramesFromClient++;
      if (audioFramesFromClient === 1) {
        console.log(
          `[CLIENT] first audio frame received session=${sessionId}`
        );
      }
      try {
        liveSession.sendRealtimeInput({
          audio: { data: msg.data, mimeType: "audio/pcm;rate=16000" },
        });
        audioFramesToGemini++;
        if (audioFramesToGemini % 50 === 1) {
          console.log(
            `[GEMINI-LIVE] audio forwarded session=${sessionId} frames=${audioFramesToGemini}`
          );
        }
      } catch (e) {
        console.error("[GEMINI-LIVE] sendRealtimeInput failed:", e);
      }
      return;
    }

    if (msg.type === "text" && liveSession) {
      try {
        liveSession.sendClientContent({
          turns: [{ role: "user", parts: [{ text: msg.text }] }],
          turnComplete: true,
        });
      } catch (e) {
        console.error("[GEMINI-LIVE] sendClientContent failed:", e);
      }
      return;
    }

    if (msg.type === "end") {
      console.log(`[SERVER] user end session=${sessionId}`);
      endCall("user_ended");
      return;
    }
  });

  ws.on("close", async () => {
    console.log(`[SERVER] WS closed session=${sessionId}`);
    // If the socket died before Twilio's `start` arrived, nothing ever
    // resolved the token and setupPromise would never settle — hanging the
    // transcript flush below. Resolving twice is a no-op.
    resolveToken(null);
    await setupPromise.catch(() => undefined);
    if (!endTriggered) endCall("client_disconnect");

    if (transcriptBuffer) {
      transcriptBuffer.stopAutoFlush();
      try {
        await transcriptBuffer.flush();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          `[FIRESTORE] final flush failed assessment=${assessmentId}:`,
          msg,
        );
      }
    }

    if (assessmentId) {
      const callDurationSec = Math.max(
        0,
        Math.round((Date.now() - clientConnectedAtMs) / 1000),
      );
      try {
        await adminDb()
          .collection("assessments")
          .doc(assessmentId)
          .update({
            callEndedAt: FieldValue.serverTimestamp(),
            callDurationSec,
          });
        console.log(
          `[FIRESTORE] assessment call ended assessment=${assessmentId} durationSec=${callDurationSec}`,
        );
        // No browser survives a phone call to POST /api/voice/finalize, so run
        // the same bookkeeping here.
        if (isTwilio) {
          const result = await finalizeAssessment(assessmentId);
          console.log(
            `[FINALIZE] assessment=${assessmentId} ${result.ok ? `status=${result.status} needsConfirmation=${result.needsConfirmation}` : `failed=${result.reason}`}`,
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          `[FIRESTORE] failed to update assessment on close assessment=${assessmentId}:`,
          msg,
        );
      }
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`[SERVER] listening http+ws on :${PORT}`);
});

// The report worker shares this process: one Fly machine runs the call relay
// and the job queue. Disable with WORKER_ENABLED=0 (e.g. local relay-only runs
// while a separate `npm run worker` handles jobs).
if (process.env.WORKER_ENABLED !== "0") {
  import("./worker.js").then((m) => m.startWorker());
}
