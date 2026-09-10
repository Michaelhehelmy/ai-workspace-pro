/**
 * Environment Detection Module
 * Lightweight platform detection for tree-shaking
 */

export const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';