/**
 * SemanticMapLoop — Background sidecar that builds a topological map
 *
 * Listens to VisionLoop's 'bytecode' events and periodically runs
 * SemanticMap.processScene() in the background. Never blocks motor control.
 */

import { EventEmitter } from 'events';
import { logger } from '../shared/logger';
import { SemanticMap, type SceneAnalysis } from './semantic_map';
import type { VisionLoop } from '../2_qwen_cerebellum/vision_loop';
import type { InferenceFunction } from '../llmunix-core/interfaces';
import { BytecodeCompiler, Opcode } from '../2_qwen_cerebellum/bytecode_compiler';
import { UDPTransmitter } from '../2_qwen_cerebellum/udp_transmitter';
import type { SensorSource } from '../shared/sensor_source';

// =============================================================================
// Types
// =============================================================================

export interface SemanticMapLoopConfig {
  /** Minimum seconds between background analyses (default: 60) */
  analyzeIntervalSec: number;
  /** Whether the loop is enabled (default: true) */
  enabled: boolean;
}

const DEFAULT_CONFIG: SemanticMapLoopConfig = {
  analyzeIntervalSec: 60,
  enabled: true,
};

// =============================================================================
// SemanticMapLoop
// =============================================================================

export class SemanticMapLoop extends EventEmitter {
  private config: SemanticMapLoopConfig;
  private semanticMap: SemanticMap;
  private visionLoop: VisionLoop;
  private infer: InferenceFunction;
  private compiler: BytecodeCompiler;
  private transmitter: UDPTransmitter;
  private sensorSource?: SensorSource;

  private running = false;
  private analyzing = false;
  private lastAnalysisTime = 0;
  private bytecodeListener: (() => void) | null = null;

  constructor(
    semanticMap: SemanticMap,
    visionLoop: VisionLoop,
    infer: InferenceFunction,
    compiler: BytecodeCompiler,
    transmitter: UDPTransmitter,
    config?: Partial<SemanticMapLoopConfig>,
    sensorSource?: SensorSource,
  ) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.semanticMap = semanticMap;
    this.visionLoop = visionLoop;
    this.infer = infer;
    this.compiler = compiler;
    this.transmitter = transmitter;
    this.sensorSource = sensorSource;
  }

  /**
   * Start listening to VisionLoop events and running background analyses.
   */
  start(): void {
    if (!this.config.enabled || this.running) return;
    this.running = true;

    this.bytecodeListener = () => {
      this.onBytecode();
    };
    this.visionLoop.on('bytecode', this.bytecodeListener);

    logger.info('SemanticMapLoop', `Started (interval: ${this.config.analyzeIntervalSec}s)`);
  }

  /**
   * Stop the loop and detach from VisionLoop.
   */
  stop(): void {
    this.running = false;

    if (this.bytecodeListener) {
      this.visionLoop.removeListener('bytecode', this.bytecodeListener);
      this.bytecodeListener = null;
    }

    logger.info('SemanticMapLoop', 'Stopped');
  }

  /**
   * Run an on-demand analysis right now (ignores interval timer).
   * Returns the SceneAnalysis or null on failure.
   */
  async analyzeNow(): Promise<SceneAnalysis | null> {
    return this.runAnalysis();
  }

  /**
   * Get the underlying SemanticMap.
   */
  getSemanticMap(): SemanticMap {
    return this.semanticMap;
  }

  isRunning(): boolean {
    return this.running;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Called on every VisionLoop 'bytecode' event. Fires-and-forgets a background
   * analysis if enough time has elapsed. Never awaited — never blocks.
   */
  private onBytecode(): void {
    const now = Date.now();
    const intervalMs = this.config.analyzeIntervalSec * 1000;

    if (now - this.lastAnalysisTime < intervalMs) return;
    if (this.analyzing) return;
    if (!this.running) return;

    // Fire-and-forget — never block VisionLoop
    this.runAnalysis().catch((err) => {
      logger.error('SemanticMapLoop', 'Background analysis error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Run a single scene analysis cycle. Protected by the `analyzing` mutex.
   */
  private async runAnalysis(): Promise<SceneAnalysis | null> {
    if (this.analyzing) return null;
    this.analyzing = true;

    try {
      // Get the latest camera frame
      const frameBase64 = this.visionLoop.getLatestFrameBase64();
      if (!frameBase64) {
        logger.debug('SemanticMapLoop', 'No frame available, skipping analysis');
        return null;
      }

      // Get scene description from VLM
      const sceneDescription = await this.infer(
        'You are a robot with a camera. Describe what you see in detail. Focus on the type of room/location, key features, and visible exits or paths.',
        'Describe the current scene for spatial mapping.',
        [frameBase64],
      );

      // Get current pose from ESP32
      let pose: { x: number; y: number; heading: number } | undefined;
      try {
        const statusFrame = this.compiler.createFrame(Opcode.GET_STATUS);
        const response = await this.transmitter.sendAndReceive(statusFrame, 2000);
        const status = JSON.parse(response.toString());
        pose = {
          x: status.pose?.x ?? 0,
          y: status.pose?.y ?? 0,
          heading: (status.pose?.h ?? 0) * 180 / Math.PI,
        };
      } catch {
        logger.debug('SemanticMapLoop', 'Could not get pose, proceeding without');
      }

      // Override heading with compass if SensorSource is available
      if (this.sensorSource) {
        const compassReading = await this.sensorSource.getHeading();
        if (compassReading) {
          const odometryHeading = pose?.heading;
          if (!pose) {
            pose = { x: 0, y: 0, heading: compassReading.heading };
          } else {
            pose.heading = compassReading.heading;
          }
          logger.info('SemanticMapLoop', `Using compass heading: ${compassReading.heading.toFixed(1)}deg` +
            (odometryHeading !== undefined ? ` (replacing odometry: ${odometryHeading.toFixed(1)}deg)` : ''));
        }
      }

      // Process the scene through SemanticMap
      const result = await this.semanticMap.processScene(sceneDescription, pose);

      this.lastAnalysisTime = Date.now();
      this.emit('analysis', {
        nodeId: result.nodeId,
        isNew: result.isNew,
        analysis: result.analysis,
      });

      logger.info('SemanticMapLoop', `Analyzed: ${result.analysis.locationLabel} (${result.isNew ? 'new' : 'revisit'} node ${result.nodeId})`);
      return result.analysis;
    } catch (err) {
      logger.error('SemanticMapLoop', 'Analysis failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      this.analyzing = false;
    }
  }
}
