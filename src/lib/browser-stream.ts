import {
  spawn,
  ChildProcessWithoutNullStreams,
} from 'node:child_process';

import {
  IncomingMessage,
  ServerResponse,
} from 'node:http';

interface BrowserStreamConfig {
  cameraId: string;
  url: string;
  width: number;
  height: number;
  fps: number;
}

interface BrowserClient {
  response: ServerResponse;
}

class BrowserStream {
  private config: BrowserStreamConfig;

  private process:
    ChildProcessWithoutNullStreams | null =
    null;

  private clients =
    new Set<BrowserClient>();

  private running = false;

  private reconnectTimer:
    NodeJS.Timeout | null = null;

  private stopping = false;

  private buffer =
    Buffer.alloc(0);

  constructor(
    config: BrowserStreamConfig
  ) {
    this.config = config;
  }

  start() {
    if (this.running) {
      return;
    }

    this.running = true;
    this.stopping = false;

    this.startProcess();
  }

  stop() {
    this.stopping = true;
    this.running = false;

    if (this.reconnectTimer) {
      clearTimeout(
        this.reconnectTimer
      );

      this.reconnectTimer =
        null;
    }

    if (this.process) {
      try {
        this.process.kill(
          'SIGKILL'
        );
      } catch {}

      this.process =
        null;
    }

    for (
      const client
      of this.clients
    ) {
      try {
        client.response.end();
      } catch {}
    }

    this.clients.clear();

    this.buffer =
      Buffer.alloc(0);
  }

  private startProcess() {
    if (
      !this.running ||
      this.stopping
    ) {
      return;
    }

    const {
      url,
      width,
      height,
      fps,
    } = this.config;

    console.log(
      `[BROWSER STREAM] Starting ${this.config.cameraId}`
    );

    const args = [
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

      '-q:v',
      '6',

      '-f',
      'mjpeg',

      'pipe:1',
    ];

    const child =
      spawn(
        'ffmpeg',
        args,
        {
          windowsHide:
            true,
        }
      );

    this.process =
      child;

    child.stdout.on(
      'data',
      (chunk: Buffer) => {
        this.handleData(
          chunk
        );
      }
    );

    child.stderr.on(
      'data',
      (data: Buffer) => {
        const message =
          data.toString().trim();

        if (message) {
          console.log(
            `[BROWSER STREAM] ${message}`
          );
        }
      }
    );

    child.on(
      'spawn',
      () => {
        console.log(
          `[BROWSER STREAM] ${this.config.cameraId} connected`
        );
      }
    );

    child.on(
      'error',
      (error) => {
        console.error(
          `[BROWSER STREAM] ${this.config.cameraId} error:`,
          error.message
        );
      }
    );

    child.on(
      'close',
      (code) => {
        this.process =
          null;

        console.log(
          `[BROWSER STREAM] ${this.config.cameraId} stopped (${code})`
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

  private scheduleReconnect() {
    if (
      this.reconnectTimer
    ) {
      return;
    }

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

  private handleData(
    chunk: Buffer
  ) {
    this.buffer =
      Buffer.concat([
        this.buffer,
        chunk,
      ]);

    while (true) {
      const start =
        this.buffer.indexOf(
          Buffer.from([
            0xff,
            0xd8,
          ])
        );

      if (
        start === -1
      ) {
        /*
         * Prevent unlimited buffer growth.
         */
        if (
          this.buffer.length >
          1024 * 1024
        ) {
          this.buffer =
            Buffer.alloc(0);
        }

        return;
      }

      const end =
        this.buffer.indexOf(
          Buffer.from([
            0xff,
            0xd9,
          ]),
          start + 2
        );

      if (
        end === -1
      ) {
        return;
      }

      const jpeg =
        this.buffer.subarray(
          start,
          end + 2
        );

      this.buffer =
        this.buffer.subarray(
          end + 2
        );

      this.broadcastFrame(
        jpeg
      );
    }
  }

  private broadcastFrame(
    jpeg: Buffer
  ) {
    const header =
      Buffer.from(
        `--frame\r\n` +
        `Content-Type: image/jpeg\r\n` +
        `Content-Length: ${jpeg.length}\r\n` +
        `\r\n`
      );

    const footer =
      Buffer.from(
        '\r\n'
      );

    for (
      const client
      of this.clients
    ) {
      try {
        client.response.write(
          header
        );

        client.response.write(
          jpeg
        );

        client.response.write(
          footer
        );
      } catch {
        this.removeClient(
          client
        );
      }
    }
  }

  addClient(
    req: IncomingMessage,
    res: ServerResponse
  ) {
    if (
      req.destroyed ||
      res.writableEnded
    ) {
      return;
    }

    res.writeHead(
      200,
      {
        'Content-Type':
          'multipart/x-mixed-replace; boundary=frame',

        'Cache-Control':
          'no-cache, no-store, must-revalidate',

        Pragma:
          'no-cache',

        Connection:
          'close',

        'Access-Control-Allow-Origin':
          '*',

        'X-Accel-Buffering':
          'no',
      }
    );

    const client:
      BrowserClient = {
        response: res,
      };

    this.clients.add(
      client
    );

    console.log(
      `[BROWSER STREAM] ${this.config.cameraId} client connected. ` +
      `Clients: ${this.clients.size}`
    );

    req.on(
      'close',
      () => {
        this.removeClient(
          client
        );
      }
    );

    res.on(
      'close',
      () => {
        this.removeClient(
          client
        );
      }
    );
  }

  private removeClient(
    client: BrowserClient
  ) {
    if (
      !this.clients.has(
        client
      )
    ) {
      return;
    }

    this.clients.delete(
      client
    );

    try {
      if (
        !client.response.writableEnded
      ) {
        client.response.end();
      }
    } catch {}

    console.log(
      `[BROWSER STREAM] ${this.config.cameraId} client disconnected. ` +
      `Clients: ${this.clients.size}`
    );
  }

  getStats() {
    return {
      cameraId:
        this.config.cameraId,

      running:
        this.running,

      connected:
        Boolean(
          this.process
        ),

      clients:
        this.clients.size,

      width:
        this.config.width,

      height:
        this.config.height,

      fps:
        this.config.fps,
    };
  }
}

class BrowserStreamManager {
  private streams =
    new Map<
      string,
      BrowserStream
    >();

  start(
    cameraId: string,
    url: string,
    width = 704,
    height = 576,
    fps = 10
  ) {
    const existing =
      this.streams.get(
        cameraId
      );

    if (existing) {
      return existing;
    }

    const stream =
      new BrowserStream({
        cameraId,
        url,
        width,
        height,
        fps,
      });

    this.streams.set(
      cameraId,
      stream
    );

    stream.start();

    return stream;
  }

  get(
    cameraId: string
  ) {
    return this.streams.get(
      cameraId
    );
  }

  stop(
    cameraId: string
  ) {
    const stream =
      this.streams.get(
        cameraId
      );

    if (!stream) {
      return false;
    }

    stream.stop();

    this.streams.delete(
      cameraId
    );

    return true;
  }

  getStats(
    cameraId: string
  ) {
    const stream =
      this.streams.get(
        cameraId
      );

    if (!stream) {
      return null;
    }

    return stream.getStats();
  }
}

export const browserStreamManager =
  new BrowserStreamManager();