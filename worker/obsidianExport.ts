/**
 * worker/obsidianExport.ts — Obsidian Vault Mirror Export Service
 *
 * Requirements:
 * - Exports approved workflow recipes into human-readable Markdown notes
 * - Supports exporting all approved workflows or a specific recipe by ID
 * - Strictly an export/mirror; never a live system dependency
 */

import { TeachRecipeService } from './teachRecipeService';
import { ObsidianMirror, ObsidianNote } from './obsidianMirror';

export interface ObsidianExportPayload {
  vaultName: string;
  notes: ObsidianNote[];
  count: number;
  generatedAt: string;
}

export class ObsidianExportService {
  /**
   * Exports all approved workflow recipes as an Obsidian vault collection.
   */
  static async exportAllWorkflows(
    db: D1Database,
    vaultName: string = 'Personal_AI_OS_Vault'
  ): Promise<ObsidianExportPayload> {
    const approvedRecipes = await TeachRecipeService.listRecipes(db, 'approved', 100);
    const notes: ObsidianNote[] = approvedRecipes.map((recipe) =>
      ObsidianMirror.formatRecipeNote(recipe)
    );

    return {
      vaultName,
      notes,
      count: notes.length,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Exports a single recipe as an Obsidian note.
   */
  static async exportSingleWorkflow(
    db: D1Database,
    recipeId: string
  ): Promise<ObsidianNote | null> {
    const recipe = await TeachRecipeService.getRecipe(db, recipeId);
    if (!recipe) return null;
    return ObsidianMirror.formatRecipeNote(recipe);
  }
}
