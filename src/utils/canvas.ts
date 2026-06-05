import { createCanvas, loadImage } from "@napi-rs/canvas";
import { QueueTrack } from "./player";
import { createProgressBar, formatDuration } from "./format";

export async function generateMusicCard(
  track: QueueTrack,
  elapsed: number
): Promise<Buffer> {
  const width = 800;
  const height = 300;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#1a0a2e");
  gradient.addColorStop(1, "#7B2FBE");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  if (track.artwork) {
    try {
      const img = await loadImage(track.artwork);
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(30, 30, 240, 240, 12);
      ctx.clip();
      ctx.drawImage(img, 30, 30, 240, 240);
      ctx.restore();
    } catch {
      /* no artwork */
    }
  }

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 28px sans-serif";
  ctx.fillText(track.title.slice(0, 40), 300, 80);

  ctx.font = "20px sans-serif";
  ctx.fillStyle = "#cccccc";
  ctx.fillText(track.artist.slice(0, 50), 300, 115);

  ctx.font = "16px monospace";
  ctx.fillStyle = "#aaaaaa";
  const bar = createProgressBar(elapsed, track.duration, 20);
  ctx.fillText(bar, 300, 180);

  ctx.font = "bold 18px sans-serif";
  ctx.fillStyle = "#ffffff";
  ctx.fillText("SONYX", width - 100, height - 30);

  return canvas.toBuffer("image/png");
}

export async function generateMusicFrame(
  track: QueueTrack,
  lyrics: string,
  elapsed: number
): Promise<Buffer> {
  const width = 1000;
  const height = 500;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#0d0d0d";
  ctx.fillRect(0, 0, width, height);

  if (track.artwork) {
    try {
      const img = await loadImage(track.artwork);
      ctx.drawImage(img, 40, 40, 400, 400);
    } catch {
      /* no artwork */
    }
  }

  ctx.fillStyle = "#7B2FBE";
  ctx.fillRect(460, 40, 4, 420);

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 24px sans-serif";
  ctx.fillText(track.title.slice(0, 35), 480, 70);
  ctx.font = "18px sans-serif";
  ctx.fillStyle = "#aaaaaa";
  ctx.fillText(track.artist, 480, 100);
  ctx.font = "14px monospace";
  ctx.fillText(createProgressBar(elapsed, track.duration, 15), 480, 130);

  ctx.fillStyle = "#dddddd";
  ctx.font = "14px sans-serif";
  const lines = lyrics.split("\n").slice(0, 22);
  lines.forEach((line, i) => {
    ctx.fillText(line.slice(0, 55), 480, 165 + i * 18);
  });

  ctx.fillStyle = "#7B2FBE";
  ctx.font = "bold 16px sans-serif";
  ctx.fillText("SONYX", width - 80, height - 20);

  return canvas.toBuffer("image/png");
}
