/**
 * Public surface of the vision module.
 *
 * NOTE: ./fixtures.ts is deliberately NOT re-exported here. The synthetic landmark generators are a test
 * rig (~250 lines of rigs for poses that no patient ever holds); exporting them from the barrel would put
 * them in the app's public API and, unless the bundler tree-shakes perfectly, in the shipped bundle.
 * Tests import them directly: `import { handPose } from '../vision/fixtures.ts'`.
 */
export * from './landmarks.ts';
export * from './features.ts';
export * from './filters.ts';
export * from './calibration.ts';
export * from './pipeline.ts';
export * from './trigger.ts';
export * from './mediapipe.ts';
