const STABLE_CLI_ERROR_CODES = new Set([
  'delta_file_exists',
  'delta_registry_update_failed',
  'expired_token',
  'invalid_claims',
  'invalid_token',
  'missing_token',
  'new_delta_migration_not_regular_file',
  'new_delta_migration_symlink_rejected',
  'new_delta_migration_too_large',
  'new_delta_migrations_dir_not_directory',
  'new_delta_migrations_dir_symlink_rejected',
  'new_generated_delta_required',
  'nothing_to_allocate',
  'project_codegen_use_project_bin',
  'project_schema_removal_unsupported',
  'schema_runtime_mismatch',
  'unregistered_generated_delta_mismatch',
  'verify_schema_runtime_spawn_failed',
])

export function cliErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'cli_error'
  const separator = error.message.indexOf(':')
  const candidate = separator === -1 ? error.message : error.message.slice(0, separator)
  return STABLE_CLI_ERROR_CODES.has(candidate) ? candidate : 'cli_error'
}
