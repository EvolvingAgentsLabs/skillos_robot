/**
 * ExternalCameraSource — Android phone overhead camera for V1 hardware
 *
 * Connects to an Android phone running IP Webcam (or DroidCam), mounted on
 * a tripod overlooking the arena. Provides overhead MJPEG frames to the
 * VisionLoop, replacing the ESP32-CAM in the V1 architecture.
 *
 * Architecture:
 *   Android Phone (tripod, top-down)
 *       ↓ MJPEG stream (WiFi)
 *   ExternalCameraSource (this module)
 *       ↓ frames
 *   VisionLoop → VLM inference → BytecodeCompiler → ESP32-S3
 *
 * Usage:
 *   const camera = new ExternalCameraSource({
 *     host: '192.168.1.50',
 *     port: 8080,
 *     path: '/video',
 *   });
 *
 *   // Capture a single frame
 *   const frame = await camera.captureFrame();
 *
 *   // Or get the MJPEG stream URL (for VisionLoop)
 *   const url = camera.getStreamUrl();
 *
 * The VisionLoop already handles MJPEG streams — this module provides
 * configuration helpers and health checking specific to the external
 * camera architecture.
 */

import * as http from 'http';
import { logger } from '../../shared/logger';
import { IpWebcamSensorSource, type SensorReading, type SensorSource } from '../../shared/sensor_source';

// =============================================================================
// Types
// =============================================================================

export interface ExternalCameraConfig {
  /** Phone IP address (e.g., '192.168.1.50') */
  host: string;
  /** HTTP port (IP Webcam default: 8080, DroidCam: 4747) */
  port: number;
  /** MJPEG stream path (IP Webcam: '/video', DroidCam: '/mjpegfeed') */
  path: string;
  /** Enable sensor data from IP Webcam (compass, accelerometer) */
  enableSensors: boolean;
  /** Connection check timeout in ms */
  healthCheckTimeoutMs: number;
}

export interface CameraHealth {
  reachable: boolean;
  streamActive: boolean;
  sensorsAvailable: boolean;
  latencyMs: number;
  resolution: string | null;
}

const DEFAULT_CONFIG: ExternalCameraConfig = {
  host: '192.168.1.50',
  port: 8080,
  path: '/video',
  enableSensors: true,
  healthCheckTimeoutMs: 5000,
};

// =============================================================================
// ExternalCameraSource
// =============================================================================

export class ExternalCameraSource {
  private config: ExternalCameraConfig;
  private sensorSource: SensorSource | null = null;

  constructor(config: Partial<ExternalCameraConfig> & { host: string }) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (this.config.enableSensors) {
      this.sensorSource = new IpWebcamSensorSource(this.config.host, this.config.port);
    }
  }

  /**
   * Get the MJPEG stream URL for use with VisionLoop.
   */
  getStreamUrl(): string {
    return `http://${this.config.host}:${this.config.port}${this.config.path}`;
  }

  /**
   * Get the sensor source for compass heading (IP Webcam only).
   * Returns null if sensors are not enabled or the app doesn't support them.
   */
  getSensorSource(): SensorSource | null {
    return this.sensorSource;
  }

  /**
   * Read the current compass heading from the phone's magnetometer.
   * Returns null if sensors are not enabled or unavailable.
   */
  async getHeading(): Promise<SensorReading | null> {
    if (!this.sensorSource) return null;
    return this.sensorSource.getHeading();
  }

  /**
   * Capture a single JPEG frame from the MJPEG stream.
   * Connects, reads one frame, disconnects. Useful for testing.
   */
  async captureFrame(timeoutMs?: number): Promise<Buffer | null> {
    const timeout = timeoutMs ?? this.config.healthCheckTimeoutMs;
    const url = this.getStreamUrl();

    return new Promise<Buffer | null>((resolve) => {
      const req = http.request(url, { timeout }, (res) => {
        if (res.statusCode !== 200) {
          req.destroy();
          resolve(null);
          return;
        }

        const chunks: Buffer[] = [];
        let resolved = false;

        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          const buffer = Buffer.concat(chunks);

          // Look for JPEG start (FFD8) and end (FFD9)
          const startIdx = buffer.indexOf(Buffer.from([0xFF, 0xD8]));
          if (startIdx === -1) return;

          const endIdx = buffer.indexOf(Buffer.from([0xFF, 0xD9]), startIdx + 2);
          if (endIdx === -1) return;

          // Extract the complete JPEG
          const jpeg = buffer.slice(startIdx, endIdx + 2);
          if (!resolved) {
            resolved = true;
            req.destroy();
            resolve(jpeg);
          }
        });

        res.on('end', () => {
          if (!resolved) resolve(null);
        });

        res.on('error', () => {
          if (!resolved) resolve(null);
        });
      });

      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });

      req.end();
    });
  }

  /**
   * Check the health of the external camera connection.
   * Tests reachability, stream availability, and sensor access.
   */
  async checkHealth(): Promise<CameraHealth> {
    const startTime = performance.now();
    const result: CameraHealth = {
      reachable: false,
      streamActive: false,
      sensorsAvailable: false,
      latencyMs: 0,
      resolution: null,
    };

    // Test stream reachability
    const frame = await this.captureFrame(this.config.healthCheckTimeoutMs);
    result.latencyMs = Math.round(performance.now() - startTime);

    if (frame) {
      result.reachable = true;
      result.streamActive = true;

      // Try to extract resolution from JPEG SOF0 marker
      result.resolution = extractJpegResolution(frame);
    }

    // Test sensor availability
    if (this.sensorSource) {
      const heading = await this.sensorSource.getHeading();
      result.sensorsAvailable = heading !== null;
    }

    return result;
  }

  /**
   * Log a formatted health report to the console.
   */
  async logHealthReport(): Promise<CameraHealth> {
    const health = await this.checkHealth();
    const url = this.getStreamUrl();

    logger.info('ExternalCamera', '--- External Camera Health Report ---');
    logger.info('ExternalCamera', `  URL:        ${url}`);
    logger.info('ExternalCamera', `  Reachable:  ${health.reachable ? 'YES' : 'NO'}`);
    logger.info('ExternalCamera', `  Stream:     ${health.streamActive ? 'ACTIVE' : 'INACTIVE'}`);
    logger.info('ExternalCamera', `  Sensors:    ${health.sensorsAvailable ? 'AVAILABLE' : 'N/A'}`);
    logger.info('ExternalCamera', `  Latency:    ${health.latencyMs}ms`);
    if (health.resolution) {
      logger.info('ExternalCamera', `  Resolution: ${health.resolution}`);
    }
    logger.info('ExternalCamera', '------------------------------------');

    return health;
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Extract width x height from a JPEG buffer by parsing the SOF0 marker.
 * Returns null if the marker is not found.
 */
function extractJpegResolution(jpeg: Buffer): string | null {
  // SOF0 marker: FF C0
  for (let i = 0; i < jpeg.length - 8; i++) {
    if (jpeg[i] === 0xFF && jpeg[i + 1] === 0xC0) {
      const height = jpeg.readUInt16BE(i + 5);
      const width = jpeg.readUInt16BE(i + 7);
      if (width > 0 && height > 0 && width < 10000 && height < 10000) {
        return `${width}x${height}`;
      }
    }
  }
  return null;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create an ExternalCameraSource from environment variables.
 * Uses ESP32_CAM_HOST/PORT/PATH (same vars, different device).
 */
export function createExternalCameraFromEnv(): ExternalCameraSource | null {
  const host = process.env.ESP32_CAM_HOST;
  if (!host) return null;

  const port = parseInt(process.env.ESP32_CAM_PORT || '8080', 10);
  const path = process.env.ESP32_CAM_PATH || '/video';
  const enableSensors = !!(process.env.IP_WEBCAM_HOST);

  return new ExternalCameraSource({ host, port, path, enableSensors });
}
