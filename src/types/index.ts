export type CameraStatus =
  | 'connected'
  | 'checking'
  | 'timeout'
  | 'offline'
  | 'error';

export type StreamStatus =
  | 'connected'
  | 'auth_failed'
  | 'stream_unavailable'
  | 'network_unreachable'
  | 'invalid_url'
  | 'timeout';

export type StreamType =
  | 'main'
  | 'sub1'
  | 'sub2';

export type VehicleDirection =
  | 'IN'
  | 'OUT';

export interface CameraStream {
  status: StreamStatus;
  url: string;
  name: string;
  resolution: string;
  fps: number;
  bitrateKbps: number;
  codec: string;
  latencyMs: number;
  message: string;
}

export interface Camera {
  id: string;
  name: string;
  ip: string;
  rtspPort: number;
  username: string;

  passwordPlain?: string;
  hasPassword?: boolean;

  location?: string;

  latitude?: number;
  longitude?: number;

  status: CameraStatus;
  statusMessage?: string;

  latencyMs?: number;
  lastSeen?: string;
  lastUpdated?: string;

  mainStreamUrl?: string;
  subStream1Url?: string;
  subStream2Url?: string;

  streams?: {
    main?: CameraStream;
    sub1?: CameraStream;
    sub2?: CameraStream;
  };
}

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  name: string;
  role: string;
}

export interface WatchlistEntry {
  id: string;
  plateNumber: string;
  category: string;
  description: string;
  vehicleType: string;
  ownerName?: string;
  notes?: string;
  alertEnabled: boolean;
  createdAt: string;
  sightingCount: number;
}

export interface VehicleEvent {
  id: string;

  timestamp: string;

  cameraId: string;
  cameraName: string;

  trackingId: number;

  vehicleType: string;

  direction: VehicleDirection;

  confidence: number;

  plateNumber?: string;
  formattedPlate?: string;
  plateConfidence?: number;

  colorName?: string;

  speedKmh?: number;

  snapshotPath?: string;
  plateImagePath?: string;
  vehicleImagePath?: string;

  latitude?: number;
  longitude?: number;

  isWatchlisted?: boolean;
  watchlistCategory?: string;

  processingTimeMs?: number;
}

export interface Alert {
  id: string;
  timestamp: string;

  type: string;
  severity: string;

  plateNumber?: string;

  cameraId?: string;
  cameraName?: string;

  category?: string;
  description?: string;

  status: 'active' | 'dismissed';
}