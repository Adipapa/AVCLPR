import { RtspStream } from './rtsp-stream.js';

class StreamManager {
  private streams =
    new Map<string, RtspStream>();

  start(
    cameraId: string,
    url: string,
    width: number,
    height: number,
    fps: number
  ) {
    const existing =
      this.streams.get(cameraId);

    if (existing) {
      return existing;
    }

    const stream =
      new RtspStream({
        url,
        width,
        height,
        fps,
      });

    stream.on(
      'connected',
      () => {
        console.log(
          `[STREAM MANAGER] ${cameraId} connected`
        );
      }
    );

    stream.on(
      'disconnected',
      () => {
        console.log(
          `[STREAM MANAGER] ${cameraId} disconnected`
        );
      }
    );

    stream.on(
      'error',
      (error) => {
        console.error(
          `[STREAM MANAGER] ${cameraId} error:`,
          error
        );
      }
    );

    stream.on(
      'stats',
      (stats) => {
        /*
         * Stats are available to the dashboard/API.
         *
         * We deliberately do not print every frame.
         */
        if (
          stats.framesReceived > 0 &&
          stats.framesReceived % 1000 === 0
        ) {
          console.log(
            `[STREAM] ${cameraId} ` +
            `${stats.framesPerSecond} FPS`
          );
        }
      }
    );

    stream.on(
      'frame',
      (frame) => {
        /*
         * AI INPUT
         *
         * YOLO will eventually receive these frames.
         *
         * IMPORTANT:
         * Do not encode these frames to JPEG here.
         * Keep this pipeline optimized for AI.
         */

        if (
          frame.frameNumber % 100 === 0
        ) {
          console.log(
            `[AI INPUT] ${cameraId} ` +
            `frame ${frame.frameNumber}`
          );
        }
      }
    );

    this.streams.set(
      cameraId,
      stream
    );

    stream.start();

    return stream;
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

  get(
    cameraId: string
  ) {
    return this.streams.get(
      cameraId
    );
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

  getAllStats() {
    const result:
      Record<string, ReturnType<RtspStream['getStats']>> =
      {};

    for (
      const [
        cameraId,
        stream
      ] of this.streams
    ) {
      result[cameraId] =
        stream.getStats();
    }

    return result;
  }
}

export const streamManager =
  new StreamManager();