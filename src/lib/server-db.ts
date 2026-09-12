import {
  Camera,
  User,
  WatchlistEntry,
  Alert,
  VehicleEvent,
} from '../types/index.js';

import bcrypt from 'bcryptjs';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';

/* =========================================================
   DATABASE
========================================================= */

const DATA_DIR = path.resolve('data');
const DATABASE_PATH = path.join(
  DATA_DIR,
  'avclpr1.db'
);

fs.mkdirSync(
  DATA_DIR,
  {
    recursive: true,
  }
);

export const db =
  new DatabaseSync(
    DATABASE_PATH
  );

/* =========================================================
   DATABASE SCHEMA
========================================================= */

db.exec(`
  CREATE TABLE IF NOT EXISTS vehicle_events (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,

    camera_id TEXT NOT NULL,
    camera_name TEXT NOT NULL,

    tracking_id INTEGER NOT NULL,

    vehicle_type TEXT NOT NULL,
    direction TEXT NOT NULL,

    confidence REAL NOT NULL,

    plate_number TEXT,
    formatted_plate TEXT,
    plate_confidence REAL,

    color_name TEXT,

    speed_kmh REAL,

    snapshot_path TEXT,
    plate_image_path TEXT,
    vehicle_image_path TEXT,

    latitude REAL,
    longitude REAL,

    is_watchlisted INTEGER DEFAULT 0,
    watchlist_category TEXT,

    processing_time_ms INTEGER,

    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_vehicle_events_timestamp
  ON vehicle_events(timestamp);

  CREATE INDEX IF NOT EXISTS idx_vehicle_events_camera
  ON vehicle_events(camera_id);

  CREATE INDEX IF NOT EXISTS idx_vehicle_events_direction
  ON vehicle_events(direction);

  CREATE INDEX IF NOT EXISTS idx_vehicle_events_plate
  ON vehicle_events(plate_number);

  CREATE INDEX IF NOT EXISTS idx_vehicle_events_vehicle_type
  ON vehicle_events(vehicle_type);
`);

/* =========================================================
   CAMERAS
========================================================= */

export const cameras: Camera[] = [
  {
    id: 'cam_lorex_01',

    name:
      'Lorex Highway Camera 01',

    ip:
      '192.168.0.100',

    rtspPort:
      554,

    username:
      'admin',

    hasPassword:
      !!process.env.LOREX_PASSWORD,

    location:
      'Highway Monitoring Point 01',

    status:
      'offline',

    statusMessage:
      'Camera not tested yet.',

    streams: {},
  },
];

/* =========================================================
   USERS
========================================================= */

export const users: User[] = [
  {
    id:
      'user_admin',

    username:
      'admin',

    name:
      'System Administrator',

    role:
      'admin',

    passwordHash:
      bcrypt.hashSync(
        'admin123',
        10
      ),
  },
];

/* =========================================================
   WATCHLIST
========================================================= */

export const watchlist:
  WatchlistEntry[] = [];

/* =========================================================
   ALERTS
========================================================= */

export const alerts:
  Alert[] = [];

/* =========================================================
   VEHICLE EVENT HELPERS
========================================================= */

function rowToVehicleEvent(
  row: any
): VehicleEvent {

  return {
    id:
      row.id,

    timestamp:
      row.timestamp,

    cameraId:
      row.camera_id,

    cameraName:
      row.camera_name,

    trackingId:
      Number(
        row.tracking_id
      ),

    vehicleType:
      row.vehicle_type,

    direction:
      row.direction,

    confidence:
      Number(
        row.confidence
      ),

    plateNumber:
      row.plate_number ??
      undefined,

    formattedPlate:
      row.formatted_plate ??
      undefined,

    plateConfidence:
      row.plate_confidence != null
        ? Number(
            row.plate_confidence
          )
        : undefined,

    colorName:
      row.color_name ??
      undefined,

    speedKmh:
      row.speed_kmh != null
        ? Number(
            row.speed_kmh
          )
        : undefined,

    snapshotPath:
      row.snapshot_path ??
      undefined,

    plateImagePath:
      row.plate_image_path ??
      undefined,

    vehicleImagePath:
      row.vehicle_image_path ??
      undefined,

    latitude:
      row.latitude != null
        ? Number(
            row.latitude
          )
        : undefined,

    longitude:
      row.longitude != null
        ? Number(
            row.longitude
          )
        : undefined,

    isWatchlisted:
      Boolean(
        row.is_watchlisted
      ),

    watchlistCategory:
      row.watchlist_category ??
      undefined,

    processingTimeMs:
      row.processing_time_ms != null
        ? Number(
            row.processing_time_ms
          )
        : undefined,
  };
}

/* =========================================================
   CREATE VEHICLE EVENT
========================================================= */

export function createVehicleEvent(
  event: VehicleEvent
): VehicleEvent {

  const statement =
    db.prepare(`
      INSERT INTO vehicle_events (
        id,
        timestamp,

        camera_id,
        camera_name,

        tracking_id,

        vehicle_type,
        direction,

        confidence,

        plate_number,
        formatted_plate,
        plate_confidence,

        color_name,

        speed_kmh,

        snapshot_path,
        plate_image_path,
        vehicle_image_path,

        latitude,
        longitude,

        is_watchlisted,
        watchlist_category,

        processing_time_ms,

        created_at
      )
      VALUES (
        ?,
        ?,

        ?,
        ?,

        ?,

        ?,
        ?,

        ?,

        ?,
        ?,
        ?,

        ?,

        ?,

        ?,
        ?,
        ?,

        ?,
        ?,

        ?,
        ?,

        ?,

        ?
      )
    `);

  const createdAt =
    new Date()
      .toISOString();

  statement.run(
    event.id,
    event.timestamp,

    event.cameraId,
    event.cameraName,

    event.trackingId,

    event.vehicleType,
    event.direction,

    event.confidence,

    event.plateNumber ??
      null,

    event.formattedPlate ??
      null,

    event.plateConfidence ??
      null,

    event.colorName ??
      null,

    event.speedKmh ??
      null,

    event.snapshotPath ??
      null,

    event.plateImagePath ??
      null,

    event.vehicleImagePath ??
      null,

    event.latitude ??
      null,

    event.longitude ??
      null,

    event.isWatchlisted
      ? 1
      : 0,

    event.watchlistCategory ??
      null,

    event.processingTimeMs ??
      null,

    createdAt
  );

  return event;
}

/* =========================================================
   GET VEHICLE EVENT BY ID
========================================================= */

export function getVehicleEventById(
  id: string
): VehicleEvent | null {

  const statement =
    db.prepare(`
      SELECT *
      FROM vehicle_events
      WHERE id = ?
      LIMIT 1
    `);

  const row =
    statement.get(
      id
    );

  if (!row) {
    return null;
  }

  return rowToVehicleEvent(
    row
  );
}

/* =========================================================
   GET VEHICLE EVENTS
========================================================= */

export interface VehicleEventQuery {
  cameraId?: string;
  direction?: 'IN' | 'OUT';
  vehicleType?: string;
  plateNumber?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export function getVehicleEvents(
  query: VehicleEventQuery = {}
) {

  const conditions:
    string[] = [];

  const parameters:
    any[] = [];

  if (query.cameraId) {

    conditions.push(
      'camera_id = ?'
    );

    parameters.push(
      query.cameraId
    );
  }

  if (query.direction) {

    conditions.push(
      'direction = ?'
    );

    parameters.push(
      query.direction
    );
  }

  if (query.vehicleType) {

    conditions.push(
      'vehicle_type = ?'
    );

    parameters.push(
      query.vehicleType
    );
  }

  if (query.plateNumber) {

    conditions.push(
      'plate_number LIKE ?'
    );

    parameters.push(
      `%${query.plateNumber}%`
    );
  }

  if (query.from) {

    conditions.push(
      'timestamp >= ?'
    );

    parameters.push(
      query.from
    );
  }

  if (query.to) {

    conditions.push(
      'timestamp <= ?'
    );

    parameters.push(
      query.to
    );
  }

  const where =
    conditions.length > 0
      ? `WHERE ${conditions.join(
          ' AND '
        )}`
      : '';

  const limit =
    Math.min(
      Math.max(
        Number(
          query.limit ?? 100
        ),
        1
      ),
      500
    );

  const offset =
    Math.max(
      Number(
        query.offset ?? 0
      ),
      0
    );

  const countStatement =
    db.prepare(`
      SELECT COUNT(*) AS total
      FROM vehicle_events
      ${where}
    `);

  const countRow =
    countStatement.get(
      ...parameters
    ) as any;

  const statement =
    db.prepare(`
      SELECT *
      FROM vehicle_events
      ${where}
      ORDER BY timestamp DESC
      LIMIT ?
      OFFSET ?
    `);

  const rows =
    statement.all(
      ...parameters,
      limit,
      offset
    );

  return {
    events:
      rows.map(
        rowToVehicleEvent
      ),

    total:
      Number(
        countRow?.total ?? 0
      ),

    limit,

    offset,
  };
}

/* =========================================================
   TRAFFIC ANALYTICS
========================================================= */

export function getTrafficAnalytics(
  cameraId?: string
) {

  const conditions:
    string[] = [];

  const parameters:
    any[] = [];

  const today =
    new Date()
      .toISOString()
      .slice(
        0,
        10
      );

  conditions.push(
    'timestamp LIKE ?'
  );

  parameters.push(
    `${today}%`
  );

  if (cameraId) {

    conditions.push(
      'camera_id = ?'
    );

    parameters.push(
      cameraId
    );
  }

  const where =
    `WHERE ${conditions.join(
      ' AND '
    )}`;

  const statement =
    db.prepare(`
      SELECT

        COUNT(*) AS total,

        SUM(
          CASE
            WHEN direction = 'IN'
            THEN 1
            ELSE 0
          END
        ) AS inbound,

        SUM(
          CASE
            WHEN direction = 'OUT'
            THEN 1
            ELSE 0
          END
        ) AS outbound,

        COUNT(
          DISTINCT plate_number
        ) AS unique_plates

      FROM vehicle_events

      ${where}
    `);

  const row =
    statement.get(
      ...parameters
    ) as any;

  return {

    total:
      Number(
        row?.total ?? 0
      ),

    inbound:
      Number(
        row?.inbound ?? 0
      ),

    outbound:
      Number(
        row?.outbound ?? 0
      ),

    uniquePlates:
      Number(
        row?.unique_plates ?? 0
      ),
  };
}

/* =========================================================
   SYSTEM HEALTH
========================================================= */

export function getSystemHealthMetrics() {

  const memory =
    process.memoryUsage();

  const eventCount =
    db.prepare(`
      SELECT COUNT(*) AS total
      FROM vehicle_events
    `).get() as any;

  return {

    status:
      'healthy',

    uptimeSeconds:
      Math.round(
        process.uptime()
      ),

    memoryUsageMb:
      Math.round(
        memory.rss /
        1024 /
        1024
      ),

    nodeVersion:
      process.version,

    database:
      'sqlite',

    databasePath:
      DATABASE_PATH,

    vehicleEvents:
      Number(
        eventCount?.total ?? 0
      ),

    timestamp:
      new Date()
        .toISOString(),
  };
}