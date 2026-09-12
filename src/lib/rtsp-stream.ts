import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';

export interface StreamConfig {
  url: string;
  width: number;
  height: number;
  fps: number;
}

export interface StreamStats {
  running: boolean;
  connected: boolean;
  framesReceived: number;
  framesPerSecond: number;
  droppedFrames: number;
  reconnects: number;
  startedAt: string | null;
  lastFrameAt: string | null;
  width: number;
  height: number;
  frameSizeBytes: number;
  status: string;
}

export interface VideoFrame {
  data: Buffer;
  width: number;
  height: number;
  timestamp: number;
  frameNumber: number;
}

export class RtspStream extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;

  private config: StreamConfig;

  private running = false;
  private connected = false;

  private frameBuffer = Buffer.alloc(0);

  private framesReceived = 0;
  private framesPerSecond = 0;
  private droppedFrames = 0;
  private reconnects = 0;

  private frameNumber = 0;

  private startedAt: string | null = null;
  private lastFrameAt: string | null = null;

  private fpsCounter = 0;
  private fpsTimer: NodeJS.Timeout | null = null;

  private reconnectTimer: NodeJS.Timeout | null = null;

  private stopping = false;

  constructor(config: StreamConfig) {
    super();

    this.config = config;
  }

  start() {
    if (this.running) {
      return;
    }

    this.running = true;
    this.stopping = false;

    this.startedAt = new Date().toISOString();

    this.startFpsMonitor();

    this.startProcess();
  }

  stop() {
    this.stopping = true;
    this.running = false;
    this.connected = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.fpsTimer) {
      clearInterval(this.fpsTimer);
      this.fpsTimer = null;
    }

    if (this.process) {
      try {
        this.process.kill('SIGKILL');
      } catch {}

      this.process = null;
    }

    this.frameBuffer = Buffer.alloc(0);

    this.emit('status', this.getStats());
  }

  private startProcess() {
    if (!this.running || this.stopping) {
      return;
    }

    const {
      url,
      width,
      height,
      fps,
    } = this.config;

    console.log(
      `[RTSP] Connecting to stream ${width}x${height} @ ${fps}fps`
    );

    const ffmpegArgs = [
      '-hide_banner',

      '-loglevel',
      'warning',

      '-rtsp_transport',
      'tcp',

      '-i',
      url,

      '-an',

      '-vf',
      `scale=${width}:${height}`,

      '-r',
      String(fps),

      '-pix_fmt',
      'bgr24',

      '-f',
      'rawvideo',

      'pipe:1',
    ];

    const child = spawn(
      'ffmpeg',
      ffmpegArgs,
      {
        windowsHide: true,
      }
    );

    this.process = child;

    const frameSize =
      width *
      height *
      3;

    let stderr = '';

    child.stderr.on(
      'data',
      (data: Buffer) => {
        stderr += data.toString();

        if (stderr.length > 5000) {
          stderr =
            stderr.slice(-5000);
        }
      }
    );

    child.stdout.on(
      'data',
      (chunk: Buffer) => {
        this.handleVideoData(
          chunk,
          frameSize
        );
      }
    );

    child.on(
      'spawn',
      () => {
        this.connected = true;

        console.log(
          '[RTSP] FFmpeg process started.'
        );

        this.emit(
          'connected',
          this.getStats()
        );

        this.emit(
          'status',
          this.getStats()
        );
      }
    );

    child.on(
      'error',
      (error) => {
        console.error(
          '[RTSP] FFmpeg error:',
          error.message
        );

        this.connected = false;

        this.emit(
          'error',
          error
        );

        this.emit(
          'status',
          this.getStats()
        );
      }
    );

    child.on(
      'close',
      (code) => {
        this.connected = false;

        console.log(
          `[RTSP] FFmpeg stopped. Exit code: ${code}`
        );

        if (stderr) {
          console.log(
            `[RTSP] FFmpeg: ${stderr.trim()}`
          );
        }

        this.emit(
          'disconnected',
          {
            code,
            stats: this.getStats(),
          }
        );

        this.emit(
          'status',
          this.getStats()
        );

        if (
          this.running &&
          !this.stopping
        ) {
          this.scheduleReconnect();
        }
      }
    );
  }

  private handleVideoData(
    chunk: Buffer,
    frameSize: number
  ) {
    this.frameBuffer =
      Buffer.concat([
        this.frameBuffer,
        chunk,
      ]);

    while (
      this.frameBuffer.length >=
      frameSize
    ) {
      const frame =
        this.frameBuffer.subarray(
          0,
          frameSize
        );

      this.frameBuffer =
        this.frameBuffer.subarray(
          frameSize
        );

      this.frameNumber++;
      this.framesReceived++;
      this.fpsCounter++;

      this.lastFrameAt =
        new Date().toISOString();

      const videoFrame: VideoFrame = {
        data: Buffer.from(frame),

        width:
          this.config.width,

        height:
          this.config.height,

        timestamp:
          Date.now(),

        frameNumber:
          this.frameNumber,
      };

      this.emit(
        'frame',
        videoFrame
      );
    }
  }

  private startFpsMonitor() {
    if (this.fpsTimer) {
      clearInterval(this.fpsTimer);
    }

    this.fpsTimer =
      setInterval(
        () => {
          this.framesPerSecond =
            this.fpsCounter;

          this.fpsCounter = 0;

          this.emit(
            'stats',
            this.getStats()
          );
        },
        1000
      );
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnects++;

    console.log(
      '[RTSP] Reconnecting in 3 seconds...'
    );

    this.reconnectTimer =
      setTimeout(
        () => {
          this.reconnectTimer =
            null;

          if (
            this.running &&
            !this.stopping
          ) {
            this.startProcess();
          }
        },
        3000
      );
  }

  getStats(): StreamStats {
    const frameSizeBytes =
      this.config.width *
      this.config.height *
      3;

    return {
      running:
        this.running,

      connected:
        this.connected,

      framesReceived:
        this.framesReceived,

      framesPerSecond:
        this.framesPerSecond,

      droppedFrames:
        this.droppedFrames,

      reconnects:
        this.reconnects,

      startedAt:
        this.startedAt,

      lastFrameAt:
        this.lastFrameAt,

      width:
        this.config.width,

      height:
        this.config.height,

      frameSizeBytes,

      status:
        this.connected
          ? 'streaming'
          : this.running
            ? 'connecting'
            : 'stopped',
    };
  }
}