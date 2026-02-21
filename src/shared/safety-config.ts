/**
 * Firmware Safety Config — TypeScript mirror of safety_layer.h
 *
 * Host-side safety parameter types, validation, and clamping logic.
 * Safety limits (max steps, timeouts) are hardcoded in the C++ safety_layer.h
 * and cannot be overridden by the host — only the SET_SPEED bytecode opcode
 * (0x09) can adjust speed/acceleration at runtime.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FirmwareSafetyConfig {
  maxMotorPWM: number;
  emergencyStopCm: number;
  speedReduceCm: number;
  maxContinuousMs: number;
  hostTimeoutMs: number;
  minBatteryVoltage: number;
}

export interface FirmwareSafetyStatus {
  emergencyStopped: boolean;
  motorRunning: boolean;
  currentMaxPWM: number;
  violations: number;
  motorRuntimeMs: number;
  lastBatteryVoltage: number;
  hostTimeoutRemaining: number;
}

// ---------------------------------------------------------------------------
// Default config (mirrors firmware defaults in safety_layer.h)
// ---------------------------------------------------------------------------

export const DEFAULT_FIRMWARE_SAFETY_CONFIG: FirmwareSafetyConfig = {
  maxMotorPWM: 200,
  emergencyStopCm: 8,
  speedReduceCm: 20,
  maxContinuousMs: 30000,
  hostTimeoutMs: 5000,
  minBatteryVoltage: 3.0,
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a (possibly partial) FirmwareSafetyConfig. Returns an object
 * indicating whether the config is valid and, if not, a list of
 * human-readable error strings.
 */
export function validateSafetyConfig(
  config: Partial<FirmwareSafetyConfig>,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // maxMotorPWM: 0-255
  if (config.maxMotorPWM !== undefined) {
    if (config.maxMotorPWM < 0) {
      errors.push('maxMotorPWM must be >= 0');
    }
    if (config.maxMotorPWM > 255) {
      errors.push('maxMotorPWM must be <= 255');
    }
  }

  // emergencyStopCm: 1-100
  if (config.emergencyStopCm !== undefined) {
    if (config.emergencyStopCm < 1) {
      errors.push('emergencyStopCm must be >= 1');
    }
    if (config.emergencyStopCm > 100) {
      errors.push('emergencyStopCm must be <= 100');
    }
  }

  // speedReduceCm must be > emergencyStopCm
  if (
    config.speedReduceCm !== undefined &&
    config.emergencyStopCm !== undefined
  ) {
    if (config.speedReduceCm <= config.emergencyStopCm) {
      errors.push('speedReduceCm must be greater than emergencyStopCm');
    }
  }

  // speedReduceCm standalone range
  if (config.speedReduceCm !== undefined) {
    if (config.speedReduceCm < 1) {
      errors.push('speedReduceCm must be >= 1');
    }
  }

  // maxContinuousMs: positive
  if (config.maxContinuousMs !== undefined) {
    if (config.maxContinuousMs < 0) {
      errors.push('maxContinuousMs must be >= 0');
    }
  }

  // hostTimeoutMs: positive
  if (config.hostTimeoutMs !== undefined) {
    if (config.hostTimeoutMs < 0) {
      errors.push('hostTimeoutMs must be >= 0');
    }
  }

  // minBatteryVoltage: non-negative
  if (config.minBatteryVoltage !== undefined) {
    if (config.minBatteryVoltage < 0) {
      errors.push('minBatteryVoltage must be >= 0');
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Stepper Safety (V1 Hardware)
// ---------------------------------------------------------------------------

export interface StepperSafetyConfig {
  maxStepsPerSecond: number;
  maxContinuousSteps: number;
  hostHeartbeatMs: number;
  maxCoilCurrentMa: number;
}

export const DEFAULT_STEPPER_SAFETY_CONFIG: StepperSafetyConfig = {
  maxStepsPerSecond: 1024,
  maxContinuousSteps: 40960,
  hostHeartbeatMs: 2000,
  maxCoilCurrentMa: 300,
};

export function validateStepperSafetyConfig(
  config: Partial<StepperSafetyConfig>,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (config.maxStepsPerSecond !== undefined) {
    if (config.maxStepsPerSecond < 1) errors.push('maxStepsPerSecond must be >= 1');
    if (config.maxStepsPerSecond > 2048) errors.push('maxStepsPerSecond must be <= 2048');
  }

  if (config.maxContinuousSteps !== undefined) {
    if (config.maxContinuousSteps < 1) errors.push('maxContinuousSteps must be >= 1');
  }

  if (config.hostHeartbeatMs !== undefined) {
    if (config.hostHeartbeatMs < 500) errors.push('hostHeartbeatMs must be >= 500');
    if (config.hostHeartbeatMs > 10000) errors.push('hostHeartbeatMs must be <= 10000');
  }

  if (config.maxCoilCurrentMa !== undefined) {
    if (config.maxCoilCurrentMa < 0) errors.push('maxCoilCurrentMa must be >= 0');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Clamp stepper speed to safe limit (mirrors firmware logic).
 */
export function clampStepperSpeed(
  requestedSpeed: number,
  config: StepperSafetyConfig,
): number {
  if (requestedSpeed < 0) return 0;
  if (requestedSpeed > config.maxStepsPerSecond) return config.maxStepsPerSecond;
  return requestedSpeed;
}

/**
 * Clamp step count to safe limit (mirrors firmware logic).
 */
export function clampStepperSteps(
  requestedSteps: number,
  config: StepperSafetyConfig,
): number {
  if (requestedSteps > config.maxContinuousSteps) return config.maxContinuousSteps;
  if (requestedSteps < -config.maxContinuousSteps) return -config.maxContinuousSteps;
  return requestedSteps;
}

/**
 * TypeScript mirror of the firmware PWM clamping logic.
 */
export function clampMotorPWM(
  requestedPWM: number,
  config: FirmwareSafetyConfig,
  distanceCm?: number,
): number {
  let effectiveMax = config.maxMotorPWM;

  if (distanceCm !== undefined) {
    if (distanceCm <= config.emergencyStopCm) {
      return 0;
    }
    if (distanceCm <= config.speedReduceCm) {
      const range = config.speedReduceCm - config.emergencyStopCm;
      const progress = distanceCm - config.emergencyStopCm;
      effectiveMax = Math.floor((progress / range) * config.maxMotorPWM);
    }
  }

  let clamped = requestedPWM;
  if (clamped > effectiveMax) {
    clamped = effectiveMax;
  }
  if (clamped > config.maxMotorPWM) {
    clamped = config.maxMotorPWM;
  }
  if (clamped < 0) {
    clamped = 0;
  }

  return clamped;
}
