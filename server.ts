import express, {
  Request,
  Response,
} from 'express';

import {
  browserStreamManager,
} from './src/lib/browser-stream.js';

import http from 'node:http';
import { spawn } from 'node:child_process';

import dotenv from 'dotenv';

import {
  WebSocketServer,
  WebSocket,
} from 'ws';

import {
  cameras,
  createVehicleEvent,
  getVehicleEventById,
  getVehicleEvents,
  getTrafficAnalytics,
  getSystemHealthMetrics,
} from './src/lib/server-db.js';

import {
  VehicleEvent,
  StreamStatus,
} from './src/types/index.js';

dotenv.config();

/* =========================================================
   AVCLPR1 SERVER
   QTS AI VEHICLE INTELLIGENCE PLATFORM
========================================================= */

const app =
  express();

const PORT =
  Number(
    process.env.PORT || 3000
  );

/* =========================================================
   MIDDLEWARE
========================================================= */

app.use(
  express.json({
    limit: '25mb',
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: '25mb',
  })
);

/* =========================================================
   CORS
========================================================= */

app.use(
  (
    req: Request,
    res: Response,
    next
  ) => {

    res.setHeader(
      'Access-Control-Allow-Origin',
      '*'
    );

    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization'
    );

    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET,POST,PUT,DELETE,OPTIONS'
    );

    if (
      req.method === 'OPTIONS'
    ) {

      return res.sendStatus(
        204
      );
    }

    next();
  }
);

/* =========================================================
   WEBSOCKET CLIENTS
========================================================= */

const websocketClients:
  Set<WebSocket> =
  new Set();

/* =========================================================
   WEBSOCKET BROADCAST
========================================================= */

function broadcast(
  payload: any
) {

  const message =
    JSON.stringify(
      payload
    );

  for (
    const ws of websocketClients
  ) {

    if (
      ws.readyState ===
      WebSocket.OPEN
    ) {

      try {

        ws.send(
          message
        );

      } catch {
        // Ignore disconnected clients.
      }
    }
  }
}

/* =========================================================
   RTSP URL
========================================================= */

function buildRtspUrl(
  camera: typeof cameras[number],
  subtype: number
): string {

  const password =
    camera.passwordPlain ||
    process.env.LOREX_PASSWORD;

  if (!password) {

    throw new Error(
      'Lorex camera password is not configured.'
    );
  }

  const username =
    encodeURIComponent(
      camera.username
    );

  const encodedPassword =
    encodeURIComponent(
      password
    );

  return (
    `rtsp://${username}:${encodedPassword}` +
    `@${camera.ip}:${camera.rtspPort}` +
    `/cam/realmonitor?channel=1&subtype=${subtype}`
  );
}

/* =========================================================
   RTSP TEST RESULT
========================================================= */

interface RtspTestResult {
  streamType:
    | 'main'
    | 'sub1'
    | 'sub2';

  subtype: number;

  status: StreamStatus;

  resolution: string;

  fps: number;

  codec: string;

  bitrateKbps: number;

  latencyMs: number;

  message: string;
}

/* =========================================================
   EXTRACT FPS
========================================================= */

function extractFps(
  output: string
): number {

  /*
   * FFmpeg may report:
   *
   * 15 fps
   * 20 tbr
   * 25 fps
   *
   * We prefer the actual "fps" field.
   */

  const matches =
    [
      ...output.matchAll(
        /(\d+(?:\.\d+)?)\s*fps/gi
      ),
    ];

  if (
    matches.length === 0
  ) {

    return 0;
  }

  const values =
    matches
      .map(
        match =>
          Number(
            match[1]
          )
      )
      .filter(
        value =>
          Number.isFinite(
            value
          )
      );

  if (
    values.length === 0
  ) {

    return 0;
  }

  /*
   * FFmpeg can print both source and output
   * frame rates. Use the first reported fps.
   */

  return values[0];
}

/* =========================================================
   EXTRACT BITRATE
========================================================= */

function extractBitrate(
  output: string
): number {

  const match =
    output.match(
      /(\d+(?:\.\d+)?)\s*(?:kbits\/s|kb\/s)/i
    );

  if (!match) {

    return 0;
  }

  return Number(
    match[1]
  );
}

/* =========================================================
   TEST RTSP STREAM
========================================================= */

function testRtspStream(
  camera: typeof cameras[number],
  streamType:
    | 'main'
    | 'sub1'
    | 'sub2',
  subtype: number
): Promise<RtspTestResult> {

  return new Promise(
    (
      resolve
    ) => {

      const started =
        Date.now();

      let finished =
        false;

      let stderrData =
        '';

      let stdoutData =
        '';

      const finish =
        (
          result:
            RtspTestResult
        ) => {

          if (
            finished
          ) {

            return;
          }

          finished =
            true;

          resolve(
            result
          );
        };

      /* -----------------------------------------------------
         BUILD URL
      ----------------------------------------------------- */

      let url:
        string;

      try {

        url =
          buildRtspUrl(
            camera,
            subtype
          );

      } catch (
        error: any
      ) {

        finish({

          streamType,

          subtype,

          status: 'stream_unavailable',

          resolution:
            'Unknown',

          fps:
            0,

          codec:
            'Unknown',

          bitrateKbps:
            0,

          latencyMs:
            0,

          message:
            error?.message ||
            'Failed to build RTSP URL.',

        });

        return;
      }

      console.log(
        `[RTSP] Testing ${streamType} ` +
        `(subtype=${subtype})`
      );

      /* -----------------------------------------------------
         FFMPEG
      ----------------------------------------------------- */

      const ffmpeg =
        spawn(
          'ffmpeg',
          [

            '-hide_banner',

            '-loglevel',
            'info',

            '-rtsp_transport',
            'tcp',

            '-i',
            url,

            '-t',
            '3',

            '-f',
            'null',

            '-',

          ],
          {
            windowsHide:
              true,
          }
        );

      /* -----------------------------------------------------
         TIMEOUT
      ----------------------------------------------------- */

      const timeout =
        setTimeout(
          () => {

            try {

              ffmpeg.kill(
                'SIGKILL'
              );

            } catch {}

            finish({

              streamType,

              subtype,

              status:
                'timeout',

              resolution:
                'Unknown',

              fps:
                0,

              codec:
                'Unknown',

              bitrateKbps:
                0,

              latencyMs:
                Date.now() -
                started,

              message:
                'RTSP stream test timed out.',

            });

          },
          12000
        );

      /* -----------------------------------------------------
         STDERR
      ----------------------------------------------------- */

      ffmpeg.stderr.on(
        'data',
        (
          data
        ) => {

          stderrData +=
            data.toString();
        }
      );

      /* -----------------------------------------------------
         STDOUT
      ----------------------------------------------------- */

      ffmpeg.stdout.on(
        'data',
        (
          data
        ) => {

          stdoutData +=
            data.toString();
        }
      );

      /* -----------------------------------------------------
         PROCESS ERROR
      ----------------------------------------------------- */

      ffmpeg.on(
        'error',
        (
          error
        ) => {

          clearTimeout(
            timeout
          );

          finish({

            streamType,

            subtype,

            status: 'stream_unavailable',

            resolution:
              'Unknown',

            fps:
              0,

            codec:
              'Unknown',

            bitrateKbps:
              0,

            latencyMs:
              Date.now() -
              started,

            message:
              error.message,

          });
        }
      );

      /* -----------------------------------------------------
         PROCESS CLOSE
      ----------------------------------------------------- */

      ffmpeg.on(
        'close',
        (
          exitCode
        ) => {

          clearTimeout(
            timeout
          );

          const output =
            `${stderrData}\n${stdoutData}`;

          /* -------------------------------------------------
             AUTHENTICATION FAILURE
          ------------------------------------------------- */

          if (
            /401|Unauthorized|authentication failed|invalid username|invalid password|401 Unauthorized/i
              .test(
                output
              )
          ) {

            finish({

              streamType,

              subtype,

              status:
                'auth_failed',

              resolution:
                'Unknown',

              fps:
                0,

              codec:
                'Unknown',

              bitrateKbps:
                0,

              latencyMs:
                Date.now() -
                started,

              message:
                'RTSP authentication failed. Check the Lorex username and password.',

            });

            return;
          }

          /* -------------------------------------------------
             CONNECTION FAILURE
          ------------------------------------------------- */

          if (
            /Connection refused|Connection timed out|No route to host|Network is unreachable/i
              .test(
                output
              )
          ) {

            finish({

              streamType,

              subtype,

              status:
                'stream_unavailable',

              resolution:
                'Unknown',

              fps:
                0,

              codec:
                'Unknown',

              bitrateKbps:
                0,

              latencyMs:
                Date.now() -
                started,

              message:
                'RTSP camera connection failed.',

            });

            return;
          }

          /* -------------------------------------------------
             RESOLUTION
          ------------------------------------------------- */

          const resolutionMatch =
            output.match(
              /(\d{3,5})x(\d{3,5})/
            );

          const resolution =
            resolutionMatch
              ? `${resolutionMatch[1]} × ${resolutionMatch[2]}`
              : 'Detected';

          /* -------------------------------------------------
             CODEC
          ------------------------------------------------- */

          const codecMatch =
            output.match(
              /Video:\s*([^,\s]+)/i
            );

          const codec =
            codecMatch
              ? codecMatch[1]
              : 'Unknown';

          /* -------------------------------------------------
             FPS
          ------------------------------------------------- */

          const fps =
            extractFps(
              output
            );

          /* -------------------------------------------------
             BITRATE
          ------------------------------------------------- */

          const bitrateKbps =
            extractBitrate(
              output
            );

          /* -------------------------------------------------
             SUCCESS
          ------------------------------------------------- */

          if (
            /Video:/i.test(
              output
            )
          ) {

            finish({

              streamType,

              subtype,

              status:
                'connected',

              resolution,

              fps,

              codec,

              bitrateKbps,

              latencyMs:
                Date.now() -
                started,

              message:
                `RTSP stream connected successfully. FFmpeg exit code: ${exitCode}.`,

            });

            return;
          }

          /* -------------------------------------------------
             UNKNOWN FAILURE
          ------------------------------------------------- */

          finish({

            streamType,

            subtype,

            status:
              'stream_unavailable',

            resolution:
              'Unknown',

            fps:
              0,

            codec:
              'Unknown',

            bitrateKbps:
              0,

            latencyMs:
              Date.now() -
              started,

            message:
              'RTSP endpoint responded, but no video stream was received.',

          });
        }
      );
    }
  );
}

/* =========================================================
   HEALTH
========================================================= */

app.get(
  '/api/health',
  (
    _req,
    res
  ) => {

    const camerasOnline =
      cameras.filter(
        camera =>
          camera.status ===
          'connected'
      ).length;

    res.json({

      success:
        true,

      system:
        'AVCLPR1',

      status:
        'online',

      timestamp:
        new Date()
          .toISOString(),

      camerasTotal:
        cameras.length,

      camerasOnline,

    });
  }
);

/* =========================================================
   SYSTEM METRICS
========================================================= */

app.get(
  '/api/system/metrics',
  (
    _req,
    res
  ) => {

    try {

      const metrics =
        getSystemHealthMetrics();

      res.json({

        success:
          true,

        metrics,

      });

    } catch (
      error: any
    ) {

      res.status(
        500
      ).json({

        success:
          false,

        error:
          error?.message ||
          'Failed to retrieve system metrics.',

      });
    }
  }
);

/* =========================================================
   CAMERAS
========================================================= */

app.get(
  '/api/cameras',
  (
    _req,
    res
  ) => {

    res.json(
      cameras
    );
  }
);

/* =========================================================
   GET CAMERA
========================================================= */

app.get(
  '/api/cameras/:id',
  (
    req,
    res
  ) => {

    const camera =
      cameras.find(
        camera =>
          camera.id ===
          req.params.id
      );

    if (!camera) {

      return res.status(
        404
      ).json({

        success:
          false,

        error:
          'Camera not found',

      });
    }

    res.json({

      success:
        true,

      camera,

    });
  }
);

/* =========================================================
   CAMERA STATUS
========================================================= */

app.get(
  '/api/cameras/:id/status',
  async (
    req,
    res
  ) => {

    const camera =
      cameras.find(
        camera =>
          camera.id ===
          req.params.id
      );

    if (!camera) {

      return res.status(
        404
      ).json({

        success:
          false,

        error:
          'Camera not found',

      });
    }

    camera.status =
      'checking';

    camera.statusMessage =
      'Checking RTSP stream...';

    camera.lastUpdated =
      new Date()
        .toISOString();

    const result =
      await testRtspStream(
        camera,
        'main',
        0
      );

    camera.status =
      result.status ===
      'connected'
        ? 'connected'
        : 'offline';

    camera.statusMessage =
      result.message;

    camera.latencyMs =
      result.latencyMs;

    camera.lastUpdated =
      new Date()
        .toISOString();

    if (
      result.status ===
      'connected'
    ) {

      camera.lastSeen =
        new Date()
          .toISOString();
    }

    camera.streams = {

      main: {

        status:
          result.status,

        url:
          buildSafeStreamUrl(
            camera,
            0
          ),

        name:
          'Main Stream',

        resolution:
          result.resolution,

        fps:
          result.fps,

        bitrateKbps:
          result.bitrateKbps,

        codec:
          result.codec,

        latencyMs:
          result.latencyMs,

        message:
          result.message,

      },

    };

    broadcast({

      type:
        'CAMERA_STATUS_UPDATED',

      camera,

    });

    res.json({

      success:
        result.status ===
        'connected',

      reachable:
        result.status ===
        'connected',

      latencyMs:
        result.latencyMs,

      message:
        result.message,

      camera,

      stream:
        result,

    });
  }
);

/* =========================================================
   SAFE STREAM URL
========================================================= */

function buildSafeStreamUrl(
  camera: typeof cameras[number],
  subtype: number
): string {

  return (
    `rtsp://${camera.username}` +
    `:********` +
    `@${camera.ip}:${camera.rtspPort}` +
    `/cam/realmonitor?channel=1&subtype=${subtype}`
  );
}

/* =========================================================
   TEST ALL CAMERA STREAMS
========================================================= */

app.post(
  '/api/cameras/test',
  async (
    req,
    res
  ) => {

    const cameraId =
      req.body?.cameraId ||
      'cam_lorex_01';

    const camera =
      cameras.find(
        camera =>
          camera.id ===
          cameraId
      );

    if (!camera) {

      return res.status(
        404
      ).json({

        success:
          false,

        error:
          'Camera not found',

      });
    }

    try {

      console.log('');

      console.log(
        '================================'
      );

      console.log(
        `Testing RTSP streams for ${camera.name}`
      );

      console.log(
        '================================'
      );

      camera.status =
        'checking';

      camera.statusMessage =
        'Testing RTSP streams...';

      const [
        main,
        sub1,
        sub2,
      ] =
        await Promise.all([

          testRtspStream(
            camera,
            'main',
            0
          ),

          testRtspStream(
            camera,
            'sub1',
            1
          ),

          testRtspStream(
            camera,
            'sub2',
            2
          ),

        ]);

      /* -----------------------------------------------------
         STORE STREAM RESULTS
      ----------------------------------------------------- */

      camera.streams = {

        main: {

          status:
            main.status,

          url:
            buildSafeStreamUrl(
              camera,
              0
            ),

          name:
            'Main Stream',

          resolution:
            main.resolution,

          fps:
            main.fps,

          bitrateKbps:
            main.bitrateKbps,

          codec:
            main.codec,

          latencyMs:
            main.latencyMs,

          message:
            main.message,

        },

        sub1: {

          status:
            sub1.status,

          url:
            buildSafeStreamUrl(
              camera,
              1
            ),

          name:
            'AI Sub Stream',

          resolution:
            sub1.resolution,

          fps:
            sub1.fps,

          bitrateKbps:
            sub1.bitrateKbps,

          codec:
            sub1.codec,

          latencyMs:
            sub1.latencyMs,

          message:
            sub1.message,

        },

        sub2: {

          status:
            sub2.status,

          url:
            buildSafeStreamUrl(
              camera,
              2
            ),

          name:
            'Preview Stream',

          resolution:
            sub2.resolution,

          fps:
            sub2.fps,

          bitrateKbps:
            sub2.bitrateKbps,

          codec:
            sub2.codec,

          latencyMs:
            sub2.latencyMs,

          message:
            sub2.message,

        },

      };

      const allConnected =
        main.status ===
          'connected' &&
        sub1.status ===
          'connected' &&
        sub2.status ===
          'connected';

      const mainConnected =
        main.status ===
        'connected';

      camera.status =
        allConnected ||
        mainConnected
          ? 'connected'
          : 'offline';

      camera.statusMessage =
        allConnected
          ? 'All RTSP streams verified successfully.'
          : mainConnected
            ? 'Main RTSP stream connected. One or more substreams failed verification.'
            : 'Main RTSP stream failed.';

      camera.latencyMs =
        Math.max(
          main.latencyMs,
          sub1.latencyMs,
          sub2.latencyMs
        );

      camera.lastUpdated =
        new Date()
          .toISOString();

      if (
        mainConnected
      ) {

        camera.lastSeen =
          new Date()
            .toISOString();
      }

      const response = {

        success:
          allConnected,

        overallStatus:
          allConnected
            ? 'connected'
            : mainConnected
              ? 'partial'
              : 'offline',

        testedAt:
          new Date()
            .toISOString(),

        camera,

        streams: {

          main,

          sub1,

          sub2,

        },

      };

      broadcast({

        type:
          'CAMERA_TEST_COMPLETED',

        camera,

        streams:
          response.streams,

      });

      console.log('');

      console.log(
        `[RTSP] Main: ${main.status} ` +
        `${main.resolution} ` +
        `${main.codec}`
      );

      console.log(
        `[RTSP] Sub1: ${sub1.status} ` +
        `${sub1.resolution} ` +
        `${sub1.codec}`
      );

      console.log(
        `[RTSP] Sub2: ${sub2.status} ` +
        `${sub2.resolution} ` +
        `${sub2.codec}`
      );

      console.log('');

      res.json(
        response
      );

    } catch (
      error: any
    ) {

      camera.status =
        'error';

      camera.statusMessage =
        error?.message ||
        'RTSP test failed.';

      camera.lastUpdated =
        new Date()
          .toISOString();

      console.error(
        '[RTSP] Test failed:',
        error
      );

      res.status(
        500
      ).json({

        success:
          false,

        error:
          error?.message ||
          'RTSP test failed.',

      });
    }
  }
);

/* =========================================================
   CAMERA UPDATE
========================================================= */

app.put(
  '/api/cameras/:id',
  (
    req,
    res
  ) => {

    const camera =
      cameras.find(
        camera =>
          camera.id ===
          req.params.id
      );

    if (!camera) {

      return res.status(
        404
      ).json({

        success:
          false,

        error:
          'Camera not found',

      });
    }

    const {
      id,
      passwordPlain,
      ...updates
    } =
      req.body || {};

    /*
     * Do not allow arbitrary updates to the ID.
     */

    Object.assign(
      camera,
      updates
    );

    if (
      passwordPlain !==
      undefined
    ) {

      camera.passwordPlain =
        passwordPlain;

      camera.hasPassword =
        Boolean(
          passwordPlain
        );
    }

    camera.lastUpdated =
      new Date()
        .toISOString();

    res.json({

      success:
        true,

      camera,

    });
  }
);

/* =========================================================
   VEHICLE EVENTS
========================================================= */

app.post(
  '/api/vehicle-events',
  (
    req,
    res
  ) => {

    try {

      const body =
        req.body || {};

      /* -----------------------------------------------------
         VALIDATION
      ----------------------------------------------------- */

      if (
        !body.cameraId
      ) {

        return res.status(
          400
        ).json({

          success:
            false,

          error:
            'cameraId is required',

        });
      }

      if (
        !body.vehicleType
      ) {

        return res.status(
          400
        ).json({

          success:
            false,

          error:
            'vehicleType is required',

        });
      }

      if (
        !body.direction
      ) {

        return res.status(
          400
        ).json({

          success:
            false,

          error:
            'direction is required',

        });
      }

      if (
        body.direction !== 'IN' &&
        body.direction !== 'OUT'
      ) {

        return res.status(
          400
        ).json({

          success:
            false,

          error:
            'direction must be IN or OUT',

        });
      }

      const camera =
        cameras.find(
          camera =>
            camera.id ===
            body.cameraId
        );

      if (!camera) {

        return res.status(
          404
        ).json({

          success:
            false,

          error:
            'Camera not found',

        });
      }

      /* -----------------------------------------------------
         CREATE EVENT
      ----------------------------------------------------- */

      const event:
        VehicleEvent = {

        id:
          body.id ||
          `evt_${Date.now()}_${Math.random()
            .toString(36)
            .slice(2, 10)}`,

        timestamp:
          body.timestamp ||
          new Date()
            .toISOString(),

        cameraId:
          camera.id,

        cameraName:
          camera.name,

        trackingId:
          Number(
            body.trackingId ??
            body.trackId ??
            0
          ),

        vehicleType:
          String(
            body.vehicleType
          ),

        direction:
          body.direction,

        confidence:
          Number(
            body.confidence ??
            0
          ),

        plateNumber:
          body.plateNumber,

        formattedPlate:
          body.formattedPlate,

        plateConfidence:
          body.plateConfidence !=
          null
            ? Number(
                body.plateConfidence
              )
            : undefined,

        colorName:
          body.colorName,

        speedKmh:
          body.speedKmh !=
          null
            ? Number(
                body.speedKmh
              )
            : undefined,

        snapshotPath:
          body.snapshot ??
          body.snapshotPath,

        plateImagePath:
          body.plateImagePath,

        vehicleImagePath:
          body.vehicleImagePath,

        latitude:
          body.latitude !=
          null
            ? Number(
                body.latitude
              )
            : camera.latitude,

        longitude:
          body.longitude !=
          null
            ? Number(
                body.longitude
              )
            : camera.longitude,

        isWatchlisted:
          Boolean(
            body.isWatchlisted
          ),

        watchlistCategory:
          body.watchlistCategory,

        processingTimeMs:
          body.processingTimeMs !=
          null
            ? Number(
                body.processingTimeMs
              )
            : undefined,

      };

      /* -----------------------------------------------------
         SAVE TO SQLITE
      ----------------------------------------------------- */

      const savedEvent =
        createVehicleEvent(
          event
        );

      /* -----------------------------------------------------
         LIVE EVENT
      ----------------------------------------------------- */

      broadcast({

        type:
          'VEHICLE_EVENT_CREATED',

        event:
          savedEvent,

      });

      console.log(
        `[EVENT] ${savedEvent.vehicleType} ` +
        `${savedEvent.direction} ` +
        `camera=${savedEvent.cameraId} ` +
        `track=${savedEvent.trackingId}`
      );

      return res.status(
        201
      ).json({

        success:
          true,

        event:
          savedEvent,

      });

    } catch (
      error: any
    ) {

      console.error(
        '[EVENT] Failed to create event:',
        error
      );

      return res.status(
        500
      ).json({

        success:
          false,

        error:
          error?.message ||
          'Failed to create vehicle event.',

      });
    }
  }
);

/* =========================================================
   GET VEHICLE EVENTS
========================================================= */

app.get(
  '/api/vehicle-events',
  (
    req,
    res
  ) => {

    try {

      const direction =
        req.query.direction ===
          'IN' ||
        req.query.direction ===
          'OUT'
          ? req.query.direction
          : undefined;

      const result =
        getVehicleEvents({

          cameraId:
            typeof req.query.cameraId ===
            'string'
              ? req.query.cameraId
              : undefined,

          direction,

          vehicleType:
            typeof req.query.vehicleType ===
            'string'
              ? req.query.vehicleType
              : undefined,

          plateNumber:
            typeof req.query.plateNumber ===
            'string'
              ? req.query.plateNumber
              : undefined,

          from:
            typeof req.query.from ===
            'string'
              ? req.query.from
              : undefined,

          to:
            typeof req.query.to ===
            'string'
              ? req.query.to
              : undefined,

          limit:
            req.query.limit
              ? Number(
                  req.query.limit
                )
              : 100,

          offset:
            req.query.offset
              ? Number(
                  req.query.offset
                )
              : 0,

        });

      return res.json({

        success:
          true,

        ...result,

      });

    } catch (
      error: any
    ) {

      console.error(
        '[EVENT] Query failed:',
        error
      );

      return res.status(
        500
      ).json({

        success:
          false,

        error:
          error?.message ||
          'Failed to retrieve vehicle events.',

      });
    }
  }
);

/* =========================================================
   GET SINGLE VEHICLE EVENT
========================================================= */

app.get(
  '/api/vehicle-events/:id',
  (
    req,
    res
  ) => {

    try {

      const event =
        getVehicleEventById(
          req.params.id
        );

      if (!event) {

        return res.status(
          404
        ).json({

          success:
            false,

          error:
            'Vehicle event not found',

        });
      }

      return res.json({

        success:
          true,

        event,

      });

    } catch (
      error: any
    ) {

      return res.status(
        500
      ).json({

        success:
          false,

        error:
          error?.message ||
          'Failed to retrieve event.',

      });
    }
  }
);

/* =========================================================
   TRAFFIC ANALYTICS
========================================================= */

app.get(
  '/api/analytics/traffic',
  (
    req,
    res
  ) => {

    try {

      const cameraId =
        typeof req.query.cameraId ===
        'string'
          ? req.query.cameraId
          : undefined;

      const analytics =
        getTrafficAnalytics(
          cameraId
        );

      return res.json({

        success:
          true,

        analytics,

      });

    } catch (
      error: any
    ) {

      console.error(
        '[ANALYTICS] Failed:',
        error
      );

      return res.status(
        500
      ).json({

        success:
          false,

        error:
          error?.message ||
          'Failed to retrieve traffic analytics.',

      });
    }
  }
);

/* =========================================================
   WEBSOCKET
========================================================= */

const server =
  http.createServer(
    app
  );

const wss =
  new WebSocketServer({

    server,

    path:
      '/ws/live-stream',

  });

wss.on(
  'connection',
  (
    ws
  ) => {

    websocketClients.add(
      ws
    );

    console.log(
      `[WS] Client connected. ` +
      `Clients: ${websocketClients.size}`
    );

    /* -----------------------------------------------------
       INITIAL STATE
    ----------------------------------------------------- */

    ws.send(
      JSON.stringify({

        type:
          'INIT',

        cameras,

      })
    );

    /* -----------------------------------------------------
       DISCONNECT
    ----------------------------------------------------- */

    ws.on(
      'close',
      () => {

        websocketClients.delete(
          ws
        );

        console.log(
          `[WS] Client disconnected. ` +
          `Clients: ${websocketClients.size}`
        );

      }
    );

    /* -----------------------------------------------------
       ERROR
    ----------------------------------------------------- */

    ws.on(
      'error',
      () => {

        websocketClients.delete(
          ws
        );

      }
    );
  }
);

/* =========================================================
   START SERVER
========================================================= */
/* =========================================================
   BROWSER CAMERA STREAM
========================================================= */

app.get(
  '/api/cameras/:id/live',
  (
    req,
    res
  ) => {

    const camera =
      cameras.find(
        camera =>
          camera.id ===
          req.params.id
      );

    if (!camera) {
      return res.status(
        404
      ).json({
        success:
          false,

        error:
          'Camera not found',
      });
    }

    const password =
      camera.passwordPlain ||
      process.env.LOREX_PASSWORD;

    if (!password) {
      return res.status(
        500
      ).json({
        success:
          false,

        error:
          'Camera password is not configured.',
      });
    }

    const username =
      encodeURIComponent(
        camera.username
      );

    const encodedPassword =
      encodeURIComponent(
        password
      );

    /*
     * Dashboard uses Sub1.
     *
     * This is intentionally separate from
     * the AI raw-frame pipeline.
     */

    const rtspUrl =
      `rtsp://${username}:${encodedPassword}` +
      `@${camera.ip}:${camera.rtspPort}` +
      `/cam/realmonitor?channel=1&subtype=1`;

    const stream =
      browserStreamManager.start(
        camera.id,
        rtspUrl,
        704,
        576,
        10
      );

    stream.addClient(
      req,
      res
    );
  }
);

/* =========================================================
   BROWSER STREAM STATUS
========================================================= */

app.get(
  '/api/cameras/:id/live/status',
  (
    req,
    res
  ) => {

    const camera =
      cameras.find(
        camera =>
          camera.id ===
          req.params.id
      );

    if (!camera) {
      return res.status(
        404
      ).json({
        success:
          false,

        error:
          'Camera not found',
      });
    }

    const stats =
      browserStreamManager.getStats(
        camera.id
      );

    return res.json({
      success:
        true,

      cameraId:
        camera.id,

      stream:
        stats,
    });
  }
);

server.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log('');

    console.log(
      '================================'
    );

    console.log(
      ' QTS AVCLPR1'
    );

    console.log(
      ' AI VEHICLE INTELLIGENCE'
    );

    console.log(
      '================================'
    );

    console.log(
      `Server: http://localhost:${PORT}`
    );

    console.log(
      `Health: http://localhost:${PORT}/api/health`
    );

    console.log(
      `Cameras: http://localhost:${PORT}/api/cameras`
    );

    console.log(
      `RTSP Test: POST /api/cameras/test`
    );

    console.log(
      `Vehicle Events: /api/vehicle-events`
    );

    console.log(
      `Traffic Analytics: /api/analytics/traffic`
    );

    console.log(
      `WebSocket: ws://localhost:${PORT}/ws/live-stream`
    );

    console.log('');

  }
);
