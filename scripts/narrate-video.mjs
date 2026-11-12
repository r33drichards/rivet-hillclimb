import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { createWriteStream } from "node:fs";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

// Run with node --env-file=.env.local scripts/narrate-video.mjs.
// The SDK reads ELEVENLABS_API_KEY. Never embed a key in source.
const client = new ElevenLabsClient();
const manifest = fileURLToPath(new URL("../video/scenes.json", import.meta.url));
const scenes = JSON.parse(await readFile(manifest, "utf8"));
const voiceId = process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb"; // George, premade narrator
const modelId = process.env.ELEVENLABS_MODEL_ID || "eleven_v4";
for (let index = 0; index < scenes.length; index++) {
  const scene = scenes[index];
  const output = resolve(dirname(manifest), scene.audio);
  const cache = output + ".sha256";
  const fingerprint = createHash("sha256").update(JSON.stringify({text:scene.text,voiceId,modelId})).digest("hex");
  await mkdir(dirname(output), { recursive: true });
  let cached = false;
  try { cached = (await readFile(cache, "utf8")) === fingerprint; await access(output); } catch { cached = false; }
  if (!cached) {
    const audio = await client.textToSpeech.convert(voiceId, {
      text: scene.text, modelId, outputFormat: "mp3_44100_128",
      voiceSettings: { stability: 0.7, similarityBoost: 0.5 },
      previousText: scenes[index - 1]?.text,
      nextText: scenes[index + 1]?.text,
    });
    await pipeline(Readable.fromWeb(audio), createWriteStream(output));
    await writeFile(cache, fingerprint);
  }
  scene.audioDuration = Number(execFileSync("ffprobe", ["-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",output], { encoding: "utf8" }).trim());
  scene.duration = Math.max(14, Math.ceil(scene.audioDuration + 1.5));
  await writeFile(manifest, JSON.stringify(scenes, null, 2) + "\n");
  console.log(`${scene.id}: ${cached ? "cached" : "narrated"}, ${scene.audioDuration.toFixed(1)}s speech / ${scene.duration}s scene`);
}
console.log(`Narration ready: ${scenes.reduce((n,s)=>n+s.duration,0)} seconds total.`);
