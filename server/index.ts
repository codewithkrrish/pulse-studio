import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateMediaUrl } from './security.js';
import { PLATFORMS } from './platforms.js';
import { extractMediaMetadata } from './extractor.js';
import { handleMediaStream } from './streamer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.resolve(__dirname, '../dist');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

import { spawnSync } from 'child_process';

function checkBinaryAvailable(cmd: string, flag = '--version'): boolean {
  try {
    const res = spawnSync(cmd, [flag], { stdio: 'ignore' });
    return res.status === 0;
  } catch {
    return false;
  }
}

// System Health & Engine Diagnostics
app.get('/api/health', (req: Request, res: Response) => {
  const ytdlpOk = checkBinaryAvailable(process.env.YT_DLP_PATH || 'yt-dlp', '--version');
  const ffmpegOk = checkBinaryAvailable('ffmpeg', '-version');

  res.json({
    status: ytdlpOk && ffmpegOk ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    engine: 'PULSE Studio Engine v1.0',
    binaries: {
      ytDlp: ytdlpOk,
      ffmpeg: ffmpegOk,
    },
    capabilities: {
      zeroDiskStreaming: ytdlpOk,
      audioTranscoding: ffmpegOk,
      highResolutionMuxing: ytdlpOk && ffmpegOk,
      supportedPlatformsCount: Object.keys(PLATFORMS).length,
    },
    hostingNotice: !ytdlpOk || !ffmpegOk
      ? 'Required system binaries (yt-dlp or ffmpeg) are missing from the host environment. Deploy using Docker or a Linux VPS.'
      : undefined,
  });
});

// Platform Directory
app.get('/api/platforms', (req: Request, res: Response) => {
  res.json({
    platforms: Object.values(PLATFORMS),
  });
});

// Probe & Extract Media Metadata
app.post('/api/extract', async (req: Request, res: Response) => {
  const { url, cookies } = req.body;

  const validation = validateMediaUrl(url);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  try {
    const metadata = await extractMediaMetadata(validation.url!);
    res.json({ success: true, data: metadata });
  } catch (err: any) {
    console.error('[API /api/extract Error]:', err.message);
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to extract media metadata',
    });
  }
});

// Direct Media Stream Pipe
app.get('/api/stream', (req: Request, res: Response) => {
  const { url, format_id, type, ext, title, start_time, end_time } = req.query;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing media URL parameter' });
  }

  const validation = validateMediaUrl(url);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  const streamType = type === 'audio' ? 'audio' : 'video';
  const streamExt = typeof ext === 'string' && ext ? ext : (streamType === 'audio' ? 'mp3' : 'mp4');
  const streamTitle = typeof title === 'string' && title ? title : 'media';
  const formatId = typeof format_id === 'string' && format_id ? format_id : (streamType === 'audio' ? 'bestaudio-mp3-320' : 'best');

  try {
    handleMediaStream(
      validation.url!,
      {
        url: validation.url!,
        formatId,
        type: streamType,
        ext: streamExt,
        title: streamTitle,
        startTime: typeof start_time === 'string' && start_time.trim() ? start_time.trim() : undefined,
        endTime: typeof end_time === 'string' && end_time.trim() ? end_time.trim() : undefined,
      },
      res
    );
  } catch (err: any) {
    console.error('[API /api/stream Error]:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Stream initiation failed' });
    }
  }
});

// HD Thumbnail Downloader Proxy
app.get('/api/thumbnail', async (req: Request, res: Response) => {
  const { url, title } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing thumbnail URL' });
  }

  try {
    const fetchRes = await fetch(url);
    if (!fetchRes.ok) throw new Error('Failed to fetch remote thumbnail');
    const arrayBuffer = await fetchRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const cleanTitle = typeof title === 'string' && title ? title.replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim() : 'thumbnail';
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(cleanTitle)}-cover.jpg"`);
    res.setHeader('Content-Type', 'image/jpeg');
    res.send(buffer);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to download thumbnail' });
  }
});

// Serve frontend static build
app.use(express.static(distPath));

// Express 5 SPA fallback handler
app.use((req: Request, res: Response) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Endpoint not found' });
  }
  res.sendFile(path.join(distPath, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[PULSE Engine] Core server running on http://localhost:${PORT}`);
});

