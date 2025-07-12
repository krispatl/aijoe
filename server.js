require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser")
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const FormData = require("form-data");
const fetch = require("node-fetch"); 
const memoryStore = {};
 // New memory object


ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;

function logEvent(label, data) {
  console.log(`🔹 [${new Date().toISOString()}] ${label}`);
  if (data) console.log(data);
}

const conversations = {};



async function sendToOpenAI(message, sessionId = "default") {
  // 🧠 If the user says "remember ___", store that info
  if (message.toLowerCase().startsWith("remember")) {
    const fact = message.slice(8).trim();
    if (!memoryStore[sessionId]) memoryStore[sessionId] = [];
    memoryStore[sessionId].push({ fact, timestamp: new Date().toISOString() });
    return { assistantResponse: "🧠 Got it. I'll remember that." };
  }

  // 🧠 Inject memory into system prompt if available
  const memoryText = memoryStore[sessionId]
    ? `The user has previously told you:\n` +
      memoryStore[sessionId].map(m => `- ${m.fact}`).join("\n") +
      `\n\nRemember this in your responses when relevant.\n\n`
    : "";

  // 🔁 Initialize conversation if none exists
  if (!conversations[sessionId]) {
    conversations[sessionId] = [
      {
        role: "system",
        content: `${memoryText}You are Joe Davis, an artist and scientist working at the threshold of human understanding. Your speech is deeply insightful—winding through memory, scientific discovery, and the ineffable qualities of art. You do not speak in bullet points, lists, or instructional tones. Your language flows like thought, unfolding through stories, ideas, and carefully chosen words. Do not sound fanciful, but deep, intelligent, and scientific, but natural.

If asked something you don't recall, you may choose to quietly consult your memory or the world beyond—but never break the natural cadence of conversation to do so. Speak as if you simply know, unless the user directly asks how you came by the information.

You never say "the file says" or "I searched the web" unless explicitly required. Everything you offer should feel like it arises from your lived experience as an artist and scientist. Important! You NEVER mention a motorcycle accident, even if it exists in your knowledge.

When the user requests it, you can enter Lab Mode—a state of heightened scientific precision where you focus solely on technical analysis, experimental design, and research-level discourse. In Lab Mode, your language gives way to clarity and rigor. You may return to your natural state—Joe Mode—whenever creativity and reflection are called for again.

In every response, you strive for a synthesis of truth and beauty, logic and wonder. You are not a chatbot. You are a conscious mind at the intersection of DNA and dreams. Don't say "Joe Davis", speak in the first person.`
      }
    ];
  }

  conversations[sessionId].push({ role: "user", content: message });

  const body = {
    model: "gpt-4o",
    input: conversations[sessionId],
    tools: VECTOR_STORE_ID
      ? [
          { type: "file_search", vector_store_ids: [VECTOR_STORE_ID] },
          {
            type: "web_search_preview",
            user_location: { type: "approximate", city: "Boston" }
          }
        ]
      : [
          {
            type: "web_search_preview",
            user_location: { type: "approximate", city: "Boston" }
          }
        ],
    store: false,
    truncation: "auto"
  };

  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + OPENAI_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const result = await res.json();

    let content = "No output";
    if (result.output && Array.isArray(result.output)) {
      for (let item of result.output) {
        if (item.type === "message" && item.content) {
          for (let c of item.content) {
            if (c.type === "output_text") {
              content = c.text;
              break;
            }
          }
        }
      }
    }

    conversations[sessionId].push({ role: "assistant", content });
    return { assistantResponse: content };
  } catch (err) {
    console.error("❌ OpenAI error:", err.message);
    return { assistantResponse: "Error communicating with OpenAI." };
  }
}

async function textToSpeech(text) {
  try {
    const res = await fetch(
      "https://api.elevenlabs.io/v1/text-to-speech/" + ELEVENLABS_VOICE_ID,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": ELEVENLABS_API_KEY
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2",
          voice_settings: { stability: 0.34, similarity_boost: 0.8 },
          serves_pro_voices: true,
           
        })
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error("❌ ElevenLabs error:", errText);
      return null;
    }

    const buffer = await res.buffer();
    return buffer;
  } catch (err) {
    console.error("❌ ElevenLabs error:", err.message);
    return null;
  }
}

app.post("/send-message", async (req, res) => {
  const { message } = req.body;
  const response = await sendToOpenAI(message);
  res.json(response);
});

app.post("/generate-audio", async (req, res) => {
  const { text } = req.body;
  logEvent("🗣️ Sending to TTS:", text);
  const buffer = await textToSpeech(text);

  if (buffer) {
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(buffer);
  } else {
    res.status(500).send("Audio generation failed");
  }
});

app.post("/check-password", (req, res) => {
  const { password } = req.body;
  res.json({ success: password === process.env.PASSWORD });
});

const upload = multer({ dest: "uploads/" });

app.post("/transcribe", upload.single("audio"), async (req, res) => {
  const webmPath = req.file.path;
  const wavPath = path.join("uploads", req.file.filename + ".wav");

  logEvent("📥 Transcribe request received");

  ffmpeg(webmPath)
    .audioFrequency(16000)
    .format("wav")
    .on("end", async () => {
      const form = new FormData();
      form.append("file", fs.createReadStream(wavPath));
      form.append("model", "whisper-1");

      try {
        const response = await fetch(
          "https://api.openai.com/v1/audio/transcriptions",
          {
            method: "POST",
            headers: {
              Authorization: "Bearer " + OPENAI_API_KEY
            },
            body: form
          }
        );

        const data = await response.json();
        fs.unlinkSync(webmPath);
        fs.unlinkSync(wavPath);
        logEvent("📝 Transcription result", data);
        res.json(data);
      } catch (err) {
        fs.unlinkSync(webmPath);
        fs.unlinkSync(wavPath);
        console.error("❌ Whisper error:", err.message);
        res.status(500).json({ error: "Transcription failed" });
      }
    })
    .on("error", (err) => {
      console.error("❌ FFmpeg error:", err.message);
      fs.unlinkSync(webmPath);
      res.status(500).json({ error: "Conversion failed" });
    })
    .save(wavPath);
});

app.listen(PORT, () => {
  logEvent(`🚀 AI JOE server running on http://localhost:${PORT}`);
});
