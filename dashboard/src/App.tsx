import {
  useEffect,
  useRef,
  useState,
} from 'react';

import './App.css';

const API_URL = 'http://localhost:3000';
const WS_URL = 'ws://localhost:3000/ws/live-stream';

interface Camera {
  id: string;
  name: string;
  ip: string;
  status: string;
  statusMessage?: string;
  location?: string;
  latencyMs?: number;
  streams?: {
    main?: {
      resolution?: string;
      fps?: number;
      codec?: string;
    };
    sub1?: {
      resolution?: string;
      fps?: number;
      codec?: string;
    };
    sub2?: {
      resolution?: string;
      fps?: number;
      codec?: string;
    };
  };
}

interface VehicleEvent {
  id: string;
  timestamp: string;
  cameraId: string;
  cameraName: string;
  trackingId: number;
  vehicleType: string;
  direction: 'IN' | 'OUT';
  confidence: number;
  plateNumber?: string;
  formattedPlate?: string;
  plateConfidence?: number;
  colorName?: string;
  speedKmh?: number;
  snapshotPath?: string;
  plateImagePath?: string;
  vehicleImagePath?: string;
  isWatchlisted?: boolean;
  watchlistCategory?: string;
  processingTimeMs?: number;
}

interface TrafficAnalytics {
  total: number;
  inbound: number;
  outbound: number;
  uniquePlates: number;
}

function App() {
  const [camera, setCamera] =
    useState<Camera | null>(null);

  const [events, setEvents] =
    useState<VehicleEvent[]>([]);

  const [selectedEvent, setSelectedEvent] =
    useState<VehicleEvent | null>(null);

  const [wsConnected, setWsConnected] =
    useState(false);

  const [streamConnected, setStreamConnected] =
    useState(false);

  const [streamKey, setStreamKey] =
    useState(Date.now());

  const [analytics, setAnalytics] =
    useState<TrafficAnalytics>({
      total: 0,
      inbound: 0,
      outbound: 0,
      uniquePlates: 0,
    });

  const [newEventId, setNewEventId] =
    useState<string | null>(null);

  const [lastEventTime, setLastEventTime] =
    useState<string | null>(null);

  const wsRef =
    useRef<WebSocket | null>(null);

  /* =========================================================
     LOAD CAMERA
  ========================================================= */

  useEffect(() => {
    fetch(`${API_URL}/api/cameras`)
      .then(response => response.json())
      .then(data => {
        const cameras =
          Array.isArray(data)
            ? data
            : data.cameras || [];

        if (cameras.length > 0) {
          setCamera(cameras[0]);
        }
      })
      .catch(error => {
        console.error(
          '[CAMERA] Load failed:',
          error
        );
      });
  }, []);

  /* =========================================================
     LOAD EVENTS
  ========================================================= */

  useEffect(() => {
    fetch(
      `${API_URL}/api/vehicle-events?limit=100`
    )
      .then(response => response.json())
      .then(data => {
        if (
          data.events &&
          Array.isArray(data.events)
        ) {
          setEvents(data.events);
        }
      })
      .catch(error => {
        console.error(
          '[EVENTS] Load failed:',
          error
        );
      });
  }, []);

  /* =========================================================
     LOAD TRAFFIC ANALYTICS
  ========================================================= */

  const loadAnalytics = () => {
    fetch(
      `${API_URL}/api/analytics/traffic`
    )
      .then(response => response.json())
      .then(data => {
        if (data.analytics) {
          setAnalytics(data.analytics);
        }
      })
      .catch(error => {
        console.error(
          '[ANALYTICS] Load failed:',
          error
        );
      });
  };

  useEffect(() => {
    loadAnalytics();

    const timer =
      setInterval(
        loadAnalytics,
        5000
      );

    return () =>
      clearInterval(timer);
  }, []);

  /* =========================================================
     WEBSOCKET
  ========================================================= */

  useEffect(() => {
    let reconnectTimer:
      ReturnType<typeof setTimeout>;

    let destroyed = false;

    const connect = () => {
      if (destroyed) {
        return;
      }

      console.log(
        '[WS] Connecting...'
      );

      const ws =
        new WebSocket(
          WS_URL
        );

      wsRef.current = ws;

      ws.onopen = () => {
        console.log(
          '[WS] Connected'
        );

        setWsConnected(true);
      };

      ws.onmessage = message => {
        try {
          const data =
            JSON.parse(
              message.data
            );

          /* -----------------------------------------------
             INITIAL STATE
          ------------------------------------------------ */

          if (
            data.type === 'INIT'
          ) {
            if (
              data.cameras &&
              data.cameras.length
            ) {
              setCamera(
                data.cameras[0]
              );
            }
          }

          /* -----------------------------------------------
             CAMERA STATUS
          ------------------------------------------------ */

          if (
            data.type ===
            'CAMERA_STATUS_UPDATED'
          ) {
            if (data.camera) {
              setCamera(
                data.camera
              );
            }
          }

          /* -----------------------------------------------
             CAMERA TEST
          ------------------------------------------------ */

          if (
            data.type ===
            'CAMERA_TEST_COMPLETED'
          ) {
            if (data.camera) {
              setCamera(
                data.camera
              );
            }
          }

          /* -----------------------------------------------
             VEHICLE EVENT
          ------------------------------------------------ */

          if (
            data.type ===
            'VEHICLE_EVENT_CREATED'
          ) {
            const event:
              VehicleEvent =
              data.event;

            if (!event) {
              return;
            }

            console.log(
              '[WS] Vehicle event:',
              event
            );

            setEvents(
              previous =>
                [
                  event,
                  ...previous.filter(
                    item =>
                      item.id !==
                      event.id
                  ),
                ].slice(
                  0,
                  100
                )
            );

            setNewEventId(
              event.id
            );

            setLastEventTime(
              event.timestamp
            );

            setSelectedEvent(
              event
            );

            loadAnalytics();

            setTimeout(
              () => {
                setNewEventId(
                  null
                );
              },
              2500
            );
          }
        } catch (error) {
          console.error(
            '[WS] Invalid message:',
            error
          );
        }
      };

      ws.onclose = () => {
        console.log(
          '[WS] Disconnected'
        );

        setWsConnected(false);

        if (!destroyed) {
          reconnectTimer =
            setTimeout(
              connect,
              3000
            );
        }
      };

      ws.onerror = error => {
        console.error(
          '[WS] Error:',
          error
        );
      };
    };

    connect();

    return () => {
      destroyed = true;

      clearTimeout(
        reconnectTimer
      );

      wsRef.current?.close();
    };
  }, []);

  /* =========================================================
     STREAM STATUS
  ========================================================= */

  useEffect(() => {
    if (!camera) {
      return;
    }

    const checkStream = () => {
      fetch(
        `${API_URL}/api/cameras/${camera.id}/live/status`
      )
        .then(response =>
          response.json()
        )
        .then(data => {
          setStreamConnected(
            Boolean(
              data.stream?.connected
            )
          );
        })
        .catch(() => {
          setStreamConnected(false);
        });
    };

    checkStream();

    const timer =
      setInterval(
        checkStream,
        3000
      );

    return () =>
      clearInterval(timer);
  }, [camera]);

  /* =========================================================
     STREAM ERROR
  ========================================================= */

  const handleStreamError = () => {
    console.error(
      '[LIVE] Stream failed'
    );

    setStreamConnected(false);

    setTimeout(() => {
      setStreamKey(
        Date.now()
      );
    }, 2000);
  };

  /* =========================================================
     FORMATTERS
  ========================================================= */

  const formatTime = (
    timestamp?: string
  ) => {
    if (!timestamp) {
      return '--:--:--';
    }

    return new Date(
      timestamp
    ).toLocaleTimeString(
      [],
      {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }
    );
  };

  const formatDate = (
    timestamp?: string
  ) => {
    if (!timestamp) {
      return '--';
    }

    return new Date(
      timestamp
    ).toLocaleDateString(
      [],
      {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      }
    );
  };

  const confidence = (
    value?: number
  ) => {
    if (
      value === undefined ||
      value === null
    ) {
      return '--';
    }

    return `${(
      value * 100
    ).toFixed(1)}%`;
  };

  const displayPlate = (
    event: VehicleEvent
  ) => {
    return (
      event.formattedPlate ||
      event.plateNumber ||
      'READING...'
    );
  };

  /* =========================================================
     RENDER
  ========================================================= */

  return (
    <div className="command-center">

      {/* =====================================================
          TOP BAR
      ===================================================== */}

      <header className="topbar">

        <div className="brand-area">

          <div className="brand">
            QTS
          </div>

          <div>
            <div className="brand-title">
              AVCLPR1
            </div>

            <div className="brand-subtitle">
              AI VEHICLE INTELLIGENCE
              COMMAND CENTER
            </div>
          </div>

        </div>

        <div className="topbar-right">

          <div className="system-clock">
            {lastEventTime
              ? `LAST EVENT ${formatTime(
                  lastEventTime
                )}`
              : 'SYSTEM MONITORING'}
          </div>

          <div className="system-status">

            <span
              className={
                wsConnected
                  ? 'status-dot online'
                  : 'status-dot offline'
              }
            />

            <span>
              WEBSOCKET
            </span>

            <strong>
              {wsConnected
                ? 'CONNECTED'
                : 'DISCONNECTED'}
            </strong>

          </div>

        </div>

      </header>


      {/* =====================================================
          SYSTEM METRICS
      ===================================================== */}

      <section className="metrics-bar">

        <div className="metric">
          <span>
            VEHICLES TODAY
          </span>

          <strong>
            {analytics.total}
          </strong>
        </div>

        <div className="metric">
          <span>
            INBOUND
          </span>

          <strong className="green">
            {analytics.inbound}
          </strong>
        </div>

        <div className="metric">
          <span>
            OUTBOUND
          </span>

          <strong className="amber">
            {analytics.outbound}
          </strong>
        </div>

        <div className="metric">
          <span>
            UNIQUE PLATES
          </span>

          <strong>
            {analytics.uniquePlates}
          </strong>
        </div>

        <div className="metric">
          <span>
            CAMERA
          </span>

          <strong
            className={
              streamConnected
                ? 'green'
                : 'red'
            }
          >
            {streamConnected
              ? 'ONLINE'
              : 'OFFLINE'}
          </strong>
        </div>

      </section>


      {/* =====================================================
          MAIN GRID
      ===================================================== */}

      <main className="main-grid">


        {/* ===================================================
            CAMERA
        =================================================== */}

        <section className="camera-section">

          <div className="panel-header">

            <div>

              <h1>
                LIVE CAMERA
              </h1>

              <span>
                {camera?.name ||
                  'Loading camera...'}
              </span>

            </div>

            <div className="camera-status">

              <span
                className={
                  streamConnected
                    ? 'status-dot online'
                    : 'status-dot offline'
                }
              />

              {streamConnected
                ? 'LIVE'
                : 'CONNECTING'}

            </div>

          </div>


          <div className="video-container">

            {camera ? (
              <img
                key={streamKey}
                className="live-video"
                src={
                  `${API_URL}/api/cameras/${camera.id}/live?key=${streamKey}`
                }
                alt="Live camera"
                onLoad={() =>
                  setStreamConnected(
                    true
                  )
                }
                onError={
                  handleStreamError
                }
              />
            ) : (
              <div className="video-loading">
                INITIALIZING CAMERA...
              </div>
            )}


            <div className="video-overlay">

              <span>
                ● LIVE
              </span>

              <span>
                {camera?.name}
              </span>

              <span>
                {camera?.ip}
              </span>

              <span>
                704 × 576
              </span>

            </div>

          </div>


          <div className="camera-info">

            <div>
              <span>
                CAMERA ID
              </span>

              <strong>
                {camera?.id || '--'}
              </strong>
            </div>

            <div>
              <span>
                LOCATION
              </span>

              <strong>
                {camera?.location ||
                  'UNSPECIFIED'}
              </strong>
            </div>

            <div>
              <span>
                LATENCY
              </span>

              <strong>
                {camera?.latencyMs ||
                  0}{' '}
                ms
              </strong>
            </div>

            <div>
              <span>
                STREAM
              </span>

              <strong>
                MJPEG / FFmpeg
              </strong>
            </div>

          </div>

        </section>


        {/* ===================================================
            EVENT FEED
        =================================================== */}

        <aside className="event-section">

          <div className="panel-header">

            <div>

              <h1>
                LIVE EVENT FEED
              </h1>

              <span>
                Real-time vehicle detections
              </span>

            </div>

            <span className="event-live">
              ● LIVE
            </span>

          </div>


          <div className="event-feed">

            {events.length === 0 ? (
              <div className="empty-events">

                <div className="empty-icon">
                  ◉
                </div>

                <strong>
                  NO VEHICLE EVENTS
                </strong>

                <small>
                  Waiting for AI detections...
                </small>

              </div>
            ) : (
              events.map(event => (
                <button
                  type="button"
                  className={
                    `event-card ${
                      selectedEvent?.id ===
                      event.id
                        ? 'selected'
                        : ''
                    } ${
                      newEventId ===
                      event.id
                        ? 'new-event'
                        : ''
                    }`
                  }
                  key={event.id}
                  onClick={() =>
                    setSelectedEvent(
                      event
                    )
                  }
                >

                  <div className="event-card-header">

                    <div className="event-type">

                      <span
                        className={
                          event.direction ===
                          'IN'
                            ? 'direction-icon inbound-icon'
                            : 'direction-icon outbound-icon'
                        }
                      >
                        {event.direction ===
                        'IN'
                          ? '↗'
                          : '↙'}
                      </span>

                      <div>

                        <strong>
                          {event.vehicleType.toUpperCase()}
                        </strong>

                        <small>
                          TRACK #
                          {event.trackingId}
                        </small>

                      </div>

                    </div>

                    <span
                      className={
                        event.direction ===
                        'IN'
                          ? 'direction in'
                          : 'direction out'
                      }
                    >
                      {event.direction}
                    </span>

                  </div>


                  <div className="plate-display">

                    <span>
                      LICENSE PLATE
                    </span>

                    <strong>
                      {displayPlate(
                        event
                      )}
                    </strong>

                  </div>


                  <div className="event-data-grid">

                    <div>
                      <span>
                        DETECTION
                      </span>

                      <strong>
                        {confidence(
                          event.confidence
                        )}
                      </strong>
                    </div>

                    <div>
                      <span>
                        PLATE CONF.
                      </span>

                      <strong>
                        {confidence(
                          event.plateConfidence
                        )}
                      </strong>
                    </div>

                    <div>
                      <span>
                        SPEED
                      </span>

                      <strong>
                        {event.speedKmh !==
                        undefined
                          ? `${event.speedKmh.toFixed(
                              0
                            )} km/h`
                          : '--'}
                      </strong>
                    </div>

                  </div>


                  <div className="event-footer">

                    <span>
                      {formatTime(
                        event.timestamp
                      )}
                    </span>

                    <span>
                      {event.cameraName}
                    </span>

                  </div>

                </button>
              ))
            )}

          </div>

        </aside>

      </main>


      {/* =====================================================
          EVENT DETAIL
      ===================================================== */}

      {selectedEvent && (
        <section className="detail-panel">

          <div className="detail-header">

            <div>
              <span>
                SELECTED EVENT
              </span>

              <strong>
                {selectedEvent.id}
              </strong>
            </div>

            <button
              type="button"
              onClick={() =>
                setSelectedEvent(null)
              }
            >
              CLOSE
            </button>

          </div>


          <div className="detail-grid">

            <div className="detail-main">

              <div className="detail-plate">
                {displayPlate(
                  selectedEvent
                )}
              </div>

              <div className="detail-meta">

                <span>
                  {selectedEvent.vehicleType.toUpperCase()}
                </span>

                <span>
                  {selectedEvent.direction}
                </span>

                <span>
                  {formatDate(
                    selectedEvent.timestamp
                  )}
                </span>

                <span>
                  {formatTime(
                    selectedEvent.timestamp
                  )}
                </span>

              </div>

            </div>


            <div className="detail-stat">
              <span>
                DETECTION CONFIDENCE
              </span>

              <strong>
                {confidence(
                  selectedEvent.confidence
                )}
              </strong>
            </div>

            <div className="detail-stat">
              <span>
                PLATE CONFIDENCE
              </span>

              <strong>
                {confidence(
                  selectedEvent.plateConfidence
                )}
              </strong>
            </div>

            <div className="detail-stat">
              <span>
                SPEED
              </span>

              <strong>
                {selectedEvent.speedKmh !==
                undefined
                  ? `${selectedEvent.speedKmh.toFixed(
                      0
                    )} km/h`
                  : '--'}
              </strong>
            </div>

            <div className="detail-stat">
              <span>
                COLOR
              </span>

              <strong>
                {selectedEvent.colorName ||
                  '--'}
              </strong>
            </div>

            <div className="detail-stat">
              <span>
                CAMERA
              </span>

              <strong>
                {selectedEvent.cameraName}
              </strong>
            </div>

            <div className="detail-stat">
              <span>
                PROCESSING
              </span>

              <strong>
                {selectedEvent.processingTimeMs !==
                undefined
                  ? `${selectedEvent.processingTimeMs} ms`
                  : '--'}
              </strong>
            </div>

          </div>

        </section>
      )}

    </div>
  );
}

export default App;