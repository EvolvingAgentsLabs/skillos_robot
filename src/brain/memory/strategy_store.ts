/**
 * RoClaw Strategy Store — Extends core StrategyStore with RoClaw-specific
 * directory naming conventions.
 *
 * RoClaw uses: level_1_goals, level_2_routes, level_3_tactical, level_4_motor
 * Core uses:   level_1_goals, level_2_strategy, level_3_tactical, level_4_reactive
 */

import * as path from 'path';
import {
  StrategyStore as CoreStrategyStore,
  type StrategyStoreConfig,
  strategyFromMarkdown,
  strategyToMarkdown,
  parseNegativeConstraints,
} from '../../llmunix-core/strategy_store';
import { HierarchyLevel } from '../../llmunix-core/types';
import type { LevelDirectoryConfig } from '../../llmunix-core/interfaces';

// Re-export parsing utilities for backward compat
export { strategyFromMarkdown, strategyToMarkdown, parseNegativeConstraints };

// =============================================================================
// RoClaw-specific level directory names
// =============================================================================

const ROCLAW_LEVEL_DIRS: LevelDirectoryConfig = {
  [HierarchyLevel.GOAL]: 'level_1_goals',
  [HierarchyLevel.STRATEGY]: 'level_2_routes',
  [HierarchyLevel.TACTICAL]: 'level_3_tactical',
  [HierarchyLevel.REACTIVE]: 'level_4_motor',
};

// =============================================================================
// RoClaw StrategyStore
// =============================================================================

export class StrategyStore extends CoreStrategyStore {
  constructor(config?: string | StrategyStoreConfig) {
    if (typeof config === 'string' || config === undefined) {
      super({
        strategiesDir: config ?? path.join(__dirname, 'strategies'),
        levelDirs: ROCLAW_LEVEL_DIRS,
      });
    } else {
      super({
        ...config,
        levelDirs: { ...ROCLAW_LEVEL_DIRS, ...(config.levelDirs ?? {}) },
      });
    }
  }
}
