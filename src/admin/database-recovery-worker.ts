import { inspectRestoreFile } from './database-recovery';

try {
  const result = inspectRestoreFile(process.argv[2], JSON.parse(process.argv[3]));
  process.send?.({ result }, () => process.disconnect?.());
} catch (error) {
  process.send?.({ error: error instanceof Error ? error.message : 'Invalid backup' }, () => process.disconnect?.());
}
