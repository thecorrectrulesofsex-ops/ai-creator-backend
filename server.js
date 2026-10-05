// AI Creator Studio backend
// Node.js 20+ recommended. Keep OPENAI_API_KEY on the server only.

const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT || 8787;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY environment variable.");
  process.exit(1);
}

const OPENAI = "https://api.openai.com/v1";

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST,GET,OPTIONS",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendError(res, status, message) {
  json(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on("data", c => {
      size += c.length;
      if (size > 15 * 1024 * 1024) {
        reject(new Error("Request too large."));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("Invalid JSON.")); }
    });
    req.on("error", reject);
  });
}

async function openaiJSON(path, options = {}) {
  const r = await fetch(OPENAI + path, {
    ...options,
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      ...(options.headers || {})
    }
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) {
    const msg = data?.error?.message || `OpenAI HTTP ${r.status}`;
    throw new Error(msg);
  }
  return data;
}

function dataUrlToBuffer(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || "");
  if (!m) throw new Error("Invalid image data.");
  return { mime: m[1], buffer: Buffer.from(m[2], "base64") };
}

async function generateImage(prompt, options) {
  const sizes = {
    "1:1": "1024x1024",
    "16:9": "1536x1024",
    "9:16": "1024x1536"
  };
  const quality = options?.quality === "Ultra" ? "high" :
                  options?.quality === "HD" ? "medium" : "auto";

  const data = await openaiJSON("/images/generations", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      model: "gpt-image-2",
      prompt,
      size: sizes[options?.ratio] || "1024x1024",
      quality,
      output_format: "png"
    })
  });

  const item = data?.data?.[0];
  if (!item?.b64_json) throw new Error("Image API returned no image.");
  return { type: "image", mime: "image/png", data: item.b64_json };
}

async function generateVoice(prompt, options) {
  // The API accepts a text input plus a built-in voice. The selected style is
  // expressed as instructions rather than exposing an API key to the browser.
  const style = options?.style || "Natural";
  const instructions = style === "News"
    ? "Read this as a clear professional news narration."
    : style === "Storytelling"
    ? "Read this as warm, expressive storytelling."
    : "Read naturally and clearly.";

  const voices = {
    "Male": "onyx",
    "Female": "nova",
    "News": "verse",
    "Storytelling": "shimmer",
    "Natural": "alloy"
  };

  const r = await fetch(OPENAI + "/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      input: prompt.slice(0, 4096),
      voice: voices[style] || "alloy",
      instructions,
      response_format: "mp3"
    })
  });

  if (!r.ok) {
    let msg = `OpenAI HTTP ${r.status}`;
    try { msg = (await r.json()).error?.message || msg; } catch {}
    throw new Error(msg);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  return { type: "audio", mime: "audio/mpeg", data: buf.toString("base64") };
}

async function createVideo(prompt, options, imageDataUrl) {
  const form = new FormData();
  form.append("model", "sora-2");
  form.append("prompt", prompt || "Create a cinematic video from this image.");
  form.append("seconds", String([4,8,12].includes(Number(options?.duration)) ? options.duration : 4));

  const ratio = options?.ratio || "9:16";
  const size = ratio === "16:9" ? "1280x720" :
               ratio === "1:1" ? "1024x1792" : "720x1280";
  form.append("size", size);

  if (imageDataUrl) {
    const { mime, buffer } = dataUrlToBuffer(imageDataUrl);
    const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
    form.append("input_reference", new Blob([buffer], {type: mime}), `reference.${ext}`);
  }

  const r = await fetch(OPENAI + "/videos", {
    method: "POST",
    headers: {"Authorization": `Bearer ${OPENAI_API_KEY}`},
    body: form
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `OpenAI HTTP ${r.status}`);
  return { type: "video-job", id: data.id, status: data.status, progress: data.progress || 0 };
}

async function videoStatus(id) {
  return await openaiJSON(`/videos/${encodeURIComponent(id)}`, {method: "GET"});
}

async function streamVideo(res, id) {
  const r = await fetch(`${OPENAI}/videos/${encodeURIComponent(id)}/content`, {
    headers: {"Authorization": `Bearer ${OPENAI_API_KEY}`}
  });
  if (!r.ok) {
    const t = await r.text();
    let msg = `OpenAI HTTP ${r.status}`;
    try { msg = JSON.parse(t)?.error?.message || msg; } catch {}
    throw new Error(msg);
  }
  res.writeHead(200, {
    "Content-Type": "video/mp4",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Cache-Control": "no-store",
    "Content-Disposition": 'inline; filename="ai-video.mp4"'
  });
  if (r.body) {
    for await (const chunk of r.body) res.write(Buffer.from(chunk));
  }
  res.end();
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST,GET,OPTIONS"
    });
    return res.end();
  }

  const u = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === "GET" && u.pathname === "/api/health") {
      return json(res, 200, {ok:true, service:"AI Creator Studio"});
    }

    if (req.method === "POST" && u.pathname === "/api/generate") {
      const body = await readBody(req);
      const mode = body.mode;
      if (!["text-image","text-voice","text-video","image-video"].includes(mode)) {
        return sendError(res, 400, "Unsupported mode.");
      }

      if (mode !== "image-video" && typeof body.prompt !== "string") {
        return sendError(res, 400, "Prompt is required.");
      }
      if (mode !== "image-video" && !body.prompt.trim()) {
        return sendError(res, 400, "Prompt is empty.");
      }

      if (mode === "text-image")
        return json(res, 200, await generateImage(body.prompt.trim(), body.options || {}));

      if (mode === "text-voice")
        return json(res, 200, await generateVoice(body.prompt.trim(), body.options || {}));

      if (mode === "image-video") {
        if (!body.image) return sendError(res, 400, "Image is required.");
        return json(res, 200, await createVideo(
          body.prompt || "Animate this image naturally with cinematic motion.",
          body.options || {},
          body.image
        ));
      }

      return json(res, 200, await createVideo(body.prompt.trim(), body.options || {}, null));
    }

    const m = u.pathname.match(/^\/api\/video-status\/([^/]+)$/);
    if (req.method === "GET" && m) {
      const data = await videoStatus(m[1]);
      return json(res, 200, {
        id: data.id,
        status: data.status,
        progress: data.progress || 0,
        error: data.error || null,
        videoUrl: data.status === "completed" ? `/api/video/${encodeURIComponent(data.id)}` : null
      });
    }

    const vm = u.pathname.match(/^\/api\/video\/([^/]+)$/);
    if (req.method === "GET" && vm) {
      return await streamVideo(res, vm[1]);
    }

    sendError(res, 404, "Not found.");
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendError(res, 500, e.message || "Server error.");
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`AI Creator backend listening on port ${PORT}`);
});
