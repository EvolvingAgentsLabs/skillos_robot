import {
  StepperKinematics,
  DEFAULT_28BYJ48_SPEC,
} from '../../src/shared/stepper-kinematics';

describe('StepperKinematics', () => {
  let kin: StepperKinematics;

  beforeEach(() => {
    kin = new StepperKinematics();
  });

  // ===========================================================================
  // Constructor & spec
  // ===========================================================================

  test('uses default 28BYJ-48 spec', () => {
    const spec = kin.getSpec();
    expect(spec.stepsPerRevolution).toBe(4096);
    expect(spec.wheelDiameterCm).toBe(6.0);
    expect(spec.wheelBaseCm).toBe(10.0);
    expect(spec.maxStepsPerSecond).toBe(1024);
    expect(spec.maxAcceleration).toBe(512);
  });

  test('accepts custom partial spec', () => {
    const custom = new StepperKinematics({ wheelDiameterCm: 8.0, wheelBaseCm: 15.0 });
    const spec = custom.getSpec();
    expect(spec.wheelDiameterCm).toBe(8.0);
    expect(spec.wheelBaseCm).toBe(15.0);
    expect(spec.stepsPerRevolution).toBe(4096); // default preserved
  });

  test('computes correct wheel circumference', () => {
    // 6cm diameter → circumference = 6 * PI ≈ 18.85
    expect(kin.getWheelCircumferenceCm()).toBeCloseTo(6.0 * Math.PI, 4);
  });

  test('computes correct steps per cm', () => {
    // 4096 / (6 * PI) ≈ 217.3
    expect(kin.getStepsPerCm()).toBeCloseTo(4096 / (6 * Math.PI), 2);
  });

  // ===========================================================================
  // distanceToSteps / stepsToDistance round-trip
  // ===========================================================================

  test('one full wheel revolution = one circumference', () => {
    const circumference = 6.0 * Math.PI; // ≈ 18.849
    const steps = kin.distanceToSteps(circumference);
    expect(steps).toBe(4096);
  });

  test('distanceToSteps negative', () => {
    const steps = kin.distanceToSteps(-10);
    expect(steps).toBeLessThan(0);
    expect(steps).toBe(-kin.distanceToSteps(10));
  });

  test('round-trip: stepsToDistance(distanceToSteps(x)) ≈ x', () => {
    const distances = [0, 1, 5, 10, 18.85, 50, -7.5];
    for (const d of distances) {
      const roundTrip = kin.stepsToDistance(kin.distanceToSteps(d));
      expect(roundTrip).toBeCloseTo(d, 1);
    }
  });

  test('distanceToSteps(0) = 0', () => {
    expect(kin.distanceToSteps(0)).toBe(0);
  });

  // ===========================================================================
  // rotationToSteps
  // ===========================================================================

  test('360 degree rotation uses correct arc length', () => {
    const steps = kin.rotationToSteps(360);
    const expectedArcCm = Math.PI * 10;
    const expectedSteps = Math.round(expectedArcCm * kin.getStepsPerCm());
    expect(steps).toBe(expectedSteps);
  });

  test('90 degree rotation is 1/4 of 360', () => {
    const steps90 = kin.rotationToSteps(90);
    const steps360 = kin.rotationToSteps(360);
    expect(steps90).toBeCloseTo(steps360 / 4, 0);
  });

  test('negative degrees rotates opposite direction', () => {
    const stepsPos = kin.rotationToSteps(45);
    const stepsNeg = kin.rotationToSteps(-45);
    expect(stepsNeg).toBe(-stepsPos);
  });

  test('rotationToSteps(0) = 0', () => {
    expect(kin.rotationToSteps(0)).toBe(0);
  });

  // ===========================================================================
  // velocityToStepsPerSecond
  // ===========================================================================

  test('velocity conversion basic', () => {
    const stepsPerSec = kin.velocityToStepsPerSecond(2);
    expect(stepsPerSec).toBeCloseTo(2 * kin.getStepsPerCm(), 0);
  });

  test('velocity clamped to max steps/s', () => {
    const stepsPerSec = kin.velocityToStepsPerSecond(100);
    expect(stepsPerSec).toBeLessThanOrEqual(1024);
  });

  test('negative velocity preserved with clamping', () => {
    const stepsPerSec = kin.velocityToStepsPerSecond(-100);
    expect(stepsPerSec).toBeGreaterThanOrEqual(-1024);
    expect(stepsPerSec).toBeLessThan(0);
  });

  // ===========================================================================
  // calculateArcSpeeds
  // ===========================================================================

  test('arc speeds: left turn has slower left wheel', () => {
    const speeds = kin.calculateArcSpeeds(30, 5);
    expect(speeds.left).toBeLessThan(speeds.right);
    expect(speeds.left).toBeGreaterThan(0);
    expect(speeds.right).toBeGreaterThan(0);
  });

  test('arc speeds: large radius approaches equal speeds', () => {
    const speeds = kin.calculateArcSpeeds(1000, 5);
    expect(Math.abs(speeds.left - speeds.right)).toBeLessThan(1);
  });

  // ===========================================================================
  // calculateMoveDuration
  // ===========================================================================

  test('zero steps returns zero duration', () => {
    expect(kin.calculateMoveDuration(0, 500)).toBe(0);
  });

  test('zero speed returns zero duration', () => {
    expect(kin.calculateMoveDuration(1000, 0)).toBe(0);
  });

  test('trapezoidal profile: large move', () => {
    const duration = kin.calculateMoveDuration(10000, 1024, 512);
    expect(duration).toBeCloseTo(11766, -2);
  });

  test('triangle profile: short move', () => {
    const duration = kin.calculateMoveDuration(500, 1024, 512);
    expect(duration).toBeCloseTo(1976, -2);
  });

  test('negative steps treated as absolute', () => {
    const durationPos = kin.calculateMoveDuration(1000, 500);
    const durationNeg = kin.calculateMoveDuration(-1000, 500);
    expect(durationPos).toBe(durationNeg);
  });

  // ===========================================================================
  // Derived values
  // ===========================================================================

  test('maxLinearVelocityCmS is correct', () => {
    const expected = 1024 / kin.getStepsPerCm();
    expect(kin.maxLinearVelocityCmS()).toBeCloseTo(expected, 4);
  });

  test('maxRPM is correct for 28BYJ-48', () => {
    expect(kin.maxRPM()).toBe(15);
  });
});
