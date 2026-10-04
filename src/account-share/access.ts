import { AppError } from '../errors/app-error';
import {
  GrantorShareRole,
  ShareJoinRole,
  ShareScope,
  ShareSource,
} from './model';

export interface ShareVisibilityInput {
  includePersonal: boolean;
  includeOwned: boolean;
  includeEditor: boolean;
  source: ShareSource;
  grantorRole?: GrantorShareRole | null;
}

export function parseShareScope(input: {
  includePersonal?: unknown;
  includeOwned?: unknown;
  includeEditor?: unknown;
  canJoinAs?: unknown;
}): ShareScope {
  const includePersonal = requireBoolean(input.includePersonal, 'includePersonal');
  const includeOwned = requireBoolean(input.includeOwned, 'includeOwned');
  const includeEditor = requireBoolean(input.includeEditor, 'includeEditor');
  if (!includePersonal && !includeOwned && !includeEditor) {
    throw new AppError(
      422,
      'VALIDATION_FAILED',
      'At least one share source must be enabled',
      { field: 'scope' },
    );
  }
  return {
    includePersonal,
    includeOwned,
    includeEditor,
    canJoinAs: parseJoinRole(input.canJoinAs),
  };
}

export function sessionVisibleThroughGrant(input: ShareVisibilityInput): boolean {
  if (input.source === 'personal') return input.includePersonal;
  if (input.grantorRole === 'viewer' || input.grantorRole == null) return false;
  if (input.grantorRole === 'owner') return input.includeOwned;
  return input.includeEditor;
}

function parseJoinRole(value: unknown): ShareJoinRole {
  if (value === undefined || value === null) return 'editor';
  if (value === 'editor' || value === 'viewer' || value === 'none') return value;
  throw new AppError(422, 'VALIDATION_FAILED', 'canJoinAs is invalid', {
    field: 'canJoinAs',
  });
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} must be a boolean`, {
      field,
    });
  }
  return value;
}
